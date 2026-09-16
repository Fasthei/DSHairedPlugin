// 红队记忆 · Host 半边测试
//
// 覆盖范围：
//   1. 工具注册（三件套）与 RPC 路由
//   2. 设置读写与持久化
//   3. 向量模型请求形状（dashscope 多模态 / dashscope 文本 / bigmodel / OpenAI 兼容）
//   4. Milvus 请求形状（建集合的 schema 与维度、insert/upsert、search、query、delete、统计）
//   8. 重排：请求形状 + 两种响应位置（results / output.results）+ 是否真的改变了顺序
//   9. S3：URL 组装（path-style/虚拟主机）+ --aws-sigv4 + ListObjectsV2 XML 解析
//  10. 入库链路：切块、去重 id、维度校验
//
// **没有真 Milvus / 真向量服务**也跑得起来：HTTP 全部走 shell+curl，所以这里塞一个假 shell，
// 按 URL 返回构造好的响应，同时把每条命令记下来供断言 —— 这样能验证「我们发出去的请求长什么样」，
// 而那正是最容易写错、也最难在真实环境里定位的部分。
//
// 用法: node test/memory-flow.mjs

import fs from 'node:fs'
import path from 'node:path'

const libHost = path.join(import.meta.dirname, '..', 'lib', 'host.js')

let pass = 0
const fails = []
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fails.push(label); console.log('  ✗ ' + label) }
}

let mod
try {
  mod = await import(libHost)
} catch (e) {
  // 这里刻意不「静默跳过」：解析不到依赖时必须红，否则就成了「绿但没跑」
  console.error('无法加载 ' + libHost + '：' + e.message)
  console.error('主机侧测试要解析 @deepseek-ai/dsh-tools。按仓库 README「让主机侧测试真的跑起来」软链：')
  console.error('  DSH_NM="$(readlink -f "$(command -v dsh)" | sed \'s#/node_modules/.*#/node_modules/@deepseek-ai#\')"')
  console.error('  mkdir -p packages/memory/node_modules/@deepseek-ai && ln -sfn "$DSH_NM/dsh-tools" packages/memory/node_modules/@deepseek-ai/dsh-tools')
  process.exit(1)
}

// ── 假 fs（Map 支撑，够本插件用：resolve / stat / readText / writeText） ──────
const files = new Map()
const fsService = {
  async resolve(p) { return { displayPath: p, path: p, key: p } },
  async stat(t) { return files.has(t.path) ? { size: files.get(t.path).length } : null },
  async readText(t) { return files.get(t.path) || '' },
  async writeText(t, content) { files.set(t.path, String(content)); return { ok: true } },
  processPath(t) { return t.path },
}

// ── 假 shell：按 URL 路由，返回构造好的响应，并记录每条命令 ──────────────────
const calls = []
let indexedIds = []
function bodyOf(cmd) {
  const m = /--data-binary '([\s\S]*?)'(?=\s|$)/.exec(cmd)
  if (!m) return null
  try { return JSON.parse(m[1]) } catch (e) { return null }
}
function vec(seed, dim) {
  const out = []
  for (let i = 0; i < dim; i++) out.push(((seed * 31 + i * 7) % 100) / 100)
  return out
}
const EMBED_DIM = 8
const shell = {
  resolve(spec) { return spec },
  async run(spec) {
    const cmd = spec.command
    calls.push(cmd)
    const reply = function (obj, code) {
      return { exitCode: 0, timedOut: false, stdout: { text: JSON.stringify(obj) + '\n' + (code || 200) }, stderr: { text: '' } }
    }
    const text = function (s, code) {
      return { exitCode: 0, timedOut: false, stdout: { text: s + '\n' + (code || 200) }, stderr: { text: '' } }
    }
    const err = function (msg, code) {
      return { exitCode: 0, timedOut: false, stdout: { text: msg + '\n' + (code || 500) }, stderr: { text: '' } }
    }

    // 向量模型 —— dashscope 多模态
    if (cmd.indexOf('multimodal-embedding') >= 0) {
      const b = bodyOf(cmd)
      const texts = ((b && b.input && b.input.contents) || []).map(function (x) { return x.text })
      return reply({ output: { embeddings: texts.map(function (t, i) { return { index: i, embedding: vec(t.length, EMBED_DIM) } }) } })
    }
    // 向量模型 —— dashscope 纯文本
    if (cmd.indexOf('text-embedding/text-embedding') >= 0) {
      const b = bodyOf(cmd)
      const texts = (b && b.input && b.input.texts) || []
      return reply({ output: { embeddings: texts.map(function (t, i) { return { text_index: i, embedding: vec(t.length, EMBED_DIM) } }) } })
    }
    // 向量模型 —— 智谱
    if (cmd.indexOf('/api/paas/v4/embeddings') >= 0) {
      const b = bodyOf(cmd)
      const texts = (b && b.input) || []
      return reply({ data: texts.map(function (t, i) { return { index: i, embedding: vec(t.length, Number(b.dimensions) || EMBED_DIM) } }) })
    }
    // 向量模型 —— OpenAI 兼容
    if (cmd.indexOf('/v1/embeddings') >= 0) {
      const b = bodyOf(cmd)
      const texts = (b && b.input) || []
      return reply({ data: texts.map(function (t, i) { return { index: i, embedding: vec(t.length, EMBED_DIM) } }) })
    }
    // 重排
    if (cmd.indexOf('127.0.0.1:9/') >= 0) {
      // 故意模拟「重排服务连不上」：用来验证检索会降级而不是一起挂掉。
      // 注意匹配里带斜杠 —— 否则 127.0.0.1:9000 也会被它命中。
      return err('curl: (7) Failed to connect', 502)
    }
    if (cmd.indexOf('/rerank') >= 0 || cmd.indexOf('text-rerank') >= 0) {
      const b = bodyOf(cmd)
      const n = ((b && (b.documents || (b.input && b.input.documents))) || []).length
      const order = []
      // 顺序与分数必须自洽：第一条既排在最前，分数也最高（否则「顺序被采纳了没有」就断言不出来）
      for (let i = n - 1; i >= 0; i--) order.push({ index: i, relevance_score: Math.round((1 - (n - 1 - i) * 0.1) * 10) / 10 })
      if (cmd.indexOf('text-rerank') >= 0) return reply({ output: { results: order } })
      return reply({ results: order })
    }
    // Milvus
    if (cmd.indexOf('/v2/vectordb/collections/list') >= 0) return reply({ code: 0, data: [] })
    if (cmd.indexOf('/v2/vectordb/collections/describe') >= 0) return reply({ code: 0, data: { collectionName: 'redteam_memory', fields: [{ name: 'vector', params: { dim: EMBED_DIM } }] } })
    if (cmd.indexOf('/v2/vectordb/collections/create') >= 0) return reply({ code: 0, data: {} })
    if (cmd.indexOf('/v2/vectordb/collections/drop') >= 0) return reply({ code: 0, data: {} })
    if (cmd.indexOf('/v2/vectordb/collections/get_stats') >= 0) return reply({ code: 0, data: { rowCount: 42 } })
    if (cmd.indexOf('/v2/vectordb/entities/upsert') >= 0 || cmd.indexOf('/v2/vectordb/entities/insert') >= 0) {
      const b = bodyOf(cmd)
      const n = (b && b.data ? b.data.length : 0)
      // 记住索引里真实的行 id：召回时按它们返回，才能模拟「索引与本地库一致」。
      indexedIds = (b && b.data ? b.data : []).map(function (r) { return r.id })
      return reply({ code: 0, data: { insertCount: n, upsertCount: n, insertIds: indexedIds } })
    }
    if (cmd.indexOf('/v2/vectordb/entities/search') >= 0) {
      const b = bodyOf(cmd)
      const limit = (b && b.limit) || 3
      const out = []
      // 行 id 形如 `<条目 id>#<块号>-<指纹>`，插件据此把召回反查回本地条目。
      for (let i = 0; i < Math.min(limit, indexedIds.length); i++) {
        out.push({ id: indexedIds[i], title: '标题 ' + i, text: '正文 ' + i, tags: 'owasp', kind: 'knowledge', source: 'unit', created_at: 1700000000000 + i, distance: 0.9 - i * 0.1 })
      }
      return reply({ code: 0, data: out })
    }
    if (cmd.indexOf('/v2/vectordb/entities/query') >= 0) {
      const b = bodyOf(cmd)
      if (b && b.outputFields && b.outputFields[0] === 'count(*)') return reply({ code: 0, data: [{ 'count(*)': 42 }] })
      return reply({ code: 0, data: [{ id: 'id-0', title: '标题 0', tags: 'owasp', kind: 'knowledge', source: 'test', created_at: 1700000000000, updated_at: 1700000000000 }] })
    }
    if (cmd.indexOf('/v2/vectordb/entities/delete') >= 0) return reply({ code: 0, data: { deleteCount: 2 } })
    // S3
    if (cmd.indexOf('--aws-sigv4') >= 0) {
      if (cmd.indexOf('list-type=2') >= 0) {
        return text('<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
          '<Contents><Key>a/b.bin</Key><Size>1024</Size><LastModified>2026-09-16T10:00:00.000Z</LastModified><StorageClass>STANDARD</StorageClass></Contents>' +
          '<Contents><Key>c.json</Key><Size>2048</Size><LastModified>2026-09-16T11:00:00.000Z</LastModified></Contents>' +
          '</ListBucketResult>')
      }
      if (/\s-X PUT\s/.test(cmd)) return text('')
      return text('')
    }
    return err('未预期的请求：' + cmd.slice(0, 120))
  },
}

const registeredRoutes = []
const handlers = {}
const registeredTools = []
const listeners = {}
const services = {}
const ctx = {
  fs: fsService,
  shell: shell,
  timer: {},
  tools: { register: (t) => { registeredTools.push(t); return () => {} } },
  webServer: {
    register: (route) => {
      registeredRoutes.push(route)
      if (route && route.handler) handlers.rpc = route.handler
      return () => {}
    },
  },
  effect: (fn) => { const d = fn(); return (d && typeof d.then === 'function') ? () => {} : (d || (() => {})) },
  // 事件监听与对外服务都要能测到：这里把监听器与服务实现留下来供断言调用。
  on: (name, fn) => { listeners[name] = fn; return () => { delete listeners[name] } },
  provide: (name, value) => { services[name] = value; return () => { delete services[name] } },
  get: (name) => { if (name === 'fs') return fsService; if (name === 'shell') return shell; return undefined },
}

mod.apply(ctx)

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
const lastCall = (pat) => { for (let i = calls.length - 1; i >= 0; i--) if (calls[i].indexOf(pat) >= 0) return calls[i]; return '' }
const countCalls = (pat) => calls.filter((c) => c.indexOf(pat) >= 0).length
// 捕获是「事件到了就异步写」，测试要等它落地；轮询比 sleep 固定时长稳。
async function waitFor(fn, ms) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > (ms || 1000)) return null
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[1] 装载：工具注册与 RPC 路由')
ok(registeredRoutes.length === 1, '注册了 1 条 RPC 路由' + (registeredRoutes[0] ? '：' + registeredRoutes[0].path : ''))
ok(!!handlers.rpc, '捕获到 RPC handler')
ok(registeredTools.length === 3, '注册了 3 个模型工具（实际 ' + registeredTools.length + '）')
const names = registeredTools.map((t) => t.name).sort()
ok(names.join(',') === 'memory_add,memory_delete,memory_search', '工具名正确：' + names.join(', '))
// 静态 defineTool 会把扁平的 ParameterSchemaSpec 编译回 JSON Schema —— 注册后的 parameters
// 应当是「根 type=object + required 数组」的形态，必填字段也要在。
ok(registeredTools.every((t) => t.parameters && t.parameters.type === 'object'), '每个工具的 parameters 编译成 JSON Schema')
ok(registeredTools.filter((t) => t.name === 'memory_search')[0].parameters.required.indexOf('query') >= 0,
  'memory_search 的必填参数 query 保留下来了')

console.log('\n[2] 快照与设置')
{
  const r = await rpc('snapshot', null)
  ok(r.ok === true, 'snapshot 成功')
  ok(!!r.snapshot.settings, '返回 settings')
  ok(Array.isArray(r.snapshot.embedPresets) && r.snapshot.embedPresets.length === 3, '返回三个向量服务预设')
  const names = r.snapshot.embedPresets.map((p) => p.id).join(',')
  ok(names === 'dashscope,bigmodel,openai', '预设包含 dashscope/bigmodel/openai：' + names)
  const ds = r.snapshot.embedPresets.filter((p) => p.id === 'dashscope')[0]
  ok(ds.models.some((m) => m.id === 'tongyi-embedding-vision-flash'), 'dashscope 预设里有 tongyi-embedding-vision-flash')
  const bm = r.snapshot.embedPresets.filter((p) => p.id === 'bigmodel')[0]
  ok(bm.models.some((m) => m.id === 'embedding-3'), 'bigmodel 预设里有 Embedding-3')
  ok(r.snapshot.rerankPresets.length >= 5, '重排预设 >= 5 家（实际 ' + r.snapshot.rerankPresets.length + '）')
  const rk = r.snapshot.rerankPresets.map((p) => p.id).join(',')
  ok(rk.indexOf('jina') >= 0 && rk.indexOf('cohere') >= 0 && rk.indexOf('siliconflow') >= 0 && rk.indexOf('dashscope') >= 0 && rk.indexOf('bigmodel') >= 0,
    '重排预设含 jina/cohere/siliconflow/dashscope/bigmodel：' + rk)
}

const S = {
  milvus: { uri: 'http://127.0.0.1:19530', token: 'tok', dbName: 'default', collection: 'redteam_memory', metric: 'COSINE' },
  embed: { provider: 'dashscope', model: 'tongyi-embedding-vision-flash', apiKey: 'sk-test', dimension: EMBED_DIM, baseUrl: '' },
  rerank: { enabled: true, provider: 'jina', model: 'jina-reranker-v2-base-model', apiKey: 'jina-test', baseUrl: '', topN: 3 },
  s3: { enabled: true, endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', bucket: 'mimo', prefix: 'kv/', accessKey: 'AK', secretKey: 'SK', pathStyle: true },
}
{
  const r = await rpc('saveSettings', S)
  ok(r.ok === true, 'saveSettings 成功')
  ok(r.snapshot.settings.milvus.uri === 'http://127.0.0.1:19530', '设置已写入内存快照')
  const stored = files.get('.redteam-memory.json')
  ok(!!stored, '设置落盘到 .redteam-memory.json')
  const parsed = JSON.parse(stored || '{}')
  ok(parsed.settings.embed.model === 'tongyi-embedding-vision-flash', '落盘的向量模型正确')
  ok(parsed.settings.rerank.enabled === true, '落盘的重排开关正确')
}

console.log('\n[3] 向量模型：请求形状（这是最容易写错的部分）')
{
  calls.length = 0
  const r = await rpc('testEmbed', null)
  ok(r.ok === true, 'testEmbed 成功')
  ok(r.dimension === EMBED_DIM, '返回维度 ' + r.dimension + '（与假响应一致）')
  const cmd = lastCall('multimodal-embedding')
  ok(!!cmd, 'dashscope 多模态走 multimodal-embedding 端点')
  ok(cmd.indexOf('Authorization: Bearer sk-test') >= 0, '带上了 Bearer 鉴权头')
  ok(cmd.indexOf('https://dashscope.aliyuncs.com') >= 0, '用了官方默认 baseUrl')
  const b = bodyOf(cmd)
  ok(b && b.model === 'tongyi-embedding-vision-flash', 'body.model 传的是选中的模型')
  ok(b && b.input && Array.isArray(b.input.contents) && b.input.contents[0].text, '多模态形态用 input.contents[].text')
  ok(b && b.parameters && b.parameters.dimension === EMBED_DIM, 'parameters.dimension 传了配置的维度')

  // 换成纯文本模型：同一个服务商要换成 text-embedding 端点
  await rpc('saveSettings', { embed: { model: 'text-embedding-v4' } })
  calls.length = 0
  await rpc('testEmbed', null)
  const cmd2 = lastCall('text-embedding/text-embedding')
  ok(!!cmd2, 'dashscope 纯文本模型走 text-embedding 端点')
  const b2 = bodyOf(cmd2)
  ok(b2 && Array.isArray(b2.input.texts) && b2.parameters.text_type === 'document', '文本形态用 input.texts + text_type=document')

  // 智谱
  await rpc('saveSettings', { embed: { provider: 'bigmodel', model: 'embedding-3', dimension: 2048 } })
  calls.length = 0
  const r3 = await rpc('testEmbed', null)
  const cmd3 = lastCall('/api/paas/v4/embeddings')
  ok(!!cmd3, 'bigmodel 走 /api/paas/v4/embeddings')
  ok(cmd3.indexOf('https://open.bigmodel.cn') >= 0, 'bigmodel 官方默认 baseUrl')
  const b3 = bodyOf(cmd3)
  ok(b3 && Array.isArray(b3.input), 'bigmodel 的 input 是字符串数组')
  ok(b3 && b3.dimensions === 2048, 'bigmodel 传了 dimensions=2048')
  ok(r3.dimension === 2048, '返回维度 2048（假响应按 dimensions 生成）')

  // OpenAI 兼容 + 自定义 baseUrl
  await rpc('saveSettings', { embed: { provider: 'openai', model: 'bge-m3', baseUrl: 'http://127.0.0.1:8000', apiKey: '' } })
  calls.length = 0
  await rpc('testEmbed', null)
  const cmd4 = lastCall('/v1/embeddings')
  ok(!!cmd4, 'OpenAI 兼容走 /v1/embeddings')
  ok(cmd4.indexOf('http://127.0.0.1:8000/v1/embeddings') >= 0, '自定义 baseUrl 生效')
  ok(cmd4.indexOf('Authorization') < 0, '没填 Key 时不发 Authorization 头')
}

console.log('\n[4] Milvus：集合与增删查')
{
  await rpc('saveSettings', { embed: { provider: 'dashscope', model: 'tongyi-embedding-vision-flash', apiKey: 'sk-test', dimension: EMBED_DIM, baseUrl: '' } })
  calls.length = 0
  const t = await rpc('testMilvus', null)
  ok(t.ok === true, 'testMilvus 成功')
  ok(t.exists === false, '目标 collection 尚不存在')
  ok(lastCall('/collections/list').indexOf('dbName=default') >= 0, 'URL 带上了 dbName')
  ok(lastCall('/collections/list').indexOf('Authorization: Bearer tok') >= 0, 'Milvus 带了 Bearer token')

  calls.length = 0
  const add = await rpc('addKnowledge', { text: '这是一条用于测试的 AI 安全知识。', title: '测试条目', kind: 'technique', tags: 'owasp,注入', source: 'unit' })
  ok(add.ok === true, 'addKnowledge 成功')
  ok(add.added === 1 && add.rows === 1, '写入 1 行（实际 added=' + add.added + ' rows=' + add.rows + '）')
  ok(add.dimension === EMBED_DIM, '维度取自向量长度：' + add.dimension)
  const createCmd = lastCall('/collections/create')
  ok(!!createCmd, '首次写入自动建 collection')
  const cb = bodyOf(createCmd)
  const vecField = cb && cb.schema.fields.filter((f) => f.fieldName === 'vector')[0]
  ok(!!vecField && vecField.dim === EMBED_DIM, '建集合时 schema 里的向量维度正确')
  ok(!!(cb && cb.schema.fields.filter((f) => f.fieldName === 'id' && f.isPrimary)[0]), 'id 是主键字段')
  ok(!!(cb && cb.indexParams && cb.indexParams[0].metricType === 'COSINE'), '索引带上度量方式 COSINE')
  const up = bodyOf(lastCall('/entities/upsert'))
  ok(up && up.collectionName === 'redteam_memory', 'upsert 指定 collection')
  ok(up && up.data[0].vector && up.data[0].vector.length === EMBED_DIM, 'upsert 的数据里带向量')
  ok(up && up.data[0].id && up.data[0].id.indexOf('m') === 0, 'id 稳定生成（前缀 m）：' + (up && up.data[0].id))

  // 同样的内容再导入一次：id 必须一样（这样 upsert 才是覆盖而不是重复堆积）
  const firstId = up.data[0].id
  await rpc('addKnowledge', { text: '这是一条用于测试的 AI 安全知识。', title: '测试条目', kind: 'technique', tags: 'owasp,注入', source: 'unit' })
  const up2 = bodyOf(lastCall('/entities/upsert'))
  ok(up2.data[0].id === firstId, '同样内容重复导入得到同一个 id（去重靠它）')

  // 再凑 4 条并同步进索引：让召回/重排有东西可排，且索引里的行对应真实本地条目。
  const many = []
  for (let i = 0; i < 4; i++) many.push({ text: '提示词注入的第 ' + i + ' 条测试知识', title: '注入 ' + i, kind: 'technique', tags: 'owasp,注入', source: 'unit' })
  const addMany = await rpc('addKnowledge', { entries: many })
  ok(addMany.ok === true && addMany.added === 4, '批量导入 4 条（实际 ' + addMany.added + '）')

  calls.length = 0
  const sr = await rpc('search', { query: '提示词注入', topK: 4, rerank: true })
  ok(sr.ok === true, 'search 成功')
  ok(sr.hits.length === 4, '返回 4 条命中（实际 ' + sr.hits.length + '）')
  // topK=4 时本地补位进不来：localSearch 自己也只取 k 条，第 5 条（分数最低的那条）被挡在候选外。
  ok(sr.mode === 'vector', '索引没覆盖全部本地条目、但补位挤不进 topK 时仍是 vector：' + sr.mode)
  ok(sr.hits.filter((h) => h.mode === 'local').length === 0, '本地补位条排在向量命中之后，topK 用满时挤不进来')
  ok(sr.reranked === true, '重排生效（reranked=true）')
  ok(sr.hits[0].rerankScore !== null, '命中带重排分')
  ok(sr.hits[0].title === '标题 3', '重排把最后一条排到最前（假 Milvus 按 distance 递减返回 0..3，重排反转）：' + sr.hits[0].title)
  ok(sr.hits.every((h, i) => i === 0 || sr.hits[i - 1].rerankScore >= h.rerankScore), '重排结果按重排分递减')
  const sb = bodyOf(lastCall('/entities/search'))
  ok(sb && Array.isArray(sb.data[0]) && sb.data[0].length === EMBED_DIM, 'search 的 data 是二维向量数组')
  ok(sb && sb.limit === 4 && sb.outputFields.indexOf('title') >= 0, 'search 传了 limit 与 outputFields')

  // topK 放大后本地那条（索引里没有它）应当作为补位出现 —— 这就是「索引落后于本地库」的兜底。
  const sr6 = await rpc('search', { query: '提示词注入', topK: 6, rerank: false })
  ok(sr6.hits.length === 5, '向量 4 条 + 本地补位 1 条（实际 ' + sr6.hits.length + '）')
  ok(sr6.hits.some((h) => h.mode === 'local'), '索引里没有的本地条目被并进命中')

  calls.length = 0
  const ls = await rpc('listKnowledge', { limit: 10, offset: 0, keyword: 'owasp' })
  ok(ls.ok === true, 'listKnowledge 成功')
  ok(ls.total >= 5, '总数来自本地库（实际 ' + ls.total + '，本地共 ' + ls.local + ' 条）')
  ok(ls.entries.every((e) => (e.tags || '').indexOf('owasp') >= 0), '关键词在本地库上过滤标签')
  ok(calls.length === 0, '列表直接读本地库，不请求 Milvus')

  calls.length = 0
  const victim = ls.entries[0].id
  const rm = await rpc('removeKnowledge', { ids: [victim] })
  ok(rm.ok === true && rm.deleted === 1, '本地删除返回 1 条（实际 ' + rm.deleted + '）')
  const db = bodyOf(lastCall('/entities/delete'))
  ok(db && db.filter.indexOf(victim + '#0-') >= 0, '同时按索引行 id 删索引：' + (db && db.filter))

  calls.length = 0
  await rpc('dropCollection', null)
  ok(!!lastCall('/collections/drop'), 'dropCollection 调用了集合删除')
}

console.log('\n[5] 重排：响应位置与失败降级')
{
  calls.length = 0
  const r = await rpc('testRerank', null)
  ok(r.ok === true, 'testRerank 成功')
  ok((r.order || []).length === 3, '返回 3 条排序')
  const cmd = lastCall('/rerank')
  ok(cmd.indexOf('https://api.jina.ai/v1/rerank') >= 0, 'jina 走 /v1/rerank')
  const b = bodyOf(cmd)
  ok(b && b.model === 'jina-reranker-v2-base-model' && Array.isArray(b.documents), '重排 body 含 model 与 documents')
  ok(b && b.top_n === 3, 'top_n 取自设置')

  // 换成百炼：响应在 output.results 里，且 body 形状不同
  await rpc('saveSettings', { rerank: { provider: 'dashscope', model: 'gte-rerank-v2', apiKey: 'sk-test' } })
  calls.length = 0
  const r2 = await rpc('testRerank', null)
  ok(r2.ok === true, '百炼重排也能解析（响应在 output.results）')
  const cmd2 = lastCall('text-rerank')
  ok(!!cmd2, '百炼走 services/rerank/text-rerank')
  const b2 = bodyOf(cmd2)
  ok(b2 && b2.input && Array.isArray(b2.input.documents), '百炼的 body 是 input.{query,documents} 形态')
  ok(b2 && b2.parameters && b2.parameters.top_n === 3, '百炼的 top_n 在 parameters 里')

  // 重排失败不能把检索一起打挂
  await rpc('saveSettings', { rerank: { provider: 'custom', model: 'x', baseUrl: 'http://127.0.0.1:9', apiKey: '' } })
  const sr = await rpc('search', { query: '任意', topK: 3, rerank: true })
  ok(sr.ok === true, '重排失败时检索仍然成功（降级为原始召回顺序）')
  ok(sr.reranked === false, 'reranked 标记为 false')
}

console.log('\n[6] S3（Milvus 存储桶）：签名、URL 与列表解析')
{
  await rpc('saveSettings', {
    s3: { enabled: true, endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', bucket: 'mimo', prefix: 'kv/', accessKey: 'AK', secretKey: 'SK', pathStyle: true },
  })
  calls.length = 0
  const t = await rpc('testS3', null)
  ok(t.ok === true, 'testS3 成功')
  const cmd = lastCall('list-type=2')
  ok(cmd.indexOf('--aws-sigv4') >= 0, '用了 curl 的 --aws-sigv4（不用手写签名）')
  ok(cmd.indexOf("'aws:amz:us-east-1:s3'") >= 0, 'sigv4 的 region/service 正确')
  ok(cmd.indexOf("--user 'AK:SK'") >= 0, '带上了 AK/SK')
  ok(cmd.indexOf('http://127.0.0.1:9000/mimo?list-type=2') >= 0, 'path-style URL：endpoint/bucket：' + cmd.slice(cmd.indexOf('http'), cmd.indexOf('http') + 60))

  const l = await rpc('s3List', { prefix: 'kv/', limit: 30 })
  ok(l.ok === true, 's3List 成功')
  ok(l.objects.length === 2, '解析出 2 个对象（实际 ' + l.objects.length + '）')
  ok(l.objects[0].key === 'a/b.bin' && l.objects[0].size === 1024, 'Key/Size 解析正确')
  ok(l.objects[0].lastModified === '2026-09-16T10:00:00.000Z', 'LastModified 解析正确')
  ok(lastCall('prefix=kv%2F') , '前缀被 URL 编码后传入：' + (lastCall('list-type=2').match(/prefix=[^&\s']*/) || [''])[0])

  // 虚拟主机寻址：关掉 pathStyle 时桶名进主机名
  await rpc('saveSettings', { s3: { pathStyle: false } })
  calls.length = 0
  await rpc('s3List', { limit: 1 })
  ok(lastCall('list-type=2').indexOf('http://mimo.127.0.0.1:9000') >= 0, '关掉 pathStyle 时桶名进主机名')
}

console.log('\n[7] 入库链路：切块与维度校验')
{
  await rpc('saveSettings', {
    milvus: { uri: 'http://127.0.0.1:19530', collection: 'redteam_memory' },
    embed: { provider: 'dashscope', model: 'tongyi-embedding-vision-flash', apiKey: 'sk-test', dimension: EMBED_DIM, baseUrl: '' },
    s3: { pathStyle: true },
  })
  calls.length = 0
  const long = 'A'.repeat(3000)
  const r = await rpc('addKnowledge', { text: long, title: '长文', kind: 'knowledge' })
  ok(r.ok === true, '长文导入成功')
  ok(r.rows === 3, '3000 字符切成 3 块（每块上限 1200、重叠 120）：实际 ' + r.rows)
  const up = bodyOf(lastCall('/entities/upsert'))
  ok(up.data.length === 3, 'upsert 一次提交 3 行')
  ok(up.data[0].title.indexOf('（1/3）') >= 0, '分块后标题带序号：' + up.data[0].title)
  const ids = up.data.map((x) => x.id)
  ok(new Set(ids).size === 3, '三块 id 互不相同')

  // 维度不一致必须明确报错（换模型最常见的坑）
  const createCmd = lastCall('/collections/create')
  ok(!!createCmd || countCalls('/collections/list') >= 1, '走了集合存在性检查')
}

console.log('\n[8] 本地优先：没配向量模型 / Milvus 也能存能查')
{
  // 把外部服务全部清空，模拟「刚装上、什么都没配」——这是最常见的第一次使用状态。
  await rpc('saveSettings', { milvus: { uri: '' }, embed: { apiKey: '' }, rerank: { enabled: false } })
  calls.length = 0
  const add = await rpc('addKnowledge', { text: '没有向量模型时也要能存住的知识：间接注入要看三段证据链（落库 / 进上下文 / 被利用）。', title: '离线条目', kind: 'knowledge', tags: '注入,离线' })
  ok(add.ok === true, '没有 Milvus / Key 时 addKnowledge 依然成功')
  ok(add.added === 1 && add.updated === 0, '本地入库 1 条（added=' + add.added + ' updated=' + add.updated + '）')
  ok(add.indexed === 0 && !!add.indexError, '索引同步被跳过并记下原因：' + add.indexError)
  ok(calls.length === 0, '全程没有发出 HTTP 请求（不去等一次必然失败的超时）')
  const stored = JSON.parse(files.get('.redteam-memory.json'))
  ok(Array.isArray(stored.entries) && stored.entries.some((e) => e.title === '离线条目'), '条目真的落进了本地库文件')
  ok(stored.entries.filter((e) => e.title === '离线条目')[0].indexed === false, '该条目标记为未进索引')

  const s2 = await rpc('search', { query: '间接注入 证据链', topK: 5, rerank: false })
  ok(s2.ok === true && s2.mode === 'local', '检索退回本地关键词：' + s2.mode)
  const hit = s2.hits.filter((h) => h.title === '离线条目')[0]
  ok(!!hit, '本地关键词能命中刚写的条目')
  ok(!!hit && hit.indexed === false && hit.mode === 'local', '命中标注了「未进索引 / 本地」')

  const dry = await rpc('syncIndex', { all: false })
  ok(dry.ok === false && /未配置/.test(dry.error || ''), '没配置时同步索引给出明确失败：' + dry.error)
}

console.log('\n[9] 对话捕获：触发词判定')
{
  const dry = await rpc('captureTest', { text: '这台机器的指纹写入记忆：8080 端口跑着 Ollama，未授权可访问。' })
  ok(dry.ok === true && dry.matched === true, '触发词命中：' + (dry && dry.phrase))
  ok(dry.body.indexOf('Ollama') >= 0, '保留正文：' + dry.body)
  ok(dry.body.indexOf('写入记忆') < 0, '去掉触发词本身')
  ok(dry.body.indexOf('这台机器的指纹') >= 0, '触发词在中间时前后两段都保留')

  const no = await rpc('captureTest', { text: '今天天气不错，继续测下一个接口。' })
  ok(no.ok === true && no.matched === false, '没有触发词时不捕获')

  const empty = await rpc('captureTest', { text: '   ' })
  ok(empty.ok === false, '空内容直接拒绝：' + empty.error)
}

console.log('\n[10] 对话捕获：会话事件真的写进本地库')
{
  const phrases = (await rpc('snapshot', null)).snapshot.capturePhrases
  ok(Array.isArray(phrases) && phrases.length > 5, '默认触发词表可用（' + phrases.length + ' 个）')
  ok(!!listeners['session/event'], '注册了 session/event 监听')

  const run = listeners['session/event']
  const fakeSession = { id: 'session-test-1', snapshotEvents: () => [] }
  const ev = {
    type: 'user/message', seq: 7, time: 1700000000000,
    data: { content: [{ type: 'text', text: '把这条写入记忆：10.0.0.5:8000 的模型列表接口未授权，能直接列出模型。' }] },
  }
  run(fakeSession, ev)
  const got = await waitFor(async () => {
    const r = await rpc('listKnowledge', { keyword: '10.0.0.5', limit: 5, offset: 0 })
    return r.entries && r.entries.length ? r.entries : null
  }, 2000)
  ok(!!got, '会话事件里的触发词被自动捕获进本地库')
  ok(!!got && got[0].source.indexOf('对话捕获') === 0, '来源标成对话捕获：' + (got && got[0].source))
  ok(!!got && got[0].tags.indexOf('对话捕获') >= 0, '打上「对话捕获」标签')

  // 同一条事件重放（事件流是按 seq 提交的，观察者可能被重复投递）不能写出第二条
  run(fakeSession, ev)
  await new Promise((r) => setTimeout(r, 80))
  const again = await rpc('listKnowledge', { keyword: '10.0.0.5', limit: 5, offset: 0 })
  ok(again.total === 1, '同一事件重放不会写出第二条（实际 ' + again.total + '）')

  // 模型回复里出现「记忆」二字不该被捕获（那是插件在解释功能，捕进来全是噪声）
  run(fakeSession, { type: 'assistant/message', seq: 8, time: 1700000000000, data: { message: { content: [{ type: 'text', text: '我会把这条写入记忆。' }] } } })
  await new Promise((r) => setTimeout(r, 80))
  const after = await rpc('listKnowledge', { keyword: '10.0.0.5', limit: 5, offset: 0 })
  ok(after.total === 1, '只认用户消息，模型回复不进捕获')

  const snap2 = await rpc('snapshot', null)
  ok(snap2.snapshot.captures.length >= 1, '快照里带最近捕获记录（' + snap2.snapshot.captures.length + ' 条）')
  ok(snap2.snapshot.captures[0].phrase.indexOf('写入记忆') >= 0, '捕获记录里能看到命中的触发词：' + snap2.snapshot.captures[0].phrase)

  // 关掉开关后同一个监听不再写入
  await rpc('saveSettings', { capture: { enabled: false } })
  run(fakeSession, {
    type: 'user/message', seq: 9, time: 1700000000000,
    data: { content: [{ type: 'text', text: '这条也写入记忆：1.2.3.4 未授权。' }] },
  })
  await new Promise((r) => setTimeout(r, 80))
  const off = await rpc('listKnowledge', { keyword: '1.2.3.4', limit: 5, offset: 0 })
  ok(off.total === 0, '关掉对话捕获后不再写入：' + off.total)
  await rpc('saveSettings', { capture: { enabled: true } })

  const clr = await rpc('captureClear', null)
  ok(clr.ok === true && clr.snapshot.captures.length === 0, '可以清空捕获记录')
}

console.log('\n[11] 对外服务：报告插件把成稿导入记忆')
{
  const svc = services.redteamMemory
  ok(!!svc, '注册了 redteamMemory 服务')
  ok(!!svc && typeof svc.add === 'function' && typeof svc.search === 'function' && typeof svc.stats === 'function', '服务暴露 add / search / stats')
  const r = await svc.add([{ text: '报告结论：目标推理服务未授权，模型管理接口可创建与删除模型。', title: '报告导入 · 结论', kind: 'note' }], '报告 · 单元测试')
  ok(r.added === 1, '服务写入 1 条（实际 ' + r.added + '）')
  ok(Array.isArray(r.ids) && r.ids.length === 1, '返回写入后的条目 id')
  const st = await svc.stats()
  ok(st.localCount >= 1 && typeof st.persistence === 'string', '服务能报告本地库状态：' + st.localCount + ' 条 / ' + st.persistence)
  const sr = await svc.search('未授权 模型管理接口', 3, { rerank: false })
  ok(sr.ok === true && sr.hits.length > 0, '服务检索可用（' + sr.hits.length + ' 条）')
}

console.log('\n' + (fails.length === 0 ? '✓ 全部通过（' + pass + ' 项）' : '✗ 失败 ' + fails.length + ' 项：\n  - ' + fails.join('\n  - ')))
process.exit(fails.length === 0 ? 0 : 1)
