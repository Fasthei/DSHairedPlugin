// 红队报告 · Host 半边主体
//
// 本文件是 applyHost 的【函数体】——函数头、harness 垫片、收尾与导出都由
// lib/parts/host.head.js 与 host.tail.js 提供，所以这里不要写 import、function 头或 return 块。
// lib/host.js 由 `npm run build:lib` 生成，不要手改 lib/。
//
// ── 这个插件干什么 ────────────────────────────────────────────────────────────
// 把一次测试的**证据**汇成一份能交付的报告：
//   1. 工作区对话（用户要求 / 关键操作 / 结果与结论）
//   2. 攻击矩阵的命中（已确认与疑似分开，带技术点名字、判据、打过的目标、证据片段）
//   3. 记忆库里与本次测试相关的知识条目
// 然后调**当前会话正在用的那个模型**（llm 服务）自动撰写，人在面板上改与预览，
// 最后导出成 Markdown / HTML / Word(.docx)，或者反手导入记忆库。
//
// ── 三个关键设计 ──────────────────────────────────────────────────────────────
// 1. **不自己攒模型凭据**：报告由 `llm.stream({provider, model})` 生成，provider/model
//    默认取 agentDefaultModel.currentSelection()，也就是你正在对话的那个模型。
//    于是「AI 自动撰写」这件事不需要用户再配一个 Key。
// 2. **证据与撰写分离**：collectEvidence() 只管把事实收齐、按预算裁剪成 digest；
//    撰写只是一次带 digest 的补全。想换提示词不用动采集；想看 AI 到底看到了什么，
//    面板上的「试算证据」把 digest 直接打出来。
// 3. **生成是后台任务**：报告要写几千字，RPC 不能一直挂着。generate 立刻返回，
//    正文边流边写进报告对象，面板轮询 snapshot 就能看到进度与半成品。
//
// 证据来源的两种情形（都要能跑）：
//   - 攻击矩阵：优先用 `redteamAttackMatrix` 服务（有技术点名字）；没有服务就**直接读**
//     工作区里的 .redteam-attack-matrix.json（读任何路径都允许，只是拿不到名字）。
//   - 记忆库：用 `redteamMemory` 服务检索；没在跑就跳过，并在报告来源里说明。
//
// 动态半边写文件的沙箱边界（实测，见 ../../docs/DEVELOPMENT.md §5.1）：
//   相对路径落在插件自己的工作区；写它之外的绝对路径会被拒。导出路径因此默认用
//   相对名并把解析出的宿主路径回显给用户，写不进去时面板上能看见原因。
//
// markdown → 块 / HTML / docx 的纯函数在 src/docx.js，由生成器内联到本文件末尾的
// 占位注释处（见 tools/build-lib.mjs 的 DOCX_MARKER；运行期不需要额外文件）。

  // ── 常量 ──────────────────────────────────────────────────────────────────
  const STORE_NAME = '.redteam-report.json'
  const STORE_VERSION = 1
  const LOG_MAX = 120
  const SHELL_TIMEOUT_MS = 20000
  const DEFAULT_MATRIX_STORE = '.redteam-attack-matrix.json'
  const SESSION_MAX_USERS = 6
  const SESSION_MAX_OPS = 24
  const SESSION_MAX_RESULTS = 12
  const OUTLINE = [
    '## 1. 概述（测试目标、时间范围、授权与范围假设）',
    '## 2. 测试方法与过程（按阶段写：侦察 / 进入 / 利用 / 影响验证）',
    '## 3. 已确认的发现（每条写：现象 → 证据 → 影响 → 复现步骤 → 修复建议）',
    '## 4. 疑似与待验证（说明为什么没确认、下一步怎么验证）',
    '## 5. 攻击面覆盖（对照攻击矩阵，说明已覆盖与明显缺口）',
    '## 6. 风险评级与优先级（高/中/低，给理由）',
    '## 7. 清理与合规（清掉了什么、留下了什么、哪些动作有副作用）',
  ]

  function blankSettings() {
    return {
      // 留空 = 用当前会话的默认模型（agentDefaultModel）。
      model: { provider: '', model: '' },
      instruction: '',
      sessionLimit: 8,
      sessionChars: 5000,
      maxConfirmed: 40,
      maxSuspected: 25,
      memoryTopK: 5,
      memoryQueries: 6,
      digestMax: 48000,
      matrixStore: '',
      exportDir: '',
      maxTokens: 8000,
    }
  }

  function blankStore() {
    return {
      version: STORE_VERSION,
      updatedAt: 0,
      settings: blankSettings(),
      reports: [],
      currentId: '',
      log: [],
      logSeq: 0,
      meta: {
        persistence: 'unknown', storePath: '', lastError: null, progress: null,
        lastOp: null, generating: false, evidence: null,
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
  function shQuote(s) { return "'" + String(s === undefined || s === null ? '' : s).replace(/'/g, "'\\''") + "'" }
  function stamp() { return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') }
  function fmtTime(ms) {
    try {
      const d = new Date(Number(ms) || 0)
      const p = function (n) { return String(n).padStart(2, '0') }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    } catch (e) { return '' }
  }
  function newId() { return 'r' + nowMs().toString(36) + '-' + String(Math.floor(Math.random() * 1e6)).toString(36) }

  function log(level, text) {
    store.logSeq = (store.logSeq || 0) + 1
    store.log.push({ seq: store.logSeq, at: nowMs(), level: level, text: String(text).slice(0, 1200) })
    if (store.log.length > LOG_MAX) store.log = store.log.slice(store.log.length - LOG_MAX)
  }

  // 内容块 -> 纯文本。tool-result 的 content 是嵌套的，要递归下去，
  // 否则工具输出（报告里最硬的那部分证据）会全丢。
  function plainText(content) {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    const out = []
    for (const b of content) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text' && typeof b.text === 'string') out.push(b.text)
      else if (b.type === 'tool-result') out.push(plainText(b.content))
    }
    return out.join('\n')
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

  function hostPathOf(fs, target) {
    try {
      if (typeof fs.processPath === 'function') return String(fs.processPath(target) || '')
    } catch (e) { /* 沙箱实现没有 processPath 时留空 */ }
    return ''
  }

  function mergeSettings(src) {
    const d = blankSettings()
    const s = store.settings
    const g = src.model
    if (g && typeof g === 'object') {
      for (const k of Object.keys(d.model)) if (g[k] !== undefined && g[k] !== null) s.model[k] = String(g[k])
    }
    if (src.instruction !== undefined) s.instruction = String(src.instruction || '').slice(0, 4000)
    if (src.matrixStore !== undefined) s.matrixStore = String(src.matrixStore || '').slice(0, 400)
    if (src.exportDir !== undefined) s.exportDir = String(src.exportDir || '').slice(0, 400)
    s.sessionLimit = Math.max(1, Math.min(60, intOf(src.sessionLimit, s.sessionLimit)))
    s.sessionChars = Math.max(500, Math.min(40000, intOf(src.sessionChars, s.sessionChars)))
    s.maxConfirmed = Math.max(1, Math.min(200, intOf(src.maxConfirmed, s.maxConfirmed)))
    s.maxSuspected = Math.max(0, Math.min(200, intOf(src.maxSuspected, s.maxSuspected)))
    s.memoryTopK = Math.max(1, Math.min(20, intOf(src.memoryTopK, s.memoryTopK)))
    s.memoryQueries = Math.max(0, Math.min(20, intOf(src.memoryQueries, s.memoryQueries)))
    s.digestMax = Math.max(4000, Math.min(200000, intOf(src.digestMax, s.digestMax)))
    s.maxTokens = Math.max(500, Math.min(64000, intOf(src.maxTokens, s.maxTokens)))
  }

  async function doLoad() {
    try {
      const r = await resolveTarget()
      if (!r) { store.meta.persistence = 'memory'; log('warn', 'fs 服务不可用，报告只在内存里，重启会丢'); return 0 }
      store.meta.storePath = hostPathOf(r.fs, r.target)
      const info = await r.fs.stat(r.target)
      const parsed = info ? JSON.parse(await r.fs.readText(r.target)) : null
      if (parsed && typeof parsed === 'object') {
        if (Number(parsed.version) !== STORE_VERSION) log('warn', '报告存储版本 ' + parsed.version + ' -> ' + STORE_VERSION + '，按字段合并')
        if (parsed.settings && typeof parsed.settings === 'object') mergeSettings(parsed.settings)
        if (Array.isArray(parsed.reports)) {
          for (const x of parsed.reports) {
            if (!x || typeof x !== 'object') continue
            store.reports.push({
              id: String(x.id || newId()),
              title: clip(x.title || '未命名报告', 200),
              markdown: String(x.markdown || ''),
              createdAt: intOf(x.createdAt, 0) || nowMs(),
              updatedAt: intOf(x.updatedAt, 0) || nowMs(),
              meta: x.meta && typeof x.meta === 'object' ? x.meta : {},
            })
          }
        }
        if (typeof parsed.currentId === 'string') store.currentId = parsed.currentId
        if (Array.isArray(parsed.log)) store.log = parsed.log.slice(-LOG_MAX)
        if (typeof parsed.logSeq === 'number') store.logSeq = parsed.logSeq
        if (parsed.meta && typeof parsed.meta === 'object' && parsed.meta.evidence) store.meta.evidence = parsed.meta.evidence
      }
      if (!currentReport() && store.reports.length) store.currentId = store.reports[store.reports.length - 1].id
      store.meta.persistence = 'ready'
      return store.reports.length
    } catch (e) {
      const m = msgOf(e)
      if (!/ENOENT|not found|不存在|null/i.test(m)) {
        store.meta.persistence = 'error'
        store.meta.lastError = '读取报告库失败：' + m
        log('err', store.meta.lastError)
      } else {
        store.meta.persistence = 'ready'
      }
      return 0
    }
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
        reports: store.reports,
        currentId: store.currentId,
        log: store.log.slice(-LOG_MAX),
        logSeq: store.logSeq,
        meta: { evidence: store.meta.evidence || null },
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

  function currentReport() {
    for (const r of store.reports) if (r.id === store.currentId) return r
    return null
  }

  function newReport(title) {
    const at = nowMs()
    return { id: newId(), title: clip(title || '未命名报告', 200), markdown: '', createdAt: at, updatedAt: at, meta: {} }
  }

  // ── 工作区与会话 ──────────────────────────────────────────────────────────
  function workspaceRegistry() {
    const reg = ctx.get('workspaceRegistry')
    if (!reg || typeof reg.list !== 'function') return null
    return reg
  }

  function listWorkspaces() {
    const reg = workspaceRegistry()
    if (!reg) return []
    let raw = null
    try { raw = reg.list() } catch (e) { return [] }
    if (!Array.isArray(raw)) return []
    const out = []
    for (const w of raw) {
      if (!w) continue
      const ids = Array.isArray(w.sessionIds) ? w.sessionIds : []
      out.push({ id: String(w.id || ''), path: String(w.path || ''), title: String(w.title || ''), sessionCount: ids.length })
    }
    return out
  }

  // 当前会话所在的工作区；取不到就退到第一个工作区。
  function currentWorkspace() {
    const reg = workspaceRegistry()
    if (!reg) return null
    try {
      const agents = ctx.get('agents')
      let agent = null
      if (agents && typeof agents.currentInitiator === 'function') agent = agents.currentInitiator()
      if (!agent && agents && typeof agents.roots === 'function') {
        const roots = agents.roots()
        if (Array.isArray(roots) && roots.length) agent = roots[0]
      }
      if (agent) {
        const sid = String(agent.id)
        for (const w of listWorkspaces()) {
          let full = null
          try { full = typeof reg.get === 'function' ? reg.get(w.id) : null } catch (e) { full = null }
          const ids = full && Array.isArray(full.sessionIds) ? full.sessionIds : []
          for (const x of ids) if (String(x) === sid) return w
        }
      }
    } catch (e) { /* 退到第一个工作区 */ }
    const all = listWorkspaces()
    return all.length > 0 ? all[0] : null
  }

  function sessionsOf(workspaceId) {
    const reg = workspaceRegistry()
    const sessions = ctx.get('sessions')
    if (!reg || !sessions || typeof sessions.get !== 'function') return []
    let w = null
    try { w = typeof reg.get === 'function' ? reg.get(workspaceId) : null } catch (e) { return [] }
    if (!w || !Array.isArray(w.sessionIds)) return []
    const out = []
    for (const id of w.sessionIds) {
      let s = null
      try { s = sessions.get(id) } catch (e) { continue }
      if (s) out.push(s)
    }
    return out
  }

  function sessionTitleOf(session) {
    const svc = ctx.get('sessionTitle')
    try {
      if (svc && typeof svc.get === 'function') {
        const t = svc.get(session)
        const v = t && (t.title || t.value || t.text)
        if (v) return clip(v, 80)
      }
    } catch (e) { /* 标题只为人看着方便 */ }
    return ''
  }

  // 一个会话压成三块：用户要求 / 关键操作 / 结果与结论。
  // 这是「报告能引用的最小可读单位」，也是 digest 预算的分配单位。
  function sessionDigest(session, chars) {
    let events = []
    try { events = session.snapshotEvents() } catch (e) { return null }
    if (!Array.isArray(events) || !events.length) return null
    const users = [], ops = [], results = []
    let firstAt = 0, lastAt = 0
    for (const ev of events) {
      if (!ev || !ev.data) continue
      const at = Number(ev.time) || 0
      if (at) { if (!firstAt || at < firstAt) firstAt = at; if (at > lastAt) lastAt = at }
      if (ev.type === 'user/message') {
        const t = plainText(ev.data.content)
        if (t.trim() && users.length < SESSION_MAX_USERS) users.push(clip(t, 400))
      } else if (ev.type === 'tool/call') {
        if (ops.length < SESSION_MAX_OPS) ops.push(clip(String(ev.data.name || '') + ' ' + String(ev.data.arguments || ''), 200))
      } else if (ev.type === 'tool/result') {
        const t = plainText(ev.data.message && ev.data.message.content)
        if (t.trim() && results.length < SESSION_MAX_RESULTS) results.push(clip(t, 300))
      } else if (ev.type === 'assistant/message') {
        const t = plainText(ev.data.message && ev.data.message.content)
        if (t.trim() && results.length < SESSION_MAX_RESULTS) results.push('（模型结论）' + clip(t, 240))
      }
    }
    const L = []
    L.push('### 会话：' + (sessionTitleOf(session) || String(session.id).slice(0, 16)))
    if (firstAt) L.push('时间：' + fmtTime(firstAt) + ' → ' + fmtTime(lastAt))
    if (users.length) { L.push('用户要求：'); for (const u of users) L.push('- ' + u) }
    if (ops.length) { L.push('关键操作（工具调用）：'); for (const o of ops) L.push('- ' + o) }
    if (results.length) { L.push('结果与结论：'); for (const r of results) L.push('- ' + r) }
    const text = L.join('\n')
    return {
      id: String(session.id), title: sessionTitleOf(session), firstAt: firstAt, lastAt: lastAt,
      users: users, ops: ops.length, results: results.length,
      text: text.length > chars ? text.slice(0, chars) + '\n（本会话已截断）' : text,
    }
  }

  // ── 证据：攻击矩阵 ────────────────────────────────────────────────────────
  function matrixPath() {
    const p = String(settings().matrixStore || '').trim()
    if (p) return p
    const w = currentWorkspace()
    return w && w.path ? String(w.path).replace(/\/+$/, '') + '/' + DEFAULT_MATRIX_STORE : DEFAULT_MATRIX_STORE
  }

  // 没有攻击矩阵插件在跑时的退路：直接读它的存储文件（读任何路径都允许）。
  // 代价是拿不到技术点名字 —— 所以只当退路，不当主路。
  async function matrixFromFile(path) {
    const fs = ctx.get('fs')
    if (!fs || typeof fs.resolve !== 'function') return null
    const target = await fs.resolve(path)
    const info = await fs.stat(target)
    if (!info) return { from: 'file', items: [], confirmed: 0, suspected: 0, storePath: path, missing: true }
    const parsed = JSON.parse(await fs.readText(target))
    const items = []
    const matrix = parsed && parsed.matrix && typeof parsed.matrix === 'object' ? parsed.matrix : {}
    for (const fwId of Object.keys(matrix)) {
      const techs = matrix[fwId] || {}
      for (const tid of Object.keys(techs)) {
        const hits = techs[tid] || {}
        for (const sid of Object.keys(hits)) {
          const h = hits[sid]
          if (!h || h.confidence === 'rejected') continue
          items.push({
            frameworkId: fwId, frameworkLabel: fwId, techniqueId: tid, techniqueName: '',
            sessionId: sid, sessionTitle: String(h.sessionTitle || ''),
            confidence: h.confidence === 'confirmed' ? 'confirmed' : 'suspected',
            decidedBy: String(h.decidedBy || ''), reason: String(h.reason || ''),
            occurrences: intOf(h.occurrences, 0), firstAt: intOf(h.firstAt, 0), lastAt: intOf(h.lastAt, 0),
            kind: String(h.kind || ''), matched: (h.matched || []).slice(0, 10), targets: (h.targets || []).slice(0, 10),
            snippets: (h.snippets || []).slice(-3).map(function (x) { return { at: x.at, label: x.label, text: clip(x.text, 400) } }),
          })
        }
      }
    }
    const out = { from: 'file', items: items, storePath: path, updatedAt: intOf(parsed.updatedAt, 0) }
    out.confirmed = items.filter(function (x) { return x.confidence === 'confirmed' }).length
    out.suspected = items.length - out.confirmed
    return out
  }

  async function collectMatrix() {
    const svc = ctx.get('redteamAttackMatrix')
    if (svc && typeof svc.digest === 'function') {
      try {
        const d = await svc.digest()
        if (d && Array.isArray(d.items)) return Object.assign({ from: 'service' }, d)
      } catch (e) {
        log('warn', '从攻击矩阵服务取数失败，改读存储文件：' + msgOf(e))
      }
    }
    const path = matrixPath()
    try {
      const d = await matrixFromFile(path)
      if (!d) return { from: 'none', items: [], confirmed: 0, suspected: 0, storePath: path }
      // 服务在跑但 digest 失败时，至少把技术点名字补上。
      if (svc && typeof svc.names === 'function') {
        try {
          const names = svc.names()
          for (const it of d.items) {
            const fw = names[it.frameworkId]
            if (!fw) continue
            it.frameworkLabel = fw.label || it.frameworkId
            it.frameworkShort = fw.short || it.frameworkLabel
            if (fw.techniques && fw.techniques[it.techniqueId]) it.techniqueName = fw.techniques[it.techniqueId]
          }
        } catch (e) { /* 名字是加分项，拿不到就算了 */ }
      }
      d.items.sort(function (a, b) {
        return (b.confidence === 'confirmed' ? 1 : 0) - (a.confidence === 'confirmed' ? 1 : 0) || (b.lastAt - a.lastAt)
      })
      return d
    } catch (e) {
      return { from: 'none', items: [], confirmed: 0, suspected: 0, storePath: path, error: msgOf(e) }
    }
  }

  // ── 证据：记忆库 ──────────────────────────────────────────────────────────
  async function collectMemory(queries) {
    const svc = ctx.get('redteamMemory')
    if (!svc || typeof svc.search !== 'function') {
      return { available: false, hits: [], note: '记忆插件没在运行（redteamMemory 服务不可用），本次报告不含记忆条目' }
    }
    const seen = {}
    const hits = []
    const budget = Math.max(0, intOf(settings().memoryQueries, 6))
    const used = queries.slice(0, budget)
    for (const q of used) {
      if (!q || !String(q).trim()) continue
      try {
        const r = await svc.search(String(q), settings().memoryTopK, { rerank: false })
        for (const h of (r && r.hits) || []) {
          const id = String(h.id || h.entryId || h.title)
          if (seen[id]) continue
          seen[id] = true
          hits.push({
            id: id, title: String(h.title || ''), kind: String(h.kind || ''), tags: String(h.tags || ''),
            text: clip(h.text, 500), source: String(h.source || ''), query: String(q), mode: String(h.mode || ''),
          })
        }
      } catch (e) {
        log('warn', '记忆检索失败（' + clip(q, 40) + '）：' + msgOf(e))
      }
    }
    return { available: true, hits: hits, queries: used }
  }

  // ── 证据采集与 digest ─────────────────────────────────────────────────────
  async function collectEvidence() {
    const s = settings()
    const w = currentWorkspace()
    const sessions = []
    if (w) {
      // 最近的会话优先：报告写的是这次测试，不是三个月前的。
      const withTime = []
      for (const session of sessionsOf(w.id)) {
        let last = 0
        try {
          const evs = session.snapshotEvents()
          if (Array.isArray(evs) && evs.length) last = Number(evs[evs.length - 1].time) || 0
        } catch (e) { /* 拿不到时间就排最后 */ }
        withTime.push({ session: session, last: last })
      }
      withTime.sort(function (a, b) { return b.last - a.last })
      for (const x of withTime.slice(0, s.sessionLimit)) {
        const d = sessionDigest(x.session, s.sessionChars)
        if (d) sessions.push(d)
      }
    }

    const matrix = await collectMatrix()
    const confirmed = matrix.items.filter(function (x) { return x.confidence === 'confirmed' }).slice(0, s.maxConfirmed)
    const suspected = matrix.items.filter(function (x) { return x.confidence !== 'confirmed' }).slice(0, s.maxSuspected)

    // 记忆检索的 query：先拿矩阵里确认的技术点名字（那是本次测试「发生了什么」），
    // 再补每个会话的第一条用户要求（那是「想做什么」）。
    const queries = []
    for (const it of confirmed.concat(suspected)) {
      const name = it.techniqueName || it.techniqueId
      if (name && queries.indexOf(name) < 0) queries.push(name)
    }
    for (const d of sessions) for (const u of (d.users || []).slice(0, 1)) if (queries.indexOf(u) < 0) queries.push(clip(u, 60))
    const memory = await collectMemory(queries)

    return {
      at: nowMs(),
      workspace: w ? { id: w.id, title: w.title, path: w.path } : null,
      sessions: sessions,
      matrix: {
        from: matrix.from, storePath: matrix.storePath || '', error: matrix.error || null,
        updatedAt: matrix.updatedAt || 0, total: matrix.items.length,
        confirmed: confirmed, suspected: suspected,
        confirmedAll: intOf(matrix.confirmed, confirmed.length), suspectedAll: intOf(matrix.suspected, suspected.length),
      },
      memory: memory,
      queries: queries,
    }
  }

  function matrixLines(items, kind) {
    const out = []
    for (const it of items) {
      const fw = it.frameworkShort || it.frameworkLabel || it.frameworkId
      const name = it.techniqueName ? '（' + it.techniqueName + '）' : ''
      const bits = []
      if (it.occurrences) bits.push('出现 ' + it.occurrences + ' 次')
      if (it.firstAt) bits.push(fmtTime(it.firstAt) + (it.lastAt && it.lastAt !== it.firstAt ? ' → ' + fmtTime(it.lastAt) : ''))
      if (it.sessionTitle) bits.push('会话「' + clip(it.sessionTitle, 40) + '」')
      if (it.decidedBy) bits.push('判定方 ' + it.decidedBy)
      out.push('- ' + fw + ' / ' + it.techniqueId + name + (bits.length ? '｜' + bits.join('｜') : ''))
      if (it.reason) out.push('  判据：' + clip(it.reason, 300))
      if (it.targets && it.targets.length) out.push('  目标：' + clip(it.targets.join('、'), 200))
      if (it.matched && it.matched.length) out.push('  命中线索：' + clip(it.matched.join('、'), 160))
      // 疑似条目的片段不进 digest：那些多半是关键词撞上的原文，放进去只会把报告带偏。
      if (kind === 'confirmed') {
        for (const sn of (it.snippets || []).slice(-2)) out.push('  证据片段[' + (sn.label || '') + ' ' + fmtTime(sn.at) + ']：' + clip(sn.text, 300))
      }
    }
    return out
  }

  function buildDigest(ev) {
    const s = settings()
    const L = []
    L.push('# 证据材料（自动采集；报告只能引用这里出现过的事实）')
    L.push('')
    L.push('## 一、工作区与会话')
    L.push('- 工作区：' + (ev.workspace ? (ev.workspace.title || '') + '（' + ev.workspace.path + '）' : '（拿不到工作区）'))
    L.push('- 采集时间：' + fmtTime(ev.at))
    L.push('- 会话数：' + ev.sessions.length)
    for (const d of ev.sessions) { L.push(''); L.push(d.text) }

    L.push('')
    L.push('## 二、攻击矩阵命中')
    L.push('- 来源：' + (ev.matrix.from === 'service' ? '攻击矩阵插件（含技术点名字）'
      : ev.matrix.from === 'file' ? '直接读 ' + ev.matrix.storePath + '（拿不到技术点名字，只有 id）' : '没有可用数据'))
    if (ev.matrix.error) L.push('- 读取问题：' + ev.matrix.error)
    L.push('- 已确认 ' + ev.matrix.confirmed.length + ' 条（全部 ' + ev.matrix.confirmedAll + ' 条）· 疑似 '
      + ev.matrix.suspected.length + ' 条（全部 ' + ev.matrix.suspectedAll + ' 条）')
    L.push('')
    L.push('### 已确认（有做成的证据）')
    const cf = matrixLines(ev.matrix.confirmed, 'confirmed')
    if (cf.length) for (const x of cf) L.push(x); else L.push('- （无）')
    L.push('')
    L.push('### 疑似（提及或尝试过，但没证明成功）')
    const sp = matrixLines(ev.matrix.suspected, 'suspected')
    if (sp.length) for (const x of sp) L.push(x); else L.push('- （无）')

    L.push('')
    L.push('## 三、记忆库里与本次测试相关的知识')
    if (!ev.memory.available) L.push('- ' + ev.memory.note)
    else if (!ev.memory.hits.length) L.push('- （没有检索到相关条目）')
    else for (const h of ev.memory.hits) L.push('- [' + (h.kind || 'knowledge') + '] ' + h.title + '：' + clip(h.text, 400))

    let text = L.join('\n')
    if (text.length > s.digestMax) {
      text = text.slice(0, s.digestMax) + '\n\n（证据材料超过 ' + s.digestMax + ' 字，已截断；可在设置里调大上限或减少会话数）'
    }
    return text
  }

  function buildSystemPrompt() {
    return [
      '你是红队报告撰写助手。你会拿到一份自动采集的证据材料，然后写一份中文技术报告（Markdown）。',
      '',
      '纪律（这些比文采重要）：',
      '1. 只能写证据材料里出现过的事实。不要编造 IP、端口、URL、命令回显、时间、数量。',
      '2. 攻击矩阵的「已确认」才能写成已确认的发现；「疑似」必须放在疑似与待验证一节，并写清为什么没确认。',
      '3. 每条发现都要能指回证据：写清出现在哪个会话、哪个技术点、什么目标。',
      '4. 数字（出现次数、时间区间）必须与证据材料一致，不要四舍五入成好看的数字。',
      '5. 证据不足就写「证据不足」——一份诚实的中等报告比一份编造的优秀报告有用得多。',
      '6. 不要用代码围栏包住整篇报告，直接给 Markdown 正文。',
    ].join('\n')
  }

  function buildUserPrompt(digest, instruction) {
    const L = []
    L.push('请根据下面的证据材料撰写红队测试报告。')
    L.push('')
    L.push('按这个大纲组织（标题层级用 ##）：')
    for (const x of OUTLINE) L.push(x)
    L.push('')
    L.push('开头用一行 `# 标题` 给出报告标题（包含测试对象与时间范围，不要只写「红队报告」）。')
    if (String(instruction || '').trim()) {
      L.push('')
      L.push('额外要求（必须满足）：')
      L.push(String(instruction).trim())
    }
    L.push('')
    L.push('---')
    L.push('')
    L.push(digest)
    return L.join('\n')
  }

  // ── 生成（后台任务，边流边写）────────────────────────────────────────────
  const gen = { active: false, reportId: '', chars: 0, startedAt: 0 }

  function pickModel() {
    const s = settings()
    const llm = ctx.get('llm')
    const out = { provider: String(s.model.provider || '').trim(), model: String(s.model.model || '').trim(), from: 'settings' }
    if (!out.provider || !out.model) {
      const svc = ctx.get('agentDefaultModel')
      let sel = null
      try { if (svc && typeof svc.currentSelection === 'function') sel = svc.currentSelection() } catch (e) { sel = null }
      if (sel && sel.provider && sel.model) {
        out.provider = String(sel.provider)
        out.model = String(sel.model)
        out.from = 'default'
      }
    }
    if (!out.provider) {
      // 最后退到 llm 注册的第一个 provider（列不出模型时至少给个能用的路由）
      try {
        const provs = llm && typeof llm.listProviders === 'function' ? llm.listProviders() : null
        if (Array.isArray(provs) && provs.length && provs[0] && provs[0].id) {
          out.provider = String(provs[0].id)
          out.from = 'provider'
        }
      } catch (e) { /* 下面统一报错 */ }
    }
    return out
  }

  async function runGenerate(report, instruction) {
    const llm = ctx.get('llm')
    if (!llm || typeof llm.stream !== 'function') throw new Error('llm 服务不可用，没法自动撰写（宿主里要有 llm 插件）')
    const sel = pickModel()
    if (!sel.provider || !sel.model) throw new Error('拿不到可用的模型：设置里没填，当前会话也没有默认模型')

    const ev = await collectEvidence()
    const digest = buildDigest(ev)
    const messages = [{ id: 'rpt-' + nowMs(), role: 'user', content: [{ type: 'text', text: buildUserPrompt(digest, instruction) }], source: { kind: 'user' } }]

    log('info', '开始撰写报告（' + sel.provider + '/' + sel.model + '，证据 ' + digest.length + ' 字：' + ev.sessions.length + ' 个会话，已确认 '
      + ev.matrix.confirmed.length + ' 条，疑似 ' + ev.matrix.suspected.length + ' 条，记忆 ' + ev.memory.hits.length + ' 条）')

    const parts = []
    let usage = null
    let finish = null
    let lastFlush = 0
    const stream = llm.stream({
      provider: sel.provider, model: sel.model, system: buildSystemPrompt(),
      messages: messages, maxTokens: settings().maxTokens,
    })

    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        parts.push(chunk.text)
        // 边流边写回报告对象：面板轮询 snapshot 就能看到正在长出来的正文。
        gen.chars = parts.join('').length
        store.meta.progress = { text: '正在撰写… ' + gen.chars + ' 字', chars: gen.chars, total: 0 }
        const now = nowMs()
        if (now - lastFlush > 800) {
          lastFlush = now
          report.markdown = parts.join('')
          report.updatedAt = now
        }
      } else if (chunk.type === 'usage' && chunk.usage) {
        usage = chunk.usage
      } else if (chunk.type === 'finish') {
        finish = chunk.reason
      }
    }

    const text = parts.join('')
    report.markdown = text
    report.updatedAt = nowMs()
    if (!report.title || report.title === '未命名报告') {
      const m = /^\s*#\s+(.+)$/m.exec(text)
      report.title = clip(m ? m[1] : ('红队测试报告 ' + fmtTime(report.createdAt)), 200)
    }
    report.meta = Object.assign({}, report.meta, {
      provider: sel.provider, model: sel.model, modelFrom: sel.from,
      chars: text.length, usage: usage || null, generatedAt: report.updatedAt,
      evidence: {
        sessions: ev.sessions.length,
        matrixConfirmed: ev.matrix.confirmed.length,
        matrixSuspected: ev.matrix.suspected.length,
        matrixFrom: ev.matrix.from,
        memoryHits: ev.memory.hits.length,
        memoryAvailable: ev.memory.available,
        digestChars: digest.length,
      },
      instruction: String(instruction || '').slice(0, 2000),
    })
    store.meta.evidence = report.meta.evidence

    if (finish && finish.kind === 'error') throw new Error('模型返回错误：' + ((finish.failure && finish.failure.message) || '未知'))
    if (finish && finish.kind === 'aborted') throw new Error('生成被中止：' + ((finish.failure && finish.failure.message) || ''))
    if (!text.trim()) throw new Error('模型没有返回任何正文（finish = ' + (finish ? finish.kind : '?') + '）')
    return { chars: text.length, evidence: report.meta.evidence }
  }

  // 生成失败且一个字都没写出来时，把这份空报告撤掉：面板里留一堆空壳只会让人困惑。
  function dropIfEmpty(report) {
    if (String(report.markdown || '').trim()) return false
    store.reports = store.reports.filter(function (r) { return r.id !== report.id })
    if (store.currentId === report.id) store.currentId = store.reports.length ? store.reports[store.reports.length - 1].id : ''
    return true
  }

  function startGenerate(report, instruction) {
    if (gen.active) return { ok: false, error: '已经有一次生成在跑，先等它结束' }
    gen.active = true
    gen.reportId = report.id
    gen.chars = 0
    gen.startedAt = nowMs()
    store.meta.generating = true
    store.meta.progress = { text: '正在采集证据…', chars: 0, total: 0 }
    store.meta.lastOp = { at: nowMs(), op: 'generate', text: report.id }
    Promise.resolve()
      .then(function () { return runGenerate(report, instruction) })
      .then(function (r) {
        store.meta.progress = null
        store.meta.generating = false
        log('ok', '报告撰写完成：' + r.chars + ' 字（' + report.title + '）')
      })
      .catch(function (e) {
        store.meta.progress = null
        store.meta.generating = false
        store.meta.lastError = '撰写失败：' + msgOf(e)
        log('err', store.meta.lastError)
        dropIfEmpty(report)
      })
      .then(function () {
        gen.active = false
        return persist()
      })
      .catch(function () {})
    return { ok: true, started: true, reportId: report.id }
  }

  // ── 导出 ──────────────────────────────────────────────────────────────────
  // 交付方式是**写到磁盘 + 把绝对路径回显给用户**，不做浏览器下载：
  // 动态形态的客户端沙箱只给了 ctx / React / host / styles / console，
  // 没有 document / Blob / URL，拼下载链接那条路在动态半边直接不可用。
  function safeName(title) {
    const base = String(title || 'report').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '')
    return (base || 'report').slice(0, 80)
  }

  // 文本走 fs.writeText；docx 是二进制，借 shell + base64 落盘。
  // 沙箱里 shell 与插件 fs 的工作区未必相同，所以先把绝对路径解析出来再交给 shell。
  async function writeExport(name, content, isBinary) {
    const dir = String(settings().exportDir || '').trim().replace(/\/+$/, '')
    const rel = dir ? dir + '/' + name : name
    const fs = ctx.get('fs')
    if (!isBinary) {
      if (!fs || typeof fs.resolve !== 'function') return { ok: false, error: 'fs 服务不可用' }
      const t = await fs.resolve(rel)
      await fs.writeText(t, content)
      return { ok: true, path: hostPathOf(fs, t) || rel }
    }
    const shell = ctx.get('shell')
    if (!shell || typeof shell.resolve !== 'function') return { ok: false, error: 'shell 服务不可用（Word 是二进制，落盘要借 shell + base64）' }
    let abs = rel
    if (fs && typeof fs.resolve === 'function') {
      try { abs = hostPathOf(fs, await fs.resolve(rel)) || rel } catch (e) { abs = rel }
    }
    const spec = shell.resolve({
      command: "printf '%s' " + shQuote(content) + ' | base64 -d > ' + shQuote(abs),
      timeoutMs: SHELL_TIMEOUT_MS, stdoutMaxBytes: 4096,
    })
    const r = await shell.run(spec)
    if (r && r.exitCode === 0) return { ok: true, path: abs }
    return { ok: false, error: '写文件失败：' + clip((r && r.stderr && r.stderr.text) || '未知', 200), path: abs }
  }

  function reportMetaTable(report) {
    const m = report.meta || {}
    const ev = m.evidence || {}
    return {
      '生成时间': fmtTime(m.generatedAt || report.updatedAt),
      '生成模型': (m.provider || '?') + ' / ' + (m.model || '?'),
      '证据：会话': String(ev.sessions === undefined ? '?' : ev.sessions),
      '证据：矩阵命中': '已确认 ' + (ev.matrixConfirmed || 0) + ' · 疑似 ' + (ev.matrixSuspected || 0),
      '证据：记忆条目': String(ev.memoryHits || 0) + (ev.memoryAvailable === false ? '（记忆插件未运行）' : ''),
      '字数': String(String(report.markdown || '').length),
    }
  }

  async function exportReport(id, format) {
    const report = store.reports.filter(function (r) { return r.id === String(id) })[0] || currentReport()
    if (!report) return { ok: false, error: '没有可导出的报告' }
    const fmt = String(format || 'md').toLowerCase()
    const name = safeName(report.title) + '-' + stamp()
    const body = String(report.markdown || '').replace(/^\s*#\s+.+\n/, '')
    if (fmt === 'md') {
      const text = '# ' + report.title + '\n\n' + body
      const w = await writeExport(name + '.md', text, false)
      return { ok: true, format: 'md', name: name + '.md', bytes: text.length, path: w.path || '', writeError: w.ok ? null : w.error }
    }
    if (fmt === 'html') {
      const html = rptBuildHtml({ title: report.title, markdown: report.markdown, meta: reportMetaTable(report) })
      const w = await writeExport(name + '.html', html, false)
      return { ok: true, format: 'html', name: name + '.html', bytes: html.length, path: w.path || '', writeError: w.ok ? null : w.error }
    }
    if (fmt === 'docx') {
      const bytes = rptBuildDocx({ title: report.title, markdown: report.markdown, meta: reportMetaTable(report) })
      const b64 = rptBytesToBase64(bytes)
      const w = await writeExport(name + '.docx', b64, true)
      log('ok', '导出 Word：' + (w.ok ? w.path : '落盘失败（' + w.error + '），已准备浏览器下载'))
      return { ok: true, format: 'docx', name: name + '.docx', bytes: bytes.length, path: w.path || '', writeError: w.ok ? null : w.error }
    }
    return { ok: false, error: '不支持的格式：' + fmt + '（支持 md / html / docx）' }
  }

  // ── 导入记忆 ──────────────────────────────────────────────────────────────
  function reportToEntries(report) {
    const title = report.title || '红队报告'
    const source = '报告 · ' + clip(title, 60)
    const out = []
    for (const b of String(report.markdown || '').split(/\n(?=##\s)/)) {
      const t = b.trim()
      if (!t) continue
      const m = /^##\s+(.+)$/m.exec(t)
      // 开头那段往往只有一行 H1 标题：当独立条目是噪声，跳过（但整篇没有 ## 时下面的兜底会保住全文）。
      if (!m && t.replace(/^#\s+.+$/m, '').trim().length < 40) continue
      out.push({ title: clip(m ? m[1] : title, 120), text: t, kind: 'note', tags: ['报告'], source: source })
    }
    if (!out.length) out.push({ title: clip(title, 120), text: String(report.markdown || ''), kind: 'note', tags: ['报告'], source: source })
    return out
  }

  async function importToMemory(id) {
    const svc = ctx.get('redteamMemory')
    if (!svc || typeof svc.add !== 'function') {
      return { ok: false, error: '记忆插件没在运行（redteamMemory 服务不可用）：先让红队记忆插件跑起来' }
    }
    const report = store.reports.filter(function (r) { return r.id === String(id) })[0] || currentReport()
    if (!report) return { ok: false, error: '没有可导入的报告' }
    if (!String(report.markdown || '').trim()) return { ok: false, error: '报告还是空的，先生成或写点内容' }
    const entries = reportToEntries(report)
    const r = await svc.add(entries, '报告 · ' + clip(report.title, 60))
    log('ok', '报告导入记忆：' + r.added + ' 条新增 / ' + r.updated + ' 条覆盖（本地共 ' + (r.localCount || 0) + ' 条' + (r.indexError ? '，索引未同步' : '') + '）')
    store.meta.lastOp = { at: nowMs(), op: 'importToMemory', text: report.title }
    return { ok: true, added: r.added, updated: r.updated, entries: entries.length, indexed: r.indexed || 0, indexError: r.indexError || null, localCount: r.localCount || 0 }
  }

  // ── 状态快照 ──────────────────────────────────────────────────────────────
  function reportSummary(r) {
    return {
      id: r.id, title: r.title, chars: String(r.markdown || '').length,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
      provider: (r.meta && r.meta.provider) || '', model: (r.meta && r.meta.model) || '',
      evidence: (r.meta && r.meta.evidence) || null,
    }
  }

  function snapshot() {
    const cur = currentReport()
    const sel = pickModel()
    return {
      updatedAt: store.updatedAt,
      settings: settings(),
      outline: OUTLINE,
      model: { provider: sel.provider, model: sel.model, from: sel.from },
      reports: store.reports.map(reportSummary),
      currentId: cur ? cur.id : '',
      current: cur ? { id: cur.id, title: cur.title, markdown: cur.markdown, meta: cur.meta || {}, updatedAt: cur.updatedAt } : null,
      status: {
        persistence: store.meta.persistence || 'unknown',
        storePath: store.meta.storePath || '',
        lastError: store.meta.lastError || null,
        progress: store.meta.progress || null,
        generating: store.meta.generating === true,
        genChars: gen.chars,
        lastOp: store.meta.lastOp || null,
        evidence: store.meta.evidence || null,
        matrixPath: matrixPath(),
      },
      log: store.log.slice(-60),
    }
  }

  // ── 模型工具 ──────────────────────────────────────────────────────────────
  const genTool = harness.defineTool({
    name: 'report_generate',
    description: '基于当前工作区的对话、攻击矩阵命中与红队记忆库，自动撰写一份红队测试报告（Markdown）。会等写完再返回；正文同时出现在红队报告面板里，可以在那里编辑、预览、导出成 Word 或导入记忆。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '报告标题（省略时由正文里的 # 标题决定）' },
        instruction: { type: 'string', description: '额外要求，例如「重点写未授权访问，给出修复优先级」' },
      },
    },
    output: {
      schema: { type: 'json' },
      render: function (args, value) {
        if (!value || value.ok !== true) return [{ type: 'text', text: '撰写失败：' + ((value && value.error) || '未知错误') }]
        const e = value.evidence || {}
        const head = '报告已生成：' + value.title + '（' + value.chars + ' 字，reportId ' + value.reportId + '）'
        const ev = '证据来源：' + (e.sessions || 0) + ' 个会话 · 矩阵已确认 ' + (e.matrixConfirmed || 0) + ' 条 / 疑似 '
          + (e.matrixSuspected || 0) + ' 条（' + (e.matrixFrom === 'service' ? '来自攻击矩阵插件' : e.matrixFrom === 'file' ? '直接读矩阵存储' : '无矩阵数据') + '）· 记忆 '
          + (e.memoryHits || 0) + ' 条' + (e.memoryAvailable === false ? '（记忆插件未运行）' : '')
        const outline = (value.headings || []).length ? '章节：' + value.headings.join(' / ') : ''
        return [{ type: 'text', text: [head, ev, outline, '正文见红队报告面板（可编辑 / 预览 / 导出 Word / 导入记忆）。'].filter(Boolean).join('\n') }]
      },
    },
    execute: async function (args) {
      await ensureLoaded()
      const a = args && typeof args === 'object' ? args : {}
      const report = newReport(clip(a.title || '', 200) || '未命名报告')
      store.reports.push(report)
      store.currentId = report.id
      try {
        const r = await runGenerate(report, a.instruction)
        await persist()
        const headings = []
        const re = /^\s*##\s+(.+)$/gm
        let m = re.exec(report.markdown)
        while (m) { headings.push(clip(m[1], 60)); m = re.exec(report.markdown) }
        return { ok: true, reportId: report.id, title: report.title, chars: r.chars, evidence: r.evidence, headings: headings.slice(0, 12) }
      } catch (e) {
        // 失败也别丢掉半成品：面板里能看到写到哪儿了；但一个字都没写出来时就别留空壳。
        store.meta.generating = false
        store.meta.progress = null
        log('err', '工具撰写报告失败：' + msgOf(e))
        if (!String(report.markdown || '').trim()) {
          dropIfEmpty(report)
          await persist()
          return { ok: false, error: msgOf(e), reportId: '', chars: 0 }
        }
        report.updatedAt = nowMs()
        await persist()
        return { ok: false, error: msgOf(e), reportId: report.id, chars: String(report.markdown || '').length }
      }
    },
  })

  const listTool = harness.defineTool({
    name: 'report_list',
    description: '列出红队报告面板里已有的报告（id、标题、字数、生成时间、证据规模）。要引用或导出某一份时先用它拿 id。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'json' },
      render: function (args, value) {
        if (!value || value.ok !== true) return [{ type: 'text', text: '读取失败：' + ((value && value.error) || '未知错误') }]
        if (!value.reports.length) return [{ type: 'text', text: '还没有报告。可以用 report_generate 生成一份。' }]
        const lines = ['共 ' + value.reports.length + ' 份报告：']
        for (const r of value.reports) lines.push('· ' + r.title + '（' + r.chars + ' 字，id ' + r.id + '，更新于 ' + fmtTime(r.updatedAt) + '）')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async function () {
      await ensureLoaded()
      return { ok: true, reports: store.reports.map(reportSummary).sort(function (a, b) { return b.updatedAt - a.updatedAt }) }
    },
  })

  const exportTool = harness.defineTool({
    name: 'report_export',
    description: '把红队报告导出成文件（md / html / docx 三选一），写到磁盘并返回绝对路径。要 Word 就传 format=docx。省略 reportId 时导出面板里当前那一份。',
    parameters: {
      type: 'object',
      properties: {
        reportId: { type: 'string', description: '报告 id（从 report_list 拿；省略时用当前那一份）' },
        format: { type: 'string', enum: ['md', 'html', 'docx'], description: '导出格式，默认 docx' },
      },
    },
    output: {
      schema: { type: 'json' },
      render: function (args, value) {
        if (!value || value.ok !== true) return [{ type: 'text', text: '导出失败：' + ((value && value.error) || '未知错误') }]
        const lines = ['已导出 ' + value.format + '：' + value.name + '（' + value.bytes + ' 字节）']
        lines.push(value.path ? '落盘路径：' + value.path : '（没有落盘：' + (value.writeError || '未知原因') + '）')
        if (value.writeError && value.path) lines.push('落盘失败：' + value.writeError)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async function (args) {
      await ensureLoaded()
      const a = args && typeof args === 'object' ? args : {}
      const r = await exportReport(a.reportId, a.format || 'docx')
      if (r.ok) log('ok', '工具导出 ' + r.format + '：' + r.name + (r.path ? ' → ' + r.path : '（未落盘）'))
      else log('err', '工具导出失败：' + r.error)
      await persist()
      return r
    },
  })

  for (const t of [genTool, listTool, exportTool]) harness.registerTool(ctx, t)

  // ── RPC 句柄（客户端 host.call 调）────────────────────────────────────────
  harness.handle('snapshot', async function () {
    await ensureLoaded()
    return { ok: true, snapshot: snapshot() }
  })

  harness.handle('saveSettings', async function (args) {
    await ensureLoaded()
    mergeSettings(args && typeof args === 'object' ? args : {})
    const sel = pickModel()
    log('info', '设置已保存（模型 ' + (sel.provider || '?') + '/' + (sel.model || '?') + '，来源 ' + sel.from + '；证据上限 ' + settings().digestMax + ' 字）')
    await persist()
    return { ok: true, snapshot: snapshot() }
  })

  // 试算证据：把采集结果与真正喂给模型的 digest 打出来。
  // 「AI 写的报告不对」九成能从这一屏看出来：是证据没采到，还是提示词没说清。
  harness.handle('collect', async function (args) {
    await ensureLoaded()
    const ev = await collectEvidence()
    const digest = buildDigest(ev)
    const preview = Math.max(1000, Math.min(40000, intOf(args && args.preview, 8000)))
    store.meta.evidence = {
      sessions: ev.sessions.length, matrixConfirmed: ev.matrix.confirmed.length,
      matrixSuspected: ev.matrix.suspected.length, matrixFrom: ev.matrix.from,
      memoryHits: ev.memory.hits.length, memoryAvailable: ev.memory.available, digestChars: digest.length,
    }
    log('info', '试算证据：' + ev.sessions.length + ' 个会话，矩阵 ' + ev.matrix.confirmed.length + '/' + ev.matrix.suspected.length
      + '，记忆 ' + ev.memory.hits.length + ' 条，digest ' + digest.length + ' 字')
    await persist()
    return {
      ok: true, snapshot: snapshot(),
      evidence: {
        workspace: ev.workspace,
        sessions: ev.sessions.map(function (d) { return { id: d.id, title: d.title, users: d.users.length, ops: d.ops, results: d.results, firstAt: d.firstAt, lastAt: d.lastAt } }),
        matrix: { from: ev.matrix.from, storePath: ev.matrix.storePath, total: ev.matrix.total, confirmed: ev.matrix.confirmed.length, suspected: ev.matrix.suspected.length, error: ev.matrix.error || null },
        memory: { available: ev.memory.available, count: ev.memory.hits.length, note: ev.memory.note || '' },
        queries: ev.queries,
        digestChars: digest.length,
        digest: digest.slice(0, preview),
        truncated: digest.length > preview,
      },
    }
  })

  harness.handle('generate', async function (args) {
    await ensureLoaded()
    const a = args && typeof args === 'object' ? args : {}
    let report = a.reportId ? (store.reports.filter(function (r) { return r.id === String(a.reportId) })[0] || null) : currentReport()
    if (!report || a.createNew === true) {
      report = newReport(clip(a.title || '', 200) || '未命名报告')
      store.reports.push(report)
    }
    store.currentId = report.id
    const r = startGenerate(report, a.instruction !== undefined ? a.instruction : settings().instruction)
    if (r.ok !== true) return { ok: false, error: r.error, snapshot: snapshot() }
    await persist()
    return { ok: true, started: true, reportId: report.id, snapshot: snapshot() }
  })

  harness.handle('saveDraft', async function (args) {
    await ensureLoaded()
    const a = args && typeof args === 'object' ? args : {}
    const report = store.reports.filter(function (r) { return r.id === String(a.id || '') })[0] || currentReport()
    if (!report) return { ok: false, error: '没有可保存的报告' }
    if (a.title !== undefined) report.title = clip(a.title || '未命名报告', 200)
    if (a.markdown !== undefined) report.markdown = String(a.markdown || '')
    report.updatedAt = nowMs()
    store.currentId = report.id
    store.meta.lastOp = { at: nowMs(), op: 'saveDraft', text: report.title + '（' + String(report.markdown).length + ' 字）' }
    await persist()
    return { ok: true, snapshot: snapshot() }
  })

  harness.handle('select', async function (args) {
    await ensureLoaded()
    const id = String((args && args.id) || '')
    if (!store.reports.filter(function (r) { return r.id === id })[0]) return { ok: false, error: '找不到这份报告' }
    store.currentId = id
    await persist()
    return { ok: true, snapshot: snapshot() }
  })

  harness.handle('create', async function (args) {
    await ensureLoaded()
    const report = newReport(clip((args && args.title) || '', 200) || '未命名报告')
    store.reports.push(report)
    store.currentId = report.id
    log('info', '新建报告：' + report.title)
    await persist()
    return { ok: true, id: report.id, snapshot: snapshot() }
  })

  harness.handle('remove', async function (args) {
    await ensureLoaded()
    const ids = Array.isArray(args && args.ids) ? args.ids.map(String).filter(Boolean) : []
    if (!ids.length) return { ok: false, error: '没有选中要删除的报告' }
    const kept = []
    let n = 0
    for (const r of store.reports) {
      if (ids.indexOf(r.id) >= 0) { n++; continue }
      kept.push(r)
    }
    store.reports = kept
    if (ids.indexOf(store.currentId) >= 0) store.currentId = kept.length ? kept[kept.length - 1].id : ''
    log('warn', '删除报告 ' + n + ' 份')
    await persist()
    return { ok: true, deleted: n, snapshot: snapshot() }
  })

  // 预览：返回**完整 HTML 文档**，客户端塞进 iframe.srcdoc —— 与导出的 HTML 是同一份实现，
  // 所以「预览看到的」就是「导出的」。不用在前端再写一遍 markdown 渲染。
  harness.handle('preview', async function (args) {
    await ensureLoaded()
    const a = args && typeof args === 'object' ? args : {}
    const report = store.reports.filter(function (r) { return r.id === String(a.id || '') })[0] || currentReport()
    const markdown = a.markdown !== undefined ? String(a.markdown || '') : String((report && report.markdown) || '')
    const title = (a.title !== undefined ? String(a.title || '') : String((report && report.title) || '')) || '红队报告'
    return { ok: true, html: rptBuildHtml({ title: title, markdown: markdown, meta: report ? reportMetaTable(report) : {} }), chars: markdown.length }
  })

  harness.handle('export', async function (args) {
    await ensureLoaded()
    const a = args && typeof args === 'object' ? args : {}
    const r = await exportReport(a.id, a.format)
    if (r.ok) log('ok', '导出 ' + r.format + '：' + r.name + (r.path ? ' → ' + r.path : '（未落盘，走浏览器下载）'))
    else log('err', '导出失败：' + r.error)
    await persist()
    return r
  })

  harness.handle('importToMemory', async function (args) {
    await ensureLoaded()
    const a = args && typeof args === 'object' ? args : {}
    try {
      const r = await importToMemory(a.id)
      await persist()
      return Object.assign({ snapshot: snapshot() }, r)
    } catch (e) {
      log('err', '导入记忆失败：' + msgOf(e))
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
      console.log('[rtreport] 报告库 ' + store.reports.length + ' 份，落盘 ' + (store.meta.persistence || '?') + '：' + (store.meta.storePath || '(未解析)'))
    })
    .catch(function (e) { console.error('[rtreport] load failed:', msgOf(e)) })
    .then(function () { loaded = true })

  console.log('[rtreport] redteam-report host half ready; tools = 3, outline =', OUTLINE.length, '节，导出格式 md/html/docx')

/* @DOCX@ */
