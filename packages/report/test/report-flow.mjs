// 红队报告 · legacy Host 引擎回归（112 项，不代表发布入口）
// 常驻发布入口由 published-smoke.mjs 直接测试 lib/host.js。
//
// 覆盖范围：
//   1. 装载：两个模型工具、RPC 路由
//   2. 快照与设置（模型留空时取当前会话的默认模型）
//   3. 证据采集：工作区 / 会话（用户要求 · 关键操作 · 结果与结论）/ 攻击矩阵 / 记忆库
//   4. digest：内容、章节、疑似条目的片段不进 digest、超预算截断
//   5. 生成：后台任务、流式写入、标题从正文里取、模型路由、证据元数据
//   6. 预览与导出：md / html / docx（真 ZIP，外部工具校验）
//   7. 导入记忆：按 ## 切段交给 redteamMemory 服务
//   8. 失败路径：llm 不可用 / 没有攻击矩阵服务时读存储文件（只有 id）/ 记忆插件没跑
//
// **不打网络、不落真盘**：llm 是一个假的流式实现，fs / shell 都是内存实现。
// 断言的重点是「我们发出去的请求长什么样」与「交给模型的那份材料长什么样」——
// 报告写不好的原因九成在这两处，而不是 markdown 渲染。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { loadLegacyHost } from './legacy-fixture.mjs'
const libHost = 'legacy fixture (lib/parts + src/host.js + src/docx.js)'
console.log('LEGACY ENGINE regression: published entry is tested separately.')

let pass = 0
const fails = []
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fails.push(label); console.log('  ✗ ' + label) }
}

let mod
try {
  mod = await loadLegacyHost()
} catch (e) {
  // 刻意不静默跳过：解析不到依赖时必须红，否则就成了「绿但没跑」。
  console.error('无法加载 ' + libHost + '：' + e.message)
  console.error('主机侧测试要解析 @deepseek-ai/dsh-tools。按仓库 README「让主机侧测试真的跑起来」软链。')
  process.exit(1)
}

// ── 假 fs / 假 shell ────────────────────────────────────────────────────────
const files = new Map()
const fsService = {
  async resolve(p) { return { displayPath: p, path: p, key: p } },
  async stat(t) { return files.has(t.path) ? { size: String(files.get(t.path)).length } : null },
  async readText(t) { return files.get(t.path) || '' },
  async writeText(t, content) { files.set(t.path, String(content)); return { ok: true } },
  processPath(t) { return '/resolved/' + t.path },
}

const shellCalls = []
const shell = {
  resolve(spec) { return spec },
  async run(spec) {
    shellCalls.push(spec.command)
    // docx 落盘走 shell + base64：把载荷解出来记进假 fs，测试里再验证它是真 ZIP。
    const m = /printf '%s' '([^']*)' \| base64 -d > '([^']*)'/.exec(spec.command)
    if (m) {
      files.set(m[2], Buffer.from(m[1], 'base64'))
      return { exitCode: 0, timedOut: false, stdout: { text: '' }, stderr: { text: '' } }
    }
    return { exitCode: 1, timedOut: false, stdout: { text: '' }, stderr: { text: '未预期的命令：' + spec.command } }
  },
}

// ── 假工作区与会话 ──────────────────────────────────────────────────────────
const T = 1789500000000
function mkSession(id, events) {
  return { id: id, snapshotEvents: () => events }
}
const sessions = {
  'session-a': mkSession('session-a', [
    { type: 'user/message', seq: 1, time: T, data: { content: [{ type: 'text', text: '帮我测一下 192.168.30.250:11434 这个推理服务的未授权访问' }] } },
    { type: 'tool/call', seq: 2, time: T + 1000, data: { callId: 'c1', name: 'bash', arguments: '{"command":"curl -sS http://192.168.30.250:11434/api/tags"}' } },
    { type: 'tool/result', seq: 3, time: T + 2000, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '{"models":[{"name":"qwen2.5:7b"},{"name":"llama3:8b"}]}' }] }] } } },
    { type: 'assistant/message', seq: 4, time: T + 3000, data: { message: { content: [{ type: 'text', text: '未授权确认：不加凭据直接列出了模型清单' }] } } },
  ]),
  'session-b': mkSession('session-b', [
    { type: 'user/message', seq: 1, time: T + 60000, data: { content: [{ type: 'text', text: '试着用 /api/create 创建一个模型，验证管理接口能不能滥用' }] } },
    { type: 'tool/call', seq: 2, time: T + 61000, data: { callId: 'c2', name: 'bash', arguments: '{"command":"curl -sS -X POST http://192.168.30.250:11434/api/create -d @/tmp/m.json"}' } },
    { type: 'tool/result', seq: 3, time: T + 62000, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: '404 page not found' }] }] } } },
  ]),
}
const workspaces = [{ id: 'ws-1', path: '/ws/proj-one', title: '推理服务测试', sessionIds: ['session-a', 'session-b'] }]

// ── 假服务：攻击矩阵 / 记忆 / 模型 ──────────────────────────────────────────
const flags = { matrix: true, memory: true, llm: true }

const matrixDigest = {
  from: 'service',
  storePath: '/ws/proj-one/.redteam-attack-matrix.json',
  updatedAt: T,
  lastScanAt: T,
  ignoreSessions: [],
  confirmed: 2,
  suspected: 1,
  items: [
    {
      frameworkId: 'atlas', frameworkLabel: 'MITRE ATLAS', frameworkShort: 'ATLAS',
      techniqueId: 'AML.T0043', techniqueName: '未授权访问推理服务',
      sessionId: 'session-a', sessionTitle: '推理服务测试', confidence: 'confirmed',
      decidedBy: 'model', reason: '不加凭据直接列出模型清单，回显里有 models 数组',
      occurrences: 3, firstAt: T, lastAt: T + 3000, kind: 'tool',
      matched: ['/api/tags', '未授权'], targets: ['192.168.30.250:11434'],
      snippets: [{ at: T + 2000, label: '工具结果 bash', text: '{"models":[{"name":"qwen2.5:7b"}]}' }],
    },
    {
      frameworkId: 'owasp-llm', frameworkLabel: 'OWASP LLM Top 10', frameworkShort: 'OWASP',
      techniqueId: 'LLM06', techniqueName: '敏感信息泄露',
      sessionId: 'session-a', sessionTitle: '推理服务测试', confidence: 'confirmed',
      decidedBy: 'model', reason: '错误信息里带出了版本号',
      occurrences: 1, firstAt: T, lastAt: T, kind: 'assistant', matched: ['版本'], targets: ['192.168.30.250:11434'],
      snippets: [{ at: T, label: '模型回复', text: '服务版本 Ollama 0.1.32' }],
    },
    {
      frameworkId: 'atlas', frameworkLabel: 'MITRE ATLAS', frameworkShort: 'ATLAS',
      techniqueId: 'AML.T0050', techniqueName: '命令与脚本执行',
      sessionId: 'session-b', sessionTitle: '推理服务测试', confidence: 'suspected',
      decidedBy: '', reason: '', occurrences: 2, firstAt: T + 61000, lastAt: T + 62000, kind: 'tool',
      matched: ['/api/create'], targets: ['192.168.30.250:11434'],
      snippets: [{ at: T + 62000, label: '工具结果 bash', text: '404 page not found —— 这个片段不该进 digest' }],
    },
  ],
}
const matrixService = {
  storePath: () => matrixDigest.storePath,
  names: () => ({ atlas: { label: 'MITRE ATLAS', short: 'ATLAS', techniques: { 'AML.T0043': '未授权访问推理服务', 'AML.T0050': '命令与脚本执行' } } }),
  digest: async () => JSON.parse(JSON.stringify(matrixDigest)),
}

const memoryHits = [
  { id: 'm1', title: '未授权访问与默认口令', kind: 'technique', tags: '未授权,凭据', text: '暴露的推理服务常常没有认证。顺序：直接调用 API 看是否要凭据 → 试默认端口与默认口令 → 看错误信息是否泄露版本。', source: 'builtin', mode: 'local' },
]
const memoryService = {
  search: async (query, k) => ({ ok: true, query: query, count: memoryHits.length, mode: 'local', hits: memoryHits.slice(0, k) }),
  add: async (entries, source) => { memoryAdded.push({ entries: entries, source: source }); return { added: entries.length, updated: 0, indexed: 0, indexError: '未配置向量模型与 Milvus（本地已存住）', localCount: entries.length, ids: entries.map((x, i) => 'e' + i) } },
  stats: async () => ({ localCount: 1, indexed: 0, pending: 1, persistence: 'ready', storePath: '/resolved/.redteam-memory.json' }),
}
const memoryAdded = []

const llmCalls = []
// 推理模型的真实失败形态：reasoning-delta 把 maxTokens 预算吃满，正文一个 text-delta 都没有。
// 生产上表现成「报告没生成」，错误却是「模型没有返回任何正文」—— 这个模式用来锁住那条报错路径。
const streamMode = { mode: 'normal' }
const REPORT_TEXT = [
  '# 红队测试报告：推理服务未授权（2026-09-16）',
  '',
  '## 1. 概述',
  '本次测试针对 192.168.30.250:11434 的推理服务，确认未授权可访问。',
  '',
  '## 3. 已确认的发现',
  '### 未授权访问模型清单',
  '- 现象：不加凭据直接列出模型清单',
  '- 证据：会话「推理服务测试」，ATLAS / AML.T0043',
  '- 影响：攻击者可直接调用推理资源',
  '',
  '## 4. 疑似与待验证',
  '- AML.T0050 命令与脚本执行：只看到 404，未证明成功。',
].join('\n')
const llm = {
  listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
  stream: function (opts) {
    llmCalls.push(opts)
    const chunks = []
    if (streamMode.mode === 'max-tokens') {
      chunks.push({ type: 'reasoning-delta', index: 0, text: '先想想要不要按这个大纲写……（推理把预算吃满）' })
      chunks.push({ type: 'usage', usage: { inputTokens: 9547, outputTokens: 32000, reasoningTokens: 32000 } })
      chunks.push({ type: 'finish', reason: { kind: 'max-tokens' } })
    } else {
      const text = REPORT_TEXT
      for (let i = 0; i < text.length; i += 40) chunks.push({ type: 'text-delta', index: 0, text: text.slice(i, i + 40) })
      chunks.push({ type: 'usage', usage: { inputTokens: 1234, outputTokens: 567 } })
      chunks.push({ type: 'finish', reason: { kind: 'stop' } })
    }
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const c of chunks) yield c
      },
    }
  },
}

// ── 假 ctx ──────────────────────────────────────────────────────────────────
const handlers = {}
const registeredRoutes = []
const tools = []
const ctx = {
  fs: fsService,
  shell: shell,
  timer: {},
  on: () => () => {},
  provide: () => () => {},
  tools: { register: (t) => { tools.push(t); return () => {} } },
  webServer: {
    register: (route) => { registeredRoutes.push(route); if (route && route.handler) handlers.rpc = route.handler; return () => {} },
  },
  effect: (fn) => { const d = fn(); return (d && typeof d.then === 'function') ? () => {} : (d || (() => {})) },
  get: (name) => {
    if (name === 'fs') return fsService
    if (name === 'shell') return shell
    if (name === 'llm') return flags.llm ? llm : undefined
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
    if (name === 'workspaceRegistry') return { list: () => workspaces.map((w) => ({ ...w })), get: (id) => workspaces.filter((w) => w.id === id)[0] }
    if (name === 'sessions') return { get: (id) => sessions[String(id)] }
    if (name === 'agents') return { currentInitiator: () => ({ id: 'session-a' }), roots: () => [{ id: 'session-a' }] }
    if (name === 'sessionTitle') return { get: (s) => ({ title: s.id === 'session-a' ? '推理服务测试' : '管理接口测试' }) }
    if (name === 'redteamAttackMatrix') return flags.matrix ? matrixService : undefined
    if (name === 'redteamMemory') return flags.memory ? memoryService : undefined
    return undefined
  },
}

await mod.apply(ctx)

function rpc(method, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, args: args === undefined ? null : args })
    const req = { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(body) } }
    const res = {
      statusCode: 200,
      setHeader() {},
      end(text) {
        let payload = null
        try { payload = JSON.parse(text || '{}') } catch (e) { reject(new Error('响应不是 JSON: ' + text)); return }
        if (payload && payload.ok === true) resolve(payload.result)
        else reject(new Error('rpc ' + method + ' 失败：' + ((payload && payload.error) || '未知')))
      },
    }
    handlers.rpc(req, res)
  })
}

async function waitFor(fn, ms) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > (ms || 3000)) return null
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[1] 装载：工具与 RPC 路由')
ok(registeredRoutes.length === 1, '注册了 1 条 RPC 路由' + (registeredRoutes[0] ? '：' + registeredRoutes[0].path : ''))
ok(!!handlers.rpc, '捕获到 RPC handler')
ok(tools.length === 3, '注册了 3 个模型工具（实际 ' + tools.length + '）')
ok(tools.map((t) => t.name).sort().join(',') === 'report_export,report_generate,report_list', '工具名正确：' + tools.map((t) => t.name).join(', '))
ok(tools.every((t) => t.parameters && t.parameters.type === 'object'), '每个工具的 parameters 编译成 JSON Schema')

console.log('\n[2] 快照与设置')
{
  const r = await rpc('snapshot', null)
  ok(r.ok === true, 'snapshot 成功')
  ok(!!r.snapshot.settings, '返回 settings')
  ok(Array.isArray(r.snapshot.outline) && r.snapshot.outline.length === 7, '返回 7 段报告大纲（实际 ' + r.snapshot.outline.length + '）')
  ok(r.snapshot.model.provider === 'deepseek' && r.snapshot.model.model === 'deepseek-chat', '模型留空时取当前会话默认模型：' + r.snapshot.model.provider + '/' + r.snapshot.model.model)
  ok(r.snapshot.model.from === 'default', '标注模型来源为 default：' + r.snapshot.model.from)
  ok(r.snapshot.status.persistence === 'ready', '报告库落盘状态 ready（假 fs 一直可用）')
  ok(r.snapshot.status.storePath === '/resolved/.redteam-report.json', '回显解析后的存储路径：' + r.snapshot.status.storePath)
  ok(r.snapshot.status.matrixPath === '/ws/proj-one/.redteam-attack-matrix.json', '默认矩阵存储锁定在工作区：' + r.snapshot.status.matrixPath)
  ok((r.snapshot.reports || []).length === 0, '初始没有报告')
}

console.log('\n[3] 证据采集：会话 / 矩阵 / 记忆')
let collectResult = null
{
  const r = await rpc('collect', { preview: 4000 })
  ok(r.ok === true, 'collect 成功')
  const ev = r.evidence
  collectResult = ev
  ok(!!ev.workspace && ev.workspace.path === '/ws/proj-one', '采到工作区：' + (ev.workspace && ev.workspace.path))
  ok(ev.sessions.length === 2, '采到 2 个会话（实际 ' + ev.sessions.length + '）')
  ok(ev.sessions[0].users === 1, '每个会话带用户要求（1 条）')
  ok(ev.sessions[0].ops >= 1 && ev.sessions[0].results >= 1, '带关键操作与结果计数：ops=' + ev.sessions[0].ops + ' results=' + ev.sessions[0].results)
  ok(ev.matrix.from === 'service', '矩阵来源标成服务：' + ev.matrix.from)
  ok(ev.matrix.confirmed === 2 && ev.matrix.suspected === 1, '矩阵 2 已确认 / 1 疑似（实际 ' + ev.matrix.confirmed + '/' + ev.matrix.suspected + '）')
  ok(ev.memory.available === true && ev.memory.count === 1, '记忆库检索到 1 条')
  ok(ev.digestChars > 500, 'digest 有内容（' + ev.digestChars + ' 字）')

  const d = ev.digest
  ok(d.indexOf('## 一、工作区与会话') >= 0 && d.indexOf('## 二、攻击矩阵命中') >= 0 && d.indexOf('## 三、记忆库') >= 0, 'digest 三段齐全')
  ok(d.indexOf('帮我测一下 192.168.30.250:11434') >= 0, 'digest 里有用户要求原文')
  ok(d.indexOf('curl -sS http://192.168.30.250:11434/api/tags') >= 0, 'digest 里有真实命令（报告要能引用）')
  ok(d.indexOf('{"models":[{"name":"qwen2.5:7b"}') >= 0, 'digest 里有工具结果')
  ok(d.indexOf('未授权确认：不加凭据直接列出了模型清单') >= 0, 'digest 里有模型结论')
  ok(d.indexOf('未授权访问推理服务') >= 0, 'digest 里技术点带名字（不是只有 id）')
  ok(d.indexOf('已确认（有做成的证据）') >= 0 && d.indexOf('疑似（提及或尝试过') >= 0, '已确认与疑似分节')
  ok(d.indexOf('判据：不加凭据直接列出模型清单') >= 0, 'digest 里有判定依据')
  ok(d.indexOf('目标：192.168.30.250:11434') >= 0, 'digest 里有打过的目标')
  ok(d.indexOf('这个片段不该进 digest') < 0, '疑似条目的证据片段不进 digest（避免把报告带偏）')
  ok(d.indexOf('未授权访问与默认口令') >= 0, 'digest 里有记忆条目')
}

console.log('\n[4] digest 预算：超了就截断')
{
  await rpc('saveSettings', { digestMax: 4000 })
  const r = await rpc('collect', { preview: 8000 })
  ok(r.evidence.truncated === true || r.evidence.digestChars <= 4000, 'digest 被限制在预算内（实际 ' + r.evidence.digestChars + ' 字）')
  await rpc('saveSettings', { digestMax: 48000 })
  const back = await rpc('collect', { preview: 2000 })
  ok(back.evidence.digest.indexOf('（证据材料超过') < 0, '预算恢复后不再截断')
}

console.log('\n[5] 生成：后台任务 + 流式写入')
{
  // 不给标题：标题应当从模型写出的第一行 `# …` 里取
  const r = await rpc('generate', {})
  ok(r.ok === true && r.started === true, 'generate 立刻返回（started）')
  ok(!!r.reportId, '返回 reportId：' + r.reportId)
  ok(r.snapshot.status.generating === true, '快照里标成生成中')
  ok(r.snapshot.status.progress && r.snapshot.status.progress.text.indexOf('证据') >= 0, '有进度文案：' + (r.snapshot.status.progress && r.snapshot.status.progress.text))

  const done = await waitFor(async () => {
    const s = await rpc('snapshot', null)
    return s.snapshot.status.generating === false ? s.snapshot : null
  }, 4000)
  ok(!!done, '生成结束（轮询到 generating=false）')
  ok(done.current.markdown === REPORT_TEXT, '正文与模型流出来的完全一致（' + done.current.markdown.length + ' 字）')
  ok(done.current.title === '红队测试报告：推理服务未授权（2026-09-16）', '标题从正文的 # 行取：' + done.current.title)
  ok(done.status.lastError === null, '没有记录错误')
  const meta = done.current.meta
  ok(meta.provider === 'deepseek' && meta.model === 'deepseek-chat', '报告元数据记下模型：' + meta.provider + '/' + meta.model)
  ok(meta.usage && meta.usage.outputTokens === 567, '记下 token 用量')
  ok(meta.evidence && meta.evidence.sessions === 2 && meta.evidence.matrixConfirmed === 2 && meta.evidence.memoryHits === 1,
    '证据规模写进报告元数据：' + JSON.stringify(meta.evidence))
  ok(done.reports.length === 1, '报告列表里有 1 份')

  const call1 = llmCalls[llmCalls.length - 1]
  ok(call1.provider === 'deepseek' && call1.model === 'deepseek-chat', 'llm.stream 用的模型正确')
  ok(typeof call1.system === 'string' && call1.system.indexOf('不要编造') >= 0, 'system 提示词带反编造纪律')
  ok(call1.messages.length === 1 && call1.messages[0].role === 'user', 'messages 是一条 user')
  const prompt = call1.messages[0].content[0].text
  ok(prompt.indexOf('## 1. 概述') >= 0 && prompt.indexOf('## 7. 清理与合规') >= 0, '提示词带完整大纲')
  ok(prompt.indexOf('## 二、攻击矩阵命中') >= 0, '提示词里带上了 digest')
  ok(call1.maxTokens === 32000, 'maxTokens 来自设置：' + call1.maxTokens)
}

console.log('\n[6] 预览与导出')
{
  const p = await rpc('preview', { title: '推理服务测试报告', markdown: '# 标题\n\n正文一\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n' })
  ok(p.ok === true, 'preview 成功')
  ok(p.html.indexOf('<!doctype html>') === 0, 'preview 返回完整 HTML 文档（可以直接塞 iframe）')
  ok(p.html.indexOf('<meta charset="utf-8">') >= 0, '带 utf-8 声明（中文不乱码）')
  ok(p.html.indexOf('<table') >= 0, 'markdown 表格渲染成 table')

  const md = await rpc('export', { format: 'md' })
  ok(md.ok === true && md.format === 'md', '导出 md 成功')
  ok(md.name.indexOf('.md') > 0, '文件名带 .md：' + md.name)
  const mdBody = files.get(md.name)
  ok(typeof mdBody === 'string' && mdBody.indexOf('# 红队测试报告') === 0, 'md 落盘且以 # 标题开头')
  ok(md.path === '/resolved/' + md.name, '回显解析后的绝对路径：' + md.path)

  const html = await rpc('export', { format: 'html' })
  ok(html.ok === true && files.get(html.name).indexOf('<!doctype html>') === 0, 'html 落盘且是完整文档')

  shellCalls.length = 0
  const docx = await rpc('export', { format: 'docx' })
  ok(docx.ok === true && docx.format === 'docx', '导出 docx 成功')
  ok(docx.bytes > 2000, 'docx 有实体内容（' + docx.bytes + ' 字节）')
  ok(shellCalls.length === 1 && shellCalls[0].indexOf('base64 -d >') >= 0, 'docx 走 shell + base64 落盘（二进制不能走 writeText）')
  const saved = files.get(docx.path)
  ok(saved instanceof Buffer && saved.slice(0, 2).toString() === 'PK', '落盘的文件是真 ZIP（PK 头）')
  const tmp = path.join(os.tmpdir(), 'rtr-test-' + Date.now() + '.docx')
  fs.writeFileSync(tmp, saved)
  let unzipOk = false
  try {
    const out = execFileSync('unzip', ['-t', tmp], { encoding: 'utf8' })
    unzipOk = /No errors detected/.test(out)
  } catch (e) { unzipOk = false }
  fs.unlinkSync(tmp)
  ok(unzipOk, 'unzip -t 认这个 docx（CRC 与结构都对）')

  const bad = await rpc('export', { format: 'pdf' })
  ok(bad.ok === false && /不支持的格式/.test(bad.error), '不支持的格式给出明确错误：' + bad.error)
}

console.log('\n[7] 导入记忆')
{
  const s = await rpc('snapshot', null)
  const r = await rpc('importToMemory', { id: s.currentId })
  ok(r.ok === true, 'importToMemory 成功')
  ok(memoryAdded.length === 1, '调了 redteamMemory.add 一次')
  ok(memoryAdded[0].entries.length === 3, '按 ## 切成 3 段（开头只有一行 H1 的前言不成条：实际 ' + memoryAdded[0].entries.length + '）')
  ok(memoryAdded[0].entries.every((e) => e.kind === 'note' && e.tags.indexOf('报告') >= 0), '每段标成 note + 报告标签')
  ok(memoryAdded[0].source.indexOf('报告 · ') === 0, '来源标成报告：' + memoryAdded[0].source)
  ok(memoryAdded[0].entries[0].title.indexOf('概述') >= 0, '段落标题取自 ## 行：' + memoryAdded[0].entries[0].title)
  ok(memoryAdded[0].entries.every((e) => e.title.indexOf('# ') !== 0), '条目标题不会带上 markdown 记号')
  ok(!!r.indexError, '记忆侧索引没同步时把原因带回来：' + r.indexError)
}

console.log('\n[8] 失败路径：外部插件没在跑 / 没配模型')
{
  flags.memory = false
  const c1 = await rpc('collect', { preview: 2000 })
  ok(c1.evidence.memory.available === false, '记忆插件不在时标记不可用')
  ok(c1.evidence.digest.indexOf('记忆插件没在运行') >= 0, 'digest 里说明记忆插件没在跑')
  const imp = await rpc('importToMemory', {})
  ok(imp.ok === false && /记忆插件/.test(imp.error), '导入记忆给出可操作的错误：' + imp.error)
  flags.memory = true

  // 没有矩阵服务：退回读存储文件，只有 id
  flags.matrix = false
  const matrixFile = JSON.stringify({
    version: 1, workspacePath: '/ws/proj-one', updatedAt: T,
    matrix: { atlas: { 'AML.T0043': { 'session-a': { sessionId: 'session-a', sessionTitle: '推理服务测试', occurrences: 3, firstAt: T, lastAt: T, confidence: 'confirmed', reason: '列出了模型清单', targets: ['192.168.30.250:11434'], matched: ['/api/tags'], snippets: [] } } } },
  })
  files.set('/ws/proj-one/.redteam-attack-matrix.json', matrixFile)
  const c2 = await rpc('collect', { preview: 4000 })
  ok(c2.evidence.matrix.from === 'file', '没有服务时退回读存储文件：' + c2.evidence.matrix.from)
  ok(c2.evidence.matrix.confirmed === 1, '从文件里也读出了 1 条已确认')
  ok(c2.evidence.digest.indexOf('拿不到技术点名字') >= 0, 'digest 里说明只有 id 没有名字')
  ok(c2.evidence.digest.indexOf('列出了模型清单') >= 0, '文件里的判据照样进 digest')
  files.delete('/ws/proj-one/.redteam-attack-matrix.json')
  flags.matrix = true

  // llm 不可用：工具调用要报错，而不是悄悄写一份空报告
  flags.llm = false
  const gen = await tools.filter((t) => t.name === 'report_generate')[0].execute({ title: '不该成功' })
  ok(gen.ok === false && /llm 服务不可用/.test(gen.error), 'llm 不可用时工具明确报错：' + gen.error)
  ok(gen.chars === 0, '不留半成品内容')
  const after = await rpc('snapshot', null)
  ok(after.snapshot.reports.length === 1, '写不出内容时不留下空壳报告（实际 ' + after.snapshot.reports.length + ' 份）')
  flags.llm = true
}

console.log('\n[8b] 工具导出：report_export（对话里说「导出成 Word」）')
{
  const t = tools.filter((x) => x.name === 'report_export')[0]
  ok(!!t, '注册了 report_export 工具')
  ok(t.parameters.properties.format.enum.join(',') === 'md,html,docx', 'format 是枚举 md/html/docx')
  const r = await t.execute({ format: 'docx' })
  ok(r.ok === true && r.format === 'docx', '工具导出 docx 成功')
  ok(r.path && r.path.indexOf('.docx') > 0, '返回落盘绝对路径：' + r.path)
  const saved = files.get(r.path)
  ok(saved instanceof Buffer && saved.slice(0, 2).toString() === 'PK', '落盘的是真 ZIP')
  // format 是枚举：静态 defineTool 会在进 execute 之前就拦住非法值（这是好事，
  // 所以这里断言的是「框架真的拦住了」，而不是「我的代码返回了 error」）。
  let threw = null
  try { await t.execute({ format: 'pdf' }) } catch (e) { threw = e }
  ok(!!threw && /must be one of/.test(String(threw.message)), '非法 format 被框架的参数校验拦住：' + (threw && threw.message))
  const noReport = await t.execute({ reportId: '不存在的 id' })
  ok(noReport.ok === true || noReport.ok === false, '给不存在的 id 时不会抛异常（回落到当前报告）')
}

console.log('\n[9] 报告管理：新建 / 切换 / 删除 / 清日志')
{
  const c = await rpc('create', { title: '手工报告' })
  ok(c.ok === true && !!c.id, '新建报告成功')
  ok(c.snapshot.reports.length === 2, '现在有 2 份报告')
  const sel = await rpc('select', { id: c.id })
  ok(sel.snapshot.currentId === c.id, '切换当前报告')
  const save = await rpc('saveDraft', { id: c.id, title: '手工报告 v2', markdown: '## 手写的一节\n内容' })
  ok(save.ok === true, '保存草稿成功')
  const cur = save.snapshot.current
  ok(cur.title === '手工报告 v2' && cur.markdown.indexOf('手写的一节') >= 0, '草稿内容回读正确')
  const rm = await rpc('remove', { ids: [c.id] })
  ok(rm.ok === true && rm.deleted === 1, '删除报告成功')
  ok(rm.snapshot.reports.length === 1, '删完剩 1 份')
  const lc = await rpc('logClear', null)
  ok(lc.ok === true && lc.snapshot.log.length === 0, '清空日志')
}

console.log('\n[10] 失败路径：推理吃满预算（finish=max-tokens，正文为空）')
{
  const n0 = (await rpc('snapshot', null)).snapshot.reports.length
  streamMode.mode = 'max-tokens'
  const g = await rpc('generate', { createNew: true })
  ok(g.ok === true && g.started === true, 'generate 先返回 started（后台任务照跑）')
  const done = await waitFor(async () => {
    const s = await rpc('snapshot', null)
    return s.snapshot.status.generating === false ? s.snapshot : null
  }, 4000)
  ok(!!done, '生成结束（generating=false）')
  const err = String((done && done.status.lastError) || '')
  ok(err.indexOf('max-tokens') >= 0, '错误里带上 finish 原因：' + err)
  ok(err.indexOf('推理占满了') >= 0, '错误点明是推理占满预算，而不是含糊的「没有正文」')
  ok(err.indexOf('推理 32000 token') >= 0, '错误带出推理实际用掉的 token：' + err)
  ok(err.indexOf('调到 64000') >= 0, '错误给出下一步的具体数值（当前 32000 -> 64000）')
  ok(done.reports.length === n0, '一个字都没写出来时不留空壳报告（仍是 ' + n0 + ' 份）')
  streamMode.mode = 'normal'
}

console.log('\n[10b] 迁移：旧库的 maxTokens=8000 载入后提升到 32000')
{
  // 独立起第二个实例：loadLegacyHost() 每次重新构造模块，于是能拿到一个干净的 store。
  // 事故形态：老库把 8000 写死在 settings 里，只改代码默认值不够 —— 自动报告会一直失败。
  const files2 = new Map()
  files2.set('.redteam-report.json', JSON.stringify({
    version: 1, updatedAt: 0, settings: { maxTokens: 8000 }, reports: [], currentId: '', log: [], logSeq: 0,
  }))
  const fs2 = {
    async resolve(p) { return { displayPath: p, path: p, key: p } },
    async stat(t) { return files2.has(t.path) ? { size: String(files2.get(t.path)).length } : null },
    async readText(t) { return files2.get(t.path) || '' },
    async writeText(t, c) { files2.set(t.path, String(c)); return { ok: true } },
    processPath(t) { return '/resolved/' + t.path },
  }
  let handler2 = null
  const ctx2 = {
    fs: fs2, shell: shell, timer: {}, on: () => () => {}, provide: () => () => {},
    tools: { register: () => () => {} },
    webServer: { register: (r) => { if (r && r.handler) handler2 = r.handler; return () => {} } },
    effect: (fn) => { const d = fn(); return (typeof d === 'function') ? d : () => {} },
    get: (name) => {
      if (name === 'fs') return fs2
      if (name === 'shell') return shell
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
      if (name === 'workspaceRegistry') return { list: () => workspaces.map((w) => ({ ...w })), get: (id) => workspaces.filter((w) => w.id === id)[0] }
      if (name === 'sessions') return { get: (id) => sessions[String(id)] }
      if (name === 'sessionTitle') return { get: (s) => ({ title: '推理服务测试' }) }
      return undefined
    },
  }
  const mod2 = await loadLegacyHost()
  await mod2.apply(ctx2)
  ok(!!handler2, '第二个实例注册了 RPC handler')
  const rpc2 = (method, args) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, args: args === undefined ? null : args })
    const req = { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(body) } }
    const res = {
      statusCode: 200, setHeader() {},
      end(text) {
        let payload = null
        try { payload = JSON.parse(text || '{}') } catch (e) { reject(new Error('响应不是 JSON: ' + text)); return }
        if (payload && payload.ok === true) resolve(payload.result)
        else reject(new Error('rpc ' + method + ' 失败：' + ((payload && payload.error) || '未知')))
      },
    }
    handler2(req, res)
  })
  const s2 = await rpc2('snapshot', null)
  ok(s2.snapshot.settings.maxTokens === 32000, '旧库 maxTokens 8000 -> 32000（实际 ' + s2.snapshot.settings.maxTokens + '）')
  await rpc2('saveSettings', {})
  const persisted = JSON.parse(files2.get('.redteam-report.json'))
  ok(Number(persisted.version) === 2 && persisted.settings.maxTokens === 32000,
    '迁移结果按新版本落盘（version=' + persisted.version + ', maxTokens=' + persisted.settings.maxTokens + '）')
}

console.log('\n' + (fails.length === 0 ? '✓ 全部通过（' + pass + ' 项）' : '✗ 失败 ' + fails.length + ' 项：\n  - ' + fails.join('\n  - ')))
process.exit(fails.length === 0 ? 0 : 1)
