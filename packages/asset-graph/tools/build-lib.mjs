// 生成 lib/host.js 与 lib/client.js。
//
// 为什么要生成而不是手写：src/host.js 与 src/client.js 是权威实现，lib/ 只是它们在
// 【常驻插件包】形态下的包装。手抄两份必然漂移；生成保证「改 src → 跑一次 npm run build:lib」即同步。
//
// 两半边的包装差异都集中在垫片里，主体逻辑逐字不动：
//   host   : harness.defineTool/registerTool/handle  -> defineTool / ctx.tools.register / HTTP 路由
//   client : host.call（闭包符号）-> fetch 到宿主路由；styles.insert（闭包符号）-> 自插 <style>
//
// 用法: node tools/build-lib.mjs [--check]
//   --check 只比对、不写入，不一致时非零退出（可用于 CI）

import fs from 'node:fs'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const check = process.argv.includes('--check')

// 插件名从包自身推导：pkg 名去掉 'dsh-' 前缀即界面/工具标识，
// 这样生成器可被任意包复用，不必逐包改字符串。
const PKG = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const PKG_NAME = PKG.name
const PLUGIN_NAME = path.basename(PKG_NAME).replace(/^dsh-/, '')
// RPC 路由挂在包命名空间下，避免与其它插件的路由相撞。
const ROUTE_BASE = '/' + PKG_NAME

const HOST_WRAPPER = "\nreturn {\n  name: '" + PLUGIN_NAME + "',\n  apply: applyHost\n}\n"
const CLIENT_WRAPPER = "\nreturn {\n  name: '" + PLUGIN_NAME + "',\n  inject: ['slots', 'timer'],\n  apply: applyClient\n}\n"

// lib/parts/*.head.js 各自以一行函数声明收尾，函数体紧随其后。用它验证产物结构。
const HOST_DECL = 'function applyHost(ctx) {'
const CLIENT_DECL = 'function applyClient(ctx) {'
const quote = (text) => JSON.stringify(text)
function assertCount(hay, needle, times, label) {
  const n = hay.split(needle).length - 1
  if (n !== times) {
    console.error(`build-lib: ${label} 期望出现 ${times} 次，实际 ${n} 次`)
    return false
  }
  return true
}

function strip(source, wrapper, file) {
  if (!source.endsWith(wrapper)) {
    console.error(`build-lib: ${file} 结尾与预期不符，无法剥离动态包装`)
    process.exit(1)
  }
  return source.slice(0, -wrapper.length)
}

// src 结尾的动态包装自带它声明的插件名。按实际内容剥离，这样同一份 src 在
// 「未作用域名包」和「@owner/… 作用域名副本」两种产物里都能正确生成 ——
// 名字只影响产物里那个 id，不影响主体逻辑。
function stripDynamicWrapper(source, kind, file) {
  const fn = kind === 'host' ? 'applyHost' : 'applyClient'
  // src 结尾固定是 return { name: '<名字>', [inject: [...]], apply: <fn> }
  // （client 比 host 多一行 inject），所以名字与 apply 之间允许任意单行属性。
  const re = new RegExp("\\nreturn \\{\\n  name: '([^']+)',\\n(?:  [^\\n]+,\\n)*  apply: " + fn + "\\n\\}\\n$")
  const m = re.exec(source)
  if (!m) {
    console.error(`build-lib: ${file} 结尾不是预期的动态包装（return { name, apply: ${fn} }），无法剥离`)
    process.exit(1)
  }
  return { source: source.slice(0, m.index), declared: m[1] }
}

// 模板里的占位符按包替换（模板因此可跨包复用）
function fill(text) {
  return text
    .split('__PKG_NAME__').join(PKG_NAME)
    .split('__PLUGIN_NAME__').join(PLUGIN_NAME)
    .split('__ROUTE_BASE__').join(ROUTE_BASE)
}

// ── Host 半边 ────────────────────────────────────────────────────────────────
const hostHead = read('lib/parts/host.head.js')
const hostTail = read('lib/parts/host.tail.js')
// src/host.js 是【主体逻辑 + 动态包装】形态，函数外壳由 host.head.js 提供。
// 若主体自己再声明一次 applyHost，产物里就会出现两个同名函数，后一个遮蔽前一个，
// 导出的 apply 变成只建了 harness 却没有注册任何工具的残壳 —— 而且语法完全合法，
// node --check 查不出来。v7.9.5 正是这样带着「零工具」发给用户的，故在此设闸。
const hostSource = read('src/host.js')
if (hostSource.includes(HOST_DECL)) {
  console.error(
    'build-lib: src/host.js 里不要写 "' + HOST_DECL + '" —— 函数外壳由 lib/parts/host.head.js 提供。\n' +
    '           主体必须只有【顶层 helper + 函数体】，结尾是动态包装 ' + quote(HOST_WRAPPER) + '。\n' +
    '           否则产物会声明两次 applyHost，导出一个不注册任何工具的残壳。'
  )
  process.exit(1)
}
const hostStripped = stripDynamicWrapper(hostSource, 'host', 'src/host.js')
let hostOut = fill(hostHead + hostStripped.source + hostTail)

// ── Client 半边 ──────────────────────────────────────────────────────────────
// 垫片注入到主体自己的 applyClient 开头，包装保持极薄（只做作用域与导出）。
const clientHead = read('lib/parts/client.head.js')
const clientShim = read('lib/parts/client.shim.js')
const clientTail = read('lib/parts/client.tail.js')
const ANCHOR = 'function applyClient(ctx) {\n  const slots = ctx.slots\n'
const clientStripped = stripDynamicWrapper(read('src/client.js'), 'client', 'src/client.js')
let clientBody = clientStripped.source
if (clientBody.split(ANCHOR).length !== 2) {
  console.error('build-lib: src/client.js 中未找到唯一的 applyClient 入口锚点')
  process.exit(1)
}
clientBody = clientBody.replace(ANCHOR, clientShim + '  const slots = ctx.slots\n')
let clientOut = fill(clientHead + clientBody + clientTail)



// src 里写的插件名与 package.json 推导出的名字不一致时给出提示（仍继续生成，
// 因为改名副本本来就是合法用法）。
if (hostStripped.declared !== PLUGIN_NAME || clientStripped.declared !== PLUGIN_NAME) {
  console.log(
    `build-lib: 注意 src 声明的插件名（host=${hostStripped.declared}, client=${clientStripped.declared}）` +
    ` 与 package.json 推导出的 ${PLUGIN_NAME} 不同；产物 id 以 package.json 为准。`
  )
}

// 生成后的结构自检：解析细节可以变，但这两条不变量不能破。
let structureBad = 0
if (hostHead.split(HOST_DECL).length - 1 !== 1 || !hostHead.includes(HOST_DECL + '\n')) {
  console.error('build-lib: lib/parts/host.head.js 必须以唯一一行 ' + quote(HOST_DECL) + ' 收尾')
  structureBad++
}
if (!assertCount(hostOut, HOST_DECL, 1, 'lib/host.js 中的 applyHost 声明')) structureBad++
if (!assertCount(hostOut, 'harness.registerTool(ctx,', 3, 'lib/host.js 中的工具注册调用')) structureBad++
if (!assertCount(clientOut, CLIENT_DECL, 1, 'lib/client.js 中的 applyClient 声明')) structureBad++

// 工具经 ctx.tools.register 注册，而 Cordis 只允许访问 inject 里声明过的服务：
// 漏掉 'tools' 会在插件树加载期抛 `cannot get property "tools" without inject`，
// 整个 dsh 起不来 —— v7.9.6 就是以这种方式发给用户的，语言检查与 --check 都拦不住。
const hostInject = (hostTail.match(/export const inject = \[([^\]]*)\]/) || [])[1] || ''
if (hostOut.includes('harness.registerTool(ctx,') && hostInject.indexOf("'tools'") < 0) {
  console.error(
    'build-lib: src/ 注册了模型工具，但 lib/parts/host.tail.js 的 inject 里没有 "tools"。\n' +
    '           工具走 ctx.tools.register，缺这个声明会让整个插件树加载失败：\n' +
    '           cannot get property "tools" without inject\n' +
    '           当前 inject = [' + hostInject.trim() + ']'
  )
  structureBad++
}
if (structureBad > 0) {
  console.error('build-lib: 产物结构不合规，已中止（详见上面各条）')
  process.exit(1)
}

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
