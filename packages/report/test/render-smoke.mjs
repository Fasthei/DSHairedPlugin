// 红队报告 · Client 半边渲染测试（静态 bundle 形态）
//
// 为什么需要它：发布出去的是 lib/client.js —— 交给 client-modules 的 CJS 工厂，
// 与 src/client.js 的动态形态完全不同。这个包是从资产图谱复制骨架来的，因此继承了
// 一个真实缺陷：垫片里的 RPC 路径被写死成了 /dsh-redteam-asset-graph/rpc。
// 所以这里**把实际请求的 url 钉进断言** —— 只记 method 的话，路径写错成别的插件也测不出来。
//
// 还钉了三件容易悄悄坏掉的事：
//   · 预览用的是宿主渲染的 HTML（iframe.srcdoc 里必须是完整文档），不是前端自己拼的；
//   · 导出按钮真的按格式调 export（docx 尤其不能退化成 md）；
//   · 主操作与破坏性操作分得开 —— 一屏九個按钮那种事不该再发生（生成/保存是主，
//     导出归成一组，删除弱化在右侧）。
//
// 用法: node test/render-smoke.mjs

import fs from 'node:fs'
import path from 'node:path'

const libClient = path.join(import.meta.dirname, '..', 'lib', 'client.js')

let pass = 0
const fails = []
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fails.push(label); console.log('  ✗ ' + label) }
}

// ── 假 React + 最小 hook 运行时 ─────────────────────────────────────────────
function createElement(type, props) {
  const children = Array.prototype.slice.call(arguments, 2)
  return { type, props: Object.assign({}, props || {}, { children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children }) }
}
let current = null
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
  // 依赖数组要真的比对：真实 React 在依赖变化时会重跑效果，桩若只跑一次，
  // 「snapshot 到了之后再加载」这类正确写法会被误判为没生效。
  useEffect(fn, deps) {
    const c = current
    const i = c.cursor++
    const prev = c.effects[i]
    const changed = !prev || deps === undefined || prev.deps === undefined ||
      deps.length !== prev.deps.length || deps.some((d, k) => d !== prev.deps[k])
    if (changed) {
      if (prev && typeof prev.cleanup === 'function') { try { prev.cleanup() } catch (e) {} }
      c.effects[i] = { deps: deps === undefined ? undefined : deps.slice(), cleanup: fn() }
    }
  },
  useMemo(fn) { return fn() },
  useRef(v) { return { current: v } },
  useCallback(fn) { return fn },
}
function makeRenderer(Comp) {
  const c = { states: {}, effects: {}, cursor: 0, dirty: false }
  return {
    run() {
      current = c
      c.cursor = 0
      c.dirty = false
      const tree = Comp({})
      current = null
      return tree
    },
    get dirty() { return c.dirty },
  }
}
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
// 按可见文本找按钮（排掉标签页那种同名按钮）
function button(tree, label, notClass) {
  return findAll(tree, (n) => n.type === 'button' && textOf(n).trim() === label &&
    (!notClass || String(n.props.className || '').indexOf(notClass) < 0))[0]
}
async function settle(render) {
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 0))
    if (!render.dirty) { await new Promise((r) => setTimeout(r, 0)); if (!render.dirty) return }
    render.run()
  }
}

// ── 假宿主 ──────────────────────────────────────────────────────────────────
const urls = []
const calls = []
const argsOf = {}
let timerQueue = []

const MARKDOWN = [
  '# 红队测试报告：推理服务未授权',
  '',
  '## 1. 概述',
  '本次测试针对 192.168.30.250:11434。',
  '',
  '## 3. 已确认的发现',
  '- ATLAS / AML.T0043 未授权访问模型清单',
].join('\n')

function fakeSnapshot() {
  return {
    updatedAt: 1789500000000,
    settings: {
      model: { provider: '', model: '' },
      instruction: '',
      sessionLimit: 8, sessionChars: 5000, maxConfirmed: 40, maxSuspected: 25,
      memoryTopK: 5, memoryQueries: 6, digestMax: 48000, matrixStore: '', exportDir: '',
      maxTokens: 8000, storePath: '.redteam-report.json',
    },
    outline: ['## 1. 概述', '## 2. 测试方法与过程', '## 3. 已确认的发现'],
    model: { provider: 'deepseek', model: 'deepseek-chat', from: 'default' },
    reports: [
      { id: 'r1', title: '红队测试报告：推理服务未授权', chars: MARKDOWN.length, createdAt: 1789500000000, updatedAt: 1789500000000, provider: 'deepseek', model: 'deepseek-chat', evidence: { sessions: 2, matrixConfirmed: 2, matrixSuspected: 1, memoryHits: 1, digestChars: 5200 } },
    ],
    currentId: 'r1',
    current: {
      id: 'r1', title: '红队测试报告：推理服务未授权', markdown: MARKDOWN, updatedAt: 1789500000000,
      meta: { provider: 'deepseek', model: 'deepseek-chat', generatedAt: 1789500000000, evidence: { sessions: 2, matrixConfirmed: 2, matrixSuspected: 1, memoryHits: 1, digestChars: 5200 } },
    },
    status: {
      persistence: 'ready', storePath: '/home/kali/桌面/.redteam-report.json', lastError: null,
      progress: null, generating: false, genChars: 0, lastOp: null,
      evidence: { sessions: 2, matrixConfirmed: 2, matrixSuspected: 1, memoryHits: 1, digestChars: 5200 },
      matrixPath: '/home/kali/项目/DSHairedPlugin/.redteam-attack-matrix.json',
    },
    log: [{ seq: 1, at: 1789500000000, level: 'ok', text: '报告撰写完成：1280 字' }],
  }
}

const evidenceFixture = {
  workspace: { id: 'ws-1', title: '推理服务测试', path: '/ws/proj-one' },
  sessions: [{ id: 'session-a', title: '推理服务测试', users: 1, ops: 3, results: 2, firstAt: 1789500000000, lastAt: 1789500003000 }],
  matrix: { from: 'service', storePath: '/ws/proj-one/.redteam-attack-matrix.json', total: 3, confirmed: 2, suspected: 1, error: null },
  memory: { available: true, count: 1, note: '' },
  queries: ['未授权访问推理服务'],
  digestChars: 5200,
  digest: '# 证据材料（自动采集）\n\n## 一、工作区与会话\n### 会话：推理服务测试',
  truncated: true,
}

globalThis.fetch = async (url, init) => {
  urls.push(url)
  let payload = {}
  try { payload = JSON.parse((init && init.body) || '{}') } catch (e) {}
  const method = payload.method
  calls.push(method)
  argsOf[method] = payload.args
  let result
  if (method === 'snapshot') result = { ok: true, snapshot: fakeSnapshot() }
  else if (method === 'preview') result = { ok: true, html: '<!doctype html><html><head><meta charset="utf-8"><title>' + (payload.args.title || '') + '</title></head><body><h1>' + (payload.args.title || '') + '</h1><table><tr><td>1</td></tr></table></body></html>', chars: String(payload.args.markdown || '').length }
  else if (method === 'export') result = { ok: true, format: payload.args.format, name: '报告-' + payload.args.format + '.' + payload.args.format, bytes: 4096, path: '/home/kali/桌面/报告.' + payload.args.format, writeError: null }
  else if (method === 'importToMemory') result = { ok: true, snapshot: fakeSnapshot(), added: 3, updated: 0, entries: 3, indexed: 0, indexError: '未配置向量模型与 Milvus（本地已存住）', localCount: 9 }
  else if (method === 'collect') result = { ok: true, snapshot: fakeSnapshot(), evidence: evidenceFixture }
  else if (method === 'create') result = { ok: true, id: 'r2', snapshot: fakeSnapshot() }
  else if (method === 'select') result = { ok: true, snapshot: fakeSnapshot() }
  else if (method === 'saveDraft') result = { ok: true, snapshot: fakeSnapshot() }
  else if (method === 'remove') result = { ok: true, deleted: 1, snapshot: fakeSnapshot() }
  else if (method === 'saveSettings') result = { ok: true, snapshot: fakeSnapshot() }
  else if (method === 'generate') result = { ok: true, started: true, reportId: 'r1', snapshot: fakeSnapshot() }
  else result = { ok: true }
  return { ok: true, status: 200, json: async () => ({ ok: true, result }) }
}

// ── 加载 bundle ─────────────────────────────────────────────────────────────
console.log('加载 lib/client.js')
let registration = null
globalThis.window = { __ModuleLoader__: { load: (r) => { registration = r } } }
try {
  new Function('window', 'document', 'fetch', fs.readFileSync(libClient, 'utf8'))(globalThis.window, undefined, globalThis.fetch)
} catch (e) {
  console.log('  ✗ 求值失败: ' + e.constructor.name + ': ' + e.message)
  process.exit(1)
}
ok(registration !== null, 'window.__ModuleLoader__.load 被调用')
ok(registration && registration.id === 'dsh-redteam-report', '注册的模块 id 是包名：' + (registration && registration.id))

console.log('\n[1] 物化模块与插槽注册')
const mod = registration.factory((name) => {
  if (name === 'react') return React
  throw new Error('未知依赖: ' + name)
})
ok(typeof mod.apply === 'function', '导出 apply 是函数')
ok(Array.isArray(mod.inject) && mod.inject.indexOf('slots') >= 0 && mod.inject.indexOf('timer') >= 0, '导出 inject 含 slots 与 timer')

let Panel = null
let Glyph = null
const slots = {
  inject: (name, cb) => { cb(); return () => {} },
  register: (def, Comp) => {
    if (def && def.name === 'main') Panel = Comp
    if (def && def.name === 'sidebar.panellist') Glyph = Comp
    return () => {}
  },
}
const ctx = {
  slots,
  get: (n) => (n === 'slots' ? slots : (n === 'timer' ? { timeout: (fn) => { timerQueue.push(fn); return () => {} } } : undefined)),
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  interval: () => () => {},
}
mod.apply(ctx)
ok(!!Panel, '主面板已注册到 main 插槽')
ok(!!Glyph, '侧栏按钮已注册到 sidebar.panellist')

console.log('\n[2] 顶栏与标签页')
const render = makeRenderer(Panel)
let tree = render.run()
await settle(render)
tree = render.run()
let text = textOf(tree)
ok(text.indexOf('红队报告') >= 0, '标题出现')
ok(text.indexOf('报告 1 份') >= 0, '顶栏显示报告份数')
ok(text.indexOf('证据：会话 2 · 矩阵 2/1 · 记忆 1') >= 0, '顶栏显示证据规模（会话/矩阵/记忆）')
ok(text.indexOf('报告') >= 0 && text.indexOf('证据') >= 0 && text.indexOf('设置') >= 0 && text.indexOf('日志') >= 0, '四个标签页都在')

console.log('\n[3] RPC 打的是本插件自己的路由（钉住 url，不是只记 method）')
ok(urls.length > 0 && urls.every((u) => u === '/dsh-redteam-report/rpc'),
  'RPC 路径正确（实际：' + JSON.stringify(Array.from(new Set(urls))) + '）')
ok(urls.indexOf('/dsh-redteam-asset-graph/rpc') < 0, '没有打到资产图谱的路由（骨架复制带来的缺陷）')

console.log('\n[4] 报告页：列表 / 编辑器 / 预览')
{
  ok(calls.indexOf('snapshot') >= 0, '加载时调了 snapshot')
  const chip = findAll(tree, (n) => typeof n.props.className === 'string' && n.props.className.indexOf('rtr-chip') >= 0 && textOf(n).indexOf('红队测试报告') >= 0)[0]
  ok(!!chip, '报告列表里有当前这份（带标题）')
  ok(!!chip && textOf(chip).indexOf('字 ·') >= 0, '列表项带上字数与时间')
  ok(!!button(tree, '重新生成'), '有「重新生成」（已有正文时）')
  const ta = findAll(tree, (n) => n.type === 'textarea')[0]
  ok(!!ta && String(ta.props.value).indexOf('ATLAS / AML.T0043') >= 0, '编辑框里是报告正文')

  // 预览走宿主：定时器（ctx.get('timer')）里那一步要手动推一下，再 settle
  for (const fn of timerQueue) fn()
  timerQueue = []
  await settle(render)
  tree = render.run()
  const frame = findAll(tree, (n) => n.type === 'iframe')[0]
  ok(!!frame, '有预览 iframe')
  ok(!!frame && String(frame.props.srcDoc).indexOf('<!doctype html>') === 0, '预览内容是完整 HTML 文档（来自宿主渲染）')
  ok(!!frame && String(frame.props.srcDoc).indexOf('<table') >= 0, '预览里表格渲染出来了')
  ok(calls.indexOf('preview') >= 0, '调了 preview RPC')
  ok(!!argsOf.preview && typeof argsOf.preview.markdown === 'string' && argsOf.preview.markdown.indexOf('AML.T0043') >= 0, 'preview 收到的是编辑框里的 markdown')
  ok(!!argsOf.preview && argsOf.preview.title === '红队测试报告：推理服务未授权', 'preview 收到标题')
}

console.log('\n[5] 操作行：主次分开，导出成组')
{
  const tools = findAll(tree, (n) => typeof n.props.className === 'string' && n.props.className === 'rtr-tools')[0]
  ok(!!tools, '有一行操作区')
  const labels = findAll(tools, (n) => n.type === 'button').map((n) => textOf(n).trim())
  ok(labels.indexOf('重新生成') >= 0 && labels.indexOf('保存') >= 0, '主操作是「重新生成」「保存」：' + JSON.stringify(labels))
  ok(labels.indexOf('Markdown') >= 0 && labels.indexOf('HTML') >= 0 && labels.indexOf('Word') >= 0, '导出三种格式成组在：' + JSON.stringify(labels))
  ok(labels.indexOf('导入记忆') >= 0 && labels.indexOf('删除') >= 0, '导入与删除也在（删除是弱化的危险样式）')
  ok(labels.length <= 7, '整个操作行不超过 7 个按钮（原来 9 个平铺）：' + labels.length)
  ok(textOf(tools).indexOf('导出') >= 0, '导出组有「导出」标签')
  const del = button(tree, '删除')
  ok(!!del && String(del.props.className).indexOf('rtr-btn-danger') >= 0, '删除用危险样式（红色文字，不是实心红块）')
  const gen = button(tree, '重新生成')
  ok(!!gen && String(gen.props.className).indexOf('rtr-btn-primary') >= 0, '生成是主按钮')
}

console.log('\n[6] 导出：三种格式各自打到 export')
{
  for (const fmt of ['md', 'html', 'docx']) {
    const expected = fmt === 'docx' ? 'Word' : (fmt === 'md' ? 'Markdown' : 'HTML')
    const b = button(tree, expected)
    ok(!!b, '找到「' + expected + '」按钮')
    if (!b) continue
    delete argsOf.export
    b.props.onClick()
    await settle(render)
    tree = render.run()
    text = textOf(tree)
    ok(argsOf.export && argsOf.export.format === fmt, '点了「' + expected + '」→ export format=' + (argsOf.export && argsOf.export.format))
    ok(text.indexOf('已导出') >= 0 && text.indexOf('/home/kali/桌面/报告.' + fmt) >= 0, '导出后回显落盘路径：' + fmt)
  }
}

console.log('\n[7] 导入记忆')
{
  const b = button(tree, '导入记忆')
  ok(!!b, '找到「导入记忆」按钮')
  if (b) {
    delete argsOf.importToMemory
    b.props.onClick()
    await settle(render)
    tree = render.run()
    text = textOf(tree)
    ok(calls.indexOf('importToMemory') >= 0, '调了 importToMemory')
    ok(!!argsOf.importToMemory && argsOf.importToMemory.id === 'r1', '带上当前报告 id：' + (argsOf.importToMemory && argsOf.importToMemory.id))
    ok(text.indexOf('已导入记忆：新增 3 条') >= 0, '回显导入结果')
  }
}

console.log('\n[8] 保存按钮只在有改动时可用')
{
  const b = findAll(tree, (n) => n.type === 'button' && textOf(n).trim().indexOf('保存') === 0)[0]
  ok(!!b, '找到保存按钮')
  ok(!!b && b.props.disabled === true, '没改动时保存是禁用的')
  const ta = findAll(tree, (n) => n.type === 'textarea')[0]
  ta.props.onChange({ target: { value: '改了一行' } })
  tree = render.run()
  const b2 = findAll(tree, (n) => n.type === 'button' && textOf(n).trim().indexOf('保存') === 0)[0]
  ok(!!b2 && b2.props.disabled !== true, '改动后保存可用')
  ok(textOf(tree).indexOf('未保存') >= 0, '顶栏提示未保存')
  b2.props.onClick()
  await settle(render)
  tree = render.run()
  ok(argsOf.saveDraft && argsOf.saveDraft.markdown === '改了一行', '保存把编辑框内容发回去')
}

console.log('\n[9] 证据页：试算证据（独立成一个 tab）')
{
  const tabBtn = button(tree, '证据', 'rtr-tab') || findAll(tree, (n) => n.type === 'button' && textOf(n).trim() === '证据' && String(n.props.className).indexOf('rtr-tab') >= 0)[0]
  ok(!!tabBtn, '找到「证据」标签页')
  if (tabBtn) {
    tabBtn.props.onClick()
    await settle(render)
    tree = render.run()
    text = textOf(tree)
    ok(text.indexOf('还没试算') >= 0, '未试算时有说明卡')
    const b = button(tree, '试算证据')
    ok(!!b, '找到「试算证据」按钮')
    if (b) {
      b.props.onClick()
      await settle(render)
      tree = render.run()
      text = textOf(tree)
      ok(calls.indexOf('collect') >= 0, '点「试算证据」调了 collect')
      ok(text.indexOf('会话 1') >= 0 && text.indexOf('已确认 2') >= 0 && text.indexOf('疑似 1') >= 0, '统计徽标渲染出来')
      ok(text.indexOf('digest 5200 字') >= 0, 'digest 体量徽标')
      ok(text.indexOf('矩阵来源 service') >= 0, '说明矩阵来源')
      ok(text.indexOf('记忆检索词：未授权访问推理服务') >= 0, '渲染出记忆检索词')
      ok(text.indexOf('推理服务测试') >= 0, '会话采集表里有会话标题')
      const pre = findAll(tree, (n) => n.type === 'pre')[0]
      ok(!!pre && textOf(pre).indexOf('证据材料（自动采集）') >= 0, 'digest 原文渲染出来')
    }
  }
}

console.log('\n[10] 设置页：模型 / 预算 / 路径 / 额外要求')
{
  const tabBtn = findAll(tree, (n) => n.type === 'button' && textOf(n).trim() === '设置' && String(n.props.className).indexOf('rtr-tab') >= 0)[0]
  ok(!!tabBtn, '找到「设置」标签页')
  if (tabBtn) {
    tabBtn.props.onClick()
    await settle(render)
    tree = render.run()
    text = textOf(tree)
    ok(text.indexOf('撰写模型') >= 0, '有撰写模型一组')
    ok(text.indexOf('deepseek/deepseek-chat') >= 0, '提示当前会用的模型（来自当前会话默认）')
    ok(text.indexOf('证据预算') >= 0 && text.indexOf('digest 总上限') >= 0, '有证据预算一组')
    ok(text.indexOf('路径') >= 0 && text.indexOf('报告库文件') >= 0, '有路径一组')
    ok(text.indexOf('额外要求') >= 0, '有额外要求一组')
    ok(text.indexOf('用当前会话默认模型') >= 0, '有「用当前会话默认模型」按钮')
    const matrixInput = findAll(tree, (n) => n.type === 'input' && String(n.props.placeholder || '').indexOf('.redteam-attack-matrix.json') >= 0)[0]
    ok(!!matrixInput, '矩阵存储的默认路径作为 placeholder 提示出来')
    ok(text.indexOf('当前落盘：/home/kali/桌面/.redteam-report.json') >= 0, '显示解析后的落盘路径')
    const saveBtn = button(tree, '保存设置')
    ok(!!saveBtn, '有保存设置按钮')
    if (saveBtn) {
      saveBtn.props.onClick()
      await settle(render)
      ok(calls.indexOf('saveSettings') >= 0, '点「保存设置」调了 saveSettings')
    }
  }
}

console.log('\n[11] 日志页')
{
  const tabBtn = findAll(tree, (n) => n.type === 'button' && textOf(n).trim() === '日志' && String(n.props.className).indexOf('rtr-tab') >= 0)[0]
  ok(!!tabBtn, '找到「日志」标签页')
  if (tabBtn) {
    tabBtn.props.onClick()
    await settle(render)
    tree = render.run()
    text = textOf(tree)
    ok(text.indexOf('报告撰写完成') >= 0, '日志行渲染出来')
    ok(text.indexOf('清空日志') >= 0, '有清空日志按钮')
  }
}

console.log('\n' + (fails.length === 0 ? '✓ 全部通过（' + pass + ' 项）' : '✗ 失败 ' + fails.length + ' 项：\n  - ' + fails.join('\n  - ')))
process.exit(fails.length === 0 ? 0 : 1)
