// Test-only assembly of the pre-workspace engine/template. Never substitute this
// for a check of lib/host.js or lib/client.js: published-smoke.mjs covers those.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = relative => readFileSync(path.join(root, relative), 'utf8')
const pkg = JSON.parse(read('package.json'))
const pluginName = pkg.name.replace(/^dsh-/, '')
const fill = text => text.replaceAll('__PKG_NAME__', pkg.name).replaceAll('__PLUGIN_NAME__', pluginName).replaceAll('__ROUTE_BASE__', '/' + pkg.name)

// Test dependency fallback only; neither production sources nor the package
// composition receive a deployment path. A missing dependency fails, not skips.
export async function testDependency(name) {
  try { return await import(name) }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
    const entry = '/home/kali/.npm/_npx/1e7f6d9597241db0/node_modules/' + name + '/lib/index.js'
    return import(pathToFileURL(entry).href)
  }
}

function withoutImports(source) {
  return source
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"\n]+['"];?\s*$/gm, '')
    .replace(/^import\s*['"][^'"\n]+['"];?\s*$/gm, '')
}

export async function loadLegacyHost() {
  const { defineTool } = await testDependency('@deepseek-ai/dsh-tools')
  if (typeof defineTool !== 'function') throw new Error('legacy fixture needs the real defineTool')
  const docx = read('src/docx.js').replace(/^export\s+(?=(?:async\s+)?(?:function|const)\b)/gm, '')
  const source = read('src/host.js')
  if (source.split('/* @DOCX@ */').length !== 2) throw new Error('legacy host DOCX marker changed')
  let text = fill(read('lib/parts/host.head.js') + source.replace('/* @DOCX@ */', docx) + read('lib/parts/host.tail.js'))
  text = withoutImports(text)
    .replace(/^export\s+(?=(?:async\s+)?(?:function|const|let)\b)/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
  // applyHost is the legacy engine; do not return a future published workspace
  // wrapper's default `apply`. Real defineTool remains the schema authority.
  return new Function('defineTool', text + '\nreturn {name: typeof name === "string" ? name : "redteam-report-legacy-test", inject:["fs","shell","timer","webServer","tools"], apply:applyHost};')(defineTool)
}

export function buildLegacyClient() {
  let source = read('src/client.js')
  const wrapper = "\nreturn {\n  name: '" + pluginName + "',\n  inject: ['slots', 'timer'],\n  apply: applyClient\n}\n"
  if (!source.endsWith(wrapper)) throw new Error('legacy client template wrapper changed')
  source = source.slice(0, -wrapper.length)
  const anchor = 'function applyClient(ctx) {\n  const slots = ctx.slots\n'
  if (source.split(anchor).length !== 2) throw new Error('legacy client apply anchor changed')
  source = source.replace(anchor, read('lib/parts/client.shim.js') + '  const slots = ctx.slots\n')
  const tail = read('lib/parts/client.tail.js').replace(/exports\.inject\s*=\s*\[[^\]]*\]/, "exports.inject = ['slots', 'timer']")
  return fill(read('lib/parts/client.head.js') + source + tail)
}
