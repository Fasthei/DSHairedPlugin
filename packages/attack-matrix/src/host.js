// 攻击矩阵 · Host 半边主体
//
// 本文件是 applyHost 的【函数体】——函数头、harness 垫片、收尾与导出都由
// lib/parts/host.head.js 与 host.tail.js 提供，所以这里不要写 import、function 头或 return 块。
// lib/host.js 由 `npm run build:lib` 生成，不要手改 lib/。
//
// ── 这个插件干什么 ────────────────────────────────────────────────────────────
// 扫【当前工作区】里所有会话的对话内容（用户消息、模型回复、工具调用与结果），
// 判断每次操作是否命中某个 AI 攻击框架的技术点：命中先记为「疑似」，由人确认后
// 计入「已覆盖」。数据按工作区落盘，切工作区就切数据集。
//
// 数据来源（都是宿主 Service，见 cordis Inspect）：
//   ctx.get('workspaceRegistry') -> list() / get(id) 拿工作区；w.sessionIds 已按 canonical cwd 过滤
//   ctx.get('sessions')          -> get(id) 拿会话；session.snapshotEvents() 拿事件
//
// 注意 sessions 是内存态（官方描述：持久化不在这个 store 里），所以只能扫进程内
// 活着的会话。矩阵自己的数据是落盘的，重启不丢已有记录，只是不能回溯扫描已经
// 不在内存里的会话。
//
// 静态形态与动态半边的差异（详见 ../../docs/DEVELOPMENT.md）：
//   - 工具用 defineTool({...}) 构造后 ctx.tools.register(t)，不要用 harness.defineTool
//   - 客户端 RPC 用 harness.handle('method', fn)，客户端侧 host.call 调

  // ══════════════════════════════════════════════════════════════════════════
  // 框架数据
  //
  // detect_keywords 是自动匹配用的特征词。命中只代表「疑似」，要人确认才算覆盖。
  // 这些词刻意选得具体：宁可漏报也不要刷屏——矩阵的价值在于缺口准，不在于命中多。
  // ══════════════════════════════════════════════════════════════════════════
/* @FRAMEWORKS@ */

  // ══════════════════════════════════════════════════════════════════════════
  // 存储
  //
  // 按工作区分文件：<工作区>/<STORE_NAME>。这让「切工作区 = 切数据集」是文件系统
  // 层面的事实，插件里不需要维护多份状态。
  // ══════════════════════════════════════════════════════════════════════════
  const STORE_NAME = '.redteam-attack-matrix.json'
  const STORE_VERSION = 1
  const SNIPPET_MAX = 200
  const SNIPPETS_PER_HIT = 4

  // 扫描与研判都自动跑，没有人工按钮：
  //   扫描是增量的（scans[sid].maxSeq），没有新事件时不落盘 —— 否则每 20 秒
  //   白写一次上百 KB 的矩阵文件。
  //   研判按批送给模型，JUDGE_BATCH 是单批上限：几十条疑似一次灌进去会淹没结论。
  const AUTO_SCAN_MS = 20000
  const AUTO_JUDGE_MS = 15000
  const JUDGE_BATCH = 8
  const JUDGE_SAMPLES = 2
  // 够一批才交出去，且两批之间至少隔这么久。不加这两道闸的话，在「正在开发
  // 这个插件的会话」里会变成每 90 秒唤醒一次模型 —— 扫描对象就是产生噪音的源头，
  // 队列永远排不空，判定请求会无休止地打断开发者。
  const JUDGE_MIN = 6
  const JUDGE_STALE_MS = 600000
  const JUDGE_COOLDOWN_MS = 300000
  // sentAt 是**租约**不是终态：唤醒模型可能根本没被接手（会话在忙、消息丢了）。
  // 超过这个时间还没有结论就把 sentAt 清掉重新排队，否则那几条会永远停在
  // 「模型研判中」——既不会被重送，也不会被判。
  const JUDGE_LEASE_MS = 900000
  const LOG_MAX = 120

  function isFresh(item, now) {
    return !item.sentAt || (now - item.sentAt > JUDGE_LEASE_MS)
  }

  function blankStore() {
    return {
      version: STORE_VERSION,
      workspacePath: '',
      updatedAt: 0,
      // scans[sessionId] = { maxSeq, title, at } —— 增量扫描的续点
      scans: {},
      // matrix[frameworkId][techniqueId][sessionId] = hit
      matrix: {},
      // 被标成「非目标」的会话：不再扫描、已有记录也清掉。
      // 存在的理由很具体：开发这个插件的工作区里，对话本身就在不停命中框架关键词
      // （我写一行注释含「主机名」就造出一个 T1082 桶），噪音会盖过真实目标数据。
      ignoreSessions: [],
      // triageAt[sessionId] = 最近一次把研判请求交给该会话的时刻。
      // 这是自反馈的第二道闸（第一道是 isSelfPrompt 过滤研判请求本身）：那之后该会话
      // 的**模型回复**是「判定过程」，里面必然复述研判请求的关键词（命中词清单、技术点名），
      // 扫回来就会造出一批和原始命中一模一样的新命中，队列永远排不空。
      triageAt: {},
      log: [],
      logSeq: 0,
      meta: { lastError: null, lastScanAt: 0, scannedSessions: 0 },
    }
  }

  function blankHit(sessionId, title) {
    return {
      sessionId: String(sessionId),
      sessionTitle: String(title || ''),
      firstAt: 0,
      lastAt: 0,
      occurrences: 0,
      // 只用于增量扫描续点；hit 本身不含任何运行时对象引用。
      maxSeq: -1,
      kind: '',
      snippets: [],
      matched: [],
      // 这条命中打过谁：URL / IP[:端口] / 主机名 / nmap -p 端口表。面板上直接显示。
      targets: [],
      confidence: 'suspected',
      confirmedAt: 0,
      // 自动研判：needsJudge 由扫描置位，sentAt 防重送，judgedAt 表示已定论。
      // decidedBy 记「谁定的」：model（AI 自动标）或 human（面板里手动点）。
      needsJudge: true,
      sentAt: 0,
      judgedAt: 0,
      decidedBy: '',
      reason: '',
    }
  }

  // ── 工具函数 ──────────────────────────────────────────────────────────────
  function msgOf(e) { return e && e.message ? String(e.message) : String(e) }

  function textOfContent(content) {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    let out = ''
    for (const b of content) {
      if (!b || typeof b !== 'object' || typeof b.text !== 'string') continue
      out += (out ? '\n' : '') + b.text
      if (out.length > 24000) break
    }
    return out
  }

  function clip(s, n) {
    const v = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim()
    return v.length > n ? v.slice(0, n - 1) + '…' : v
  }

  function lower(s) { return String(s === undefined || s === null ? '' : s).toLowerCase() }
  function nowMs() { return Date.now() }

  function fmtTime(ms) {
    if (!ms) return ''
    try {
      const d = new Date(ms)
      const p = function (n) { return n < 10 ? '0' + n : String(n) }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    } catch (e) { return '' }
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

  // 当前会话所在的工作区；取不到就退到第一个工作区（总比什么都不显示强）。
  function currentWorkspace() {
    const reg = workspaceRegistry()
    if (!reg) return null
    try {
      const agents = ctx.get('agents')
      let agent = null
      if (agents && typeof agents.currentInitiator === 'function') agent = agents.currentInitiator()
      if (!agent && agents && typeof agents.roots === 'function') {
        const roots = agents.roots()
        if (Array.isArray(roots) && roots.length === 1) agent = roots[0]
      }
      if (agent) {
        const sid = String(agent.id)
        for (const w of listWorkspaces()) {
          let full = null
          try { full = typeof reg.get === 'function' ? reg.get(w.id) : null } catch (e) {}
          const ids = full && Array.isArray(full.sessionIds) ? full.sessionIds : []
          for (const x of ids) if (String(x) === sid) return w
        }
      }
    } catch (e) {}
    const all = listWorkspaces()
    return all.length > 0 ? all[0] : null
  }

  // 工作区里的会话成员表。研判派发、孤儿命中过滤都以它为准。
  // 取不到（注册表不可用、工作区不存在）时返回空数组 —— 宁可放弃这次派发，
  // 也不要退化成「随便找个会话投过去」。
  function memberSessionIds(workspaceId) {
    const reg = workspaceRegistry()
    try {
      const w = reg && typeof reg.get === 'function' ? reg.get(String(workspaceId || '')) : null
      return w && Array.isArray(w.sessionIds) ? w.sessionIds.map(String) : []
    } catch (e) { return [] }
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

  // ── 落盘 ──────────────────────────────────────────────────────────────────
  function storePathFor(workspacePath) {
    const base = String(workspacePath || '').replace(/\/+$/, '')
    return (base ? base + '/' : '') + STORE_NAME
  }

  async function readStore(workspacePath) {
    const store = blankStore()
    store.workspacePath = String(workspacePath || '')
    const fs = ctx.get('fs')
    if (!fs || typeof fs.resolve !== 'function') {
      store.meta.lastError = 'fs 服务不可用，本次仅内存分析'
      return store
    }
    try {
      const target = await fs.resolve(storePathFor(workspacePath))
      const info = await fs.stat(target)
      if (!info) return store
      const parsed = JSON.parse(await fs.readText(target))
      if (!parsed || typeof parsed !== 'object') return store
      if (Number(parsed.version) !== STORE_VERSION) {
        store.meta.lastError = '已有数据版本 ' + parsed.version + '，当前 ' + STORE_VERSION + '，已忽略旧数据'
        return store
      }
      if (parsed.scans && typeof parsed.scans === 'object') store.scans = parsed.scans
      if (parsed.matrix && typeof parsed.matrix === 'object') store.matrix = parsed.matrix
      if (Array.isArray(parsed.ignoreSessions)) store.ignoreSessions = parsed.ignoreSessions.map(String)
      if (parsed.triageAt && typeof parsed.triageAt === 'object') {
        for (const k of Object.keys(parsed.triageAt)) store.triageAt[String(k)] = Number(parsed.triageAt[k]) || 0
      }
      if (Array.isArray(parsed.log)) store.log = parsed.log.slice(-LOG_MAX)
      if (typeof parsed.logSeq === 'number') store.logSeq = parsed.logSeq
      if (parsed.meta && typeof parsed.meta === 'object') {
        store.meta.lastScanAt = Number(parsed.meta.lastScanAt) || 0
        store.meta.scannedSessions = Number(parsed.meta.scannedSessions) || 0
      }
      store.updatedAt = Number(parsed.updatedAt) || 0
      return store
    } catch (e) {
      // 文件不存在不是错误：当作空矩阵继续。
      const m = msgOf(e)
      if (!/ENOENT|not found|不存在|null/i.test(m)) store.meta.lastError = '读取失败：' + m
      return store
    }
  }

  async function writeStore(store) {
    const fs = ctx.get('fs')
    if (!fs || typeof fs.resolve !== 'function') return false
    try {
      const target = await fs.resolve(storePathFor(store.workspacePath))
      const payload = {
        version: STORE_VERSION,
        workspacePath: store.workspacePath,
        updatedAt: store.updatedAt,
        scans: store.scans,
        matrix: store.matrix,
        ignoreSessions: store.ignoreSessions || [],
        triageAt: store.triageAt || {},
        log: (store.log || []).slice(-LOG_MAX),
        logSeq: store.logSeq || 0,
        meta: {
          lastScanAt: store.meta.lastScanAt,
          scannedSessions: store.meta.scannedSessions,
        },
      }
      await fs.writeText(target, JSON.stringify(payload, null, 2))
      return true
    } catch (e) {
      store.meta.lastError = '写入失败：' + msgOf(e)
      return false
    }
  }

  // ── 会话事件 -> 操作项 ────────────────────────────────────────────────────
  // 一次「攻击操作」= 一条用户消息 / 一次模型回复 / 一次工具调用或结果。
  // 这是矩阵卡片能对应到的最小可读单位，也是时间线的刻度。
  //
  // 但插件**自己的产出不能进矩阵**，否则是自反馈：判定 reason 里必然引用被命中的
  // 关键词（「`rce` 是 source 的子串」），研判请求正文里又带着「命中词：…」清单，
  // 下一轮扫描把它们当成新命中，于是同一批关键词被反复放大。
  // 实测污染面：matrix_label 出现在 25 个桶的证据里，研判正文出现在 6 个桶里。
  // 残留（已知、未处理）：判定过程中模型自己写的分析文本没有可靠标记可认，
  // 只能靠「别在开发这个插件的会话里依赖覆盖率」这条使用纪律回避。
  const SELF_TOOLS = ['matrix_label']
  const SELF_PROMPT = '【攻击矩阵 · 自动研判】'
  function isSelfTool(name) { return SELF_TOOLS.indexOf(String(name || '')) >= 0 }
  function isSelfPrompt(text) { return String(text || '').indexOf(SELF_PROMPT) >= 0 }

  function activitiesOf(session, opts) {
    let events = []
    try { events = session.snapshotEvents() } catch (e) { return [] }
    if (!Array.isArray(events)) return []
    // 这个会话收到过研判请求吗？收到过的话，那一刻之后的模型回复属于「判定过程」，
    // 不能再当命中扫回来（见 blankStore 里 triageAt 的说明）。
    const triageAt = (opts && opts.triageAt) || {}
    const judgedFrom = Number(triageAt[String(session.id || '')]) || 0

    // 先收拢工具调用，好让「调用 + 结果」在结果那条上仍能看到工具名与参数。
    const calls = {}
    for (const ev of events) {
      if (!ev || !ev.data || ev.type !== 'tool/call') continue
      const cid = String(ev.data.callId || '')
      if (cid) calls[cid] = { name: String(ev.data.name || ''), args: String(ev.data.arguments || '') }
    }

    const out = []
    for (const ev of events) {
      if (!ev || !ev.data) continue
      const seq = Number(ev.seq)
      const at = Number(ev.time) || 0
      const d = ev.data
      if (ev.type === 'user/message') {
        const text = textOfContent(d.content)
        if (text.trim() && !isSelfPrompt(text)) out.push({ kind: 'user', seq: seq, at: at, text: text, label: '用户消息' })
      } else if (ev.type === 'assistant/message') {
        if (judgedFrom && at >= judgedFrom) continue
        const text = textOfContent(d.message && d.message.content)
        if (text.trim()) out.push({ kind: 'assistant', seq: seq, at: at, text: text, label: '模型回复' })
      } else if (ev.type === 'tool/call') {
        if (isSelfTool(d.name)) continue
        out.push({ kind: 'tool', seq: seq, at: at, text: String(d.name || '') + ' ' + String(d.arguments || ''), label: '工具调用 ' + String(d.name || '') })
      } else if (ev.type === 'tool/result') {
        const cid = String((d.message && d.message.source && d.message.source.callId) || '')
        const c = calls[cid]
        if (c && isSelfTool(c.name)) continue
        out.push({
          kind: 'tool',
          seq: seq,
          at: at,
          text: (c ? c.name + ' ' + c.args + ' ' : '') + textOfContent(d.message && d.message.content),
          label: '工具结果' + (c && c.name ? ' ' + c.name : ''),
          error: !!d.error,
        })
      }
    }
    return out
  }

  function sessionTitleOf(session) {
    try {
      const st = ctx.get('sessionTitle')
      if (st && typeof st.get === 'function') {
        const snap = st.get(session)
        if (snap && snap.title) return clip(snap.title, 60)
      }
    } catch (e) {}
    const id = String(session.id || '')
    return id.length > 14 ? id.slice(0, 14) : id
  }

  // ── 目标提取 ──────────────────────────────────────────────────────────────
  // 时间线和攻击操作日志要能一眼看出「打的是谁」：光有技术点 ID 没用，
  // 红队回溯时要的是具体目标。所以从操作文本里抽出 URL / IP[:端口] / 主机名 / nmap 的 -p 端口表。
  // 只做保守提取：宁可少列，不要把随机数字当端口刷屏。
  const RE_URL = /\bhttps?:\/\/[^\s"'`,;)<>\\]+/gi
  const RE_IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g
  const RE_HOST = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|cn|net|org|io|cc|dev|app|xyz|top|info|biz|me|tv|cloud|site|online|tech|store|shop|link|live|fun|pro|work|space|website|host|press|wiki|edu|gov|mil|int|ai|sh|de|jp|uk|fr|ru|us|ca|au|nl|se|it|es|br|in|kr|tw|hk|sg|local|internal|lan)\b/gi
  // nmap 风格的端口表：`-p 8002,8003,8004,11434` / `-p 1-1024`
  const RE_PORTLIST = /(?:^|\s)-p\s+([0-9][0-9,\-]{0,80})/i
  const TARGETS_MAX = 12

  function targetsIn(text) {
    const s = String(text === undefined || text === null ? '' : text)
    if (!s) return []
    const out = []
    function add(v) {
      const t = String(v || '').trim()
      if (!t || t.length > 80) return
      if (out.indexOf(t) >= 0) return
      if (out.length < TARGETS_MAX) out.push(t)
    }
    let m
    RE_URL.lastIndex = 0
    while ((m = RE_URL.exec(s))) add(m[0])
    RE_IPV4.lastIndex = 0
    while ((m = RE_IPV4.exec(s))) add(m[0])
    RE_HOST.lastIndex = 0
    while ((m = RE_HOST.exec(s))) add(m[0].toLowerCase())
    const pl = RE_PORTLIST.exec(s)
    if (pl && pl[1]) add('端口 ' + pl[1])
    return out
  }

  function mergeTargets(hit, list) {
    if (!Array.isArray(list) || list.length === 0) return
    if (!Array.isArray(hit.targets)) hit.targets = []
    for (const t of list) {
      if (hit.targets.indexOf(t) >= 0) continue
      if (hit.targets.length >= TARGETS_MAX) return
      hit.targets.push(t)
    }
  }

  // 读的时候兜底：加 targets 字段之前扫出来的桶没有它，就从留存的证据片段里现取。
  // 这样不必为了看目标而重扫 —— 重扫会把已有的判定结论一起丢掉。
  function hitTargets(h) {
    if (Array.isArray(h.targets) && h.targets.length) return h.targets
    let s = ''
    for (const x of (h.snippets || [])) s += ' ' + (x.text || '')
    return targetsIn(s)
  }

  // ── 匹配 ──────────────────────────────────────────────────────────────────
  // 关键词表是扁平的，直接对 haystack 做匹配：一次操作 × 全部关键词。
  // 关键词总量在几百这个量级，实时扫描足够快，不值得上倒排索引。
  //
  // 但**必须带词边界**。裸 indexOf 实测造出过两个巨型假阳性：
  //   `rce` 命中 source / resource（单桶 395 次），`dos` 命中 todos（单桶 147 次）。
  // 含 CJK 的关键词不能用词边界（中文没有词边界），仍走子串匹配。
  const KW_ASCII = /^[\x20-\x7e]+$/
  const kwRegexCache = {}

  function kwHit(hay, kw) {
    let re = kwRegexCache[kw]
    if (re === undefined) {
      if (!KW_ASCII.test(kw)) re = null
      else {
        const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        re = new RegExp('(^|[^a-z0-9])' + esc + '($|[^a-z0-9])', 'i')
      }
      kwRegexCache[kw] = re
    }
    if (re === null) return hay.indexOf(kw) >= 0
    return re.test(hay)
  }

  function matchFrameworks(text) {
    const hay = lower(text)
    if (!hay) return []
    const found = []
    for (const fw of FRAMEWORKS) {
      for (const tech of fw.techniques) {
        let score = 0
        const hit = []
        for (const kw of tech.detect_keywords) {
          if (kw && kwHit(hay, kw)) { score++; hit.push(kw) }
        }
        if (score > 0) found.push({ frameworkId: fw.id, techniqueId: tech.id, keywords: hit, score: score })
      }
    }
    return found
  }

  // 同一条操作命中同一技术点的多个关键词时只留最好的那条：命中词越多越可信。
  function bestPerTechnique(matches) {
    const best = {}
    for (const m of matches) {
      const k = m.frameworkId + '\u0000' + m.techniqueId
      if (!best[k] || m.score > best[k].score) best[k] = m
    }
    const out = []
    for (const k of Object.keys(best)) out.push(best[k])
    return out
  }

  function entryBucket(store, frameworkId, techniqueId) {
    if (!store.matrix[frameworkId]) store.matrix[frameworkId] = {}
    if (!store.matrix[frameworkId][techniqueId]) store.matrix[frameworkId][techniqueId] = {}
    return store.matrix[frameworkId][techniqueId]
  }

  // ── 扫描 ──────────────────────────────────────────────────────────────────
  async function scanWorkspace(workspaceId, options) {
    const opts = options || {}
    const list = listWorkspaces()
    let w = null
    if (workspaceId) { for (const x of list) if (x.id === workspaceId) { w = x; break } }
    if (!w) w = currentWorkspace()
    if (!w) return { ok: false, error: '拿不到工作区（workspaceRegistry 不可用？）' }

    const store = await readStore(w.path)
    if (opts.reset === true) { store.matrix = {}; store.scans = {} }

    const sessions = sessionsOf(w.id)
    let touched = 0
    let scannedSessions = 0
    let newMatches = 0

    for (const session of sessions) {
      const sid = String(session.id || '')
      if (!sid) continue
      // 非目标会话：连水位都不碰，直接跳过。
      if ((store.ignoreSessions || []).indexOf(sid) >= 0) continue
      const title = sessionTitleOf(session)
      const acts = activitiesOf(session, { triageAt: store.triageAt })
      if (acts.length === 0) continue
      scannedSessions++

      const prev = store.scans[sid]
      const fromSeq = prev && typeof prev.maxSeq === 'number' ? prev.maxSeq : -1
      let maxSeq = fromSeq

      for (const act of acts) {
        if (!(act.seq > fromSeq)) continue
        if (act.seq > maxSeq) maxSeq = act.seq
        const matches = bestPerTechnique(matchFrameworks(act.text))
        if (matches.length === 0) continue
        newMatches++
        for (const m of matches) {
          const bucket = entryBucket(store, m.frameworkId, m.techniqueId)
          let hit = bucket[sid]
          if (!hit) { hit = blankHit(sid, title); bucket[sid] = hit }
          hit.sessionTitle = title
          hit.occurrences += 1
          // 扫描只负责「排进待判定队列」：第一次命中、或已定论之后又出现新操作，
          // 都重新排队等模型判定（decidedBy 为空 = 还没人下过结论）。
          if (hit.confidence !== 'confirmed' && !hit.judgedAt) { hit.needsJudge = true; hit.sentAt = 0 }
          if (!hit.firstAt || act.at < hit.firstAt) hit.firstAt = act.at
          if (act.at > hit.lastAt) hit.lastAt = act.at
          if (act.kind === 'tool') hit.kind = 'tool'
          else if (!hit.kind) hit.kind = act.kind
          for (const kw of m.keywords) if (hit.matched.indexOf(kw) < 0 && hit.matched.length < 12) hit.matched.push(kw)
          mergeTargets(hit, targetsIn(act.text))
          // 证据片段保留策略：最早的 2 条 + **滚动保留最新的 2 条**。
          // 原来只留最早的 4 条 —— 于是判定者永远看不到后半段发生了什么。
          // 实测踩过：一次未授权的模型创建/删除发生在很靠后的位置，判定时根本看不到，
          // 那次战果就没被记上。前面两条留着是为了保住「这条桶从什么开始」。
          const snip = { at: act.at, seq: act.seq, kind: act.kind, label: act.label, text: clip(act.text, SNIPPET_MAX) }
          if (hit.snippets.length < SNIPPETS_PER_HIT) {
            hit.snippets.push(snip)
          } else {
            hit.snippets[SNIPPETS_PER_HIT - 2] = hit.snippets[SNIPPETS_PER_HIT - 1]
            hit.snippets[SNIPPETS_PER_HIT - 1] = snip
          }
        }
      }

      if (maxSeq > fromSeq || !prev) {
        store.scans[sid] = { maxSeq: maxSeq, title: title, at: nowMs() }
        if (maxSeq > fromSeq) touched++
      }
    }

    store.meta.scannedSessions = scannedSessions
    // 没有新事件就不落盘。矩阵文件是百 KB 级，20 秒白写一次纯属浪费 I/O；
    // lastScanAt 的含义因此是「最近一次扫到新内容的时刻」，面板上按这个措辞显示。
    const changed = touched > 0 || opts.reset === true || newMatches > 0
    let saved = true
    if (changed) {
      store.updatedAt = nowMs()
      store.meta.lastScanAt = store.updatedAt
      saved = await writeStore(store)
      if (!saved && !store.meta.lastError) store.meta.lastError = '写入失败（未知原因）'
    }

    return {
      ok: true, saved: saved, changed: changed, store: store, workspace: w,
      stats: { sessions: sessions.length, scannedSessions: scannedSessions, newMatches: newMatches, touchedSessions: touched },
    }
  }

  // ── 自动扫描与自动研判 ────────────────────────────────────────────────────
  // 面板上没有「扫描」按钮：host 按节拍自己扫，自己把疑似交给模型定论。
  // 结论只能有两个来源 —— 模型（matrix_label，AI 自动标）或人在面板上手动点
  // （confirm / ignore）。扫描永远只负责「排进队列」，不自己下结论。
  let scanBusy = false
  let judgeBusy = false
  let lastHandoffAt = 0
  let rememberedAgent = null
  const autoScanState = { at: 0, changedAt: 0, sessions: 0, matches: 0 }

  // 所有「读整份 store -> 改 -> 整份写回」的路径都必须串行。
  // 不串行会丢更新：注册日志那次就是这样被同时进行的扫描覆盖掉的 ——
  // 两个异步链各自读了同一份旧数据，后写的把先写的改动整段抹掉。
  let storeChain = Promise.resolve()
  function withStore(fn) {
    const run = storeChain.then(function () { return fn() }, function () { return fn() })
    storeChain = run.then(function () {}, function () {})
    return run
  }

  function logTo(store, level, text) {
    store.logSeq = (store.logSeq || 0) + 1
    store.log.push({ seq: store.logSeq, at: nowMs(), level: level, text: String(text).slice(0, 1200) })
    if (store.log.length > LOG_MAX) store.log = store.log.slice(store.log.length - LOG_MAX)
  }

  // 待判定 = 还没有人下过结论的疑似命中。
  // 旧数据没有 judgedAt/decidedBy 这两个字段，判据里按「未判定」处理 ——
  // 于是升级后第一轮扫描就会把这批历史疑似全部排进队列，不需要迁移脚本。
  function pendingItems(store) {
    const out = []
    for (const fw of FRAMEWORKS) {
      const bucket = store.matrix[fw.id] || {}
      for (const tech of fw.techniques) {
        const hits = bucket[tech.id] || {}
        for (const sid of Object.keys(hits)) {
          const h = hits[sid]
          if (!h || h.confidence === 'confirmed' || h.judgedAt) continue
          out.push({
            frameworkId: fw.id, techniqueId: tech.id, techniqueName: tech.name,
            sessionId: sid, sessionTitle: h.sessionTitle,
            firstAt: h.firstAt || 0, lastAt: h.lastAt || 0, occurrences: h.occurrences || 0,
            matched: (h.matched || []).slice(0, 6),
            samples: (h.snippets || []).slice(-JUDGE_SAMPLES).map(function (s) { return clip(s.text, 300) }),
            sentAt: h.sentAt || 0,
          })
        }
      }
    }
    // 命中多的、近的先判：信息量大的先定论。
    out.sort(function (a, b) { return (b.occurrences - a.occurrences) || (b.lastAt - a.lastAt) })
    return out
  }

  function judgeRules() {
    const L = []
    L.push('你的任务：给下面每条「疑似命中」下结论，逐条调用 matrix_label 登记。')
    L.push('')
    L.push('三种结论：')
    L.push('1. confirmed —— **已经实现、已经验证**：对话里有做成的证据，例如利用成功、拿到回显/shell/文件内容、PoC 跑通、注入或越权确实生效、拿到了本不该拿到的数据。')
    L.push('2. suspected —— 只是提及、计划、讨论，或者尝试过但没有成功的证据。')
    L.push('3. rejected —— 误报：命中的其实是正常开发或与目标无关的内容。')
    L.push('')
    L.push('判定纪律（这几条决定了覆盖率可不可信）：')
    L.push('- 只有「做成了」才算 confirmed。命令写出来了、工具被调用了，但结果没证明成功 —— 那是 suspected。')
    L.push('- 关键看工具结果：报错、权限拒绝、404、连接超时、空结果都是**没做成**。')
    L.push('- 拿不准就 suspected。覆盖率虚高比缺项更有害。')
    L.push('- reason 要写你实际看到的内容，不要写「关键词匹配到了」这种同义反复。')
    L.push('')
    L.push('每条都要调一次 matrix_label，不要只在回复里写结论。')
    return L.join('\n')
  }

  function buildJudgePrompt(workspace, items) {
    const L = []
    L.push('【攻击矩阵 · 自动研判】工作区：' + (workspace.path || workspace.title || workspace.id))
    L.push('')
    L.push(judgeRules())
    L.push('')
    L.push('待判定 ' + items.length + ' 条：')
    for (const it of items) {
      L.push('')
      L.push('- ' + it.frameworkId + ' / ' + it.techniqueId + ' ' + it.techniqueName)
      L.push('  会话：' + (it.sessionTitle || '') + '（sessionId=' + it.sessionId + '）')
      L.push('  命中 ' + it.occurrences + ' 次，' + fmtTime(it.firstAt) + ' → ' + fmtTime(it.lastAt))
      L.push('  命中词：' + (it.matched || []).join('、'))
      for (const s of it.samples) L.push('  证据：' + s)
    }
    return L.join('\n')
  }

  function findAgent(workspaceId) {
    const agents = ctx.get('agents')
    if (!agents) return null
    const ids = memberSessionIds(workspaceId)
    if (ids.length === 0) return null
    function owned(a) { return !!a && ids.indexOf(String(a.id)) >= 0 }
    try {
      if (typeof agents.currentInitiator === 'function') {
        const a = agents.currentInitiator()
        if (owned(a)) { rememberedAgent = a; return a }
      }
      // 定时器回调里没有驱动链，currentInitiator() 必然是空的。这时候按
      // 「哪个根会话属于这个工作区」来认 —— 那才是该收到研判请求的会话。
      const roots = typeof agents.roots === 'function' ? agents.roots() : []
      if (Array.isArray(roots)) {
        for (const a of roots) if (owned(a)) { rememberedAgent = a; return a }
      }
    } catch (e) {}
    // 兜底：上次投递过的那个 agent，但必须**仍然属于这个工作区**。
    return owned(rememberedAgent) ? rememberedAgent : null
  }

  async function handoffToModel(store, workspace, items, agent) {
    if (!agent || typeof agent.followup !== 'function') {
      logTo(store, 'warn', '找不到本工作区内可唤醒的会话（不跨工作区投递），' + items.length + ' 条疑似留在队列里等下次研判')
      return false
    }
    const text = buildJudgePrompt(workspace, items)
    const base = {
      id: 'rtmatrix-' + nowMs().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      role: 'user',
      content: [{ type: 'text', text: text }],
    }
    try {
      agent.followup(Object.assign({}, base, { source: { kind: 'plugin', plugin: 'redteam-attack-matrix' } }))
    } catch (e1) {
      try {
        agent.followup(Object.assign({}, base, { id: base.id + 'b', source: { kind: 'user' } }))
      } catch (e2) {
        logTo(store, 'err', '唤醒模型失败：' + msgOf(e2) + ' —— 疑似仍留在队列里')
        return false
      }
    }
    // 投递成功才记时刻：这一刻之后该会话的模型回复是判定过程，不再当命中扫描。
    store.triageAt[String(agent.id)] = nowMs()
    return true
  }

  async function autoScanOnce() {
    if (scanBusy) return
    const w = currentWorkspace()
    if (!w) return
    scanBusy = true
    autoScanState.at = nowMs()
    try {
      await withStore(async function () {
        const r = await scanWorkspace(w.id, {})
        if (!r.ok || !r.stats) return
        autoScanState.sessions = r.stats.scannedSessions || 0
        autoScanState.matches = r.stats.newMatches || 0
        if (!r.changed) return
        autoScanState.changedAt = nowMs()
        const store = r.store
        logTo(store, 'ok', '自动扫描：' + autoScanState.sessions + ' 个会话，命中 ' + autoScanState.matches + ' 处操作')
        store.updatedAt = nowMs()
        await writeStore(store)
      })
    } catch (e) {
      console.error('[rtmatrix] 自动扫描失败: ' + msgOf(e))
    } finally {
      scanBusy = false
    }
  }

  async function autoJudgeOnce() {
    if (judgeBusy || scanBusy) return
    if (lastHandoffAt && nowMs() - lastHandoffAt < JUDGE_COOLDOWN_MS) return
    const w = currentWorkspace()
    if (!w) return
    judgeBusy = true
    try {
      await withStore(async function () {
        const store = await readStore(w.path)
        // 孤儿命中（所属会话已经不在这个工作区里）不参与自动派发：
        // 它们既没有收件人，也说明数据是从别处带过来的 —— 早先这种条目会被
        // 投给工作区里任何一个活着的会话，表现就是「研判串台」。
        // 它们仍然留在面板上，可以人工判定或忽略。
        const memberIds = memberSessionIds(w.id)
        const pending = pendingItems(store)
        const all = pending.filter(function (x) { return memberIds.indexOf(String(x.sessionId)) >= 0 })
        const orphans = pending.length - all.length
        if (orphans > 0) {
          logTo(store, 'warn', '跳过 ' + orphans + ' 条孤儿命中（所属会话已不在本工作区，不自动派发；可在面板人工判定）')
        }
        const now0 = nowMs()
        const fresh = all.filter(function (x) { return isFresh(x, now0) })
        if (fresh.length === 0) return
        // 闸门：要么攒够 JUDGE_MIN 条，要么有已经等了很久的（避免少量命中永远排不上）。
        const oldest = fresh[0] || null
        const stale = oldest && oldest.firstAt && (nowMs() - oldest.firstAt > JUDGE_STALE_MS)
        if (fresh.length < JUDGE_MIN && !stale) return
        // 收件人必须属于本工作区：认不出来就整批不派发（下一轮再试），
        // 而不是退回「随便找个会话投过去」。
        const agent = findAgent(w.id)
        if (!agent) {
          logTo(store, 'warn', '本工作区没有可唤醒的会话（不跨工作区投递），' + fresh.length + ' 条疑似暂不派发')
          if (orphans > 0) { store.updatedAt = nowMs(); await writeStore(store) }
          return
        }
        const batch = fresh.slice(0, JUDGE_BATCH)
        for (const it of batch) {
          const h = ((store.matrix[it.frameworkId] || {})[it.techniqueId] || {})[it.sessionId]
          if (h) h.sentAt = nowMs()
        }
        logTo(store, 'phase', '自动研判：交给模型 ' + batch.length + ' 条疑似（队列共 ' + all.length + ' 条）')
        store.updatedAt = nowMs()
        await writeStore(store)
        // 先把「已送出」落盘再唤醒模型：反过来的话，模型可能在被标记之前就开始判定。
        const ok = await handoffToModel(store, w, batch, agent)
        lastHandoffAt = nowMs()
        if (!ok) {
          // 没送出去就别把它们标成已送出，否则会永远卡在队列里。
          for (const it of batch) {
            const h = ((store.matrix[it.frameworkId] || {})[it.techniqueId] || {})[it.sessionId]
            if (h && h.confidence !== 'confirmed') h.sentAt = 0
          }
          await writeStore(store)
        } else {
          // 投递成功：把 triageAt 落盘（handoffToModel 里写入），
          // 否则重启后这道自反馈闸门就失效了。
          await writeStore(store)
        }
      })
    } catch (e) {
      console.error('[rtmatrix] 自动研判失败: ' + msgOf(e))
    } finally {
      judgeBusy = false
    }
  }

  // 模型下的结论落到矩阵上。rejected 走的是和手动「排除」同一条路：删除该命中。
  async function applyDecision(args) {
    const a = args && typeof args === 'object' ? args : {}
    const frameworkId = String(a.frameworkId || '')
    const techniqueId = String(a.techniqueId || '')
    const sessionId = String(a.sessionId || '')
    const raw = String(a.decision || '')
    const decision = raw === 'confirmed' ? 'confirmed' : (raw === 'rejected' ? 'rejected' : 'suspected')
    const reason = clip(a.reason || '', 400)
    if (!reason) return { ok: false, error: 'reason 不能为空 —— 判定依据是审计链的一部分' }
    const w = currentWorkspace()
    if (!w) return { ok: false, error: '拿不到工作区' }
    return await withStore(async function () {
      const store = await readStore(w.path)
      const hits = (store.matrix[frameworkId] || {})[techniqueId]
      if (!hits) return { ok: false, error: '没有这个技术点的记录：' + frameworkId + '/' + techniqueId }
      const h = hits[sessionId]
      if (!h) return { ok: false, error: '没有这个会话的命中记录：' + sessionId }
      const who = (h.sessionTitle || sessionId)
      if (decision === 'rejected') {
        delete hits[sessionId]
        logTo(store, 'warn', '排除 ' + frameworkId + '/' + techniqueId + '（' + who + '）：' + reason)
      } else {
        h.confidence = decision
        h.decidedBy = 'model'
        h.reason = reason
        h.judgedAt = nowMs()
        h.needsJudge = false
        h.sentAt = 0
        if (decision === 'confirmed') h.confirmedAt = nowMs()
        logTo(store, decision === 'confirmed' ? 'ok' : 'info',
          (decision === 'confirmed' ? '确认 ' : '存疑 ') + frameworkId + '/' + techniqueId + '（' + who + '）：' + reason)
      }
      store.updatedAt = nowMs()
      await writeStore(store)
      return { ok: true, decision: decision, pending: pendingItems(store).length }
    })
  }

  const labelTool = harness.defineTool({
    name: 'matrix_label',
    description: '为攻击矩阵的一条技术点命中下结论（攻击矩阵面板的自动研判用）。confirmed=已经实现或已验证；suspected=证据不足，保持疑似；rejected=误报，删除该命中。每条命中单独调用一次。',
    parameters: {
      type: 'object',
      properties: {
        frameworkId: { type: 'string', description: '框架 id，例如 atlas / attack-enterprise / owasp-llm / nvidia-kill-chain' },
        techniqueId: { type: 'string', description: '技术点 id，例如 T1190 / LLM01' },
        sessionId: { type: 'string', description: '会话 id，研判消息里给出的 sessionId' },
        decision: { type: 'string', enum: ['confirmed', 'suspected', 'rejected'], description: 'confirmed=做成了；suspected=只是提及或尝试未果；rejected=误报' },
        reason: { type: 'string', description: '判定依据：你实际看到的内容。会写进矩阵日志并显示在卡片上。' },
      },
      required: ['frameworkId', 'techniqueId', 'sessionId', 'decision', 'reason'],
    },
    output: {
      schema: { type: 'json' },
      render: function (args, value) {
        if (!value || value.ok !== true) return [{ type: 'text', text: '判定失败：' + ((value && value.error) || '未知错误') }]
        return [{ type: 'text', text: '已判定 ' + args.frameworkId + '/' + args.techniqueId + ' → ' + value.decision + '（还剩 ' + value.pending + ' 条待判定）' }]
      },
    },
    execute: async function (args) { return await applyDecision(args) },
  })
  // 注册失败必须是可见的：自动研判整条链路都指望这个工具，静默失败会变成
  // 「扫描在跑但永远没人下结论」——asset-graph 就栽在工具注册无声失败上。
  try {
    harness.registerTool(ctx, labelTool)
    Promise.resolve().then(function () {
      return withStore(async function () {
        const w = currentWorkspace()
        if (!w) return
        const store = await readStore(w.path)
        logTo(store, 'info', '已注册模型工具 matrix_label（自动研判用）')
        store.updatedAt = nowMs()
        await writeStore(store)
      })
    }).catch(function () {})
  } catch (e) {
    console.error('[rtmatrix] matrix_label 注册失败: ' + msgOf(e))
    Promise.resolve().then(function () {
      return withStore(async function () {
        const w = currentWorkspace()
        if (!w) return
        const store = await readStore(w.path)
        logTo(store, 'err', 'matrix_label 注册失败：' + msgOf(e))
        await writeStore(store)
      })
    }).catch(function () {})
  }

  // ── 读模型 ────────────────────────────────────────────────────────────────
  // 只发面板真的需要的叶子字段，不发整个 store。
  function summarizeStore(store, workspaceId) {
    const frameworks = []
    const timeline = []
    for (const fw of FRAMEWORKS) {
      const bucket = store.matrix[fw.id] || {}
      let suspected = 0
      let confirmed = 0
      let operations = 0
      const entries = []
      for (const tech of fw.techniques) {
        const hits = bucket[tech.id] || {}
        const ids = Object.keys(hits)
        let n = 0
        let confSessions = 0
        let confirmedOps = 0
        let firstAt = 0
        let lastAt = 0
        let pendingSessions = 0
        for (const sid of ids) {
          const h = hits[sid]
          n += h.occurrences || 0
          if (h.confidence === 'confirmed') { confSessions++; confirmedOps += h.occurrences || 0 }
          else if (!h.judgedAt) pendingSessions++
          if (h.lastAt > lastAt) lastAt = h.lastAt
          if (h.firstAt && (!firstAt || h.firstAt < firstAt)) firstAt = h.firstAt
          if (h.lastAt > 0) {
            // at=lastAt 只用来排序；展示用的是 firstAt → lastAt 这个区间。
            // 之前只发 lastAt，于是「横跨 27 小时、388 次命中」在时间线上被压成一个时刻。
            timeline.push({
              frameworkId: fw.id, techniqueId: tech.id, techniqueName: tech.name,
              at: h.lastAt, firstAt: h.firstAt || h.lastAt, lastAt: h.lastAt,
              sessionId: sid, sessionTitle: h.sessionTitle,
              pieces: h.occurrences || 0, confidence: h.confidence,
              decidedBy: h.decidedBy || '', reason: h.reason || '',
              targets: hitTargets(h), matched: (h.matched || []).slice(0, 8),
            })
          }
        }
        if (n > 0) suspected++
        if (confSessions > 0) confirmed++
        operations += n
        entries.push({
          id: tech.id, name: tech.name, tactics: tech.tactic_ids || [],
          confirmed: confSessions > 0, sessions: ids.length, occurrences: n,
          confirmedOps: confirmedOps, firstAt: firstAt, lastAt: lastAt,
          pending: pendingSessions,
        })
      }
      frameworks.push({
        id: fw.id, name: fw.name, short: fw.short || fw.name, source: fw.source || '',
        tactics: fw.tactics || [], total: fw.techniques.length,
        suspected: suspected, confirmed: confirmed, operations: operations, entries: entries,
      })
    }
    timeline.sort(function (a, b) { return b.at - a.at })
    const pendingAll = pendingItems(store)
    let pendingFresh = 0
    const nowP = nowMs()
    for (const x of pendingAll) if (isFresh(x, nowP)) pendingFresh++
    return {
      workspaceId: workspaceId || '',
      workspacePath: store.workspacePath || '',
      updatedAt: store.updatedAt || 0,
      lastScanAt: store.meta.lastScanAt || 0,
      lastError: store.meta.lastError || null,
      sessions: store.meta.scannedSessions || 0,
      frameworks: frameworks,
      timeline: timeline.slice(0, 200),
      timelineTotal: timeline.length,
      // 待判定：total 是还没人下结论的疑似条数，fresh 是还没送给模型的条数。
      pending: { total: pendingAll.length, fresh: pendingFresh },
      // 自动扫描的心跳（内存态，不入库）：面板用它显示「还在自动跑」。
      autoScan: {
        at: autoScanState.at, changedAt: autoScanState.changedAt,
        sessions: autoScanState.sessions, matches: autoScanState.matches,
        intervalMs: AUTO_SCAN_MS,
      },
      judging: { lastHandoffAt: lastHandoffAt, cooldownMs: JUDGE_COOLDOWN_MS, batch: JUDGE_BATCH },
      // 被标成非目标的会话（面板上显示数量，并提供一键恢复）。
      ignored: (store.ignoreSessions || []).slice(),
      log: (store.log || []).slice(-40),
    }
  }

  function techniqueDetail(store, frameworkId, techniqueId) {
    const fw = FRAMEWORKS.filter(function (x) { return x.id === frameworkId })[0]
    if (!fw) return { ok: false, error: '未知框架：' + frameworkId }
    const tech = fw.techniques.filter(function (x) { return x.id === techniqueId })[0]
    if (!tech) return { ok: false, error: '未知技术点：' + techniqueId }
    const hits = (store.matrix[frameworkId] || {})[techniqueId] || {}
    const operations = []
    for (const sid of Object.keys(hits)) {
      const h = hits[sid]
      operations.push({
        sessionId: sid, sessionTitle: h.sessionTitle, confidence: h.confidence,
        occurrences: h.occurrences, firstAt: h.firstAt, lastAt: h.lastAt,
        matched: h.matched, snippets: h.snippets, targets: hitTargets(h),
        decidedBy: h.decidedBy || '', reason: h.reason || '', judgedAt: h.judgedAt || 0,
      })
    }
    operations.sort(function (a, b) { return b.lastAt - a.lastAt })
    return {
      ok: true,
      framework: { id: fw.id, name: fw.name },
      technique: {
        id: tech.id, name: tech.name, description: tech.description,
        tactic_ids: tech.tactic_ids || [], detect_hints: tech.detect_hints || '',
        detect_keywords: tech.detect_keywords,
      },
      tactics: fw.tactics || [],
      operations: operations,
    }
  }

  async function loadCurrent(workspaceId) {
    const list = listWorkspaces()
    let w = null
    if (workspaceId) { for (const x of list) if (x.id === workspaceId) { w = x; break } }
    if (!w) w = currentWorkspace()
    if (!w) return { ok: false, error: '拿不到工作区', workspaces: list }
    const store = await readStore(w.path)
    return { ok: true, workspace: w, store: store, workspaces: list }
  }

  // ── RPC 句柄（客户端 host.call 调）──────────────────────────────────────────
  harness.handle('snapshot', async function (args) {
    const wsId = args && args.workspaceId ? String(args.workspaceId) : ''
    const r = await loadCurrent(wsId)
    if (!r.ok) return { ok: false, error: r.error, workspaces: r.workspaces || [] }
    return { ok: true, workspaces: r.workspaces, current: r.workspace, view: summarizeStore(r.store, r.workspace.id) }
  })

  harness.handle('scan', async function (args) {
    const wsId = args && args.workspaceId ? String(args.workspaceId) : ''
    return await withStore(async function () {
      const r = await scanWorkspace(wsId, { reset: !!(args && args.reset) })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, stats: r.stats, current: r.workspace, view: summarizeStore(r.store, r.workspace.id) }
    })
  })

  harness.handle('technique', async function (args) {
    const wsId = args && args.workspaceId ? String(args.workspaceId) : ''
    const r = await loadCurrent(wsId)
    if (!r.ok) return { ok: false, error: r.error }
    const d = techniqueDetail(r.store, String((args && args.frameworkId) || ''), String((args && args.techniqueId) || ''))
    d.workspaceId = r.workspace.id
    return d
  })

  harness.handle('confirm', async function (args) {
    const wsId = args && args.workspaceId ? String(args.workspaceId) : ''
    const frameworkId = String((args && args.frameworkId) || '')
    const techniqueId = String((args && args.techniqueId) || '')
    const sessionId = args && args.sessionId ? String(args.sessionId) : ''
    return await withStore(async function () {
      const r = await loadCurrent(wsId)
      if (!r.ok) return { ok: false, error: r.error }
      const bucket = (r.store.matrix[frameworkId] || {})[techniqueId]
      if (!bucket) return { ok: false, error: '该技术点还没有记录，先扫描一次' }
      const ids = sessionId && bucket[sessionId] ? [sessionId] : Object.keys(bucket)
      let n = 0
      for (const sid of ids) {
        const h = bucket[sid]
        if (!h) continue
        h.confidence = 'confirmed'
        h.confirmedAt = nowMs()
        // 人工确认也要留痕：面板上能分辨「AI 自动标」和「人点的」。
        h.decidedBy = 'human'
        h.judgedAt = nowMs()
        h.needsJudge = false
        h.sentAt = 0
        if (!h.reason) h.reason = '面板手动确认'
        n++
      }
      if (n > 0) logTo(r.store, 'ok', '人工确认 ' + frameworkId + '/' + techniqueId + '（' + n + ' 个会话）')
      r.store.updatedAt = nowMs()
      await writeStore(r.store)
      return { ok: true, changed: n, view: summarizeStore(r.store, r.workspace.id) }
    })
  })

  harness.handle('ignore', async function (args) {
    const wsId = args && args.workspaceId ? String(args.workspaceId) : ''
    const frameworkId = String((args && args.frameworkId) || '')
    const techniqueId = String((args && args.techniqueId) || '')
    const sessionId = args && args.sessionId ? String(args.sessionId) : ''
    return await withStore(async function () {
      const r = await loadCurrent(wsId)
      if (!r.ok) return { ok: false, error: r.error }
      if (!(r.store.matrix[frameworkId] || {})[techniqueId]) return { ok: false, error: '该技术点还没有记录' }
      if (sessionId) delete r.store.matrix[frameworkId][techniqueId][sessionId]
      else r.store.matrix[frameworkId][techniqueId] = {}
      logTo(r.store, 'warn', '人工排除 ' + frameworkId + '/' + techniqueId + (sessionId ? '（' + sessionId + '）' : '（全部会话）'))
      r.store.updatedAt = nowMs()
      await writeStore(r.store)
      return { ok: true, view: summarizeStore(r.store, r.workspace.id) }
    })
  })

  // 「清除」与「重扫」是一对互补动作，区别只在水位：
  //   清除 = 清空命中记录与判定结论，**保留** scans 续点 → 历史事件不再入表，从此刻起重来；
  //   重扫 = 连 scans 一起清 → 同一批历史事件被原样重建（所以它清不掉噪音）。
  // 因此清除是可逆的：想要回历史就重扫一次。
  harness.handle('clear', async function (args) {
    const wsId = args && args.workspaceId ? String(args.workspaceId) : ''
    return await withStore(async function () {
      const r = await loadCurrent(wsId)
      if (!r.ok) return { ok: false, error: r.error }
      let buckets = 0
      for (const fw of Object.keys(r.store.matrix)) {
        const techs = r.store.matrix[fw] || {}
        for (const tid of Object.keys(techs)) buckets += Object.keys(techs[tid] || {}).length
      }
      r.store.matrix = {}
      // 日志也清掉（它记的是被清的这批数据），但立刻留一条清除记录本身。
      r.store.log = []
      r.store.logSeq = 0
      logTo(r.store, 'warn', '人工清除本工作区矩阵数据：' + buckets + ' 条命中记录出表（扫描续点保留 —— 历史事件不会重新入表，想要回历史请点「重扫」）')
      r.store.updatedAt = nowMs()
      await writeStore(r.store)
      return { ok: true, cleared: buckets, view: summarizeStore(r.store, r.workspace.id) }
    })
  })

  // ── 导出：时间线 CSV ──────────────────────────────────────────────────────
  // 面板只显示最近 200 个分组，导出取**全部**桶 —— 它是拿去写报告/进表格的交付物。
  function stampFull(ms) {
    if (!ms) return ''
    const d = new Date(ms)
    const p = function (n) { return n < 10 ? '0' + n : String(n) }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  }

  function csvCell(v) {
    const s = v === undefined || v === null ? '' : String(v)
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }

  function buildTimelineCsv(store) {
    const header = ['firstAt', 'lastAt', 'durationSec', 'frameworkId', 'techniqueId', 'techniqueName',
      'sessionId', 'sessionTitle', 'occurrences', 'confidence', 'decidedBy', 'reason',
      'targets', 'matchedKeywords', 'firstAtLocal', 'lastAtLocal', 'exportedAt']
    const rows = []
    for (const fw of FRAMEWORKS) {
      const bucket = store.matrix[fw.id] || {}
      for (const tech of fw.techniques) {
        const hits = bucket[tech.id] || {}
        for (const sid of Object.keys(hits)) {
          const h = hits[sid]
          if (!h || !h.lastAt) continue
          rows.push({
            first: h.firstAt || h.lastAt, last: h.lastAt,
            fw: fw.id, tid: tech.id, tname: tech.name,
            sid: sid, stitle: h.sessionTitle || '',
            n: h.occurrences || 0, conf: h.confidence || '',
            by: h.decidedBy || '', reason: h.reason || '',
            targets: hitTargets(h).join(' | '),
            matched: (h.matched || []).join(' | '),
          })
        }
      }
    }
    rows.sort(function (a, b) { return b.last - a.last })
    const L = [header.join(',')]
    for (const r of rows) {
      L.push([r.first, r.last, Math.round((r.last - r.first) / 1000), r.fw, r.tid, r.tname,
        r.sid, r.stitle, r.n, r.conf, r.by, r.reason, r.targets, r.matched,
        stampFull(r.first), stampFull(r.last), stampFull(nowMs())].map(csvCell).join(','))
    }
    // 前置 BOM：不带它 Excel 会把中文读成乱码。
    return { text: '\ufeff' + L.join('\r\n') + '\r\n', rows: rows.length }
  }

  harness.handle('exportCsv', async function (args) {
    const wsId = args && args.workspaceId ? String(args.workspaceId) : ''
    const r = await loadCurrent(wsId)
    if (!r.ok) return { ok: false, error: r.error, workspaces: r.workspaces || [] }
    const built = buildTimelineCsv(r.store)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const safe = String(r.workspace.id || 'workspace').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 32)
    return { ok: true, filename: 'attack-matrix-' + safe + '-' + stamp + '.csv', content: built.text, rows: built.rows }
  })

  // 把某个会话标成「非目标」：不再扫描它，并清掉它已有的记录 —— 忽略一个会话的
  // 意思就是「这些不是目标活动」，留着一堆桶只会污染覆盖率。可逆：
  // 恢复之后重扫一次，历史命中就回来了。
  harness.handle('ignoreSession', async function (args) {
    const wsId = args && args.workspaceId ? String(args.workspaceId) : ''
    const sid = String((args && args.sessionId) || '')
    const off = !!(args && args.off === true)
    const all = !!(args && args.all === true)
    if (!all && !sid) return { ok: false, error: '缺少 sessionId' }
    return await withStore(async function () {
      const r = await loadCurrent(wsId)
      if (!r.ok) return { ok: false, error: r.error }
      if (!Array.isArray(r.store.ignoreSessions)) r.store.ignoreSessions = []
      let removed = 0
      let note = ''
      if (all) {
        const n = r.store.ignoreSessions.length
        r.store.ignoreSessions = []
        note = '恢复全部（' + n + ' 个会话）—— 之后的扫描会重新收录'
      } else if (off) {
        const i = r.store.ignoreSessions.indexOf(sid)
        if (i >= 0) r.store.ignoreSessions.splice(i, 1)
        note = '恢复会话「' + sid + '」—— 之后的扫描会重新收录，历史命中需「重扫」才回来'
      } else {
        if (r.store.ignoreSessions.indexOf(sid) < 0) r.store.ignoreSessions.push(sid)
        for (const fw of Object.keys(r.store.matrix)) {
          const techs = r.store.matrix[fw] || {}
          for (const tid of Object.keys(techs)) {
            if (techs[tid] && techs[tid][sid]) { delete techs[tid][sid]; removed++ }
          }
        }
        if (r.store.scans && r.store.scans[sid]) delete r.store.scans[sid]
        note = '忽略会话「' + sid + '」：移出 ' + removed + ' 条命中记录，之后不再扫描它'
      }
      logTo(r.store, 'warn', '人工' + note)
      r.store.updatedAt = nowMs()
      await writeStore(r.store)
      return { ok: true, removed: removed, ignored: r.store.ignoreSessions.slice(), view: summarizeStore(r.store, r.workspace.id) }
    })
  })

  harness.handle('frameworks', async function () {
    return {
      ok: true,
      frameworks: FRAMEWORKS.map(function (fw) {
        return {
          id: fw.id, name: fw.name, short: fw.short || fw.name, source: fw.source || '',
          tactics: fw.tactics || [],
          techniques: fw.techniques.map(function (t) { return { id: t.id, name: t.name, tactic_ids: t.tactic_ids || [] } }),
        }
      }),
    }
  })

  // 自动扫描 + 自动研判的心跳。timer 的返回值就是 disposer，交给 ctx.effect 管生命周期，
  // 这样 stop / 卸载时不会留下野定时器。
  ctx.effect(function () {
    const t = ctx.get('timer')
    if (!t || typeof t.interval !== 'function') {
      console.error('[rtmatrix] timer 服务不可用：自动扫描与自动研判都不会运行')
      return
    }
    const a = t.interval(function () { autoScanOnce().catch(function () {}) }, AUTO_SCAN_MS)
    const b = t.interval(function () { autoJudgeOnce().catch(function () {}) }, AUTO_JUDGE_MS)
    return function () { a(); b() }
  }, 'redteam-attack-matrix: auto scan + judge')

  // ── 对外服务：报告插件要「命中攻击矩阵的内容」────────────────────────────────
  // 框架表（技术点名字）只在本插件里；命中详情的存储结构也只有本插件知道。
  // 与其让报告插件去猜文件格式和 id→名字，不如在这里把「能写进报告的那份数据」直接交出去。
  // 没有这个服务时报告插件会退回直接读存储文件 —— 那时只有 id，没有名字。
  ctx.effect(function () {
    if (typeof ctx.provide !== 'function') return function () {}
    return ctx.provide('redteamAttackMatrix', {
      storePath: function () {
        const list = listWorkspaces()
        const w = currentWorkspace()
        return w ? storePathFor(w.path) : ''
      },
      names: function () {
        const out = {}
        for (const fw of FRAMEWORKS) {
          const techs = {}
          for (const t of fw.techniques) techs[t.id] = t.name
          out[fw.id] = { label: fw.name, short: fw.short || fw.name, source: fw.source || '', techniques: techs }
        }
        return out
      },
      // 报告能直接用的一份汇总：已确认 / 疑似分开，带名字、判据、打过的目标和证据片段。
      digest: function () {
        return withStore(async function () {
          const loaded = await loadCurrent('')
          if (!loaded.ok) throw new Error(loaded.error || '拿不到工作区')
          const st = loaded.store
          const items = []
          for (const fw of FRAMEWORKS) {
            const bucket = st.matrix[fw.id] || {}
            for (const tech of fw.techniques) {
              const hits = bucket[tech.id] || {}
              for (const sid of Object.keys(hits)) {
                const h = hits[sid]
                if (!h || h.confidence === 'rejected') continue
                items.push({
                  frameworkId: fw.id, frameworkLabel: fw.name, frameworkShort: fw.short || fw.name,
                  techniqueId: tech.id, techniqueName: tech.name,
                  sessionId: sid, sessionTitle: h.sessionTitle || '',
                  confidence: h.confidence === 'confirmed' ? 'confirmed' : 'suspected',
                  decidedBy: h.decidedBy || '', reason: h.reason || '',
                  occurrences: h.occurrences || 0, firstAt: h.firstAt || 0, lastAt: h.lastAt || 0,
                  kind: h.kind || '', matched: (h.matched || []).slice(0, 10), targets: hitTargets(h),
                  snippets: (h.snippets || []).slice(-3).map(function (x) { return { at: x.at, label: x.label, text: clip(x.text, 400) } }),
                })
              }
            }
          }
          // 已确认的排前面，然后按最近发生排：报告要先写实的。
          items.sort(function (a, b) {
            return (b.confidence === 'confirmed' ? 1 : 0) - (a.confidence === 'confirmed' ? 1 : 0) || (b.lastAt - a.lastAt)
          })
          return {
            workspacePath: st.workspacePath || '',
            storePath: storePathFor(st.workspacePath),
            updatedAt: st.updatedAt || 0,
            lastScanAt: (st.meta && st.meta.lastScanAt) || 0,
            scannedSessions: (st.meta && st.meta.scannedSessions) || 0,
            ignoreSessions: (st.ignoreSessions || []).slice(),
            confirmed: items.filter(function (x) { return x.confidence === 'confirmed' }).length,
            suspected: items.filter(function (x) { return x.confidence !== 'confirmed' }).length,
            items: items,
          }
        })
      },
    })
  }, 'redteam-attack-matrix: 对外服务 redteamAttackMatrix')

  // 装载后先扫一次，不然要等一个节拍才看到东西。
  Promise.resolve().then(function () { return autoScanOnce() }).catch(function () {})

  const techniqueCount = FRAMEWORKS.reduce(function (n, f) { return n + f.techniques.length }, 0)
  console.log('[rtmatrix] attack-matrix host half ready; frameworks =', FRAMEWORKS.length, 'techniques =', techniqueCount)
