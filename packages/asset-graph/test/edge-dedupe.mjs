// 关系边去重回归测试
//
// 背景（真实缺陷）：addEdgeRaw 原先按 (from, to, relation) 去重，而 analyzePool 会为
// 每个 URL→域名 无条件生成一条 belongs_to。于是「人工再加一条 hosts_on」不会覆盖它，
// 同一对资产上留下两条语义重复的边 —— 实测在一个 27 资产的图谱里出现 5 对。
//
// 修法：按「无序资产对」去重，冲突时保留更权威的一条（manual > import > auto）。
//
// 为什么用真实 host 半边而不是复制一份逻辑：复制品会和实现一起漂移，测不到真东西。
// 这里把宿主服务全部替换成内存假件（fs / tools / webServer / effect），
// 于是整个插件在不接触真实 DSH 进程、不读写 ~/.redteam-assets.json 的情况下跑起来。
//
// 依赖：lib/host.js 需要解析 @deepseek-ai/dsh-tools（defineTool）。仓库里没有提交
// node_modules，所以拿不到该模块时本测试会明确跳过而不是假装通过。
//
// 用法: node test/edge-dedupe.mjs

import fs from 'node:fs'
import path from 'node:path'

const libHost = path.join(import.meta.dirname, '..', 'lib', 'host.js')

let mod
try {
  mod = await import(libHost)
} catch (e) {
  if (e && (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'MODULE_NOT_FOUND')) {
    console.log('跳过：无法解析 @deepseek-ai/dsh-tools —— 先装依赖（或从 DSH 部署目录软链 node_modules/@deepseek-ai）再跑')
    process.exit(0)
  }
  throw e
}

// ---------- 内存假 fs ----------
function fakeFs(initial) {
  const files = new Map()
  for (const [k, v] of Object.entries(initial || {})) files.set(k, v)
  const obj = {
    resolve: async (p) => ({ path: String(p), displayPath: String(p) }),
    processPath: (t) => t.path,
    stat: async (t) => (files.has(t.path) ? { size: files.get(t.path).length } : null),
    readText: async (t) => {
      if (!files.has(t.path)) throw new Error('ENOENT: ' + t.path)
      return files.get(t.path)
    },
    writeText: async (t, text) => {
      files.set(t.path, String(text))
    },
  }
  return { fs: obj, files }
}

// ---------- 断言工具 ----------
let pass = 0
const fails = []
function ok(cond, label) {
  if (cond) {
    pass++
    console.log('  ✓ ' + label)
  } else {
    fails.push(label)
    console.log('  ✗ ' + label)
  }
}
const pairOf = (e) => [String(e.from), String(e.to)].sort().join('|')
function edgesBetween(edges, a, b) {
  const key = [String(a), String(b)].sort().join('|')
  return edges.filter((e) => pairOf(e) === key)
}

// ---------- 装配插件 ----------
const STORE = '/virtual/.redteam-assets.json'
const { fs: fsService, files } = fakeFs()
const registeredTools = {}
const registeredRoutes = []
const handlers = {}
const store = { path: STORE }

const ctx = {
  fs: fsService,
  shell: {},
  timer: {},
  tools: { register: (tool) => registeredTools[tool.name] = tool },
  webServer: {
    register: (route) => {
      registeredRoutes.push(route)
      if (route && route.handler) handlers.rpc = route.handler
      return () => {}
    },
  },
  effect: (fn) => {
    const d = fn()
    return typeof d === 'function' ? d : () => {}
  },
  on: () => () => {},
  get: (name) => (name === 'fs' ? fsService : undefined),
}

const applied = mod.apply(ctx)
if (applied && typeof applied.then === 'function') await applied

const call = (name, args) => {
  const tool = registeredTools[name]
  if (!tool) throw new Error('工具未注册: ' + name + '（已注册：' + Object.keys(registeredTools).join(',') + '）')
  return tool.execute(args, { sessionId: 'test' })
}

// 工具的 execute 只 submit 持久化（persist 串在 writeChain 上、不 await），
// 所以断言落盘内容前必须先让写链跑完。
const settle = () => new Promise((resolve) => setImmediate(resolve))
async function callAndSettle(name, args) {
  const r = await call(name, args)
  await settle()
  return r
}
// 写入路径由宿主 fs.resolve('.redteam-assets.json') 决定，不一定等于我们请求的路径；
// 测试只关心「写了哪个文件」，所以取第一个落盘的文件。
const readStore = () => {
  const keys = [...files.keys()]
  if (keys.length === 0) throw new Error('store 尚未落盘（假 fs 里还没有任何文件）')
  return JSON.parse(files.get(keys[keys.length - 1]))
}

console.log('装配：注册工具 ' + Object.keys(registeredTools).join(', '))

// ============================================================
console.log('\n[1] 人工 hosts_on 压过自动 belongs_to（原缺陷现场）')
await callAndSettle('asset_record', { value: 'http://test.example.com/page-1', type: 'url', note: 'A', relay: 'test.example.com', relation: 'hosts_on', evidence: '人工判定' })
await callAndSettle('asset_record', { value: 'http://test.example.com/page-2', type: 'url', note: 'B', relay: 'test.example.com', relation: 'hosts_on', evidence: '人工判定' })

{
  const data = readStore()
  const urls = data.assets.filter((a) => a.type === 'url')
  const dom = data.assets.find((a) => a.type === 'domain')
  ok(urls.length === 2 && !!dom, '样本齐备：2 个 URL + 1 个域名')
  for (const u of urls) {
    const list = edgesBetween(data.edges, u.id, dom.id)
    ok(list.length === 1, String(u.value) + ' ↔ ' + dom.value + ' 只有 1 条边（实际 ' + list.length + '）')
    ok(list.length === 1 && list[0].source === 'manual' && list[0].relation === 'hosts_on', u.value + ' 保留人工 hosts_on 关系')
    ok(list.length === 1 && String(list[0].evidence || '').indexOf('belongs_to') >= 0, u.value + ' 被丢弃的自动关系有留痕')
  }
  ok(data.edges.filter((e) => e.source === 'auto').length === 0, '没有残留的自动重复边')
  // 前提校验：这些 URL 真的会命中 hostMatchesDomain，否则用例是空转的。
  const urlVals = urls.map((u) => u.value).join(', ')
  ok(urls.every((u) => /^https?:\/\//.test(u.value)), 'URL 带 scheme（否则 analyzePool 不会建边）：' + urlVals)
}

// ============================================================
console.log('\n[2] 重复登记同一对资产不新增边')
{
  const before = readStore().edges.length
  await callAndSettle('asset_record', { value: 'http://test.example.com/page-1', type: 'url', relay: 'test.example.com', relation: 'hosts_on', evidence: '再次登记' })
  const after = readStore().edges.length
  ok(before === after, '边数不变（' + before + ' → ' + after + '）')
}

// ============================================================
console.log('\n[3] 人工覆盖自动后，重建关系不会把它退回去')
// 走 RPC「analyze」重建整张图：先清掉所有自动边再重新推断，最容易暴露退回问题。
if (handlers.rpc) {
  const reply = await new Promise((resolve) => {
    // 路由处理器按 async-iterable 读请求体（`for await (const chunk of req)`），
    // 所以这里的假 request 必须真的可迭代，否则 body 为空 -> method 解析失败 -> 404。
    const payloadText = JSON.stringify({ method: 'analyze', args: null })
    const req = {
      method: 'POST',
      async *[Symbol.asyncIterator]() { yield Buffer.from(payloadText) },
    }
    const captured = { statusCode: 0, body: '' }
    const res = {
      setHeader() {},
      set statusCode(v) { captured.statusCode = v },
      get statusCode() { return captured.statusCode },
      end(text) {
        captured.body = text || ''
        resolve(captured)
      },
    }
    handlers.rpc(req, res)
  })
  ok(reply.statusCode === 200, 'RPC analyze 返回 200（实际 ' + reply.statusCode + '）')
  const data = readStore()
  const dom = data.assets.find((a) => a.type === 'domain')
  const urls = data.assets.filter((a) => a.type === 'url')
  for (const u of urls) {
    const list = edgesBetween(data.edges, u.id, dom.id)
    ok(list.length === 1 && list[0].source === 'manual', '重建后 ' + u.value + ' 仍是 1 条人工边')
  }
} else {
  ok(false, '未捕获到 RPC 路由，无法验证重建路径')
}

// ============================================================
console.log('\n[4] 同一对资产上自动关系互不重复')
{
  // ip 既是 URL 的 host，可以同时命中 hosts_on；断言不会两条
  await callAndSettle('asset_record', { value: '10.20.30.40', type: 'ip', note: 'C' })
  await callAndSettle('asset_record', { value: 'http://10.20.30.40/admin', type: 'url', note: 'D' })
  const data = readStore()
  const ip = data.assets.find((a) => a.value === '10.20.30.40')
  const u = data.assets.find((a) => a.value === 'http://10.20.30.40/admin')
  const list = edgesBetween(data.edges, u.id, ip.id)
  ok(list.length === 1, 'URL ↔ IP 只有 1 条边（实际 ' + list.length + '）')
}

// ============================================================
console.log('\n[5] 全局不变量：任何一对资产至多一条边')
{
  const data = readStore()
  const seen = new Map()
  let dup = 0
  for (const e of data.edges) {
    const k = pairOf(e)
    if (seen.has(k)) dup++
    seen.set(k, e)
  }
  ok(dup === 0, '全图 ' + data.edges.length + ' 条边中重复对 = ' + dup)
}

console.log('\n' + (fails.length === 0 ? '✓ 全部通过（' + pass + ' 项）' : '✗ 失败 ' + fails.length + ' 项：\n  - ' + fails.join('\n  - ')))
process.exit(fails.length === 0 ? 0 : 1)
