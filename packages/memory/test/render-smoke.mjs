// 红队记忆 · Client 半边渲染测试（静态 bundle 形态）
//
// 为什么需要它：发布出去的是 lib/client.js —— 交给 client-modules 的 CJS 工厂，
// 与 src/client.js 的动态形态完全不同。这个包是从资产图谱复制骨架来的，因此继承了
// 一个真实缺陷：垫片里的 RPC 路径被写死成了 /dsh-redteam-asset-graph/rpc。
// 所以这里**把实际请求的 url 钉进断言** —— 只记 method 的话，路径写错成别的插件也测不出来。
//
// 这个包有两个界面，都要测：
//   · 红队记忆（main 面板）：知识库 / 检索 / 日志 —— 只用不管配
//   · 红队设置（settings.section 页）：Milvus / 向量模型 / 重排 / S3 / 本地库 —— 只配不管用
// 配置从数据面板搬走这件事很容易「搬一半」：注册了设置页但面板还留着旧 tab，或者反过来。
// 所以两边都断言。
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
  // 「snapshot 到了之后再加载列表」这类正确写法会被误判为没生效。
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

function fakeSnapshot() {
  return {
    updatedAt: 1700000000000,
    settings: {
      milvus: { uri: 'http://127.0.0.1:19530', token: '', dbName: 'default', collection: 'redteam_memory', metric: 'COSINE' },
      embed: { provider: 'dashscope', model: 'tongyi-embedding-vision-flash', apiKey: 'sk-x', dimension: 1024, baseUrl: '' },
      rerank: { enabled: true, provider: 'jina', model: 'jina-reranker-v2-base-multilingual', apiKey: 'j', baseUrl: '', topN: 8 },
      s3: { enabled: true, endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', bucket: 'mimo', prefix: '', accessKey: 'AK', secretKey: 'SK', pathStyle: true },
      capture: { enabled: true, phrases: '写入记忆,记到记忆', kind: 'note', withContext: true },
      storePath: '.redteam-memory.json', searchTopK: 8,
    },
    embedPresets: [
      { id: 'dashscope', label: '阿里百炼 DashScope', base: 'https://dashscope.aliyuncs.com', keyHint: '', models: [{ id: 'tongyi-embedding-vision-flash', dimension: 1024 }] },
      { id: 'bigmodel', label: '智谱 BigModel', base: 'https://open.bigmodel.cn', keyHint: '', models: [{ id: 'embedding-3', dimension: 2048 }] },
      { id: 'openai', label: 'OpenAI 兼容', base: '', keyHint: '', models: [{ id: 'bge-m3', dimension: 1024 }] },
    ],
    rerankPresets: [
      { id: 'jina', label: 'Jina Reranker', base: 'https://api.jina.ai', models: ['jina-reranker-v2-base-multilingual'] },
      { id: 'cohere', label: 'Cohere Rerank', base: 'https://api.cohere.com', models: ['rerank-v3.5'] },
    ],
    kinds: ['knowledge', 'technique', 'payload', 'checklist', 'note'],
    importLabel: 'pdf / word(.docx) / md / txt',
    importExt: ['.md', '.markdown', '.txt', '.docx', '.pdf'],
    status: {
      collection: 'redteam_memory', collectionReady: true, dimension: 1024, rowCount: 16,
      localCount: 18, indexed: 16, pending: 2, embedReady: true, milvusReady: true,
      seeded: false, persistence: 'ready', storePath: '/home/kali/桌面/.redteam-memory.json',
      lastError: null, progress: null, lastOp: null,
    },
    captures: [
      { at: 1700000002000, session: 'session-abc', title: '红队测试', phrase: '写入记忆', entryId: 'm9', text: '10.0.0.5:8000 未授权可列模型', indexed: false, error: '未配置向量模型与 Milvus（本地已存住）' },
    ],
    capturePhrases: ['写入记忆', '记到记忆'],
    log: [{ seq: 1, at: 1700000000000, level: 'ok', text: '向量模型连通：tongyi-embedding-vision-flash，维度 1024' }],
  }
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
  else if (method === 'listKnowledge') {
    result = { ok: true, total: 2, limit: 30, offset: 0, local: 18, entries: [
      { id: 'm1', title: 'OWASP LLM01 提示词注入', kind: 'knowledge', tags: 'owasp,注入', source: 'builtin', created_at: 1700000000000, updated_at: 1700000000000, indexed: true, chars: 88 },
      { id: 'm2', title: '间接注入：文档上传链路', kind: 'technique', tags: '注入,rag', source: 'builtin', created_at: 1700000001000, updated_at: 1700000001000, indexed: false, chars: 120 },
    ] }
  } else if (method === 'search') {
    result = { ok: true, query: payload.args.query, count: 1, mode: 'vector', reranked: true, hits: [
      { id: 'm1', entryId: 'm1', title: 'OWASP LLM01 提示词注入', text: '把指令伪装成数据塞进上下文…', tags: 'owasp', kind: 'knowledge', source: 'builtin', score: 0.88, rerankScore: 0.97, mode: 'vector', indexed: true },
    ] }
  } else if (method === 'captureTest') {
    result = { ok: true, matched: true, phrase: '写入记忆', body: '10.0.0.5:8000 未授权', kind: 'note', text: '10.0.0.5:8000 未授权' }
  } else if (method === 'importFile') {
    result = { ok: true, snapshot: fakeSnapshot(), path: payload.args.path, ext: '.pdf', how: 'pdftotext -layout', chars: 2048, added: 2, updated: 0, parsed: 2, indexed: 2, indexError: null }
  } else if (method === 'syncIndex') result = { ok: true, synced: 2, entries: 2, snapshot: fakeSnapshot() }
  else if (method === 'getEntry') result = { ok: true, entry: { id: 'm1', title: 'OWASP LLM01 提示词注入', text: '把指令伪装成数据塞进上下文…', kind: 'knowledge', source: 'builtin', created_at: 1700000000000 } }
  else if (method === 'saveSettings') result = { ok: true, snapshot: fakeSnapshot() }
  else if (method === 'testMilvus') result = { ok: true, collections: ['redteam_memory'], collection: 'redteam_memory', exists: true, rowCount: 16, ms: 12 }
  else if (method === 'testS3') result = { ok: true, bucket: 'mimo', sample: 1 }
  else if (method === 's3List') result = { ok: true, bucket: 'mimo', objects: [{ key: 'kv/a.bin', size: 2048, lastModified: '2026-09-16T10:00:00Z' }], truncated: false }
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
ok(registration && registration.id === 'dsh-redteam-memory', '注册的模块 id 是包名：' + (registration && registration.id))

console.log('\n[1] 物化模块与插槽注册')
const mod = registration.factory((name) => {
  if (name === 'react') return React
  throw new Error('未知依赖: ' + name)
})
ok(typeof mod.apply === 'function', '导出 apply 是函数')
ok(Array.isArray(mod.inject) && mod.inject.indexOf('slots') >= 0, '导出 inject 含 slots')

let Panel = null
let Glyph = null
let Settings = null
let settingsReg = null
const slots = {
  inject: (name, cb) => { cb(); return () => {} },
  register: (def, Comp) => {
    if (def && def.name === 'main') Panel = Comp
    if (def && def.name === 'sidebar.panellist') Glyph = Comp
    if (def && def.name === 'settings.section') { Settings = Comp; settingsReg = def }
    return () => {}
  },
}
const ctx = {
  slots,
  get: (n) => (n === 'slots' ? slots : undefined),
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  interval: () => () => {},
}
mod.apply(ctx)
ok(!!Panel, '主面板已注册到 main 插槽')
ok(!!Glyph, '侧栏按钮已注册到 sidebar.panellist')
ok(!!Settings, '设置页已注册到 settings.section')
ok(!!settingsReg && settingsReg.id === 'redteam-memory', '设置页的 id 是包名：' + (settingsReg && settingsReg.id))
ok(!!settingsReg && settingsReg.label === '红队设置', '设置页的标签是「红队设置」：' + (settingsReg && settingsReg.label))
ok(!!settingsReg && typeof settingsReg.order === 'number', '设置页带排序位：' + (settingsReg && settingsReg.order))

console.log('\n[0] 样式只引用注册过的主题 token')
{
  // 回归线：曾经把 bg-layer-1 / bg-layer-2 记成 bg-l1 / bg-l2 —— 名字不存在，
  // var() 直接回退到硬编码 rgba，深浅色主题下观感不一致却没人报错。
  const TOKENS = [
    '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-brand-primary',
    '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
    '--dsw-alias-state-error-primary', '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary',
    '--dsw-specific-sidebar-fill',
  ]
  const src = fs.readFileSync(libClient, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')
  const used = Array.from(new Set(src.match(/--dsw-[a-z0-9-]+/g) || []))
  const unknown = used.filter((t) => TOKENS.indexOf(t) < 0)
  ok(used.length > 5, '样式中确实用了主题 token（' + used.length + ' 个）')
  ok(unknown.length === 0, '没有不存在的 token' + (unknown.length ? '：' + JSON.stringify(unknown) : ''))
}

console.log('\n[2] 记忆面板：顶栏 / 标签页')
const render = makeRenderer(Panel)
let tree = render.run()
await settle(render)
tree = render.run()
let text = textOf(tree)
ok(text.indexOf('红队记忆') >= 0, '标题出现')
ok(text.indexOf('本地 18 条') >= 0 && text.indexOf('索引 16 条') >= 0, '顶栏显示本地条数与索引条数')
ok(text.indexOf('待同步 2') >= 0, '顶栏显示待同步条数')
ok(text.indexOf('向量模型已配') >= 0, '顶栏显示向量模型是否配好')
ok(text.indexOf('知识库') >= 0 && text.indexOf('检索') >= 0 && text.indexOf('日志') >= 0, '三个标签页都在')
ok(text.indexOf('连接') < 0, '「连接」tab 已经不在数据面板里')
ok(text.indexOf('设置 → 红队设置') >= 0, '面板上给出配置所在的路径')
ok(text.indexOf('刷新') >= 0, '顶栏有刷新按钮')

console.log('\n[3] RPC 打的是本插件自己的路由（钉住 url，不是只记 method）')
ok(urls.length > 0 && urls.every((u) => u === '/dsh-redteam-memory/rpc'),
  'RPC 路径正确（实际：' + JSON.stringify(Array.from(new Set(urls))) + '）')
ok(urls.indexOf('/dsh-redteam-asset-graph/rpc') < 0, '没有打到资产图谱的路由（骨架复制带来的缺陷）')

console.log('\n[4] 知识库页：工具行 / 导入 / 列表')
ok(calls.indexOf('listKnowledge') >= 0, '调用了 listKnowledge')
ok(text.indexOf('OWASP LLM01 提示词注入') >= 0, '列表里出现条目标题')
ok(text.indexOf('间接注入：文档上传链路') >= 0, '列表里出现第二条')
ok(text.indexOf('owasp,注入') >= 0, '显示标签')
ok(text.indexOf('导入内置知识包') >= 0, '有「导入内置知识包」按钮')
ok(text.indexOf('同步索引（2）') >= 0, '有「同步索引」按钮并带上待同步条数')
ok(text.indexOf('已索引') >= 0 && text.indexOf('仅本地') >= 0, '索引状态逐条标出来')
ok(text.indexOf('删除选中') >= 0 && text.indexOf('删除向量索引') >= 0, '删除按钮在（措辞区分本地与索引）')

console.log('\n[4b] 导入：只有一条路、四种格式')
{
  ok(text.indexOf('导入文件') >= 0, '有「导入文件」卡片')
  ok(text.indexOf('pdf / word(.docx) / md / txt') >= 0, '格式说明来自宿主（只此一处来源）')
  ok(text.indexOf('pdftotext') >= 0 && text.indexOf('unzip') >= 0, '说明每种格式怎么解析')
  ok(text.indexOf('.json') < 0 && text.indexOf('xlsx') < 0, '不再出现 json 之类「看着像支持」的格式名')
  const box = findAll(tree, (n) => n.type === 'input' && String(n.props.placeholder || '').indexOf('文件绝对路径') >= 0)[0]
  ok(!!box, '有文件路径输入框')
  if (box) {
    box.props.onChange({ target: { value: '/home/kali/桌面/report.pdf' } })
    tree = render.run()
    const go = findAll(tree, (n) => n.type === 'button' && textOf(n) === '导入')[0]
    ok(!!go, '找到「导入」按钮')
    if (go) {
      delete argsOf.importFile
      go.props.onClick()
      await settle(render)
      tree = render.run()
      text = textOf(tree)
      ok(calls.indexOf('importFile') >= 0, '点「导入」调了 importFile')
      ok(argsOf.importFile && argsOf.importFile.path === '/home/kali/桌面/report.pdf', '把路径发了回去：' + (argsOf.importFile && argsOf.importFile.path))
      ok(text.indexOf('已导入 2 条（.pdf，2048 字，pdftotext -layout）') >= 0, '回显导入结果与解析方式')
    }
  }
}

console.log('\n[4c] 对话捕获：默认折叠，展开才配置')
{
  ok(text.indexOf('对话捕获') >= 0, '有「对话捕获」卡片')
  ok(text.indexOf('触发词 2 个') >= 0 && text.indexOf('最近捕获 1 条') >= 0, '摘要行显示触发词与捕获条数')
  ok(text.indexOf('10.0.0.5:8000 未授权可列模型') < 0, '折叠时不渲染捕获明细')
  const open = findAll(tree, (n) => n.type === 'button' && textOf(n) === '展开')[0]
  ok(!!open, '有「展开」按钮')
  if (open) {
    open.props.onClick()
    tree = render.run()
    text = textOf(tree)
    ok(text.indexOf('10.0.0.5:8000 未授权可列模型') >= 0, '展开后渲染出最近捕获的内容摘要')
    ok(text.indexOf('索引未同步') >= 0, '捕获记录标了索引未同步')
    const phraseInput = findAll(tree, (n) => n.type === 'input' && String(n.props.value) === '写入记忆,记到记忆')[0]
    ok(!!phraseInput, '触发词回填到输入框')
    const box = findAll(tree, (n) => n.type === 'input' && String(n.props.placeholder || '').indexOf('这台机的指纹') >= 0)[0]
    ok(!!box, '有触发词干跑输入框')
    if (box) {
      box.props.onChange({ target: { value: '这台机的指纹写入记忆' } })
      tree = render.run()
      const dry = findAll(tree, (n) => n.type === 'button' && textOf(n) === '干跑')[0]
      ok(!!dry, '找到「干跑」按钮')
      if (dry) {
        dry.props.onClick()
        await settle(render)
        tree = render.run()
        text = textOf(tree)
        ok(calls.indexOf('captureTest') >= 0, '点「干跑」调了 captureTest')
        ok(text.indexOf('会捕获：触发词「写入记忆」') >= 0, '干跑结果标出命中的触发词')
      }
    }
  }
}

console.log('\n[5] 打开条目详情')
{
  const links = findAll(tree, (n) => typeof n.props.className === 'string' && n.props.className === 'rtm-lnk')
  ok(links.length >= 1, '列表行有可点击的标题' + (links.length ? '' : '（0 个）'))
  if (links[0]) {
    links[0].props.onClick()
    await settle(render)
    tree = render.run()
    text = textOf(tree)
    ok(calls.indexOf('getEntry') >= 0, '点击后调用了 getEntry')
    ok(text.indexOf('把指令伪装成数据塞进上下文') >= 0, '详情里出现全文')
  }
}

console.log('\n[6] 检索页：结果与分数')
{
  const tabBtn = findAll(tree, (n) => n.type === 'button' && textOf(n).trim() === '检索')[0]
  ok(!!tabBtn, '找到「检索」标签页')
  if (tabBtn) {
    tabBtn.props.onClick()
    await settle(render)
    tree = render.run()
    const inputs = findAll(tree, (n) => n.type === 'input' && n.props.placeholder && String(n.props.placeholder).indexOf('提示词注入') >= 0)
    ok(inputs.length >= 1, '有检索输入框')
    if (inputs[0]) {
      inputs[0].props.onChange({ target: { value: '提示词注入怎么验证' } })
      tree = render.run()
      // 「检索」既是标签页也是执行按钮，要排掉标签页那个
      const go = findAll(tree, (n) => n.type === 'button' && textOf(n) === '检索' &&
        String(n.props.className || '').indexOf('rtm-tab') < 0)[0]
      if (go) {
        go.props.onClick()
        await settle(render)
        tree = render.run()
        text = textOf(tree)
        ok(calls.indexOf('search') >= 0, '点了检索会调 search')
        ok(text.indexOf('召回 0.880') >= 0, '显示召回分')
        ok(text.indexOf('重排 0.970') >= 0, '显示重排分')
        ok(text.indexOf('已重排') >= 0, '标注了已重排')
        ok(text.indexOf('向量检索') >= 0, '标注了检索方式')
      } else ok(false, '找到「检索」执行按钮')
    }
  }
}

console.log('\n[7] 红队设置页：四组配置 + 本地库')
{
  const srender = makeRenderer(Settings)
  let stree = srender.run()
  await settle(srender)
  stree = srender.run()
  let stext = textOf(stree)
  ok(stext.indexOf('红队设置') >= 0, '标题出现')
  ok(stext.indexOf('Milvus 地址') >= 0, '有 Milvus 地址输入框')
  ok(stext.indexOf('向量服务') >= 0 && stext.indexOf('向量模型') < 0 || stext.indexOf('Embedding') >= 0, '有向量模型一组')
  ok(stext.indexOf('重排模型') >= 0, '有重排模型一组')
  ok(stext.indexOf('桶名') >= 0, '有 S3 一组')
  ok(stext.indexOf('本地库') >= 0 && stext.indexOf('本地库文件') >= 0, '有本地库一组（含存储文件）')
  ok(stext.indexOf('默认返回条数') >= 0, '有默认返回条数')
  ok(stext.indexOf('保存设置') >= 0, '有保存设置按钮')
  ok(stext.indexOf('整库重建索引') >= 0, '有整库重建索引')
  ok(stext.indexOf('删除向量索引') >= 0, '有删除向量索引')
  ok(stext.indexOf('列举 S3 对象') >= 0 && stext.indexOf('导出到 S3') >= 0, 'S3 列举与导出按钮在')
  ok(stext.indexOf('测试 Milvus') >= 0 && stext.indexOf('测试向量模型') >= 0 && stext.indexOf('测试重排') >= 0 && stext.indexOf('测试 S3') >= 0, '四个测试按钮都在')
  ok(stext.indexOf('不配也能记') >= 0, '说明「不配也能用」（本地优先）')

  const inputsAll = findAll(stree, (n) => n.type === 'input')
  ok(inputsAll.some((n) => n.props.value === 'mimo'), '桶名默认值 mimo 已填入输入框')
  ok(inputsAll.some((n) => String(n.props.value).indexOf('127.0.0.1:19530') >= 0), 'Milvus 地址已回填')
  ok(inputsAll.some((n) => String(n.props.value) === '.redteam-memory.json'), '本地库文件已回填')

  const selects = findAll(stree, (n) => n.type === 'select')
  const optsOf = (sel) => findAll(sel, (n) => n.type === 'option').map(textOf)
  const allOpts = selects.reduce((a, s) => a.concat(optsOf(s)), [])
  ok(allOpts.some((o) => o.indexOf('tongyi-embedding-vision-flash') >= 0), '向量模型下拉含 tongyi-embedding-vision-flash')
  ok(allOpts.some((o) => o.indexOf('智谱 BigModel') >= 0), '向量服务下拉含智谱 BigModel')
  ok(allOpts.some((o) => o.indexOf('BAAI/bge-reranker-v2-m3') >= 0) || allOpts.some((o) => o.indexOf('jina-reranker') >= 0), '重排下拉含常见重排模型')

  // 切到智谱：模型下拉要跟着换成 Embedding-3（换服务商时的联动是最容易写错的地方）
  const provSel = selects.filter((s) => optsOf(s).some((o) => o.indexOf('智谱 BigModel') >= 0))[0]
  if (provSel) {
    provSel.props.onChange({ target: { value: 'bigmodel' } })
    stree = srender.run()
    const sel2 = findAll(stree, (n) => n.type === 'select')
    const opts2 = sel2.reduce((a, s) => a.concat(optsOf(s)), [])
    ok(opts2.some((o) => o.indexOf('embedding-3') >= 0), '切到智谱后模型下拉出现 Embedding-3')
    const dumpInputs = findAll(stree, (n) => n.type === 'input')
    ok(dumpInputs.some((n) => Number(n.props.value) === 2048), '切服务商时维度跟着改成 2048')
  } else ok(false, '找到向量服务下拉')

  const testBtn = findAll(stree, (n) => n.type === 'button' && textOf(n) === '测试 Milvus')[0]
  if (testBtn) {
    testBtn.props.onClick()
    await settle(srender)
    stree = srender.run()
    stext = textOf(stree)
    ok(calls.indexOf('testMilvus') >= 0, '点「测试 Milvus」调了 testMilvus')
    ok(stext.indexOf('✓ Milvus') >= 0, '测试结果渲染成成功提示')
  }
  const s3Btn = findAll(stree, (n) => n.type === 'button' && textOf(n) === '列举 S3 对象')[0]
  if (s3Btn) {
    s3Btn.props.onClick()
    await settle(srender)
    stree = srender.run()
    stext = textOf(stree)
    ok(calls.indexOf('s3List') >= 0, '点「列举 S3 对象」调了 s3List')
    ok(stext.indexOf('kv/a.bin') >= 0, '对象列表渲染出来')
  }
  const saveBtn = findAll(stree, (n) => n.type === 'button' && textOf(n) === '保存设置')[0]
  if (saveBtn) {
    saveBtn.props.onClick()
    await settle(srender)
    ok(calls.indexOf('saveSettings') >= 0, '点「保存设置」调了 saveSettings')
  }
}

console.log('\n[8] 日志页')
{
  const tabBtn = findAll(tree, (n) => n.type === 'button' && textOf(n).trim() === '日志')[0]
  ok(!!tabBtn, '找到「日志」标签页')
  if (tabBtn) {
    tabBtn.props.onClick()
    await settle(render)
    tree = render.run()
    text = textOf(tree)
    ok(text.indexOf('向量模型连通') >= 0, '日志行渲染出来')
    ok(text.indexOf('清空日志') >= 0, '有清空日志按钮')
  }
}

console.log('\n' + (fails.length === 0 ? '✓ 全部通过（' + pass + ' 项）' : '✗ 失败 ' + fails.length + ' 项：\n  - ' + fails.join('\n  - ')))
process.exit(fails.length === 0 ? 0 : 1)
