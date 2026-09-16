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
const PLUGIN_NAME = PKG_NAME.replace(/^dsh-/, '')
// RPC 路由挂在包命名空间下，避免与其它插件的路由相撞。
const ROUTE_BASE = '/' + PKG_NAME

const CLIENT_WRAPPER = "\nreturn {\n  name: '" + PLUGIN_NAME + "',\n  inject: ['slots', 'timer'],\n  apply: applyClient\n}\n"

function strip(source, wrapper, file) {
  if (!source.endsWith(wrapper)) {
    console.error(`build-lib: ${file} 结尾与预期不符，无法剥离动态包装`)
    process.exit(1)
  }
  return source.slice(0, -wrapper.length)
}

// 模板里的占位符按包替换（模板因此可跨包复用）
function fill(text) {
  return text
    .split('__PKG_NAME__').join(PKG_NAME)
    .split('__PLUGIN_NAME__').join(PLUGIN_NAME)
    .split('__ROUTE_BASE__').join(ROUTE_BASE)
}

// ── 框架数据 ────────────────────────────────────────────────────────────────
// 攻击矩阵的框架清单（tactics + techniques + detect_keywords）单独放在
// src/frameworks.js：它有几千行，混进 host.js 主体会让逻辑读不下去。
// 生成时把它内联进产物，所以 lib/host.js 仍是自包含的，运行期不需要额外文件。
const FRAMEWORK_MARKER = '/* @FRAMEWORKS@ */'
const frameworksStripped = (() => {
  const src = read('src/frameworks.js')
  // 去掉 ESM 包装：产物里这一段只是函数体内的 `const FRAMEWORKS = [...]`。
  const m = /^([\s\S]*?)export const FRAMEWORKS = ([\s\S]*?)\n$/.exec(src)
  if (!m) {
    console.error('build-lib: src/frameworks.js 必须以 `export const FRAMEWORKS = [...]` 结尾')
    process.exit(1)
  }
  return (m[1].trim() ? m[1].trim() + '\n\n' : '') + '  const FRAMEWORKS = ' + m[2].trim() + '\n'
})()

// ── Host 半边 ────────────────────────────────────────────────────────────────
const hostHead = read('lib/parts/host.head.js')
const hostTail = read('lib/parts/host.tail.js')
// 本插件的 src/host.js 只写 applyHost 的函数体（函数头与收尾由 lib/parts 提供），
// 因此这里不做「剥离动态包装」——那个包装是 asset-graph 那种内联插件对象才有的。
const hostBody = read('src/host.js')
if (hostBody.split(FRAMEWORK_MARKER).length !== 2) {
  console.error('build-lib: src/host.js 里必须恰好有一个 ' + FRAMEWORK_MARKER + ' 占位符')
  process.exit(1)
}
// 顺序很重要：先把框架数据嵌进去，再跑 fill()。反过来 fill() 会先看到
// __FRAMEWORKS__ 这个不属于它的占位符（无害但顺序反了不好读），而且框架数据里
// 若出现 __PKG_NAME__ 之类字样也不会被误替换。
let hostOut = fill(hostHead + hostBody.replace(FRAMEWORK_MARKER, frameworksStripped) + hostTail)

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
let clientOut = fill(clientHead + clientBody + clientTail)



// 产物结构自检。asset-graph 那次「applyHost 声明两次 -> 导出零工具残壳」的教训：
// 生成的产物必须有结构不变量，否则语法合法但语义全废。
let structureBad = 0
const countOf = (hay, needle) => hay.split(needle).length - 1
if (countOf(hostOut, 'function applyHost(ctx) {') !== 1) {
  console.error('build-lib: lib/host.js 里 applyHost 声明数应为 1，实际 ' + countOf(hostOut, 'function applyHost(ctx) {'))
  structureBad++
}
if (countOf(hostOut, 'const FRAMEWORKS = [') !== 1) {
  console.error('build-lib: lib/host.js 里 FRAMEWORKS 定义数应为 1，实际 ' + countOf(hostOut, 'const FRAMEWORKS = ['))
  structureBad++
}
if (hostOut.includes(FRAMEWORK_MARKER)) {
  console.error('build-lib: lib/host.js 里仍残留 ' + FRAMEWORK_MARKER + ' 占位符')
  structureBad++
}
try {
  // 数据里带注释（说明来源与取舍），所以不能用 JSON.parse；用 Function 求值拿真值。
  const src = frameworksStripped.replace(/^[\s\S]*?const FRAMEWORKS = /, '').replace(/\n$/, '')
  const parsed = new Function('return (' + src + ')')()
  if (!Array.isArray(parsed) || parsed.length === 0) {
    console.error('build-lib: 框架数据为空')
    structureBad++
  } else {
    for (const fw of parsed) {
      if (!fw.id || !fw.name || !Array.isArray(fw.techniques)) {
        console.error('build-lib: 框架 ' + (fw && fw.id) + ' 结构不完整')
        structureBad++
        continue
      }
      if (fw.techniques.length === 0) {
        // 空框架会产出一个永远 0/N 的标签页，等于把「没做完」发给用户，所以直接拦住。
        console.error('build-lib: 框架 ' + fw.id + ' 还没有技术点数据（数据未填完）')
        structureBad++
      }
      const seen = {}
      for (const t of fw.techniques) {
        if (!t.id || !t.name) { console.error('build-lib: ' + fw.id + ' 有技术点缺少 id/name'); structureBad++ }
        if (seen[t.id]) { console.error('build-lib: ' + fw.id + ' 技术点 id 重复：' + t.id); structureBad++ }
        seen[t.id] = true
        if (!Array.isArray(t.detect_keywords)) { console.error('build-lib: ' + fw.id + '/' + t.id + ' 缺少 detect_keywords'); structureBad++ }
      }
    }
  }
} catch (e) {
  console.error('build-lib: 框架数据求值失败 —— ' + e.message)
  structureBad++
}
if (structureBad > 0) {
  console.error('build-lib: 产物结构不合规，已中止')
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
