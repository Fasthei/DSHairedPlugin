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

  function blankStore() {
    return {
      version: STORE_VERSION,
      workspacePath: '',
      updatedAt: 0,
      // scans[sessionId] = { maxSeq, title, at } —— 增量扫描的续点
      scans: {},
      // matrix[frameworkId][techniqueId][sessionId] = hit
      matrix: {},
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
      confidence: 'suspected',
      confirmedAt: 0,
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
        meta: { lastScanAt: store.meta.lastScanAt, scannedSessions: store.meta.scannedSessions },
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
  function activitiesOf(session) {
    let events = []
    try { events = session.snapshotEvents() } catch (e) { return [] }
    if (!Array.isArray(events)) return []

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
        if (text.trim()) out.push({ kind: 'user', seq: seq, at: at, text: text, label: '用户消息' })
      } else if (ev.type === 'assistant/message') {
        const text = textOfContent(d.message && d.message.content)
        if (text.trim()) out.push({ kind: 'assistant', seq: seq, at: at, text: text, label: '模型回复' })
      } else if (ev.type === 'tool/call') {
        out.push({ kind: 'tool', seq: seq, at: at, text: String(d.name || '') + ' ' + String(d.arguments || ''), label: '工具调用 ' + String(d.name || '') })
      } else if (ev.type === 'tool/result') {
        const cid = String((d.message && d.message.source && d.message.source.callId) || '')
        const c = calls[cid]
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

  // ── 匹配 ──────────────────────────────────────────────────────────────────
  // 关键词表是扁平的，直接对haystack做 indexOf：一次操作 × 全部关键词。
  // 关键词总量在几百这个量级，实时扫描足够快，不值得上倒排索引。
  function matchFrameworks(text) {
    const hay = lower(text)
    if (!hay) return []
    const found = []
    for (const fw of FRAMEWORKS) {
      for (const tech of fw.techniques) {
        let score = 0
        const hit = []
        for (const kw of tech.detect_keywords) {
          if (kw && hay.indexOf(kw) >= 0) { score++; hit.push(kw) }
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
      const title = sessionTitleOf(session)
      const acts = activitiesOf(session)
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
          if (!hit.firstAt || act.at < hit.firstAt) hit.firstAt = act.at
          if (act.at > hit.lastAt) hit.lastAt = act.at
          if (act.kind === 'tool') hit.kind = 'tool'
          else if (!hit.kind) hit.kind = act.kind
          for (const kw of m.keywords) if (hit.matched.indexOf(kw) < 0 && hit.matched.length < 12) hit.matched.push(kw)
          if (hit.snippets.length < SNIPPETS_PER_HIT) {
            hit.snippets.push({ at: act.at, seq: act.seq, kind: act.kind, label: act.label, text: clip(act.text, SNIPPET_MAX) })
          }
        }
      }

      if (maxSeq > fromSeq || !prev) {
        store.scans[sid] = { maxSeq: maxSeq, title: title, at: nowMs() }
        if (maxSeq > fromSeq) touched++
      }
    }

    store.updatedAt = nowMs()
    store.meta.lastScanAt = store.updatedAt
    store.meta.scannedSessions = scannedSessions
    const saved = await writeStore(store)
    if (!saved && !store.meta.lastError) store.meta.lastError = '写入失败（未知原因）'

    return {
      ok: true, saved: saved, store: store, workspace: w,
      stats: { sessions: sessions.length, scannedSessions: scannedSessions, newMatches: newMatches, touchedSessions: touched },
    }
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
        for (const sid of ids) {
          const h = hits[sid]
          n += h.occurrences || 0
          if (h.confidence === 'confirmed') { confSessions++; confirmedOps += h.occurrences || 0 }
          if (h.lastAt > lastAt) lastAt = h.lastAt
          if (h.firstAt && (!firstAt || h.firstAt < firstAt)) firstAt = h.firstAt
          if (h.lastAt > 0) {
            timeline.push({
              frameworkId: fw.id, techniqueId: tech.id, techniqueName: tech.name,
              at: h.lastAt, sessionId: sid, sessionTitle: h.sessionTitle,
              pieces: h.occurrences || 0, confidence: h.confidence,
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
        })
      }
      frameworks.push({
        id: fw.id, name: fw.name, short: fw.short || fw.name, source: fw.source || '',
        tactics: fw.tactics || [], total: fw.techniques.length,
        suspected: suspected, confirmed: confirmed, operations: operations, entries: entries,
      })
    }
    timeline.sort(function (a, b) { return b.at - a.at })
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
        matched: h.matched, snippets: h.snippets,
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
    const r = await scanWorkspace(wsId, { reset: !!(args && args.reset) })
    if (!r.ok) return { ok: false, error: r.error }
    return { ok: true, stats: r.stats, current: r.workspace, view: summarizeStore(r.store, r.workspace.id) }
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
      n++
    }
    r.store.updatedAt = nowMs()
    await writeStore(r.store)
    return { ok: true, changed: n, view: summarizeStore(r.store, r.workspace.id) }
  })

  harness.handle('ignore', async function (args) {
    const wsId = args && args.workspaceId ? String(args.workspaceId) : ''
    const frameworkId = String((args && args.frameworkId) || '')
    const techniqueId = String((args && args.techniqueId) || '')
    const sessionId = args && args.sessionId ? String(args.sessionId) : ''
    const r = await loadCurrent(wsId)
    if (!r.ok) return { ok: false, error: r.error }
    if (!(r.store.matrix[frameworkId] || {})[techniqueId]) return { ok: false, error: '该技术点还没有记录' }
    if (sessionId) delete r.store.matrix[frameworkId][techniqueId][sessionId]
    else r.store.matrix[frameworkId][techniqueId] = {}
    r.store.updatedAt = nowMs()
    await writeStore(r.store)
    return { ok: true, view: summarizeStore(r.store, r.workspace.id) }
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

  const techniqueCount = FRAMEWORKS.reduce(function (n, f) { return n + f.techniques.length }, 0)
  console.log('[rtmatrix] attack-matrix host half ready; frameworks =', FRAMEWORKS.length, 'techniques =', techniqueCount)
