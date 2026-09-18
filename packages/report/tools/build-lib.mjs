// 生成 lib/host.js 与 lib/client.js。
//
// 为什么要生成而不是手写：src/host.js 与 src/client.js 是权威实现，lib/ 只是它们在
// 【常驻插件包】形态下的包装。手抄两份必然漂移；生成保证「改 src → 跑一次 npm run build:lib」即同步。
//
// 正式 Host 由 workspace-install 注册，旧引擎源码作为数据传给每工作区运行器。
// Client 经过 workspace-client 转换后再以静态 bundle 提供：
//   host   : harness.defineTool/registerTool/handle -> defineTool / ctx.tools.register / HTTP 路由
//   client : host.call -> 宿主 HTTP；styles.insert -> stylesheet；统一设置由 memory 提供
//
// 用法: node tools/build-lib.mjs [--check]
//   --check 只比对、不写入，不一致时非零退出（可用于 CI）

import fs from 'node:fs'
import path from 'node:path'
import { rptBuildWorkspaceClientSource } from '../src/workspace-client.js'

const root = path.join(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const check = process.argv.includes('--check')

// 插件名从包自身推导：pkg 名去掉 'dsh-' 前缀即界面/工具标识，
// 这样生成器可被任意包复用，不必逐包改字符串。
const PKG = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const PKG_NAME = PKG.name
const PLUGIN_NAME = PKG_NAME.replace(/^dsh-/, '')
// RPC 路由挂在包命名空间下，避免与其它插件的路由相撞。
const ROUTE_BASE = '/' + PKG_NAME

const CLIENT_WRAPPER = "\nreturn {\n  name: '" + PLUGIN_NAME + "',\n  inject: ['slots', 'timer'],\n  apply: applyClient\n}\n"

// 剥离时按「结构」匹配，不比对包名：GitHub Packages 的副本会在改名的
// package.json 下重跑本脚本，而 src/client.js 里的名字仍是未作用域的那个。
// 比对包名会让改名副本直接失败（实测卡住过 0.4.1 / 0.2.1 的 gh 发布）。
const CLIENT_WRAPPER_RE = /\nreturn \{\n {2}name: '[^']*',\n {2}inject: \['slots', 'timer'\],\n {2}apply: applyClient\n\}\n$/

function strip(source, wrapper, file) {
  if (!CLIENT_WRAPPER_RE.test(source)) {
    console.error(`build-lib: ${file} 结尾与预期不符，无法剥离动态包装`)
    process.exit(1)
  }
  return source.replace(CLIENT_WRAPPER_RE, '')
}

// 模板里的占位符按包替换（模板因此可跨包复用）
function fill(text) {
  return text
    .split('__PKG_NAME__').join(PKG_NAME)
    .split('__PLUGIN_NAME__').join(PLUGIN_NAME)
    .split('__ROUTE_BASE__').join(ROUTE_BASE)
}

// ── 渲染模块 ────────────────────────────────────────────────────────────────
// markdown → 块/HTML/docx 的实现单独放在 src/docx.js：它是纯函数、能单测，
// 混进 host.js 主体会让「撰写报告」的逻辑读不下去。生成时内联进产物，
// 所以 lib/host.js 仍是自包含的，运行期不需要额外文件。
const DOCX_MARKER = '/* @DOCX@ */'
const docxStripped = (() => {
  const src = read('src/docx.js')
  if (!/^export (function|const) /m.test(src)) {
    console.error('build-lib: src/docx.js 必须用 `export function` / `export const` 导出')
    process.exit(1)
  }
  const stripped = src.replace(/^export /gm, '')
  if (/^\s*(import|export)\s/m.test(stripped)) {
    console.error('build-lib: src/docx.js 去掉 export 后仍有 import/export，无法内联')
    process.exit(1)
  }
  return stripped.trim() + '\n'
})()

// ── Host 半边 ────────────────────────────────────────────────────────────────
const hostHead = read('lib/parts/host.head.js')
const hostTail = read('lib/parts/host.tail.js')
// 本插件的 src/host.js 只写 applyHost 的函数体（函数头与收尾由 lib/parts 提供），
// 因此这里不做「剥离动态包装」——那个包装是 asset-graph 那种内联插件对象才有的。
const hostBody = read('src/host.js')
if (hostBody.split(DOCX_MARKER).length !== 2) {
  console.error('build-lib: src/host.js 里必须恰好有一个 ' + DOCX_MARKER + ' 占位符')
  process.exit(1)
}
// 顺序很重要：先把渲染模块嵌进去，再跑 fill()。反过来 fill() 会先看到
// 不属于它的占位符，而渲染模块里若出现 __PKG_NAME__ 之类字样也会被误替换。
// Keep the legacy engine as source data for independently scoped closures.
// The installed main entry runs the workspace manager, never the legacy globals.
const productionBody = '\n  await rptInstallWorkspaceReports(ctx, harness, { hostSource: '
  + JSON.stringify(hostBody) + ', docxSource: ' + JSON.stringify(read('src/docx.js')) + ' });\n'
let hostOut = fill(hostHead + productionBody + hostTail)

// ── Client 半边 ──────────────────────────────────────────────────────────────
// 垫片注入到主体自己的 applyClient 开头，包装保持极薄（只做作用域与导出）。
const clientHead = read('lib/parts/client.head.js')
const clientShim = read('lib/parts/client.shim.js')
const clientTail = read('lib/parts/client.tail.js')
const ANCHOR = 'function applyClient(ctx) {\n  const slots = ctx.slots\n'
let clientBody = strip(read('src/client.js'), CLIENT_WRAPPER, 'src/client.js')
if (clientBody.split(ANCHOR).length !== 2) {
  console.error('build-lib: src/client.js 中未找到唯一的 applyClient 入口锚点')
  process.exit(1)
}
clientBody = clientBody.replace(ANCHOR, clientShim + '  const slots = ctx.slots\n')
clientBody = rptBuildWorkspaceClientSource(clientBody)
clientBody = clientBody.replace('  const slots = ctx.slots;', "  const settingsHub = ctx.get('redteamSettingsUI');\n  if (!settingsHub) throw new Error('请先安装并启用 dsh-redteam-memory >= 0.4.0');\n  const slots = ctx.slots;")
let clientOut = fill(clientHead + clientBody + clientTail)



const targets = [
  ['lib/host.js', hostOut],
  ['lib/client.js', clientOut],
]

let bad = 0
for (const [rel, content] of targets) {
  const abs = path.join(root, rel)
  if (check) {
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : ''
    if (current !== content) { console.error(`build-lib --check: ${rel} 与 src/ 不同步`); bad++ }
    else console.log(`build-lib --check: ${rel} 同步`)
  } else {
    fs.writeFileSync(abs, content, 'utf8')
    console.log(`build-lib: 已生成 ${rel}（${Buffer.byteLength(content)} 字节）`)
  }
}
process.exit(bad === 0 ? 0 : 1)
