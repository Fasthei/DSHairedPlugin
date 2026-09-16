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

const HOST_WRAPPER = "\nreturn {\n  name: 'redteam-asset-graph',\n  apply: applyHost\n}\n"
const CLIENT_WRAPPER = "\nreturn {\n  name: 'redteam-asset-graph',\n  inject: ['slots', 'timer'],\n  apply: applyClient\n}\n"

function strip(source, wrapper, file) {
  if (!source.endsWith(wrapper)) {
    console.error(`build-lib: ${file} 结尾与预期不符，无法剥离动态包装`)
    process.exit(1)
  }
  return source.slice(0, -wrapper.length)
}

// ── Host 半边 ────────────────────────────────────────────────────────────────
const hostHead = read('lib/parts/host.head.js')
const hostTail = read('lib/parts/host.tail.js')
const hostOut = hostHead + strip(read('src/host.js'), HOST_WRAPPER, 'src/host.js') + hostTail

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
const clientOut = clientHead + clientBody + clientTail

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
