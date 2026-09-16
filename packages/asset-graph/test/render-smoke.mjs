// Client 半边渲染冒烟测试
//
// 为什么需要它：Client 半边只经过 node --check 是**不够**的 —— 语法完全合法
// 的代码仍可能在运行期崩溃。真实案例：assocInfo 是函数声明（会提升），
// 在它依赖的 const EV_PLACEHOLDER 初始化之前就被调用，于是抛
// "Cannot access 'EV_PLACEHOLDER' before initialization"（TDZ）。
// 这类错误只在「选中一个带边的资产」时触发，恰好绕过了所有静态检查。
//
// 用法: node test/render-smoke.mjs [src/client.js]
// 若 ~/.redteam-assets.json 存在则用真实数据（挑一个带边的资产作为选中项），
// 否则用内置小样本。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const target = process.argv[2] || path.join(import.meta.dirname, '..', 'src', 'client.js')
const storePath = path.join(os.homedir(), '.redteam-assets.json')

const FIXTURE = {
  projects: [{ id: 'p1', name: 'demo', path: '/tmp/demo' }],
  assets: [
    { id: 'a1', projectId: 'p1', type: 'url', value: 'https://docs.example.com/overview', sources: ['model'], tags: ['文档站'], confidence: 80, hits: 1, createdAt: 1, note: '【收录依据】目标文档站的概览页。' },
    { id: 'a2', projectId: 'p1', type: 'domain', value: 'docs.example.com', sources: ['model', 'relay'], tags: ['同主体'], confidence: 85, hits: 2, createdAt: 2, note: '【收录依据·同主体】example.com 的子域。' }
  ],
  edges: [{ id: 'e1', from: 'a1', to: 'a2', relation: 'belongs_to', weight: 3, source: 'auto', evidence: 'docs.example.com', createdAt: 3 }],
  trash: [], log: []
}

let store = FIXTURE
let used = '内置样本'
try {
  if (fs.existsSync(storePath)) { store = JSON.parse(fs.readFileSync(storePath, 'utf8')); used = storePath }
} catch (e) { /* 退回内置样本 */ }

const edgesOf = (id) => (store.edges || []).filter((e) => e.from === id || e.to === id)
const pick = (store.assets || []).find((a) => edgesOf(a.id).length > 0)
if (!pick) { console.error('没有带边的资产可供测试'); process.exit(2) }

const snapshot = {
  updatedAt: Date.now(),
  projects: store.projects || [],
  activeProjectId: (store.projects?.[0]?.id) || '',
  activeWorkspacePath: '',
  assets: store.assets || [],
  edges: store.edges || [],
  trash: (store.trash || []).slice(-50),
  trashTotal: (store.trash || []).length,
  log: (store.log || []).slice(-50),
  live: null,
  toolCatalog: [],
  jinaUrl: 'https://mcp.jina.ai/v1',
  jinaReady: true,
  settings: { jinaKey: 'jina_test', jinaTools: [], autoModel: true, autoCapture: true, followWorkspace: true, storePath: '.redteam-assets.json' },
  candidates: { pending: 0, total: 0 },
  meta: { storePathAbs: storePath, persistence: 'ready', lastError: null, lastSavedAt: 0, enriching: false, progress: null, run: { state: 'idle', text: '', startedAt: 0, endedAt: 0 } },
  stats: { typeCounts: {}, autoEdges: 0 }
}

let useIdx = 0
const noop = () => {}
const React = {
  useState: (init) => {
    const i = useIdx++
    if (i === 0) return [snapshot, noop]   // state
    if (i === 4) return [pick.id, noop]    // selected —— 让 assocInfo 真正跑循环
    return [init, noop]
  },
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useEffect: () => {},
  createElement: (type, props, ...children) => ({ type, props, children })
}
const host = { call: () => Promise.resolve(snapshot) }
const styles = { insert: () => noop }
let Main = null
const slots = {
  inject: (name, cb) => { cb(); return noop },
  register: (def, Comp) => { if (def?.name === 'main') Main = Comp; return noop }
}
const ctx = { slots, get: () => undefined, effect: (fn) => (typeof fn() === 'function' ? noop : noop), interval: () => noop }

let plugin
try {
  plugin = new Function('React', 'host', 'styles', 'ctx', fs.readFileSync(target, 'utf8'))(React, host, styles, ctx)
} catch (e) { console.error('求值失败:', e.message); process.exit(1) }

try { plugin.apply(ctx) } catch (e) { console.error('apply 失败:', e.constructor.name + ': ' + e.message); process.exit(1) }
if (!Main) { console.error('未注册 main 面板'); process.exit(1) }

try {
  const el = Main()
  if (!el || !el.type) { console.error('渲染结果为空'); process.exit(1) }
  console.log('✓ 渲染通过（数据源: %s；选中 %s，%d 条边）', used, pick.value, edgesOf(pick.id).length)
} catch (e) {
  console.error('✗ 渲染崩溃:', e.constructor.name + ': ' + e.message)
  process.exit(1)
}
