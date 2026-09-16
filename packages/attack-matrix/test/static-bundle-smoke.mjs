// 攻击矩阵 · Client 半边【常驻包形态】渲染测试
//
// 为什么需要它：发布出去的是 lib/client.js —— 交给 client-modules 的 CJS 工厂
// （window.__ModuleLoader__.load({id, factory})），与 src/client.js 的动态形态完全
// 不同。asset-graph 那次「只测动态形态、静态 bundle 从未验证」的教训说明这一环
// 必须单独测。
//
// 这里带一个最小 hook 运行时：useState/useEffect 真的能驱动重渲染，所以面板的
// host.call 链路（加载 -> 渲染 -> 扫描 -> 再渲染）是真的跑过一遍，不是只看它没抛错。
//
// 用法: node test/static-bundle-smoke.mjs

import fs from 'node:fs'
import path from 'node:path'

const libClient = path.join(import.meta.dirname, '..', 'lib', 'client.js')

let pass = 0
const fails = []
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fails.push(label); console.log('  ✗ ' + label) }
}

// ── 假 React ────────────────────────────────────────────────────────────────
function createElement(type, props, ...children) {
  return {
    type,
    props: { ...(props || {}), children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children },
  }
}

// 最小 hook 运行时。current 指向正在渲染的组件槽位。
let current = null
let rerender = () => {}
const React = {
  createElement,
  Fragment: 'Fragment',
  useState(init) {
    const c = current
    const i = c.cursor++
    if (!(i in c.states)) c.states[i] = typeof init === 'function' ? init() : init
    const set = (v) => {
      const next = typeof v === 'function' ? v(c.states[i]) : v
      if (next !== c.states[i]) { c.states[i] = next; c.dirty = true }
    }
    return [c.states[i], set]
  },
  useEffect(fn) {
    const c = current
    const i = c.cursor++
    if (!c.effects[i]) { c.effects[i] = true; fn() }
  },
  useMemo(fn) { return fn() },
  useRef(v) { return { current: v } },
  useCallback(fn) { return fn },
}

function makeRenderer(Comp) {
  const c = { states: {}, effects: {}, cursor: 0, dirty: false }
  function run() {
    c.cursor = 0
    c.dirty = false
    current = c
    const out = Comp()
    current = null
    return out
  }
  return { run, ctx: c }
}

// 把 promise 链推到底，让 useEffect 里的 host.call 落定并触发重渲染。
async function settle(render, times) {
  for (let i = 0; i < (times || 8); i++) {
    await new Promise((r) => setImmediate(r))
    if (render.ctx.dirty) render.run()
  }
}

// ── 假 window / fetch ───────────────────────────────────────────────────────
let registration = null
globalThis.window = { __ModuleLoader__: { load: (def) => { registration = def } } }

function fakeView(opts) {
  const o = opts || {}
  return {
    workspaceId: 'w1',
    workspacePath: '/ws/proj-one',
    updatedAt: 1,
    lastScanAt: o.scanned ? 1700000000000 : 0,
    lastError: null,
    sessions: o.scanned ? 3 : 0,
    frameworks: [
      {
        id: 'owasp-llm', name: 'OWASP Top 10 for LLM Applications 2025', short: 'OWASP LLM', source: 'src',
        tactics: [], total: 10, suspected: 1, confirmed: o.confirmed ? 1 : 0, operations: o.scanned ? 4 : 0,
        entries: [
          { id: 'LLM01', name: 'Prompt Injection', tactics: [], confirmed: !!o.confirmed, sessions: 1, occurrences: 4, confirmedOps: o.confirmed ? 4 : 0, firstAt: 1, lastAt: 1700000000000 },
          { id: 'LLM02', name: 'Sensitive Information Disclosure', tactics: [], confirmed: false, sessions: 0, occurrences: 0, confirmedOps: 0, firstAt: 0, lastAt: 0 },
        ],
      },
      {
        id: 'nvidia-kill-chain', name: 'NVIDIA AI Kill Chain', short: 'NVIDIA Kill Chain', source: 'src',
        tactics: [
          { id: 'recon', name: 'recon', description: 'x' },
          { id: 'poison', name: 'poison', description: 'y' },
        ],
        total: 30, suspected: 0, confirmed: 0, operations: 0,
        entries: [
          { id: 'nv-recon-route-mapping', name: '数据流路径测绘', tactics: ['recon'], confirmed: false, sessions: 0, occurrences: 0, confirmedOps: 0, firstAt: 0, lastAt: 0 },
          { id: 'nv-poison-direct-prompt-injection', name: '直接提示词注入', tactics: ['poison'], confirmed: false, sessions: 0, occurrences: 0, confirmedOps: 0, firstAt: 0, lastAt: 0 },
        ],
      },
      { id: 'atlas', name: 'MITRE ATLAS', short: 'ATLAS', source: 'src', tactics: [], total: 0, suspected: 0, confirmed: 0, operations: 0, entries: [] },
      {
        // ATT&CK 那次黑板事故的复现夹具：有阶段、有技术点，
        // 而且其中一条的 tactic_ids 故意对不上 —— 它必须落进「未归类」而不是消失。
        id: 'attack-enterprise', name: 'MITRE ATT&CK Enterprise', short: 'ATT&CK', source: 'src',
        tactics: [{ id: 'TA0043', name: 'Reconnaissance', description: 'x' }],
        total: 2, suspected: 1, confirmed: 0, operations: 4,
        entries: [
          { id: 'T1595', name: '主动扫描', tactics: ['TA0043'], confirmed: false, sessions: 1, occurrences: 4, confirmedOps: 0, firstAt: 0, lastAt: 0 },
          { id: 'T9999', name: '阶段 id 写错的技术点', tactics: ['bogus-slug'], confirmed: false, sessions: 1, occurrences: 1, confirmedOps: 0, firstAt: 0, lastAt: 0 },
        ],
      },
    ],
    timeline: o.scanned ? [{ frameworkId: 'owasp-llm', techniqueId: 'LLM01', techniqueName: 'Prompt Injection', at: 1700000240000, firstAt: 1700000000000, lastAt: 1700000240000, sessionId: 'session-a', sessionTitle: 'AI 站点注入测试', pieces: 4, confidence: o.confirmed ? 'confirmed' : 'suspected', targets: ['https://target.example.com/api/chat', '192.168.30.250', '端口 8002,8003,8004'], matched: ['prompt injection'] }] : [],
    timelineTotal: o.scanned ? 1 : 0,
    ignored: o.ignored || [],
  }
}

let state = { scanned: false, confirmed: false, ignored: [] }
let calls = []
// 记录 url：客户端必须打本插件自己的路由。只记 method 的话，路径写错成别的
// 插件（v1.0.0 的实际事故：写死成了 asset-graph 的路径）也测不出来。
const urls = []
globalThis.fetch = async (url, init) => {
  urls.push(url)
  let payload = {}
  try { payload = JSON.parse((init && init.body) || '{}') } catch (e) {}
  calls.push(payload.method)
  const method = payload.method
  let result
  if (method === 'snapshot') {
    result = {
      ok: true,
      workspaces: [{ id: 'w1', path: '/ws/proj-one', title: 'proj-one', sessionCount: 3 }],
      current: { id: 'w1', path: '/ws/proj-one', title: 'proj-one', sessionCount: 3 },
      view: fakeView(state),
    }
  } else if (method === 'scan') {
    state.scanned = true
    result = { ok: true, stats: { sessions: 3, scannedSessions: 3, newMatches: 4 }, current: { id: 'w1', path: '/ws/proj-one', title: 'proj-one' }, view: fakeView(state) }
  } else if (method === 'confirm') {
    state.confirmed = true
    result = { ok: true, changed: 1, view: fakeView(state) }
  } else if (method === 'clear') {
    state.scanned = false
    state.confirmed = false
    result = { ok: true, cleared: 4, view: fakeView(state) }
  } else if (method === 'exportCsv') {
    result = { ok: true, filename: 'attack-matrix-w1-2026.csv', rows: 7, content: '\ufefffirstAt,lastAt,targets\r\n1700000000000,1700000240000,192.168.30.250\r\n' }
  } else if (method === 'ignoreSession') {
    if (payload.args && payload.args.all) state.ignored = []
    else if (payload.args && payload.args.off) state.ignored = state.ignored.filter((x) => x !== payload.args.sessionId)
    else if (state.ignored.indexOf(payload.args.sessionId) < 0) state.ignored = state.ignored.concat([payload.args.sessionId])
    result = { ok: true, removed: 3, ignored: state.ignored, view: fakeView(state) }
  } else if (method === 'technique') {
    result = {
      ok: true,
      framework: { id: 'owasp-llm', name: 'OWASP LLM' },
      technique: { id: 'LLM01', name: 'Prompt Injection', description: '测试用描述', tactic_ids: [], detect_hints: '测试用线索', detect_keywords: ['prompt injection', '越狱'] },
      tactics: [],
      operations: [{ sessionId: 'session-a', sessionTitle: 'AI 站点注入测试', confidence: state.confirmed ? 'confirmed' : 'suspected', occurrences: 4, firstAt: 1700000000000, lastAt: 1700000240000, matched: ['prompt injection'], targets: ['https://target.example.com/api/chat', '192.168.30.250', '端口 8002,8003,8004'], snippets: [{ at: 1700000000000, seq: 1, kind: 'user', label: '用户消息', text: '试试 prompt injection' }], decidedBy: 'model', reason: '测试用判定依据' }],
    }
  } else {
    return { ok: true, status: 200, json: async () => ({ ok: false, error: 'unknown method ' + method }) }
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, result }) }
}

// 把渲染树压成纯文本，便于断言屏幕上真的出现了什么。
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (node.props) return textOf(node.props.children)
  return ''
}
function findAll(node, pred, out) {
  const acc = out || []
  if (!node || typeof node !== 'object') return acc
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, acc); return acc }
  if (pred(node)) acc.push(node)
  findAll(node.props && node.props.children, pred, acc)
  return acc
}

// ════════════════════════════════════════════════════════════════════════════
console.log('加载 lib/client.js')
try {
  new Function('window', 'document', 'fetch', fs.readFileSync(libClient, 'utf8'))(globalThis.window, undefined, globalThis.fetch)
} catch (e) {
  console.log('  ✗ 求值失败: ' + e.constructor.name + ': ' + e.message)
  process.exit(1)
}
ok(registration !== null, 'window.__ModuleLoader__.load 被调用')
ok(registration && typeof registration.factory === 'function', '工厂是函数')
if (!registration) process.exit(1)

console.log('\n[1] 物化模块')
let mod
try {
  mod = registration.factory((name) => {
    if (name === 'react') return React
    throw new Error('未知依赖: ' + name)
  })
} catch (e) {
  ok(false, '工厂执行失败: ' + e.constructor.name + ': ' + e.message)
  process.exit(1)
}
ok(typeof mod.apply === 'function', '导出 apply 是函数')
ok(Array.isArray(mod.inject) && mod.inject.indexOf('slots') >= 0, '导出 inject 含 slots：' + JSON.stringify(mod.inject))

console.log('\n[2] apply 注册插槽')
let Main = null
let Glyph = null
const slots = {
  inject: (name, cb) => { cb(); return () => {} },
  register: (def, Comp) => {
    if (def && def.name === 'main') Main = Comp
    if (def && def.name === 'sidebar.panellist') Glyph = Comp
    return () => {}
  },
}
const ctx = {
  slots,
  get: (n) => (n === 'slots' ? slots : undefined),
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  interval: () => () => {},
  timeout: () => () => {},
}
try { mod.apply(ctx) } catch (e) { ok(false, 'apply 抛错: ' + e.constructor.name + ': ' + e.message) }
ok(Main !== null, '注册了 main 面板')
ok(Glyph !== null, '注册了侧边栏图标')
if (Glyph) {
  const g = Glyph({ size: 16, active: true })
  ok(!!g && g.type === 'svg', '图标渲染出 svg')
}

console.log('\n[3] 首屏：加载工作区与框架标签页')
const render = makeRenderer(Main)
let tree = render.run()
await settle(render)
ok(calls.indexOf('snapshot') >= 0, '首屏调用了 snapshot')
ok(urls.length > 0 && urls.every((u) => u === '/dsh-redteam-attack-matrix/rpc'),
  'RPC 打的是本插件自己的路由（实际：' + JSON.stringify(Array.from(new Set(urls))) + '）')
tree = render.run()
let text = textOf(tree)
ok(text.indexOf('攻击矩阵') >= 0, '标题出现')
ok(text.indexOf('proj-one') >= 0, '工作区下拉里有 proj-one')
ok(text.indexOf('OWASP LLM') >= 0, '框架标签页出现 OWASP LLM')
ok(text.indexOf('NVIDIA Kill Chain') >= 0, '框架标签页出现 NVIDIA Kill Chain')
ok(text.indexOf('ATLAS') >= 0, '框架标签页出现 ATLAS')
ok(text.indexOf('Prompt Injection') >= 0, '技术卡片出现 Prompt Injection')
ok(text.indexOf('未覆盖') >= 0, '未命中的卡片显示「未覆盖」')
ok(text.indexOf('还没有记录') >= 0, '未扫描时时间线提示为空')

console.log('\n[3.5] 按 tactic 分组：有阶段的框架分节显示')
{
  // 切到 NVIDIA（有 tactics），确认渲染出分组标题而不是平铺
  const tabs = findAll(tree, (n) => n.type === 'button' && typeof n.props.className === 'string' && (n.props.className === 'rtm-tab' || n.props.className === 'rtm-tab rtm-tab-on'))
  const nvTab = tabs.filter((b) => textOf(b).indexOf('NVIDIA') >= 0)[0]
  ok(!!nvTab, '找到 NVIDIA 标签页')
  if (nvTab) {
    nvTab.props.onClick()
    tree = render.run()
    let t2 = textOf(tree)
    const groups = findAll(tree, (n) => typeof n.props.className === 'string' && n.props.className === 'rtm-group')
    ok(groups.length === 2, 'NVIDIA 渲染出 2 个 tactic 分组（实际 ' + groups.length + '）')
    ok(t2.indexOf('recon') >= 0 && t2.indexOf('poison') >= 0, '分组标题出现 recon / poison')
    ok(t2.indexOf('数据流路径测绘') >= 0, 'recon 组下有对应技术点')

    const owTab = tabs.filter((b) => textOf(b).indexOf('OWASP') >= 0)[0]
    if (owTab) {
      owTab.props.onClick()
      tree = render.run()
      const groups2 = findAll(tree, (n) => typeof n.props.className === 'string' && n.props.className === 'rtm-group')
      ok(groups2.length === 0, 'OWASP（无阶段）不平铺分组，直接展示卡片（实际分组 ' + groups2.length + '）')
    }
  }
}

console.log('\n[4] 顶栏：扫描按钮已移除，只剩「重扫」作为修复入口')
const buttons = findAll(tree, (n) => n.type === 'button')
ok(!buttons.some((b) => textOf(b).indexOf('扫描对话') >= 0),
  '顶栏没有「扫描对话」按钮（扫描改为 host 自动跑）')
const rescanBtn = buttons.filter((b) => textOf(b).indexOf('重扫') >= 0)[0]
ok(!!rescanBtn, '找到「重扫」按钮')
if (rescanBtn) {
  rescanBtn.props.onClick()
  await settle(render)
  ok(calls.indexOf('scan') >= 0, '点击后调用了 scan')
  tree = render.run()
  text = textOf(tree)
  ok(text.indexOf('疑似 4') >= 0, '卡片出现疑似徽标（疑似 4）')
  ok(text.indexOf('对本组织发起测试的时间线') >= 0, '时间线区块出现')
  ok(text.indexOf('AI 站点注入测试') >= 0, '时间线里出现会话标题')
}

console.log('\n[4.5] 时间描述：精确到秒、给出区间、标出时区')
{
  // 回归防线：旧版只显示 MM-DD HH:mm 且只发 lastAt，一条横跨 27.5 小时的命中
  // 会被压成一个时刻。这里断言区间、秒、时长、时区四样都在。
  ok(/\d{2}:\d{2}:\d{2}/.test(text), '时间精确到秒')
  ok(text.indexOf('→') >= 0, '时间线显示的是区间（first → last）而不是单个时刻')
  ok(text.indexOf('4 分钟') >= 0, '区间带上可读时长')
  ok(text.indexOf('本地时区 UTC') >= 0, '标明本地时区')
  ok(text.indexOf('个 框架×技术×会话 分组') >= 0, '「条」的口径写清楚是分组数而不是操作数')
  // 状态改成了徽标（已确认 / 疑似）：原来那行写的是「待判定」，而「待判定」是队列状态、
  // 不是置信度，两者混在一起会让人以为没判过。
  const pills = findAll(tree, (n) => typeof n.props.className === 'string' && n.props.className.indexOf('rtm-pill') === 0)
  ok(pills.length > 0, '时间线每行有状态徽标（已确认 / 疑似）（' + pills.length + ' 个）')
  ok(text.indexOf('ATT&CK') >= 0 || text.indexOf('OWASP LLM') >= 0, '框架显示的是短名而不是 id')
  ok(text.indexOf('重扫') >= 0 && text.indexOf('自动扫描') >= 0, '顶栏状态显示自动扫描心跳')
}

console.log('\n[5] 打开卡片：详情与攻击操作日志')
const cards = findAll(tree, (n) => typeof n.props.className === 'string' && n.props.className.indexOf('rtm-card') === 0)
ok(cards.length >= 3, '渲染出 ' + cards.length + ' 张技术卡片')
const card = cards.filter((c) => textOf(c).indexOf('LLM01') >= 0)[0]
ok(!!card, '找到 LLM01 卡片')
if (card) {
  card.props.onClick()
  await settle(render)
  ok(calls.indexOf('technique') >= 0, '点击卡片调用了 technique')
  tree = render.run()
  text = textOf(tree)
  ok(text.indexOf('攻击操作日志') >= 0, '详情里出现「攻击操作日志」')
  ok(text.indexOf('测试用线索') >= 0, '详情里出现判定线索')
  ok(text.indexOf('试试 prompt injection') >= 0, '详情里出现证据片段')
  ok(text.indexOf('确认覆盖') >= 0, '详情里有「确认覆盖」按钮')
  ok(text.indexOf('排除') >= 0, '详情里有「排除」按钮')

  console.log('\n[6] 确认覆盖：覆盖率随之变化')
  const btn2 = findAll(tree, (n) => n.type === 'button').filter((b) => textOf(b).indexOf('确认覆盖') >= 0)[0]
  ok(!!btn2, '找到「确认覆盖」按钮')
  if (btn2) {
    btn2.props.onClick()
    await settle(render)
    ok(calls.indexOf('confirm') >= 0, '点击后调用了 confirm')
    tree = render.run()
    text = textOf(tree)
    ok(text.indexOf('已确认 1') >= 0, '覆盖率显示已确认 1（' + '已确认 1' + '）')
    ok(text.indexOf('已确认') >= 0, '卡片/详情反映已确认状态')
  }
}

console.log('\n[7] 清除：破坏性动作必须二次确认')
{
  const btnOf = (label) => findAll(tree, (n) => n.type === 'button').filter((b) => textOf(b).trim() === label)[0]
  const b1 = btnOf('清除')
  ok(!!b1, '找到「清除」按钮')
  if (b1) {
    // 第一次点击只上膛，不能真的清 —— 矩阵数据没有垃圾箱，误点就没了
    b1.props.onClick()
    await settle(render)
    ok(calls.indexOf('clear') < 0, '第一次点击不执行清除（只是上膛）')
    tree = render.run()
    text = textOf(tree)
    ok(text.indexOf('确认清除') >= 0, '按钮变成「确认清除」')
    ok(text.indexOf('再点一次执行清除') >= 0, '给出了后果说明')

    const b2 = findAll(tree, (n) => n.type === 'button').filter((x) => textOf(x).indexOf('确认清除') >= 0)[0]
    ok(!!b2, '找到「确认清除」按钮')
    if (b2) {
      b2.props.onClick()
      await settle(render)
      ok(calls.indexOf('clear') >= 0, '第二次点击才调用 clear')
      tree = render.run()
      text = textOf(tree)
      ok(text.indexOf('已清除 4 条命中记录') >= 0, '提示里说明了清掉多少条')
      ok(text.indexOf('扫描续点保留') >= 0, '提示里说清了与「重扫」的区别')
      // 清除后矩阵回到未扫描状态，且「重扫」仍在（它是找回历史的唯一入口）
      ok(text.indexOf('还没有记录') >= 0, '清除后回到空矩阵状态')
      ok(!!findAll(tree, (n) => n.type === 'button').filter((x) => textOf(x).indexOf('重扫') >= 0)[0],
        '「重扫」仍在 —— 它是把历史找回来的入口')
    }
  }
}

console.log('\n[8] 目标与 CSV：时间线要能看出打的是谁，并能整份导出')
{
  // 上一节的「清除」把夹具清空了，这里先重扫把数据找回来
  const rs = findAll(tree, (n) => n.type === 'button').filter((b) => textOf(b).indexOf('重扫') >= 0)[0]
  if (rs) { rs.props.onClick(); await settle(render) }
  tree = render.run()
  text = textOf(tree)

  // 时间线每行要有具体目标（IP / 端口 / URL），光有技术点 ID 回溯时没用
  ok(text.indexOf('192.168.30.250') >= 0, '时间线显示具体 IP')
  ok(text.indexOf('端口 8002,8003,8004') >= 0, '时间线显示具体端口')
  ok(text.indexOf('target.example.com') >= 0, '时间线显示主机名')

  const expBtn = findAll(tree, (n) => n.type === 'button').filter((b) => textOf(b).indexOf('导出 CSV') >= 0)[0]
  ok(!!expBtn, '找到「导出 CSV」按钮')
  if (expBtn) {
    expBtn.props.onClick()
    await settle(render)
    ok(calls.indexOf('exportCsv') >= 0, '点击后调用了 exportCsv')
    tree = render.run()
    text = textOf(tree)
    const a = findAll(tree, (n) => n.type === 'a' && n.props && n.props.download)[0]
    ok(!!a, '渲染出带 download 的下载链接')
    if (a) {
      ok(a.props.download === 'attack-matrix-w1-2026.csv', 'download 文件名来自 host：' + a.props.download)
      ok(String(a.props.href).indexOf('data:text/csv') === 0, 'href 是 text/csv 的 data URI')
      ok(decodeURIComponent(String(a.props.href).replace(/^data:text\/csv;charset=utf-8,/, '')).charCodeAt(0) === 0xfeff,
        'CSV 原文首字符是 BOM（中文不乱码）')
    }
    ok(text.indexOf('（7 行）') >= 0, '提示了导出行数，说明导出的是全部')
  }
}

console.log('\n[9] 忽略会话：整个非目标对话一键关掉，且可恢复')
{
  const card2 = findAll(tree, (n) => typeof n.props.className === 'string' && n.props.className.indexOf('rtm-card') === 0 && textOf(n).indexOf('LLM01') >= 0)[0]
  ok(!!card2, '找到 LLM01 卡片')
  if (card2) {
    card2.props.onClick()
    await settle(render)
    tree = render.run()
    const igBtn = findAll(tree, (n) => n.type === 'button').filter((b) => textOf(b).indexOf('忽略该会话') >= 0)[0]
    ok(!!igBtn, '详情里有「忽略该会话」按钮')
    if (igBtn) {
      igBtn.props.onClick()
      await settle(render)
      ok(calls.indexOf('ignoreSession') >= 0, '点击后调用了 ignoreSession')
      tree = render.run()
      text = textOf(tree)
      ok(text.indexOf('已忽略 1 个会话') >= 0, '顶栏显示已忽略数量')
      const rsBtn = findAll(tree, (n) => n.type === 'button').filter((b) => textOf(b).trim() === '恢复')[0]
      ok(!!rsBtn, '顶栏有「恢复」按钮')
      if (rsBtn) {
        rsBtn.props.onClick()
        await settle(render)
        tree = render.run()
        text = textOf(tree)
        ok(calls.filter((c) => c === 'ignoreSession').length >= 2, '恢复也走 ignoreSession（all:true）')
        ok(text.indexOf('已忽略') < 0, '恢复后不再显示已忽略')
      }
    }
  }
}

console.log('\n[10] ATT&CK 标签页：阶段 id 对不上时不能渲染成一块黑板')
{
  const tab = findAll(tree, (n) => n.type === 'button' && typeof n.props.className === 'string' && n.props.className.indexOf('rtm-tab') === 0 && textOf(n).indexOf('ATT&CK') >= 0)[0]
  ok(!!tab, '找到 ATT&CK 标签页')
  if (tab) {
    tab.props.onClick()
    await settle(render)
    tree = render.run()
    text = textOf(tree)
    ok(text.indexOf('T1595') >= 0, 'ATT&CK 页渲染出了卡片')
    ok(text.indexOf('Reconnaissance') >= 0, '渲染出了阶段分组标题')
    ok(text.indexOf('未归类') >= 0 && text.indexOf('T9999') >= 0,
      '阶段 id 对不上的技术点落进「未归类」，没有凭空消失')
  }
}

console.log('\n[11] 「已确认」必须是红色：它是战果，不是好消息')
{
  const css = fs.readFileSync(libClient, 'utf8')
  const has = (sel, token) => new RegExp(sel + '\\{[^}]*' + token).test(css)
  ok(has('\\.rtm-confirmed', 'state-error-primary'), '已确认卡片用红色令牌')
  ok(has('\\.rtm-pill-conf', 'state-error-primary'), '时间线的「已确认」徽标用红色')
  ok(has('\\.rtm-tl-conf \\.rtm-tl-dot', 'state-error-primary'), '已确认那行的圆点用红色')
  ok(has('\\.rtm-badge-ok', 'state-error-primary'), '卡片徽标用红色')
  ok(has('\\.rtm-cov-fill', 'state-error-primary'), '覆盖率条里已确认的部分用红色')
  // 反面：这几个选择器不能再落回绿色（绿会读成「好」，语义是反的）
  const stillGreen = ['\\.rtm-confirmed', '\\.rtm-pill-conf', '\\.rtm-badge-ok', '\\.rtm-cov-fill', '\\.rtm-op-ok']
    .filter((sel) => has(sel, 'state-success-primary'))
  ok(stillGreen.length === 0, '已确认相关样式不再用绿色' + (stillGreen.length ? '（' + stillGreen.join(',') + '）' : ''))
}

console.log('\n' + (fails.length === 0 ? '✓ 全部通过（' + pass + ' 项）' : '✗ 失败 ' + fails.length + ' 项：\n  - ' + fails.join('\n  - ')))
process.exit(fails.length === 0 ? 0 : 1)
