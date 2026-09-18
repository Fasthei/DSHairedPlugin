// 红队记忆 · Host 半边主体
//
// 本文件是 applyHost 的【函数体】——函数头、harness 垫片、收尾与导出都由
// lib/parts/host.head.js 与 host.tail.js 提供，所以这里不要写 import、function 头或 return 块。
// lib/host.js 由 `npm run build:lib` 生成，不要手改 lib/。
//
// ── 这个插件干什么 ────────────────────────────────────────────────────────────
// 给模型一个**可检索的 AI 安全知识库**：把 AI 安全知识与进攻技巧（OWASP LLM Top 10、
// 提示词注入、RAG 投毒、Agent/MCP 工具滥用、推理服务未授权与已知 CVE…）存进本地库，
// 模型用 memory_search 检索，人可以在面板上导入 / 删除 / 浏览。
//
// ── 架构：本地库是权威数据，Milvus 只是它的派生索引 ────────────────────────────
//   .redteam-memory.json（本地条目，一定写得进去）
//     └─ 同步 → Milvus（向量召回 + 可选重排：jina / siliconflow / dashscope / cohere / bigmodel）
//                向量模型（阿里 tongyi-embedding-vision-flash / 智谱 Embedding-3 / OpenAI 兼容）
//     └─ 同步失败也不影响读写：检索自动退回本地关键词匹配，面板上能看到待同步条数。
//   MinIO（Milvus 用的存储桶，例如 mimo）：连通测试 / 列举 / 整库导出（导出源同样是本地库）
//
// 这条「本地优先」的顺序是刻意的：记忆是给人用的，不该因为外部服务没配好就写不进去。
// 对话捕获（工作区里有人说「写入记忆」）尤其依赖它 —— 捕获必须「说了就记住」。
//
// ── 为什么 HTTP 走 shell+curl 而不是 fetch ────────────────────────────────────
// 动态半边屏蔽了 fetch（见 ../../docs/DEVELOPMENT.md），而本插件两种形态都要能跑。
// 资产图谱调 Jina MCP 用的就是同一套：ctx.get('shell') → curl。顺带一个好处：
// curl 自带 --aws-sigv4，S3 的签名不用手写。
//
// 动态半边写文件的沙箱边界（实测，见 ../../docs/DEVELOPMENT.md §5.1）：
//   fs.resolve(相对路径) 落在**插件自己的默认工作区**（本机是 /home/kali/桌面），
//   写它之外的绝对路径会被拒（file access denied under workspace-write mode），
//   但**读**任何路径都允许。所以 storePath 默认用相对名，并把解析出的宿主路径显示在面板上。
//
// 静态形态与动态半边的差异（详见 ../../docs/DEVELOPMENT.md）：
//   - 工具与 RPC 统一用 harness.defineTool / harness.registerTool / harness.handle
//     （静态包的 host.head.js 提供垫片把它们映射到 defineTool / ctx.tools.register / HTTP 路由）

  // ── 常量 ──────────────────────────────────────────────────────────────────
  const STORE_NAME = '.redteam-memory.json'
  const STORE_VERSION = 2
  const LOG_MAX = 120
  const ENTRY_MAX = 5000
  const CAPTURE_MAX = 50
  const INDEX_BATCH = 16

  // 导入只认这四类。刻意不扩：格式越多，「导入失败」的成因就越多，而这四类覆盖了
  // 红队现场真正会拿到的东西（报告 / 笔记 / 扫描导出的 txt）。解析都不引依赖：
  // md、txt 直接读；docx 借 unzip 取 word/document.xml；pdf 借 pdftotext（poppler）。
  const IMPORT_EXT = ['.md', '.markdown', '.txt', '.docx', '.pdf']
  const IMPORT_LABEL = 'pdf / word(.docx) / md / txt'
  // word / pdf 抽出来的是纯文本、没有 markdown 记号，按空行分段再按长度归拢，
  // 否则整份文档会变成一条巨大条目（切块后标题只剩「x（1/40）」）。
  const PLAIN_GROUP_MAX = 2000

  // 对话捕获的默认触发词。命中任意一个就把这条消息收进记忆库 ——
  // 「写入记忆」这类说法是红队队员的自然表达，不该要求他们换用工具。
  const CAPTURE_PHRASES = '写入记忆,写到记忆,记到记忆,记入记忆,存到记忆,存入记忆,存进记忆,记录到记忆,加入记忆,加到记忆,记住这点,记住这个,remember this,save to memory'
  const HTTP_TIMEOUT_MS = 60000
  const EMBED_BATCH = 16
  const INSERT_BATCH = 50
  const CHUNK_MAX = 1200
  const CHUNK_OVERLAP = 120
  const LIST_DEFAULT = 50
  const KINDS = ['knowledge', 'technique', 'payload', 'checklist', 'note']

  // 向量模型预设。dimension 是默认维度，建集合时用它；换模型必须换集合或删掉重建。
  const EMBED_PRESETS = {
    dashscope: {
      label: '阿里百炼 DashScope',
      base: 'https://dashscope.aliyuncs.com',
      keyHint: 'sk-…（百炼控制台的 API Key）',
      models: [
        { id: 'tongyi-embedding-vision-flash', dimension: 1024, note: '多模态（文本+图）flash，默认 1024 维' },
        { id: 'tongyi-embedding-vision-plus', dimension: 1152, note: '多模态 plus' },
        { id: 'text-embedding-v4', dimension: 1024, note: '纯文本，可选 1024/768/512/256/128/64' },
      ],
    },
    bigmodel: {
      label: '智谱 BigModel',
      base: 'https://open.bigmodel.cn',
      keyHint: '…（bigmodel.cn 的 API Key）',
      models: [
        { id: 'embedding-3', dimension: 2048, note: '默认 2048 维，可指定 2048/1024/512/256' },
        { id: 'embedding-2', dimension: 1024, note: '上一代，1024 维' },
      ],
    },
    openai: {
      label: 'OpenAI 兼容（自建 / 其它厂商）',
      base: '',
      keyHint: '按你的服务填，不需要鉴权可留空',
      models: [
        { id: 'text-embedding-3-large', dimension: 3072, note: 'OpenAI' },
        { id: 'text-embedding-3-small', dimension: 1536, note: 'OpenAI' },
        { id: 'bge-m3', dimension: 1024, note: '本地 vLLM / Ollama 常见' },
      ],
    },
  }

  // 重排模型预设：常见的都列上，直接选，不用记路径。
  const RERANK_PRESETS = {
    jina: { label: 'Jina Reranker', base: 'https://api.jina.ai', path: '/v1/rerank', models: ['jina-reranker-v2-base-multilingual', 'jina-reranker-v3', 'jina-reranker-m0'] },
    siliconflow: { label: 'SiliconFlow 硅基流动', base: 'https://api.siliconflow.cn', path: '/v1/rerank', models: ['BAAI/bge-reranker-v2-m3', 'BAAI/bge-reranker-v2-minicpm-layerwise', 'Qwen/Qwen3-Reranker-8B', 'netease-youdao/bce-reranker-base_v1'] },
    dashscope: { label: '阿里百炼 gte-rerank', base: 'https://dashscope.aliyuncs.com', path: '/api/v1/services/rerank/text-rerank/text-rerank', models: ['gte-rerank-v2', 'qwen3-reranker-8b'] },
    cohere: { label: 'Cohere Rerank', base: 'https://api.cohere.com', path: '/v1/rerank', models: ['rerank-v3.5', 'rerank-multilingual-v3.0', 'rerank-english-v3.0'] },
    bigmodel: { label: '智谱 Rerank', base: 'https://open.bigmodel.cn', path: '/api/paas/v4/rerank', models: ['rerank'] },
    custom: { label: '自定义（OpenAI 兼容 /v1/rerank）', base: '', path: '/v1/rerank', models: [] },
  }

  // 内置知识包：装完点一下「导入内置知识包」就能检索，不必先自己灌数据。
  // 每条都是公开、可写进报告的知识点，不是可直接执行的东西。
  const SEED_KNOWLEDGE = [
    { title: 'OWASP LLM01 提示词注入', kind: 'knowledge', tags: 'owasp,注入', text: '把指令伪装成数据塞进模型上下文，使它偏离原定职责。直接注入 = 用户在对话里覆盖系统指令；间接注入 = 载荷藏进模型会读到的文档/网页/工具返回里。测试要点：先确认哪些输入真的进了模型上下文 —— 只读 message 字段的系统，往其它字段塞载荷是无效的；再确认工具返回值是否被当指令执行。' },
    { title: 'OWASP LLM02 敏感信息泄露', kind: 'knowledge', tags: 'owasp,泄露', text: '模型输出里带出不该带出的内容：系统提示词、内部文档、他人数据、凭据。要区分「模型复述了上下文里的东西」与「应用把敏感数据拼进了上下文」，后者才是可用发现。留证时同时保存原始请求与响应。' },
    { title: 'OWASP LLM03 供应链', kind: 'knowledge', tags: 'owasp,供应链', text: '模型权重、微调数据、推理框架、依赖包任一环被污染都会传导到应用。红队视角：确认推理服务与版本（例如 Ollama 的版本号）、模型来源与哈希、是否允许外部拉取模型；公开 CVE 与官方披露是主要线索来源。' },
    { title: 'OWASP LLM04 数据与模型投毒', kind: 'knowledge', tags: 'owasp,投毒', text: '污染训练或检索数据以影响模型行为。RAG 场景更现实的是投毒检索库：只要能写进知识库，就可能影响后续回答。验证关键是「写进去的内容会不会被读出来」—— 写入计数增长不等于内容被处理，必须找到读回路径才算数。' },
    { title: 'OWASP LLM05 不当输出处理', kind: 'knowledge', tags: 'owasp,下游注入', text: '模型输出被下游直接当代码/命令/HTML/SQL 使用。关注输出是否流入 shell、模板、SQL、浏览器 DOM（XSS）或工具参数。这条通常与「Agent 工具调用」串起来打。' },
    { title: 'OWASP LLM06 过度代理权限', kind: 'knowledge', tags: 'owasp,agent', text: 'Agent 拿着超出需要的权限（能删数据、能发外部请求、能读文件）。测试要点：逐一确认每个工具的真实副作用，而不是看它的描述 —— 描述写着只读的工具也可能真的会改数据。' },
    { title: 'OWASP LLM07 系统提示词泄露', kind: 'knowledge', tags: 'owasp,提示词', text: '套出系统提示词。常见手法：要求复述、角色扮演、翻译/编码变换、要求以 JSON 或表格输出上下文。拿到后重点看有没有藏在提示词里的凭据、内部端点、业务规则。' },
    { title: 'OWASP LLM08 向量与嵌入弱点', kind: 'knowledge', tags: 'owasp,向量库', text: '嵌入与向量库本身可被攻击：越权读写 collection、检索越权（搜到别的租户内容）、嵌入反演（从向量近似还原原文）。红队要确认向量库是否有认证、是否按租户隔离、是否暴露管理接口。' },
    { title: 'OWASP LLM09 错误信息（幻觉）', kind: 'knowledge', tags: 'owasp,幻觉', text: '模型编造不存在的事实并让使用者据此行动。红队价值在于证明「编造内容会被下游当真」—— 例如让 Agent 依据幻觉去调用工具或写数据。' },
    { title: 'OWASP LLM10 模型拒绝服务', kind: 'knowledge', tags: 'owasp,dos', text: '用超长上下文、递归工具调用、批量并发把推理资源吃满。测试限定在授权环境且要能恢复：先记录 QPS/耗时基线，再对比攻击后的基线，用数据说明影响。' },
    { title: '间接注入：文档上传链路', kind: 'technique', tags: '注入,rag', text: '把载荷写成「正常文档」（季度报告、README、工单），诱导模型在检索时读到。验证链看三段：上传是否真的落库（计数/列表）、文档是否被处理进上下文（检索命中）、载荷是否被执行（工具被调用或内容被反射）。三段缺一段就不算成功。' },
    { title: '工具与 MCP 服务枚举', kind: 'technique', tags: '枚举,agent', text: '先问出模型有哪些工具/命令（"你有哪些可以调用的工具或函数？"），再逐个验证是否真的存在、是否真的有副作用。很多目标的工具列表是装饰性的 —— 只在提示词里写着，后端没有对应端点。' },
    { title: 'RAG 索引目标收集', kind: 'technique', tags: 'rag,收集', text: '知识库往往比对话更值钱。路径：确认知识库接口（上传/列表/读取）、确认读写是否同一份数据、用主题词把内容勾出来（按 topic 注入再按 topic 查询）。写入路径与读取路径不相通是常见现象。' },
    { title: '未授权访问与默认口令', kind: 'technique', tags: '未授权,凭据', text: '暴露的推理服务（Ollama / vLLM / TGI 等）常常没有认证。顺序：直接调用 API 看是否要凭据 → 试官方默认端口与默认口令 → 看响应头与错误信息是否泄露版本（版本决定可用 CVE）。所有验证限定在授权范围内。' },
    { title: '模型管理接口的滥用面', kind: 'technique', tags: 'ollama,cve', text: '推理服务的模型管理接口（/api/create、/api/pull、/api/delete）常被忽略：未授权时能创建/删除模型，部分版本还能借 from / modelfile 参数读取路径（GGUF 相关 CVE）。要点：先确认接口是否要鉴权，再看参数接受的输入类型，最后验证副作用（模型清单变化）。' },
    { title: '证据与合规：报告要留什么', kind: 'checklist', tags: '报告,证据', text: '每条确认的发现都要能复现：原始请求（含认证状态）、原始响应、时间戳、影响说明。测试结束要清理自己写入的东西（上传的文档、创建的模型、数据库里的过程），并在报告里写明清理结果 —— 这既是职业要求，也避免污染授权环境。' },
  ]

  function blankSettings() {
    return {
      milvus: { uri: '', token: '', dbName: 'default', collection: 'redteam_memory', metric: 'COSINE' },
      embed: { provider: 'dashscope', model: 'tongyi-embedding-vision-flash', apiKey: '', dimension: 1024, baseUrl: '' },
      rerank: { enabled: false, provider: 'jina', model: 'jina-reranker-v2-base-multilingual', apiKey: '', baseUrl: '', topN: 8 },
      s3: { enabled: false, endpoint: '', region: 'us-east-1', bucket: 'mimo', prefix: '', accessKey: '', secretKey: '', pathStyle: true },
      // 对话捕获：工作区里有人说「写入记忆」就自动入库，不需要额外配置向量库。
      capture: { enabled: true, phrases: CAPTURE_PHRASES, kind: 'note', withContext: true },
      storePath: STORE_NAME,
      searchTopK: 8,
    }
  }

  function blankStore() {
    return {
      version: STORE_VERSION,
      updatedAt: 0,
      settings: blankSettings(),
      // 本地条目是**权威数据**：Milvus 只是它的派生索引。
      // 这样没有向量模型 Key 也能记录与检索，网络故障也不会丢数据。
      entries: [],
      captures: [],
      log: [],
      logSeq: 0,
      meta: {
        collectionReady: false, dimension: 0, rowCount: 0, indexed: 0,
        lastError: null, lastOp: null, progress: null, seeded: false,
        persistence: 'unknown', storePath: '',
      },
    }
  }

  // ── 工具函数 ──────────────────────────────────────────────────────────────
  function msgOf(e) { return e && e.message ? String(e.message) : String(e) }
  function nowMs() { return Date.now() }
  function clip(s, n) {
    const v = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim()
    return v.length > n ? v.slice(0, n - 1) + '…' : v
  }
  function intOf(v, d) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : d }
  function boolOf(v, d) { return typeof v === 'boolean' ? v : (v === 'true' ? true : (v === 'false' ? false : d)) }

  // 单引号包裹的 shell 参数。把 JSON 内联进命令时必须走它，否则引号会被 shell 吃掉。
  function shQuote(s) { return "'" + String(s === undefined || s === null ? '' : s).replace(/'/g, "'\\''") + "'" }

  // 稳定内容 id：动态沙箱里没有 crypto，双累加器 FNV 变体足够做去重。
  function contentId(parts) {
    const s = parts.join('\u0000')
    let a = 0x811c9dc5, b = 0x01000193
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      a = (a ^ c) >>> 0; a = (a * 16777619) >>> 0
      b = (b + c * (i + 1)) >>> 0; b = (b ^ (b << 5)) >>> 0
    }
    return 'm' + a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
  }

  function log(level, text) {
    store.logSeq = (store.logSeq || 0) + 1
    store.log.push({ seq: store.logSeq, at: nowMs(), level: level, text: String(text).slice(0, 1200) })
    if (store.log.length > LOG_MAX) store.log = store.log.slice(store.log.length - LOG_MAX)
  }

  function logFailure(prefix, e, extra) {
    log('err', prefix + '：' + msgOf(e) + (extra ? ' [' + extra + ']' : ''))
  }

  // ── 落盘 ──────────────────────────────────────────────────────────────────
  const store = blankStore()
  let loaded = false

  function settings() { return store.settings }

  async function resolveTarget() {
    const fs = ctx.get('fs')
    if (fs === undefined || fs === null) return null
    const target = await fs.resolve(store.settings.storePath || STORE_NAME)
    return { fs: fs, target: target }
  }

  // 只接受已知字段，避免界面上的脏数据写进设置。
  function mergeSettings(src) {
    const d = blankSettings()
    const s = store.settings
    const pick = function (group, keys) {
      const g = src[group]
      if (!g || typeof g !== 'object') return
      for (const k of keys) if (g[k] !== undefined && g[k] !== null) s[group][k] = g[k]
    }
    pick('milvus', Object.keys(d.milvus))
    pick('embed', Object.keys(d.embed))
    pick('rerank', Object.keys(d.rerank))
    pick('s3', Object.keys(d.s3))
    pick('capture', ['enabled', 'kind', 'withContext'])
    if (src.capture && src.capture.phrases !== undefined) s.capture.phrases = String(src.capture.phrases || '').slice(0, 2000)
    if (src.storePath !== undefined) s.storePath = String(src.storePath || STORE_NAME)
    if (src.searchTopK !== undefined) s.searchTopK = intOf(src.searchTopK, 8)
    s.milvus.metric = /^(COSINE|L2|IP)$/.test(String(s.milvus.metric)) ? String(s.milvus.metric) : 'COSINE'
    s.embed.dimension = intOf(s.embed.dimension, 1024)
    s.rerank.topN = Math.max(1, Math.min(50, intOf(s.rerank.topN, 8)))
    s.searchTopK = Math.max(1, Math.min(50, intOf(s.searchTopK, 8)))
    s.rerank.enabled = boolOf(s.rerank.enabled, false)
    s.s3.enabled = boolOf(s.s3.enabled, false)
    s.s3.pathStyle = boolOf(s.s3.pathStyle, true)
    s.capture.enabled = boolOf(s.capture.enabled, true)
    s.capture.withContext = boolOf(s.capture.withContext, true)
    if (KINDS.indexOf(String(s.capture.kind)) < 0) s.capture.kind = 'note'
  }

  // 触发词表：逗号/顿号/换行分隔，去重、去空。
  function capturePhrases(s) {
    const raw = String((s || settings()).capture.phrases || '')
    const out = []
    for (const p of raw.split(/[,，、\n]/)) {
      const v = p.trim()
      if (v && out.indexOf(v) < 0) out.push(v)
    }
    return out
  }

  async function doLoad() {
    try {
      const r = await resolveTarget()
      if (!r) { store.meta.persistence = 'memory'; log('warn', 'fs 服务不可用，本次仅内存保存'); return 0 }
      store.meta.storePath = hostPathOf(r.fs, r.target)
      const info = await r.fs.stat(r.target)
      const parsed = info ? JSON.parse(await r.fs.readText(r.target)) : null
      if (parsed && typeof parsed === 'object') {
        // 版本只用于提示：设置与条目都按字段合并，升级不该丢掉已经配好的 Key。
        if (Number(parsed.version) !== STORE_VERSION) {
          log('warn', '存储版本 ' + parsed.version + ' -> ' + STORE_VERSION + '，按字段合并（不会丢设置）')
        }
        if (parsed.settings && typeof parsed.settings === 'object') mergeSettings(parsed.settings)
        if (Array.isArray(parsed.entries)) {
          for (const e of parsed.entries) {
            const n = asEntry(e)
            if (n) store.entries.push(n)
          }
        }
        if (Array.isArray(parsed.captures)) store.captures = parsed.captures.slice(-CAPTURE_MAX)
        if (Array.isArray(parsed.log)) store.log = parsed.log.slice(-LOG_MAX)
        if (typeof parsed.logSeq === 'number') store.logSeq = parsed.logSeq
        if (parsed.meta && typeof parsed.meta === 'object') {
          store.meta.collectionReady = parsed.meta.collectionReady === true
          store.meta.dimension = intOf(parsed.meta.dimension, 0)
          store.meta.seeded = parsed.meta.seeded === true
          store.meta.indexed = intOf(parsed.meta.indexed, 0)
        }
        recalcMeta()
      }
      store.meta.persistence = 'ready'
      return store.entries.length
    } catch (e) {
      const m = msgOf(e)
      if (!/ENOENT|not found|不存在|null/i.test(m)) {
        store.meta.persistence = 'error'
        store.meta.lastError = '读取记忆库失败：' + m
        log('err', store.meta.lastError)
      } else {
        store.meta.persistence = 'ready'
      }
      return 0
    }
  }

  function hostPathOf(fs, target) {
    try {
      if (typeof fs.processPath === 'function') return String(fs.processPath(target) || '')
    } catch (e) { /* 沙箱实现没有 processPath 时留空 */ }
    return ''
  }

  async function persist() {
    store.updatedAt = nowMs()
    const r = await resolveTarget()
    if (!r) return false
    try {
      const payload = {
        version: STORE_VERSION,
        updatedAt: store.updatedAt,
        settings: store.settings,
        entries: store.entries.slice(-ENTRY_MAX),
        captures: store.captures.slice(-CAPTURE_MAX),
        log: store.log.slice(-LOG_MAX),
        logSeq: store.logSeq,
        meta: {
          collectionReady: store.meta.collectionReady,
          dimension: store.meta.dimension,
          seeded: store.meta.seeded,
          indexed: store.meta.indexed,
        },
      }
      await r.fs.writeText(r.target, JSON.stringify(payload, null, 2))
      store.meta.storePath = hostPathOf(r.fs, r.target)
      store.meta.persistence = 'ready'
      return true
    } catch (e) {
      store.meta.persistence = 'error'
      store.meta.lastError = '写入失败：' + msgOf(e)
      log('err', store.meta.lastError)
      return false
    }
  }

  async function ensureLoaded() { if (loaded) return 0; loaded = true; return await doLoad() }

  // ── HTTP：统一走 shell + curl ─────────────────────────────────────────────
  async function curlJson(url, opts) {
    const o = opts || {}
    const shell = ctx.get('shell')
    if (shell === undefined || shell === null) throw new Error('shell 服务不可用（HTTP 走 curl，需要 shell 服务）')
    const t = intOf(o.timeoutMs, HTTP_TIMEOUT_MS)
    const parts = ['curl -sS -m ' + Math.ceil(t / 1000), '-X ' + (o.method || 'POST')]
    for (const h of (o.headers || [])) parts.push('-H ' + shQuote(h))
    if (o.body !== undefined && o.body !== null) parts.push('--data-binary ' + shQuote(typeof o.body === 'string' ? o.body : JSON.stringify(o.body)))
    parts.push(shQuote(url))
    // 追加 HTTP 状态码：curl 成功但 HTTP 失败时才能给出准确原因（Milvus 的业务错误反而是 200）
    parts.push('-w ' + shQuote('\\n%{http_code}'))
    const spec = shell.resolve({ command: parts.join(' '), timeoutMs: t + 8000, stdoutMaxBytes: intOf(o.maxBytes, 4000000) })
    const res = await shell.run(spec)
    const raw = res && res.stdout ? String(res.stdout.text || '') : ''
    const errText = res && res.stderr ? String(res.stderr.text || '') : ''
    if (res && res.timedOut) throw new Error('curl 超时（' + Math.round(t / 1000) + 's）')
    const cut = raw.lastIndexOf('\n')
    const body = cut >= 0 ? raw.slice(0, cut) : raw
    const code = cut >= 0 ? Number(raw.slice(cut + 1).trim()) : 0
    if (res && res.exitCode !== 0) throw new Error('curl 退出码 ' + res.exitCode + '：' + clip(errText || body, 240))
    if (!(code >= 200 && code < 300)) throw new Error('HTTP ' + code + '：' + clip(body || errText, 400))
    if (!String(body).trim()) return null
    try { return JSON.parse(body) } catch (e) { throw new Error('响应不是 JSON：' + clip(body, 300)) }
  }

  // ── 向量模型 ──────────────────────────────────────────────────────────────
  function embedPreset(s) { return EMBED_PRESETS[s.embed.provider] || EMBED_PRESETS.dashscope }
  function embedBase(s) { return String(s.embed.baseUrl || '').trim().replace(/\/+$/, '') || embedPreset(s).base }
  function embedHeaders(s) {
    const h = ['Content-Type: application/json']
    if (String(s.embed.apiKey || '').trim()) h.push('Authorization: Bearer ' + String(s.embed.apiKey).trim())
    return h
  }

  async function embedBatch(texts, s) {
    const cfg = s || settings()
    const provider = String(cfg.embed.provider || 'dashscope')
    const model = String(cfg.embed.model || '').trim()
    if (!model) throw new Error('未配置向量模型')
    const base = embedBase(cfg)
    if (!base) throw new Error('未配置向量模型的接口地址（baseUrl）')
    if (!String(cfg.embed.apiKey || '').trim() && provider !== 'openai') {
      log('warn', '向量模型未填 API Key（' + provider + '）：如果服务需要鉴权会返回 401')
    }
    let url, body, pick

    if (provider === 'dashscope') {
      // 多模态与纯文本是两个端点，按模型名判断
      const isMultimodal = /vision|multimodal/i.test(model)
      url = base + (isMultimodal
        ? '/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding'
        : '/api/v1/services/embeddings/text-embedding/text-embedding')
      body = isMultimodal
        ? { model: model, input: { contents: texts.map(function (x) { return { text: x } }) }, parameters: { dimension: cfg.embed.dimension } }
        : { model: model, input: { texts: texts }, parameters: { dimension: cfg.embed.dimension, text_type: 'document' } }
      pick = function (res) {
        const out = res && res.output && res.output.embeddings
        if (!Array.isArray(out)) throw new Error('DashScope 响应里没有 output.embeddings：' + clip(JSON.stringify(res), 300))
        return out.map(function (e) { return e.embedding })
      }
    } else if (provider === 'bigmodel') {
      url = base + '/api/paas/v4/embeddings'
      body = { model: model, input: texts }
      if (cfg.embed.dimension) body.dimensions = cfg.embed.dimension
      pick = function (res) {
        const out = res && res.data
        if (!Array.isArray(out)) throw new Error('BigModel 响应里没有 data：' + clip(JSON.stringify(res), 300))
        return out.slice().sort(function (a, b) { return intOf(a.index, 0) - intOf(b.index, 0) }).map(function (e) { return e.embedding })
      }
    } else {
      url = base + '/v1/embeddings'
      body = { model: model, input: texts }
      if (cfg.embed.dimension && /text-embedding-3/.test(model)) body.dimensions = cfg.embed.dimension
      pick = function (res) {
        const out = res && res.data
        if (!Array.isArray(out)) throw new Error('OpenAI 兼容响应里没有 data：' + clip(JSON.stringify(res), 300))
        return out.slice().sort(function (a, b) { return intOf(a.index, 0) - intOf(b.index, 0) }).map(function (e) { return e.embedding })
      }
    }

    const res = await curlJson(url, { body: body, headers: embedHeaders(cfg), timeoutMs: HTTP_TIMEOUT_MS })
    const vecs = pick(res)
    for (const v of vecs) if (!Array.isArray(v) || v.length === 0) throw new Error('返回了空向量（模型 ' + model + '）')
    if (vecs.length !== texts.length) throw new Error('返回向量数（' + vecs.length + '）与输入条数（' + texts.length + '）不一致')
    return vecs
  }

  async function embedTexts(texts, s) {
    const out = []
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const chunk = texts.slice(i, i + EMBED_BATCH)
      const vecs = await embedBatch(chunk, s)
      for (const v of vecs) out.push(v)
      store.meta.progress = { text: '向量化 ' + Math.min(i + chunk.length, texts.length) + '/' + texts.length, done: i + chunk.length, total: texts.length }
    }
    return out
  }

  // ── 重排模型 ──────────────────────────────────────────────────────────────
  function rerankPreset(s) { return RERANK_PRESETS[s.rerank.provider] || RERANK_PRESETS.jina }
  function rerankReady(s) {
    const cfg = s || settings()
    return cfg.rerank.enabled === true && !!String(cfg.rerank.model || '').trim() && !!String(cfg.rerank.provider || '').trim()
  }

  async function rerankDocs(query, docs, s) {
    const cfg = s || settings()
    const preset = rerankPreset(cfg)
    const base = String(cfg.rerank.baseUrl || '').trim().replace(/\/+$/, '') || preset.base
    if (!base) throw new Error('未配置重排服务的接口地址（baseUrl）')
    const url = base + (preset.path || '/v1/rerank')
    const headers = ['Content-Type: application/json']
    if (String(cfg.rerank.apiKey || '').trim()) headers.push('Authorization: Bearer ' + String(cfg.rerank.apiKey).trim())
    const topN = Math.max(1, Math.min(docs.length, intOf(cfg.rerank.topN, 8)))
    const body = cfg.rerank.provider === 'dashscope'
      ? { model: cfg.rerank.model, input: { query: query, documents: docs }, parameters: { return_documents: false, top_n: topN } }
      : { model: cfg.rerank.model, query: query, documents: docs, top_n: topN }
    const res = await curlJson(url, { body: body, headers: headers, timeoutMs: HTTP_TIMEOUT_MS })
    // 字段位置各家不同：多数在 results，百炼在 output.results；分数多为 relevance_score
    const list = (res && Array.isArray(res.results)) ? res.results
      : ((res && res.output && Array.isArray(res.output.results)) ? res.output.results : null)
    if (!list) throw new Error('重排响应里没有 results：' + clip(JSON.stringify(res), 300))
    const out = []
    for (const r of list) {
      const idx = intOf(r.index, -1)
      if (idx < 0 || idx >= docs.length) continue
      out.push({ index: idx, score: Number(r.relevance_score !== undefined ? r.relevance_score : r.score) || 0 })
    }
    return out
  }

  // ── Milvus（REST v2） ─────────────────────────────────────────────────────
  function milvusCfg(s) { return (s || settings()).milvus }
  function milvusBase(s) { return String(milvusCfg(s).uri || '').trim().replace(/\/+$/, '') }
  function collectionName(s) { return String(milvusCfg(s).collection || 'redteam_memory').trim() || 'redteam_memory' }

  function milvusUrl(path, s) {
    const cfg = milvusCfg(s)
    const base = milvusBase(s)
    if (!base) throw new Error('未配置 Milvus 地址（自建如 http://127.0.0.1:19530，Zilliz 如 https://xxx.api.region.zillizcloud.com）')
    let url = base + path
    if (cfg.dbName) url += (path.indexOf('?') >= 0 ? '&' : '?') + 'dbName=' + encodeURIComponent(String(cfg.dbName))
    return url
  }

  async function milvusCall(path, body, s) {
    const cfg = milvusCfg(s)
    const headers = ['Content-Type: application/json', 'Accept: application/json']
    if (String(cfg.token || '').trim()) headers.push('Authorization: Bearer ' + String(cfg.token).trim())
    const res = await curlJson(milvusUrl('/v2/vectordb' + path, s), { body: body || {}, headers: headers, timeoutMs: HTTP_TIMEOUT_MS })
    // Milvus v2 的业务错误是 HTTP 200 + code != 0
    if (res && typeof res.code === 'number' && res.code !== 0) {
      throw new Error('Milvus 错误 code=' + res.code + '：' + clip(res.message || JSON.stringify(res), 300))
    }
    return res
  }

  async function milvusListCollections(s) {
    const res = await milvusCall('/collections/list', {}, s)
    const d = res && res.data
    if (Array.isArray(d)) return d.map(String)
    if (d && Array.isArray(d.collectionNames)) return d.collectionNames.map(String)
    return []
  }

  async function milvusDescribe(s) {
    const res = await milvusCall('/collections/describe', { collectionName: collectionName(s) }, s)
    return res && res.data ? res.data : null
  }

  // 显式 schema（不用动态字段）：字段类型可控，查询结果稳定。
  function buildSchema(dim) {
    return {
      autoId: false,
      enabledDynamicField: false,
      fields: [
        { fieldName: 'id', dataType: 'VarChar', isPrimary: true, maxLength: 64 },
        { fieldName: 'vector', dataType: 'FloatVector', dim: dim },
        { fieldName: 'title', dataType: 'VarChar', maxLength: 512 },
        { fieldName: 'text', dataType: 'VarChar', maxLength: 16384 },
        { fieldName: 'tags', dataType: 'VarChar', maxLength: 512 },
        { fieldName: 'kind', dataType: 'VarChar', maxLength: 32 },
        { fieldName: 'source', dataType: 'VarChar', maxLength: 512 },
        { fieldName: 'created_at', dataType: 'Int64' },
        { fieldName: 'updated_at', dataType: 'Int64' },
      ],
    }
  }

  function dimOfDescribe(d) {
    const fields = (d && d.fields) || []
    for (const f of fields) {
      const name = String(f.name || f.fieldName || '')
      if (name !== 'vector') continue
      if (f.params && f.params.dim !== undefined) return intOf(f.params.dim, 0)
      if (f.dim !== undefined) return intOf(f.dim, 0)
    }
    return 0
  }

  async function milvusEnsureCollection(s, dim) {
    const name = collectionName(s)
    const list = await milvusListCollections(s)
    if (list.indexOf(name) >= 0) {
      const existing = dimOfDescribe(await milvusDescribe(s))
      if (existing && dim && existing !== dim) {
        throw new Error('集合 ' + name + ' 已存在，向量维度是 ' + existing + '，与当前模型维度 ' + dim + ' 不一致。换模型必须换集合名，或先删掉集合重建。')
      }
      store.meta.collectionReady = true
      store.meta.dimension = existing || dim || 0
      return { created: false, name: name, dimension: store.meta.dimension }
    }
    await milvusCall('/collections/create', {
      collectionName: name,
      schema: buildSchema(dim),
      indexParams: [{ fieldName: 'vector', indexName: 'vector_idx', metricType: String(milvusCfg(s).metric || 'COSINE'), indexType: 'AUTOINDEX' }],
    }, s)
    store.meta.collectionReady = true
    store.meta.dimension = dim
    return { created: true, name: name, dimension: dim }
  }

  async function milvusSearch(vector, topK, s, filter) {
    const body = {
      collectionName: collectionName(s),
      data: [vector],
      limit: Math.max(1, Math.min(200, intOf(topK, 8))),
      outputFields: ['id', 'title', 'text', 'tags', 'kind', 'source', 'created_at'],
    }
    if (filter) body.filter = filter
    const res = await milvusCall('/entities/search', body, s)
    const d = res && res.data
    if (Array.isArray(d)) return d
    if (d && Array.isArray(d.data)) return d.data
    return []
  }

  async function milvusDelete(ids, s) {
    if (!ids.length) return 0
    const quoted = ids.map(function (x) { return '"' + String(x).replace(/"/g, '') + '"' })
    const res = await milvusCall('/entities/delete', { collectionName: collectionName(s), filter: 'id in [' + quoted.join(',') + ']' }, s)
    const d = res && res.data
    return intOf(d && (d.deleteCount !== undefined ? d.deleteCount : d.delete_count), ids.length)
  }

  async function milvusDrop(s) {
    await milvusCall('/collections/drop', { collectionName: collectionName(s) }, s)
    store.meta.collectionReady = false
    store.meta.rowCount = 0
  }

  async function milvusCount(s) {
    try {
      const res = await milvusCall('/collections/get_stats', { collectionName: collectionName(s) }, s)
      const d = res && res.data
      const n = intOf(d && (d.rowCount !== undefined ? d.rowCount : d.row_count), -1)
      if (n >= 0) return n
    } catch (e) { /* 旧版本可能没有 get_stats，退回 query 统计 */ }
    try {
      const res = await milvusCall('/entities/query', { collectionName: collectionName(s), filter: '', outputFields: ['count(*)'], limit: 1 }, s)
      const d = res && res.data
      const first = Array.isArray(d) ? d[0] : (d && Array.isArray(d.data) ? d.data[0] : null)
      if (first) return intOf(first['count(*)'] !== undefined ? first['count(*)'] : first.count, 0)
    } catch (e) { /* 统计拿不到不影响主流程 */ }
    return -1
  }

  // ── MinIO（Milvus 的存储桶，例如 mimo）：curl 自带 --aws-sigv4 ────────────────
  function s3Cfg(s) { return (s || settings()).s3 }
  function s3Ready(s) {
    const c = s3Cfg(s)
    return c.enabled === true && !!String(c.endpoint || '').trim() && !!String(c.bucket || '').trim()
  }

  function s3Url(key, query, s) {
    const c = s3Cfg(s)
    const base = String(c.endpoint).replace(/\/+$/, '')
    const path = c.pathStyle === false
      ? base.replace('://', '://' + c.bucket + '.') + (key ? '/' + key : '/')
      : base + '/' + c.bucket + (key ? '/' + key : '')
    return query ? path + '?' + query : path
  }

  async function s3Call(method, key, query, body, s, opts) {
    const c = s3Cfg(s)
    if (!String(c.endpoint || '').trim()) throw new Error('未配置 MinIO 端点')
    const shell = ctx.get('shell')
    if (shell === undefined || shell === null) throw new Error('shell 服务不可用（MinIO 走 curl）')
    const region = String(c.region || 'us-east-1')
    const t = intOf(opts && opts.timeoutMs, HTTP_TIMEOUT_MS)
    const parts = ['curl -sS -m ' + Math.ceil(t / 1000), '-X ' + method]
    parts.push('--aws-sigv4 ' + shQuote('aws:amz:' + region + ':s3'))
    parts.push('--user ' + shQuote(String(c.accessKey || '') + ':' + String(c.secretKey || '')))
    if (body !== undefined && body !== null) {
      parts.push('-H ' + shQuote('Content-Type: ' + ((opts && opts.contentType) || 'application/octet-stream')))
      parts.push('--data-binary ' + shQuote(body))
    }
    parts.push(shQuote(s3Url(key, query, s)))
    parts.push('-w ' + shQuote('\\n%{http_code}'))
    const spec = shell.resolve({ command: parts.join(' '), timeoutMs: t + 8000, stdoutMaxBytes: intOf(opts && opts.maxBytes, 4000000) })
    const res = await shell.run(spec)
    const raw = res && res.stdout ? String(res.stdout.text || '') : ''
    const errText = res && res.stderr ? String(res.stderr.text || '') : ''
    if (res && res.timedOut) throw new Error('MinIO 请求超时')
    const cut = raw.lastIndexOf('\n')
    const text = cut >= 0 ? raw.slice(0, cut) : raw
    const code = cut >= 0 ? Number(raw.slice(cut + 1).trim()) : 0
    if (res && res.exitCode !== 0) throw new Error('curl 退出码 ' + res.exitCode + '：' + clip(errText || text, 240))
    if (!(code >= 200 && code < 300)) throw new Error('MinIO HTTP ' + code + '：' + clip(text || errText, 400))
    return text
  }

  // ListObjectsV2 返回 XML：只需要 Key/Size/LastModified，正则足够，不必引 XML 解析器。
  function parseS3List(xml) {
    const out = []
    const re = /<Contents>([\s\S]*?)<\/Contents>/g
    let m
    while ((m = re.exec(xml))) {
      const block = m[1]
      const pick = function (tag) {
        const r = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>')
        const mm = r.exec(block)
        return mm ? mm[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : ''
      }
      out.push({ key: pick('Key'), size: intOf(pick('Size'), 0), lastModified: pick('LastModified'), storageClass: pick('StorageClass') })
    }
    const tokM = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)
    return { objects: out, truncated: /<IsTruncated>true<\/IsTruncated>/.test(xml), nextToken: tokM ? tokM[1] : '' }
  }

  async function s3List(prefix, limit, s) {
    const q = ['list-type=2', 'max-keys=' + Math.max(1, Math.min(1000, intOf(limit, 50)))]
    const p = String(prefix || '').trim()
    if (p) q.push('prefix=' + encodeURIComponent(p))
    return parseS3List(await s3Call('GET', '', q.join('&'), null, s))
  }

  // ── 知识库操作 ────────────────────────────────────────────────────────────
  // ── 导入解析：pdf / word(.docx) / md / txt ─────────────────────────────────
  function extOf(path) {
    const m = /\.([A-Za-z0-9]+)\s*$/.exec(String(path || '').trim())
    return m ? '.' + m[1].toLowerCase() : ''
  }

  // Word 的正文就是一个 XML：段落边界是 </w:p>，制表与换行有专门标签。
  // 抽文本只需要这三条规则 + 反转义，不需要完整 XML 解析器。
  function docxXmlToText(xml) {
    let s = String(xml || '')
    s = s.replace(/<w:tab\b[^>]*\/?>/g, '\t')
    s = s.replace(/<w:br\b[^>]*\/?>/g, '\n')
    s = s.replace(/<\/w:p>/g, '\n')
    s = s.replace(/<[^>]+>/g, '')
    s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  }

  function splitPlainText(text) {
    const out = []
    let buf = []
    let size = 0
    const flush = function () {
      if (!buf.length) return
      const t = buf.join('\n').trim()
      if (t) out.push(t)
      buf = []
      size = 0
    }
    for (const para of String(text || '').split(/\n\s*\n/)) {
      const p = para.trim()
      if (!p) continue
      // 已经攒了内容、再加就超上限时先收一段：这样段落边界才是切点，
      // 而不是「撞到上限才切」（那会把一整段正文和前面的短标题糊在一起）。
      if (size > 0 && size + p.length > PLAIN_GROUP_MAX) flush()
      buf.push(p)
      size += p.length
      if (size >= PLAIN_GROUP_MAX) flush()
    }
    flush()
    return out
  }

  async function readImport(path) {
    const ext = extOf(path)
    if (IMPORT_EXT.indexOf(ext) < 0) {
      throw new Error('只支持 ' + IMPORT_LABEL + '（拿到的是 ' + (ext ? ext + ' 文件' : '没有扩展名的文件') + '）')
    }
    if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
      const fs = ctx.get('fs')
      if (fs === undefined || fs === null) throw new Error('fs 服务不可用，读不了文本文件')
      const target = await fs.resolve(path)
      const info = await fs.stat(target)
      if (!info) throw new Error('文件不存在：' + path)
      return { text: String(await fs.readText(target)), ext: ext, how: '直接读文本' }
    }
    const shell = ctx.get('shell')
    if (shell === undefined || shell === null || typeof shell.resolve !== 'function') {
      throw new Error('shell 服务不可用：' + (ext === '.docx' ? 'word' : 'pdf') + ' 要靠外部命令抽文本')
    }
    const cmd = ext === '.docx'
      ? 'unzip -p ' + shQuote(path) + ' word/document.xml'
      : 'pdftotext -layout ' + shQuote(path) + ' -'
    const spec = shell.resolve({ command: cmd, timeoutMs: 60000, stdoutMaxBytes: 16 * 1024 * 1024 })
    const r = await shell.run(spec)
    const body = (r && r.stdout && r.stdout.text) || ''
    if (!r || r.exitCode !== 0 || !String(body).trim()) {
      const why = clip((r && r.stderr && r.stderr.text) || ('命令退出码 ' + (r && r.exitCode)), 200)
      throw new Error((ext === '.docx' ? 'word' : 'pdf') + ' 抽文本失败：' + why
        + (ext === '.pdf' ? '（pdf 需要 poppler 的 pdftotext）' : '（老式 .doc 不支持，请先另存为 .docx）'))
    }
    return { text: ext === '.docx' ? docxXmlToText(body) : String(body), ext: ext, how: ext === '.docx' ? 'unzip 取 word/document.xml' : 'pdftotext -layout' }
  }

  // 切条目：markdown 按 ## 分节；word / pdf 按长度归拢。
  function entriesFromDoc(path, doc) {
    const tag = doc.ext.replace('.', '')
    const out = []
    if (doc.ext === '.md' || doc.ext === '.markdown') {
      for (const part of String(doc.text).split(/\n(?=##\s)/)) {
        const t = part.trim()
        if (!t) continue
        const m = /^##\s+(.+)$/m.exec(t)
        out.push({ title: clip((m ? m[1] : t.split('\n')[0]) || path, 120), text: t, kind: 'knowledge', tags: [tag], source: path })
      }
    } else {
      const groups = splitPlainText(doc.text)
      for (let i = 0; i < groups.length; i++) {
        const t = groups[i]
        out.push({ title: clip(t.split('\n')[0] || (path + ' 第 ' + (i + 1) + ' 段'), 120), text: t, kind: 'knowledge', tags: [tag], source: path })
      }
    }
    return out
  }

  function splitChunks(text) {
    const s = String(text || '').trim()
    if (!s) return []
    if (s.length <= CHUNK_MAX) return [s]
    const out = []
    let i = 0
    while (i < s.length) {
      out.push(s.slice(i, i + CHUNK_MAX))
      if (i + CHUNK_MAX >= s.length) break
      i += CHUNK_MAX - CHUNK_OVERLAP
    }
    return out
  }

  function asEntry(raw, fallbackSource) {
    const r = raw && typeof raw === 'object' ? raw : {}
    const text = String(r.text === undefined ? '' : r.text).trim()
    if (!text) return null
    const e = {
      title: clip(r.title || text.split('\n')[0], 200),
      text: text,
      kind: KINDS.indexOf(String(r.kind)) >= 0 ? String(r.kind) : 'knowledge',
      tags: Array.isArray(r.tags)
        ? r.tags.map(String).slice(0, 12)
        : String(r.tags || '').split(/[,，\s]+/).filter(Boolean).slice(0, 12),
      source: clip(r.source || fallbackSource || 'manual', 200),
      created_at: intOf(r.created_at, 0) || nowMs(),
      updated_at: intOf(r.updated_at, 0) || nowMs(),
      indexed: r.indexed === true,
    }
    e.id = String(r.id || '') || contentId(['e', e.kind, e.title, e.text])
    return e
  }

  function indexOfEntry(id) {
    for (let i = 0; i < store.entries.length; i++) if (store.entries[i].id === id) return i
    return -1
  }

  function recalcMeta() {
    let indexed = 0
    for (const e of store.entries) if (e.indexed === true) indexed++
    store.meta.localCount = store.entries.length
    store.meta.indexed = indexed
    store.meta.pending = store.entries.length - indexed
  }

  // 条目 -> 索引行。行 id 以条目 id 开头（`<条目 id>#<块号>-<内容指纹>`），
  // 于是从 Milvus 的检索结果能直接反查回本地条目，删除也不必回查向量库。
  function chunkRowsOf(e) {
    const chunks = splitChunks(e.text)
    const rows = []
    for (let i = 0; i < chunks.length; i++) {
      const part = chunks[i]
      rows.push({
        id: e.id + '#' + i + '-' + contentId([e.id, String(i), part]).slice(1, 9),
        title: chunks.length > 1 ? e.title + '（' + (i + 1) + '/' + chunks.length + '）' : e.title,
        text: part,
        tags: (e.tags || []).join(','),
        kind: e.kind,
        source: e.source,
        created_at: e.created_at,
        updated_at: e.updated_at,
      })
    }
    return rows
  }

  function entryIdFromRow(id) { return String(id || '').split('#')[0] }

  // 本地写入：同 id（同标题同正文）视为同一段知识，覆盖而不是重复累积。
  function putEntriesLocal(entries) {
    let added = 0, updated = 0
    for (const e of entries) {
      const at = indexOfEntry(e.id)
      if (at >= 0) {
        e.created_at = store.entries[at].created_at || e.created_at
        e.indexed = false
        store.entries[at] = e
        updated++
      } else {
        store.entries.push(e)
        added++
      }
    }
    if (store.entries.length > ENTRY_MAX) {
      const drop = store.entries.length - ENTRY_MAX
      store.entries = store.entries.slice(drop)
      log('warn', '本地条目超过上限 ' + ENTRY_MAX + '，丢弃最旧的 ' + drop + ' 条')
    }
    recalcMeta()
    return { added: added, updated: updated }
  }

  // 把条目同步进 Milvus。可能抛错（没 Key / 连不上），由调用方决定怎么记。
  async function indexEntries(list, s) {
    const cfg = s || settings()
    const rows = []
    for (const e of list) for (const r of chunkRowsOf(e)) rows.push(r)
    if (!rows.length) return { rows: 0, dimension: 0 }
    const vectors = await embedTexts(rows.map(function (r) { return r.title + '\n' + r.text }), cfg)
    for (let i = 0; i < rows.length; i++) rows[i].vector = vectors[i]
    const dim = vectors[0].length
    await milvusEnsureCollection(cfg, dim)
    let n = 0
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const batch = rows.slice(i, i + INSERT_BATCH)
      try {
        // upsert：同 id 重复导入时覆盖而不是主键冲突
        const res = await milvusCall('/entities/upsert', { collectionName: collectionName(cfg), data: batch }, cfg)
        const d = res && res.data
        n += intOf(d && (d.upsertCount !== undefined ? d.upsertCount : d.insertCount), batch.length)
      } catch (e) {
        const res = await milvusCall('/entities/insert', { collectionName: collectionName(cfg), data: batch }, cfg)
        const d = res && res.data
        n += intOf(d && (d.insertCount !== undefined ? d.insertCount : d.insert_count), batch.length)
      }
      store.meta.progress = { text: '写入索引 ' + Math.min(i + batch.length, rows.length) + '/' + rows.length, done: i + batch.length, total: rows.length }
    }
    store.meta.progress = null
    store.meta.collectionReady = true
    store.meta.dimension = dim
    return { rows: rows.length, indexed: n, dimension: dim }
  }

  // 写入 = 先落本地库（一定成功），再尽力同步向量索引（失败只记日志，不回滚）。
  // 这条顺序是刻意的：记忆是给人用的，不该因为外部服务没配好就写不进去。
  async function addEntries(entries, s, source, opts) {
    const o = opts || {}
    const clean = []
    for (const raw of entries) {
      const e = asEntry(raw, source)
      if (e) clean.push(e)
    }
    const skipped = entries.length - clean.length
    if (!clean.length) return { added: 0, updated: 0, entries: 0, rows: 0, dimension: 0, indexed: 0, indexError: null, skipped: skipped }

    const loc = putEntriesLocal(clean)
    let indexed = 0, rows = 0, indexError = null
    if (o.index !== false) {
      // 没配向量模型 / Milvus 时**不去发请求**（否则每次写入都要等一次超时），
      // 直接把「为什么没进索引」记下来，配好后用面板上的「同步索引」补。
      if (!milvusBase() || !embedReady(s)) {
        indexError = '未配置向量模型与 Milvus（本地已存住）'
      } else {
        try {
          const r = await indexEntries(clean, s)
          rows = r.rows
          indexed = r.indexed
          for (const e of clean) {
            const at = indexOfEntry(e.id)
            if (at >= 0) store.entries[at].indexed = true
          }
        } catch (e) {
          indexError = msgOf(e)
          store.meta.progress = null
          store.meta.lastError = '向量索引同步失败（本地已存住）：' + indexError
          log('warn', store.meta.lastError)
        }
      }
    }
    recalcMeta()
    return { added: loc.added, updated: loc.updated, ids: clean.map(function (e) { return e.id }), entries: clean.length, rows: rows, dimension: store.meta.dimension || 0, indexed: indexed, indexError: indexError, skipped: skipped }
  }

  // 把还没进索引（或索引失败）的条目补进 Milvus。
  async function syncIndex(s, all) {
    const cfg = s || settings()
    if (!milvusBase(cfg) || !embedReady(cfg)) throw new Error('未配置 Milvus 地址或向量模型 API Key，无法同步索引')
    const todo = all === true ? store.entries.slice() : store.entries.filter(function (e) { return e.indexed !== true })
    if (!todo.length) return { ok: true, synced: 0, entries: 0, dimension: store.meta.dimension || 0 }
    const r = await indexEntries(todo, cfg)
    for (const e of todo) {
      const at = indexOfEntry(e.id)
      if (at >= 0) store.entries[at].indexed = true
    }
    recalcMeta()
    return { ok: true, synced: r.indexed, entries: todo.length, dimension: r.dimension }
  }

  // 删除：本地一定删掉；删索引是尽力而为 —— 连不上向量库不该让本地条目删不掉。
  // ids 既接受条目 id，也接受检索结果里的索引行 id（`<条目 id>#…`）。
  async function removeEntries(ids) {
    const want = {}
    for (const id of ids) want[String(id)] = true
    const kept = []
    const gone = []
    for (const e of store.entries) {
      if (want[e.id]) { gone.push(e); continue }
      kept.push(e)
    }
    store.entries = kept
    recalcMeta()
    const rowIds = []
    for (const e of gone) for (const r of chunkRowsOf(e)) rowIds.push(r.id)
    for (const id of ids) if (String(id).indexOf('#') >= 0 && rowIds.indexOf(String(id)) < 0) rowIds.push(String(id))
    let indexDeleted = 0, indexError = null
    if (rowIds.length && milvusBase()) {
      try {
        indexDeleted = await milvusDelete(rowIds)
      } catch (e) {
        indexError = msgOf(e)
        log('warn', '删除向量索引失败（本地已删除）：' + indexError)
      }
    }
    return { deleted: gone.length, indexDeleted: indexDeleted, indexError: indexError, gone: gone.map(function (e) { return e.id }) }
  }

  function hitOf(e, score, mode) {    return {
      id: e.id,
      entryId: e.id,
      title: e.title,
      text: clip(e.text, 600),
      tags: (e.tags || []).join(','),
      kind: e.kind,
      source: e.source,
      created_at: e.created_at,
      score: score,
      rerankScore: null,
      indexed: e.indexed === true,
      mode: mode || 'local',
    }
  }

  // 本地关键词检索：没有向量库（或索引还没同步）时的兜底，永远可用。
  // 中文没有词边界，所以除了空白切分还要补 2 字滑窗，否则「间接注入」匹配不到「注入」。
  function localSearch(query, k, opts) {
    const o = opts || {}
    const q = String(query || '').trim().toLowerCase()
    if (!q) return []
    const terms = []
    for (const t of q.split(/[\s,，、;；:：/|()（）\[\]【】"'`]+/)) if (t) terms.push(t)
    for (const seg of q.replace(/[^\u4e00-\u9fa5]/g, ' ').split(/\s+/)) {
      for (let i = 0; i + 2 <= seg.length; i++) terms.push(seg.slice(i, i + 2))
    }
    const uniq = []
    for (const t of terms) if (t.length >= 2 && uniq.indexOf(t) < 0) uniq.push(t)
    const hits = []
    for (const e of store.entries) {
      if (typeof o.filter === 'function' && !o.filter(e)) continue
      const title = String(e.title || '').toLowerCase()
      const tags = (e.tags || []).join(',').toLowerCase()
      const text = String(e.text || '').toLowerCase()
      let score = 0, matched = 0
      for (const t of uniq) {
        let s = 0
        if (title.indexOf(t) >= 0) s += 3
        if (tags.indexOf(t) >= 0) s += 2
        if (text.indexOf(t) >= 0) s += 1
        if (s > 0) { matched++; score += s }
      }
      if (!matched) continue
      hits.push({ e: e, score: score + matched })
    }
    hits.sort(function (a, b) { return b.score - a.score || b.e.updated_at - a.e.updated_at })
    return hits.slice(0, k).map(function (h) { return hitOf(h.e, h.score, 'local') })
  }

  function embedReady(s) { return String((s || settings()).embed.apiKey || '').trim() !== '' }

  async function searchKnowledge(query, topK, opts) {
    const s = settings()
    const o = opts || {}
    const q = String(query || '').trim()
    if (!q) return { ok: false, error: '检索内容为空' }
    const k = Math.max(1, Math.min(50, intOf(topK, s.searchTopK || 8)))

    let rows = []
    let mode = 'local'
    let vectorError = null
    if (milvusBase(s) && embedReady(s)) {
      try {
        const vectors = await embedTexts([q], s)
        const hits = await milvusSearch(vectors[0], k, s, o.filter)
        rows = hits.map(function (h) {
          const id = String(h.id || '')
          return {
            id: id,
            entryId: entryIdFromRow(id),
            title: String(h.title || ''),
            text: String(h.text || ''),
            tags: String(h.tags || ''),
            kind: String(h.kind || ''),
            source: String(h.source || ''),
            score: Number(h.distance !== undefined ? h.distance : h.score) || 0,
            rerankScore: null,
            indexed: true,
            mode: 'vector',
          }
        })
        mode = 'vector'
      } catch (e) {
        vectorError = msgOf(e)
        log('warn', '向量检索失败，改用本地检索：' + vectorError)
      }
    }

    // 本地库可能比索引新（离线期间写入、索引同步失败），所以两条路都要走一遍再合并。
    const local = localSearch(q, k, o)
    const seen = {}
    for (const r of rows) seen[r.entryId] = true
    let extra = 0
    for (const r of local) {
      if (seen[r.entryId]) continue
      rows.push(r)
      seen[r.entryId] = true
      extra++
    }
    if (mode === 'vector') { if (extra > 0) mode = 'hybrid' } else { mode = 'local' }

    // 召回之后再上重排：把候选文本交给重排模型重新排序
    const wantRerank = o.rerank === undefined ? true : o.rerank === true
    if (wantRerank && rerankReady(s) && rows.length > 1) {
      try {
        const order = await rerankDocs(q, rows.map(function (r) { return r.title + '\n' + r.text }), s)
        if (order.length) {
          const sorted = order.map(function (x) { const r = rows[x.index]; r.rerankScore = x.score; return r })
          for (const r of rows) if (r.rerankScore === null) sorted.push(r)
          rows.length = 0
          for (const r of sorted) rows.push(r)
        }
      } catch (e) {
        log('warn', '重排失败，返回原始召回顺序：' + msgOf(e))
      }
    }
    return {
      ok: true, query: q, count: rows.length, mode: mode, vectorError: vectorError,
      indexedRows: mode === 'local' ? 0 : rows.filter(function (r) { return r.mode === 'vector' }).length,
      hits: rows.slice(0, k),
      reranked: rows.some(function (r) { return r.rerankScore !== null }),
    }
  }

  // ── 状态快照（面板用） ────────────────────────────────────────────────────
  function snapshot() {
    const s = settings()
    return {
      updatedAt: store.updatedAt,
      settings: s,
      embedPresets: Object.keys(EMBED_PRESETS).map(function (k) {
        return { id: k, label: EMBED_PRESETS[k].label, base: EMBED_PRESETS[k].base, keyHint: EMBED_PRESETS[k].keyHint, models: EMBED_PRESETS[k].models }
      }),
      rerankPresets: Object.keys(RERANK_PRESETS).map(function (k) {
        return { id: k, label: RERANK_PRESETS[k].label, base: RERANK_PRESETS[k].base, models: RERANK_PRESETS[k].models }
      }),
      kinds: KINDS,
      status: {
        collection: collectionName(s),
        collectionReady: store.meta.collectionReady === true,
        dimension: store.meta.dimension || 0,
        rowCount: store.meta.rowCount || 0,
        // 本地条目是权威数据，索引条数只是它的派生视图，两个数要一起看。
        localCount: store.meta.localCount || 0,
        indexed: store.meta.indexed || 0,
        pending: store.meta.pending || 0,
        embedReady: embedReady(s),
        milvusReady: !!milvusBase(s),
        seeded: store.meta.seeded === true,
        persistence: store.meta.persistence || 'unknown',
        storePath: store.meta.storePath || '',
        lastError: store.meta.lastError || null,
        progress: store.meta.progress || null,
        lastOp: store.meta.lastOp || null,
      },
      importLabel: IMPORT_LABEL,
      importExt: IMPORT_EXT.slice(),
      captures: store.captures.slice(-20).reverse(),
      capturePhrases: capturePhrases(s),
      log: store.log.slice(-60),
    }
  }

  async function refreshCount(s) {
    if (!milvusBase(s)) return -1
    try {
      const n = await milvusCount(s)
      if (n >= 0) store.meta.rowCount = n
      return n
    } catch (e) { return -1 }
  }

  // ── 对话捕获 ──────────────────────────────────────────────────────────────
  // 红队队员在会话里说「把这台机器的指纹写入记忆」，不该要求他改用工具。这里监听
  // post-commit 的 session/event；命中触发词就把那条消息收进本地库。
  //
  // 三个刻意的选择：
  //   1. 只认用户消息。模型回复里的「记忆」多半是在解释功能本身，捕进来是噪声。
  //   2. 入库不依赖向量模型 —— 先落本地库，索引同步失败只记日志（捕获必须「说了就记住」）。
  //   3. 同一个会话序号只捕一次，事件重放/重复投递不会写出两条。
  const captured = {}
  let captureBusy = false

  function textOfContent(content) {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    const parts = []
    for (const b of content) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
    return parts.join('\n')
  }

  function matchCapturePhrase(text) {
    const lower = String(text || '').toLowerCase()
    for (const p of capturePhrases()) {
      const at = lower.indexOf(p.toLowerCase())
      if (at >= 0) return { phrase: p, at: at }
    }
    return null
  }

  // 「请把这条写入记忆：xxx」-> 「xxx」。去掉触发词与它两侧的连接词，剩下的才是要记的内容。
  function captureBody(text, hit) {
    const raw = String(text || '')
    let head = raw.slice(0, hit.at)
    let tail = raw.slice(hit.at + hit.phrase.length)
    tail = tail.replace(/^[\s:：,，、。.;；\-—]*/, '')
    head = head.replace(/[\s:：,，、。.;；\-—]*$/, '')
    head = head.replace(/^(请|麻烦|帮我|帮忙|记得|记住|把|将|这条|这段|这个|这条信息)+/g, '')
    const body = (head && tail) ? (head + '\n' + tail) : (head || tail)
    return body.trim() || raw.trim()
  }

  function sessionTitleOf(session) {
    const svc = ctx.get('sessionTitle')
    try {
      if (svc && typeof svc.get === 'function') {
        const t = svc.get(session)
        const v = t && (t.title || t.value || t.text)
        if (v) return clip(v, 80)
      }
    } catch (e) { /* 标题只为人看着方便，取不到就退回会话 id */ }
    return ''
  }

  // 触发词后面没跟内容时（「记住这个」），取上一条消息当上下文 —— 否则记下来的是空壳。
  function previousTextOf(session, seq) {
    let events = []
    try { events = session.snapshotEvents() } catch (e) { return '' }
    if (!Array.isArray(events)) return ''
    let best = ''
    for (const ev of events) {
      if (!ev || Number(ev.seq) >= Number(seq)) continue
      if (ev.type === 'user/message') best = textOfContent(ev.data && ev.data.content)
      else if (ev.type === 'assistant/message') {
        const t = textOfContent(ev.data && ev.data.message && ev.data.message.content)
        if (t.trim()) best = t
      }
      if (best.length > 4000) best = best.slice(0, 4000)
    }
    return clip(best, 1200)
  }

  async function captureFrom(session, event) {
    const text = textOfContent(event.data && event.data.content)
    if (!text.trim()) return null
    const hit = matchCapturePhrase(text)
    if (!hit) return null
    const key = String((session && session.id) || '') + '#' + String(event.seq)
    if (captured[key]) return null
    captured[key] = true

    const sid = String((session && session.id) || '')
    const title = session ? sessionTitleOf(session) : ''
    const body = captureBody(text, hit)
    let finalText = body
    if (settings().capture.withContext && body.replace(/\s+/g, '').length < 12 && session) {
      const around = previousTextOf(session, event.seq)
      if (around) finalText = around + '\n\n（对话里出现触发词「' + hit.phrase + '」，随上下文一并记下）'
    }
    const label = '对话捕获 · ' + (title || sid.slice(0, 12) || '面板')
    const r = await addEntries([{
      title: clip(body.split('\n')[0] || body, 60),
      text: finalText,
      kind: settings().capture.kind,
      tags: ['对话捕获'],
      source: label,
    }], null, label)

    store.captures.push({
      at: nowMs(), session: sid, title: title || sid.slice(0, 12), phrase: hit.phrase,
      entryId: (r.ids && r.ids[0]) || '', text: clip(finalText, 200),
      indexed: r.indexed > 0, error: r.indexError || null,
    })
    if (store.captures.length > CAPTURE_MAX) store.captures = store.captures.slice(-CAPTURE_MAX)
    log('ok', '对话捕获（' + hit.phrase + '）：' + clip(finalText, 100) + (r.indexError ? '［索引未同步，本地已存］' : ''))
    store.meta.lastOp = { at: nowMs(), op: 'capture', text: clip(finalText, 120) }
    await persist()
    return r
  }

  ctx.effect(function () {
    const off = ctx.on('session/event', function (session, event) {
      if (!event || event.type !== 'user/message') return
      if (!settings().capture.enabled) return
      // 捕获要写库 + 落盘（读改写），串行化，避免并发互相覆盖。
      if (captureBusy) return
      captureBusy = true
      Promise.resolve()
        .then(function () { return ensureLoaded() })
        .then(function () { return captureFrom(session, event) })
        .catch(function (e) { console.error('[rtmemory] 对话捕获失败: ' + msgOf(e)) })
        .then(function () { captureBusy = false })
    })
    return function () { if (typeof off === 'function') off() }
  }, 'redteam-memory: 对话捕获')

  // 对外服务：其它插件（例如报告插件把成稿导入记忆）不必各自去读写存储文件。
  ctx.effect(function () {
    if (typeof ctx.provide !== 'function') {
      log('warn', '当前运行时不支持 ctx.provide，跳过 redteamMemory 服务注册')
      return function () {}
    }
    return ctx.provide('redteamMemory', {
      add: async function (entries, source) {
        await ensureLoaded()
        const list = Array.isArray(entries) ? entries : [entries]
        const r = await addEntries(list, null, source || 'plugin')
        log('ok', '外部插件写入记忆 ' + r.added + ' 条（来源 ' + (source || 'plugin') + '，本地共 ' + (store.meta.localCount || 0) + ' 条）')
        await persist()
        return {
          added: r.added, updated: r.updated, entries: r.entries, rows: r.rows, dimension: r.dimension,
          indexed: r.indexed, indexError: r.indexError, localCount: store.meta.localCount || 0, ids: r.ids || [],
        }
      },
      search: async function (query, topK, opts) {
        await ensureLoaded()
        return await searchKnowledge(query, topK, opts)
      },
      stats: async function () {
        await ensureLoaded()
        recalcMeta()
        return {
          localCount: store.meta.localCount || 0, indexed: store.meta.indexed || 0,
          pending: store.meta.pending || 0, persistence: store.meta.persistence || 'unknown',
          storePath: store.meta.storePath || '',
        }
      },
    })
  }, 'redteam-memory: 对外服务 redteamMemory')

  // ── 模型工具 ──────────────────────────────────────────────────────────────
  const searchTool = harness.defineTool({
    name: 'memory_search',
    description: '在红队记忆库里检索 AI 安全知识与进攻技巧（OWASP LLM Top 10、提示词注入、RAG 投毒、Agent/MCP 工具滥用、推理服务未授权与已知 CVE、证据与合规清单等）。做 AI/LLM 方向测试、需要判断某个手法或风险点、或写报告时用这个工具，比凭印象回答可靠。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要检索的内容，自然语言即可，例如「间接提示词注入怎么验证」' },
        topK: { type: 'integer', description: '返回条数，默认取设置里的值' },
        rerank: { type: 'boolean', description: '是否用重排模型精排（默认按设置里的开关）' },
      },
      required: ['query'],
    },
    output: {
      schema: { type: 'json' },
      render: function (args, value) {
        if (!value || value.ok !== true) return [{ type: 'text', text: '检索失败：' + ((value && value.error) || '未知错误') }]
        if (!value.hits || value.hits.length === 0) return [{ type: 'text', text: '记忆库里没有匹配内容（检索：' + value.query + '）。可以先用 memory_add 导入相关知识。' }]
        const how = value.mode === 'vector' ? '向量检索' : (value.mode === 'hybrid' ? '向量 + 本地关键词' : '本地关键词检索')
        const lines = ['命中 ' + value.hits.length + ' 条（' + how + '）' + (value.reranked ? '，已重排' : '') + '：']
        if (value.vectorError) lines.push('（向量检索失败，已退回本地：' + value.vectorError + '）')
        for (const h of value.hits) {
          lines.push('')
          lines.push('· ' + h.title + '  [' + h.kind + (h.tags ? ' / ' + h.tags : '') + ']  分数 ' + Number(h.score).toFixed(3))
          lines.push('  ' + h.text)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async function (args) {
      await ensureLoaded()
      const r = await searchKnowledge(args && args.query, args && args.topK, { rerank: args && args.rerank })
      store.meta.lastOp = { at: nowMs(), op: 'memory_search', text: clip((args && args.query) || '', 120) }
      await persist()
      return r
    },
  })

  const addTool = harness.defineTool({
    name: 'memory_add',
    description: '往红队记忆库写入一条知识（AI 安全知识、进攻技巧、检查清单、复盘结论）。先落本地库（一定成功），再尽力同步向量索引 —— 就算没配向量模型，内容也能存住并被 memory_search 检索到。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '知识正文。一段一个主题，不要写成流水账。' },
        title: { type: 'string', description: '标题（省略时取正文首行）' },
        kind: { type: 'string', description: 'knowledge / technique / payload / checklist / note' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，例如 owasp、注入、rag、agent' },
        source: { type: 'string', description: '来源：CVE 编号、文档链接、某次测试的复盘' },
      },
      required: ['text'],
    },
    output: {
      schema: { type: 'json' },
      render: function (args, value) {
        if (!value || value.ok !== true) return [{ type: 'text', text: '写入失败：' + ((value && value.error) || '未知错误') }]
        const head = '已写入本地记忆库 ' + value.added + ' 条（本地共 ' + (value.localCount || 0) + ' 条）'
        const tail = value.indexError
          ? '；向量索引未同步（' + value.indexError + '），本地检索仍可用，配好向量模型后在面板点「同步索引」即可。'
          : '；向量索引已同步 ' + (value.indexed || 0) + ' 行（维度 ' + (value.dimension || '?') + '）。'
        return [{ type: 'text', text: head + tail }]
      },
    },
    execute: async function (args) {
      await ensureLoaded()
      const r = await addEntries([args], null, 'model')
      store.meta.lastOp = { at: nowMs(), op: 'memory_add', text: clip((args && (args.title || args.text)) || '', 120) }
      log('ok', '模型写入记忆 ' + r.added + ' 条（本地 ' + (store.meta.localCount || 0) + ' 条，索引 ' + r.indexed + ' 行' + (r.indexError ? '，索引失败' : '') + '）：' + clip((args && (args.title || args.text)) || '', 100))
      await refreshCount()
      await persist()
      return Object.assign({ ok: true, localCount: store.meta.localCount || 0 }, r)
    },
  })

  const deleteTool = harness.defineTool({
    name: 'memory_delete',
    description: '从红队记忆库按 id 删除条目。id 从 memory_search 的结果里拿。删除不可恢复，删前先确认 id。',
    parameters: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, description: '要删除的条目 id 列表' } },
      required: ['ids'],
    },
    output: {
      schema: { type: 'json' },
      render: function (args, value) {
        if (!value || value.ok !== true) return [{ type: 'text', text: '删除失败：' + ((value && value.error) || '未知错误') }]
        return [{ type: 'text', text: '已删除 ' + value.deleted + ' 条' + (value.indexError ? '（向量索引未同步删除：' + value.indexError + '）' : '') }]
      },
    },
    execute: async function (args) {
      await ensureLoaded()
      const ids = Array.isArray(args && args.ids) ? args.ids.map(String).filter(Boolean) : []
      if (!ids.length) return { ok: false, error: 'ids 为空' }
      const r = await removeEntries(ids)
      log('warn', '模型删除记忆 ' + r.deleted + ' 条：' + r.gone.slice(0, 5).join(', '))
      store.meta.lastOp = { at: nowMs(), op: 'memory_delete', text: ids.length + ' 条' }
      await refreshCount()
      await persist()
      return { ok: true, deleted: r.deleted, indexDeleted: r.indexDeleted, indexError: r.indexError }
    },
  })

  for (const t of [searchTool, addTool, deleteTool]) harness.registerTool(ctx, t)

  // ── RPC 句柄（客户端 host.call 调） ───────────────────────────────────────
  harness.handle('snapshot', async function () {
    await ensureLoaded()
    if (milvusBase()) { try { await refreshCount() } catch (e) { /* 连不上时保留旧值 */ } }
    return { ok: true, snapshot: snapshot() }
  })

  harness.handle('saveSettings', async function (args) {
    await ensureLoaded()
    mergeSettings(args && typeof args === 'object' ? args : {})
    const cap = settings().capture
    log('info', '设置已保存（Milvus ' + (milvusBase() || '未配置') + '，集合 ' + collectionName() + '，向量模型 ' + settings().embed.model
      + '；对话捕获 ' + (cap.enabled ? '开' : '关') + '，触发词 ' + capturePhrases().length + ' 个）')
    await persist()
    return { ok: true, snapshot: snapshot() }
  })

  // 触发词干跑：判断「这句话会不会被捕获」，不写入任何东西 —— 调触发词时用它验。
  harness.handle('captureTest', async function (args) {
    await ensureLoaded()
    const text = String((args && args.text) || '')
    if (!text.trim()) return { ok: false, error: '先给一句话再试' }
    const hit = matchCapturePhrase(text)
    if (!hit) return { ok: true, matched: false, phrases: capturePhrases(), hint: '没有一个触发词命中，这句话不会被捕获' }
    return { ok: true, matched: true, phrase: hit.phrase, body: captureBody(text, hit), kind: settings().capture.kind, text: clip(captureBody(text, hit), 400) }
  })

  // 手工捕获：把面板里的一段文字直接收进记忆（不走会话事件，路径与自动捕获一致）。
  harness.handle('captureAdd', async function (args) {
    await ensureLoaded()
    const text = String((args && args.text) || '').trim()
    if (!text) return { ok: false, error: '内容为空' }
    const r = await addEntries([{
      title: clip(String((args && args.title) || text.split('\n')[0]), 60),
      text: text,
      kind: KINDS.indexOf(String(args && args.kind)) >= 0 ? String(args.kind) : settings().capture.kind,
      tags: ['对话捕获'],
      source: '人工捕获',
    }], null, '人工捕获')
    store.captures.push({ at: nowMs(), session: '', title: '人工捕获', phrase: '', entryId: (r.ids && r.ids[0]) || '', text: clip(text, 200), indexed: r.indexed > 0, error: r.indexError || null })
    if (store.captures.length > CAPTURE_MAX) store.captures = store.captures.slice(-CAPTURE_MAX)
    log('ok', '人工捕获一条：' + clip(text, 100))
    await persist()
    return { ok: true, snapshot: snapshot(), added: r.added, updated: r.updated, entries: r.entries, rows: r.rows, dimension: r.dimension, indexed: r.indexed, indexError: r.indexError }
  })

  harness.handle('captureClear', async function () {
    store.captures = []
    await persist()
    return { ok: true, snapshot: snapshot() }
  })

  // Connection/configuration failures are business results, not failed RPC handlers.
  function connectionTestError(error) {
    const message = msgOf(error)
    const hint = /未配置|未启用|未选模型|未填/.test(message)
      ? '。请在「设置 → 红队设置」填写对应配置，先点击「保存记忆设置」，再测试；测试使用已保存配置。' : ''
    return { ok: false, error: message + hint }
  }
  function handleConnectionTest(method, test) {
    harness.handle(method, async function (args) {
      try {
        const result = await test(args)
        return result && result.ok === false ? connectionTestError(result.error || '连接测试失败') : result
      } catch (error) { return connectionTestError(error) }
    })
  }

  handleConnectionTest('testMilvus', async function () {
    await ensureLoaded()
    const t0 = nowMs()
    const list = await milvusListCollections()
    const has = list.indexOf(collectionName()) >= 0
    if (has) {
      const n = await milvusCount()
      if (n >= 0) store.meta.rowCount = n
      store.meta.collectionReady = true
    }
    log('ok', 'Milvus 连通：共 ' + list.length + ' 个 collection' + (has ? '，其中 ' + collectionName() + ' 存在（' + (store.meta.rowCount || 0) + ' 行）' : '，目标 collection 尚不存在（首次写入时自动创建）'))
    await persist()
    return { ok: true, collections: list, collection: collectionName(), exists: has, rowCount: store.meta.rowCount || 0, ms: nowMs() - t0 }
  })

  handleConnectionTest('testEmbed', async function () {
    await ensureLoaded()
    // Custom OpenAI-compatible endpoints may intentionally allow anonymous access.
    if (!embedReady() && settings().embed.provider !== 'openai') return { ok: false, error: '未配置向量模型 API Key' }
    const t0 = nowMs()
    const vecs = await embedTexts(['连接测试：红队记忆库'], null)
    const dim = vecs[0].length
    log('ok', '向量模型连通：' + settings().embed.model + '，维度 ' + dim)
    return { ok: true, model: settings().embed.model, dimension: dim, ms: nowMs() - t0, head: vecs[0].slice(0, 6) }
  })

  handleConnectionTest('testRerank', async function () {
    await ensureLoaded()
    if (!rerankReady()) return { ok: false, error: '重排未启用或未选模型' }
    const docs = ['提示词注入：把指令伪装成数据塞进上下文', '模型窃取：通过大量查询近似复制模型', '端口扫描：枚举目标开放端口']
    const t0 = nowMs()
    const r = await rerankDocs('怎么做提示词注入测试', docs, null)
    log('ok', '重排模型连通：' + settings().rerank.model + '，返回 ' + r.length + ' 条排序')
    return { ok: true, model: settings().rerank.model, order: r, ms: nowMs() - t0 }
  })

  handleConnectionTest('testS3', async function () {
    await ensureLoaded()
    if (!s3Cfg().enabled) return { ok: false, error: 'MinIO 未启用（先在上面勾选并填端点/桶）' }
    const xml = await s3Call('GET', '', 'list-type=2&max-keys=1', null, null)
    const parsed = parseS3List(xml)
    log('ok', 'MinIO 连通：桶 ' + s3Cfg().bucket + ' 可列举')
    return { ok: true, bucket: s3Cfg().bucket, sample: parsed.objects.length }
  })

  harness.handle('s3List', async function (args) {
    await ensureLoaded()
    if (!s3Cfg().enabled) return { ok: false, error: 'MinIO 未启用' }
    const r = await s3List(args && args.prefix, args && args.limit)
    return { ok: true, bucket: s3Cfg().bucket, objects: r.objects, truncated: r.truncated, nextToken: r.nextToken }
  })

  // 把整库导出成 JSON 存进 MinIO（Milvus 的存储桶，例如 mimo）—— 备份 / 交付用。
  // 导出的源是**本地库**：本地才是权威数据，索引可能还没同步完。
  harness.handle('s3Backup', async function (args) {
    await ensureLoaded()
    if (!s3Ready()) return { ok: false, error: 'MinIO 未启用或未填端点/桶' }
    const rows = store.entries.map(function (e) {
      return {
        id: e.id, title: e.title, text: e.text, tags: (e.tags || []).join(','), kind: e.kind,
        source: e.source, created_at: e.created_at, updated_at: e.updated_at, indexed: e.indexed === true,
      }
    })
    const key = String((args && args.key) || '').trim() || ('memory-backup-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json')
    const payload = JSON.stringify({ exportedAt: new Date().toISOString(), collection: collectionName(), count: rows.length, entries: rows }, null, 2)
    await s3Call('PUT', key, '', payload, null, { contentType: 'application/json' })
    log('ok', '已导出 ' + rows.length + ' 条到 s3://' + s3Cfg().bucket + '/' + key)
    await persist()
    return { ok: true, key: key, count: rows.length, bucket: s3Cfg().bucket }
  })

  harness.handle('listKnowledge', async function (args) {
    await ensureLoaded()
    // 列表直接读本地库：它才是权威数据，也就不会出现「索引没同步就看不到」的空列表。
    const limit = Math.max(1, Math.min(500, intOf(args && args.limit, LIST_DEFAULT)))
    const offset = Math.max(0, intOf(args && args.offset, 0))
    const kw = String((args && args.keyword) || '').trim().toLowerCase()
    const kind = String((args && args.kind) || '').trim()
    let list = store.entries.slice().sort(function (a, b) { return b.updated_at - a.updated_at })
    if (kind) list = list.filter(function (e) { return e.kind === kind })
    if (kw) {
      list = list.filter(function (e) {
        return String(e.title || '').toLowerCase().indexOf(kw) >= 0
          || String(e.text || '').toLowerCase().indexOf(kw) >= 0
          || (e.tags || []).join(',').toLowerCase().indexOf(kw) >= 0
          || String(e.source || '').toLowerCase().indexOf(kw) >= 0
      })
    }
    const total = list.length
    const page = list.slice(offset, offset + limit).map(function (e) {
      return {
        id: e.id, title: e.title, text: clip(e.text, 160), tags: (e.tags || []).join(','),
        kind: e.kind, source: e.source, created_at: e.created_at, updated_at: e.updated_at,
        indexed: e.indexed === true, chars: String(e.text || '').length,
      }
    })
    return { ok: true, entries: page, total: total, limit: limit, offset: offset, local: store.entries.length }
  })

  harness.handle('getEntry', async function (args) {
    await ensureLoaded()
    const id = String((args && args.id) || '').replace(/"/g, '')
    if (!id) return { ok: false, error: '缺少 id' }
    const at = indexOfEntry(id)
    if (at < 0) return { ok: false, error: '找不到该条目（可能刚被删除）' }
    const e = store.entries[at]
    return { ok: true, entry: Object.assign({}, e, { tags: (e.tags || []).join(',') }) }
  })

  harness.handle('search', async function (args) {
    await ensureLoaded()
    const r = await searchKnowledge(args && args.query, args && args.topK, { rerank: args && args.rerank })
    store.meta.lastOp = { at: nowMs(), op: 'search', text: clip((args && args.query) || '', 120) }
    return r
  })

  // 把本地还没进索引的条目补进 Milvus（all=true 时整库重建索引）。
  harness.handle('syncIndex', async function (args) {
    await ensureLoaded()
    const all = boolOf(args && args.all, false)
    try {
      const r = await syncIndex(null, all)
      if (r.entries > 0) log('ok', '索引同步完成：' + r.entries + ' 条本地条目 -> ' + r.synced + ' 行（维度 ' + (r.dimension || '?') + '）')
      else log('info', '索引已是最新，无需同步')
      store.meta.lastOp = { at: nowMs(), op: 'syncIndex', text: r.entries + ' 条' }
      store.meta.lastError = null
      await refreshCount()
      await persist()
      return { ok: true, snapshot: snapshot(), entries: r.entries, synced: r.synced }
    } catch (e) {
      store.meta.progress = null
      logFailure('索引同步失败', e, 'syncIndex')
      await persist()
      return { ok: false, error: msgOf(e), snapshot: snapshot() }
    }
  })

  // 从文件导入：pdf / word(.docx) / md / txt
  harness.handle('importFile', async function (args) {
    await ensureLoaded()
    const path = String((args && args.path) || '').trim()
    if (!path) return { ok: false, error: '缺少文件路径（用绝对路径）', snapshot: snapshot() }
    try {
      const doc = await readImport(path)
      const entries = entriesFromDoc(path, doc)
      if (!entries.length) return { ok: false, error: '从文件里没抽到可入库的文字：' + path, snapshot: snapshot() }
      const r = await addEntries(entries, null, path)
      log('ok', '导入 ' + clip(path, 90) + '（' + doc.ext + '，' + doc.how + '，' + doc.text.length + ' 字）→ '
        + r.added + ' 条' + (r.indexError ? '（本地已存，索引未同步）' : '（索引 ' + r.indexed + ' 行）'))
      store.meta.lastOp = { at: nowMs(), op: 'importFile', text: clip(path, 120) }
      await refreshCount()
      await persist()
      return {
        ok: true, snapshot: snapshot(), path: path, ext: doc.ext, how: doc.how,
        chars: doc.text.length, added: r.added, updated: r.updated, parsed: entries.length,
        indexed: r.indexed, indexError: r.indexError,
      }
    } catch (e) {
      store.meta.progress = null
      logFailure('导入失败', e, clip(path, 80))
      await persist()
      return { ok: false, error: msgOf(e), snapshot: snapshot() }
    }
  })

  harness.handle('seed', async function () {
    await ensureLoaded()
    try {
      const r = await addEntries(SEED_KNOWLEDGE, null, 'builtin')
      store.meta.seeded = true
      log('ok', '已导入内置知识包 ' + r.added + ' 条（AI 安全知识与进攻技巧），索引 ' + r.indexed + ' 行' + (r.indexError ? '（索引未同步，本地已存）' : ''))
      store.meta.lastOp = { at: nowMs(), op: 'seed', text: r.added + ' 条' }
      await refreshCount()
      await persist()
      return { ok: true, snapshot: snapshot(), added: r.added }
    } catch (e) {
      store.meta.progress = null
      logFailure('内置知识包导入失败', e, 'seed')
      await persist()
      return { ok: false, error: msgOf(e), snapshot: snapshot() }
    }
  })

  harness.handle('removeKnowledge', async function (args) {
    await ensureLoaded()
    const ids = Array.isArray(args && args.ids) ? args.ids.map(String).filter(Boolean) : []
    if (!ids.length) return { ok: false, error: '没有选中要删除的条目' }
    try {
      const r = await removeEntries(ids)
      log('warn', '人工删除记忆 ' + r.deleted + ' 条：' + r.gone.slice(0, 5).join(', ') + (r.gone.length > 5 ? ' …' : '') + (r.indexError ? '' : '（索引同步删除 ' + r.indexDeleted + ' 行）'))
      store.meta.lastOp = { at: nowMs(), op: 'remove', text: r.deleted + ' 条' }
      await refreshCount()
      await persist()
      return { ok: true, snapshot: snapshot(), deleted: r.deleted, indexDeleted: r.indexDeleted, indexError: r.indexError }
    } catch (e) {
      logFailure('删除失败', e, 'removeKnowledge')
      await persist()
      return { ok: false, error: msgOf(e), snapshot: snapshot() }
    }
  })

  harness.handle('dropCollection', async function () {
    await ensureLoaded()
    try {
      await milvusDrop()
      log('warn', '已删除 collection ' + collectionName() + '（下次写入会自动重建）')
      await persist()
      return { ok: true, snapshot: snapshot() }
    } catch (e) {
      logFailure('删除 collection 失败', e, 'dropCollection')
      await persist()
      return { ok: false, error: msgOf(e), snapshot: snapshot() }
    }
  })

  harness.handle('logClear', async function () {
    store.log = []
    await persist()
    return { ok: true, snapshot: snapshot() }
  })

  ensureLoaded()
    .then(function () {
      console.log('[rtmemory] 本地记忆库 ' + (store.meta.localCount || 0) + ' 条，索引 ' + (store.meta.indexed || 0)
        + ' 条，落盘 ' + (store.meta.persistence || '?') + '：' + (store.meta.storePath || '(未解析)'))
    })
    .catch(function (e) { console.error('[rtmemory] load failed:', msgOf(e)) })
    .then(function () { loaded = true })

  console.log('[rtmemory] redteam-memory host half ready; tools = 3, seed =', SEED_KNOWLEDGE.length, ', capture =', capturePhrases().length, '触发词')
