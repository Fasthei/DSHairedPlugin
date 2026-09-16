// 常驻（静态）客户端半边 —— 浏览器 bundle 形态（由 tools/build-lib.mjs 生成）。
//
// client-modules 是 CJS 懒执行模型：bundle 只【注册】工厂，副作用留在闭包内，
// 首次 require 时物化。因此这里用 window.__ModuleLoader__.load({id, factory}) 注册。
//
// 包装刻意保持极薄（只做作用域与导出），全部改造集中在主体自己的 applyClient 里，
// 见 lib/parts/client.shim.js。
window.__ModuleLoader__.load({
  id: 'dsh-redteam-attack-matrix',
  factory: (require) => {
    let React = require('react');
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

// 攻击矩阵 · Client 半边
//
// lib/client.js 由 `npm run build:lib` 从本文件生成，不要手改 lib/。
// 生成器以函数名 `applyClient` 为入口锚点，并在其中注入 host.call / styles.insert 垫片
// ——静态 bundle 里没有这两个闭包符号，原因见 ../../docs/DEVELOPMENT.md。
//
// 注意：本文件必须以 `return { name, inject, apply }` 块【结尾】，生成器据此剥离动态包装。
//
// ── 界面结构 ──────────────────────────────────────────────────────────────────
// ┌ 顶栏：工作区下拉 + 扫描按钮 + 统计
// ├ 框架标签页：ATLAS / OWASP LLM Top 10 / NVIDIA AI Kill Chain，每个框架一页
// ├ 技术卡片网格：命中徽标（疑似 / 已确认），点开看该技术点的攻击操作日志
// └ 底部：对本组织发起测试的时间线
//
// 卡片用描边表达覆盖状态：灰=未覆盖、黄=疑似、绿=已确认。

function applyClient(ctx) {
  // ── 静态形态垫片（动态半边的闭包符号在静态包里不存在）──
  //
  // 1) host.call：转到宿主 HTTP 路由（见 lib/host.js 的 /dsh-redteam-attack-matrix/rpc）。
  //    选 HTTP 而非 ctx.remote：Remote 需 typert 代码生成（zod schema + 生成绑定），
  //    而本插件有 20 个无类型 JSON 句柄，为此引入整套生成链不划算；
  //    且 fetch 只被【动态】半边屏蔽，静态模块可直接用。
  // 2) styles.insert：动态 runner 把它作为闭包参数注入，静态 bundle 里没有，
  //    故自行插入 <style> 元素（浏览器全局可用），并登记到 fiber 便于卸载清理。
  // 路径必须是生成器替换的占位符，不能写死包名：写死会让本插件去调别的插件的
  // 路由（v1.0.0 就是写死成了 asset-graph 的路径，发布出去面板全 404，而且与
  // 资产图谱同时安装时还会读到对方的数据）。见 tools/build-lib.mjs 的 fill()。
  const RPC_PATH = '/dsh-redteam-attack-matrix/rpc'
  const host = {
    call(method, args) {
      return fetch(RPC_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: method, args: args === undefined ? null : args }),
      }).then(function (res) {
        return res.json().catch(function () { return null }).then(function (payload) {
          if (!res.ok || !payload || payload.ok !== true) {
            const detail = (payload && payload.error) || ('HTTP ' + res.status)
            throw new Error('redteam-attack-matrix rpc ' + method + ' 失败：' + detail)
          }
          return payload.result
        })
      })
    },
  }

  const STYLE_ID = 'redteam-attack-matrix-styles'
  const styles = {
    insert(css) {
      if (typeof document === 'undefined') return function () {}
      let el = document.getElementById(STYLE_ID)
      if (!el) { el = document.createElement('style'); el.id = STYLE_ID; document.head.appendChild(el) }
      el.textContent += String(css) + '\n'
      const dispose = function () { if (el && el.parentNode) el.parentNode.removeChild(el) }
      try { ctx.effect(function () { return dispose }, 'redteam-attack-matrix: styles') } catch (e) { return dispose }
      return dispose
    },
  }

  const slots = ctx.slots

  const PANEL_KEY = 'redteam-attack-matrix'

  function el(tag, props) {
    const children = Array.prototype.slice.call(arguments, 2)
    return React.createElement.apply(React, [tag, props || {}].concat(children))
  }

  // 时间戳统一到「秒」。原来是 MM-DD HH:mm —— 年份和秒都没有：跨年分不清，
  // 同一分钟内的先后顺序也丢了，而时间线的用途恰恰是回溯先后顺序。
  function stamp(ms, withYear) {
    if (!ms) return '—'
    try {
      const d = new Date(ms)
      const p = function (n) { return n < 10 ? '0' + n : String(n) }
      const md = p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
      if (withYear || d.getFullYear() !== new Date().getFullYear()) return d.getFullYear() + '-' + md
      return md
    } catch (e) { return '—' }
  }

  function shortTime(ms) { return stamp(ms, false) }
  function fmtTime(ms) { return stamp(ms, true) }

  // 时间不标时区，拿去写报告就说不清是哪一台机器上的几点。
  function tzLabel() {
    try {
      const off = -new Date().getTimezoneOffset()
      const sign = off < 0 ? '-' : '+'
      const abs = Math.abs(off)
      const p = function (n) { return n < 10 ? '0' + n : String(n) }
      return 'UTC' + sign + p(Math.floor(abs / 60)) + ':' + p(abs % 60)
    } catch (e) { return '' }
  }

  function durText(a, b) {
    if (!a || !b || b <= a) return ''
    const s = Math.round((b - a) / 1000)
    if (s < 60) return s + ' 秒'
    if (s < 3600) return Math.round(s / 60) + ' 分钟'
    if (s < 86400) return (s / 3600).toFixed(1) + ' 小时'
    return (s / 86400).toFixed(1) + ' 天'
  }

  // 一次命中可能横跨很久（实测有 388 次命中横跨 27.5 小时的），所以给的是区间而不是一个点。
  function spanText(a, b) {
    if (!a && !b) return '—'
    if (!a || a === b) return fmtTime(b || a)
    const d = durText(a, b)
    return fmtTime(a) + ' → ' + fmtTime(b) + (d ? '（' + d + '）' : '')
  }

  // 面板必须自己刷新：扫描与研判都由 host 自动跑，没有用户动作来触发重渲染。
  // 优先用 timer 服务的 ctx.interval（有生命周期管理），没有就退到 window 定时器。
  function every(ms, fn) {
    try {
      if (typeof ctx.interval === 'function') return ctx.interval(fn, ms)
    } catch (e) {}
    if (typeof window === 'undefined' || !window.setInterval) return function () {}
    const id = window.setInterval(fn, ms)
    return function () { window.clearInterval(id) }
  }

  function pct(a, b) { return b > 0 ? Math.round((a / b) * 100) : 0 }

  // 顶栏状态。扫描按钮删掉之后，用户只能从这里知道 host 还在自动干活。
  function statusText(view) {
    const parts = []
    parts.push('会话 ' + (view.sessions || 0))
    parts.push('操作 ' + (view.timelineTotal || 0) + ' 条')
    const p = view.pending || { total: 0, fresh: 0 }
    if (p.total > 0) parts.push('待判定 ' + p.total + (p.fresh > 0 ? '（排队 ' + p.fresh + '）' : '（模型研判中）'))
    const a = view.autoScan
    if (a && a.at) {
      parts.push('自动扫描 ' + shortTime(a.at) + (a.changedAt ? '（上次有新内容 ' + shortTime(a.changedAt) + '）' : '（无新内容）'))
    } else {
      parts.push('自动扫描启动中')
    }
    if (view.lastScanAt) parts.push('最近更新 ' + shortTime(view.lastScanAt))
    return parts.join(' · ')
  }

  // ── 主面板 ────────────────────────────────────────────────────────────────
  function Panel() {
    const [view, setView] = React.useState(null)
    const [workspaces, setWorkspaces] = React.useState([])
    const [current, setCurrent] = React.useState(null)
    const [tab, setTab] = React.useState('')
    const [detail, setDetail] = React.useState(null)
    const [busy, setBusy] = React.useState('')
    const [error, setError] = React.useState(null)
    const [toast, setToast] = React.useState('')
    const [clearArmed, setClearArmed] = React.useState(false)
    const [csvOut, setCsvOut] = React.useState(null)

    function applySnap(r) {
      if (!r || r.ok !== true) {
        setError((r && r.error) || '宿主没有返回数据')
        if (r && r.workspaces) setWorkspaces(r.workspaces)
        return
      }
      setError(null)
      setWorkspaces(r.workspaces || [])
      setCurrent(r.current || null)
      setView(r.view || null)
    }

    function load(wsId) {
      setBusy('load')
      return host.call('snapshot', wsId ? { workspaceId: wsId } : null)
        .then(applySnap)
        .catch(function (e) { setError(String((e && e.message) || e)) })
        .then(function () { setBusy('') })
    }

    React.useEffect(function () { load() }, [])

    // 之前只在挂载时 load 一次。扫描与研判现在都是 host 自动跑的，没有用户操作来
    // 触发重渲染 —— 不轮询的话，自动产生的结论永远不会显示出来。
    const liveRef = React.useRef({ busy: '', current: null })
    liveRef.current = { busy: busy, current: current }
    React.useEffect(function () {
      return every(3000, function () {
        const cur = liveRef.current
        if (cur.busy) return
        host.call('snapshot', cur.current ? { workspaceId: cur.current.id } : null)
          .then(function (r) {
            if (!r || r.ok !== true) return
            setWorkspaces(r.workspaces || [])
            setCurrent(r.current || null)
            setView(r.view || null)
          })
          .catch(function () {})
      })
    }, [])

    // 只有「重扫」会用到：清空本工作区矩阵后重新全量扫描。
    // 常规扫描由 host 自己按节拍做，面板不提供触发入口。
    function doRescan() {
      setBusy('scan')
      setToast('')
      host.call('scan', { workspaceId: current ? current.id : undefined, reset: true })
        .then(function (r) {
          if (!r || r.ok !== true) { setError((r && r.error) || '重扫失败'); return }
          setError(null)
          setCurrent(r.current || null)
          setView(r.view || null)
          const s = r.stats || {}
          setToast('已重扫：' + (s.scannedSessions || 0) + ' 个会话，命中 ' + (s.newMatches || 0) + ' 处操作')
        })
        .catch(function (e) { setError(String((e && e.message) || e)) })
        .then(function () { setBusy('') })
    }

    // 清除 = 清空命中记录与判定结论，但保留扫描续点：历史事件不会重新入表，
    // 从此刻起重来。这是它与「重扫」的唯一区别 —— 重扫会连水位一起清，
    // 于是同一批历史事件被原样重建。清除因此可逆：想要回历史就重扫一次。
    // 破坏性动作，所以按钮要二次确认（不像资产图谱的清除会进垃圾箱）。
    function doClear() {
      setBusy('clear')
      setToast('')
      host.call('clear', { workspaceId: current ? current.id : undefined })
        .then(function (r) {
          if (!r || r.ok !== true) { setError((r && r.error) || '清除失败'); return }
          setError(null)
          setDetail(null)
          setView(r.view || null)
          setToast('已清除 ' + (r.cleared || 0) + ' 条命中记录。扫描续点保留：历史事件不会重新入表，之后只收新操作；想要回历史就点「重扫」')
        })
        .catch(function (e) { setError(String((e && e.message) || e)) })
        .then(function () { setBusy('') })
    }

    // 时间线导出：host 给的是**全部**桶的 CSV 文本（面板只显示最近 200 个），
    // 客户端拼成 data URI 交给 <a download>。用 encodeURIComponent 而不是 base64 ——
    // CSV 里有中文，base64 得先自己编 UTF-8。
    function doExportCsv() {
      setBusy('csv')
      setCsvOut(null)
      host.call('exportCsv', { workspaceId: current ? current.id : undefined })
        .then(function (r) {
          if (!r || r.ok !== true) { setError((r && r.error) || '导出失败'); return }
          setError(null)
          if (!r.content) { setToast('这个工作区还没有可导出的记录'); return }
          setCsvOut({
            filename: r.filename,
            href: 'data:text/csv;charset=utf-8,' + encodeURIComponent(r.content),
            rows: r.rows || 0,
          })
          setToast('已生成 CSV：' + (r.rows || 0) + ' 行（含全部时间线，不只是面板显示的那部分）')
        })
        .catch(function (e) { setError(String((e && e.message) || e)) })
        .then(function () { setBusy('') })
    }

    // 把某个会话标成「非目标」。存在的理由：开发这个插件的工作区里，对话本身就在
    // 不停命中框架关键词（写一行含「主机名」的注释就能造出一个 T1082 桶），
    // 逐条排除永远排不完，要的是把整个不是目标活动的会话关掉。
    function doIgnoreSession(sessionId, title) {
      if (!sessionId) return
      setBusy('mark')
      host.call('ignoreSession', { workspaceId: current ? current.id : undefined, sessionId: sessionId })
        .then(function (r) {
          if (!r || r.ok !== true) { setError((r && r.error) || '忽略失败'); return }
          setError(null)
          setDetail(null)
          setView(r.view || null)
          setToast('已忽略会话「' + (title || sessionId) + '」：移出 ' + (r.removed || 0) + ' 条命中记录，之后不再扫描它。顶栏「恢复」可撤销')
        })
        .catch(function (e) { setError(String((e && e.message) || e)) })
        .then(function () { setBusy('') })
    }

    function doRestoreSessions() {
      setBusy('mark')
      host.call('ignoreSession', { workspaceId: current ? current.id : undefined, all: true })
        .then(function (r) {
          if (!r || r.ok !== true) { setError((r && r.error) || '恢复失败'); return }
          setError(null)
          setView(r.view || null)
          setToast('已恢复全部被忽略的会话。想让它们的历史命中回来，点一次「重扫」')
        })
        .catch(function (e) { setError(String((e && e.message) || e)) })
        .then(function () { setBusy('') })
    }

    function switchWorkspace(id) {
      setDetail(null)
      setTab('')
      load(id)
    }

    function openTechnique(frameworkId, techniqueId) {
      setBusy('detail')
      host.call('technique', { workspaceId: current ? current.id : undefined, frameworkId: frameworkId, techniqueId: techniqueId })
        .then(function (r) {
          if (!r || r.ok !== true) { setError((r && r.error) || '读取失败'); return }
          setDetail(r)
        })
        .catch(function (e) { setError(String((e && e.message) || e)) })
        .then(function () { setBusy('') })
    }

    // status: 'confirmed'（确认覆盖）| 'ignore'（排除这条记录）
    function mark(op, status) {
      setBusy('mark')
      const method = status === 'ignore' ? 'ignore' : 'confirm'
      host.call(method, {
        workspaceId: current ? current.id : undefined,
        frameworkId: detail.framework.id,
        techniqueId: detail.technique.id,
        sessionId: op.sessionId,
      })
        .then(function (r) {
          if (!r || r.ok !== true) { setError((r && r.error) || '操作失败'); return }
          setError(null)
          setView(r.view)
          return host.call('technique', {
            workspaceId: current ? current.id : undefined,
            frameworkId: detail.framework.id,
            techniqueId: detail.technique.id,
          }).then(function (d2) { if (d2 && d2.ok === true) setDetail(d2) })
        })
        .catch(function (e) { setError(String((e && e.message) || e)) })
        .then(function () { setBusy('') })
    }

    const frameworks = (view && view.frameworks) || []
    const active = frameworks.filter(function (f) { return f.id === tab })[0] || frameworks[0] || null

    // 时间线里显示框架短名（ATLAS / ATT&CK / OWASP LLM / NVIDIA），不是 `attack-enterprise`
    // 这种 id —— 一列长 id 会把那一格撑得七扭八歪。
    function fwShort(id) {
      const f = frameworks.filter(function (x) { return x.id === id })[0]
      return (f && (f.short || f.name)) || id
    }

    // 一张技术卡片。三态用描边表达：灰=未覆盖、黄=疑似、绿=已确认。
    function cardOf(e) {
      const cls = e.confirmed ? 'rtm-card rtm-confirmed' : (e.occurrences > 0 ? 'rtm-card rtm-suspected' : 'rtm-card')
      const isOpen = !!(detail && detail.technique && detail.technique.id === e.id && detail.framework.id === active.id)
      return el('div', {
        key: e.id,
        className: cls + (isOpen ? ' rtm-card-open' : ''),
        onClick: function () { openTechnique(active.id, e.id) },
        title: '查看这个技术点对应的操作日志',
      },
        el('div', { className: 'rtm-card-h' },
          el('span', { className: 'rtm-card-id' }, e.id),
          e.occurrences > 0 ? el('span', { className: 'rtm-badge' + (e.confirmed ? ' rtm-badge-ok' : '') },
            (e.confirmed ? '已确认 ' : '疑似 ') + e.occurrences) : null
        ),
        el('div', { className: 'rtm-card-name' }, e.name),
        el('div', { className: 'rtm-card-m' },
          e.occurrences > 0 ? (e.sessions + ' 个会话 · 最近 ' + shortTime(e.lastAt)) : '未覆盖')
      )
    }

    // 按 tactic 分组。一个技术点可能属于多个 tactic（ATLAS 里很常见），
    // 那就在每个 tactic 下都出现一次 —— 分组的作用是「按阶段看缺口」，重复出现不误导。
    //
    // 兜底是必须的：如果只遍历 fw.tactics，任何 tactic_ids 对不上声明表的技术点会被
    // **静默丢掉**，整个框架就渲染成一块黑板。实战踩过这一次：ATT&CK 的技术点写的是
    // slug（reconnaissance）、阶段表写的是 TA00xx，46 个技术点全被吞掉、标签页一片空白。
    // 所以命不中任何已知阶段的一律进「未归类」，宁可显示得难看，也不能凭空消失。
    function groupByTactic(fw) {
      const known = {}
      for (const t of (fw.tactics || [])) known[t.id] = true
      const byId = {}
      function push(tid, e) {
        if (!byId[tid]) byId[tid] = []
        byId[tid].push(e)
      }
      for (const e of fw.entries) {
        const tids = (e.tactics && e.tactics.length) ? e.tactics : []
        let placed = false
        for (const tid of tids) {
          if (!known[tid]) continue
          push(tid, e)
          placed = true
        }
        if (!placed) push('__none__', e)
      }
      const out = []
      for (const t of (fw.tactics || [])) {
        const list = byId[t.id]
        if (!list || list.length === 0) continue
        const confirmed = list.filter(function (e) { return e.confirmed }).length
        // 有命中的排前面，让缺口之外的重点先被看到
        list.sort(function (a, b) { return (b.occurrences || 0) - (a.occurrences || 0) })
        out.push({ id: t.id, name: t.name, description: t.description || '', entries: list, confirmed: confirmed })
      }
      if (byId['__none__'] && byId['__none__'].length) {
        out.push({
          id: '__none__', name: '未归类',
          description: '阶段表里没有对应项的技术点。出现这一组通常说明框架数据的 phase id 写错了 —— 需要修数据，不是修界面。',
          entries: byId['__none__'],
          confirmed: byId['__none__'].filter(function (e) { return e.confirmed }).length,
        })
      }
      return out
    }

    return el('div', { className: 'rtm-root' },
      el('div', { className: 'rtm-bar' },
        el('span', { className: 'rtm-brand' }, '攻击矩阵'),
        el('select', {
          className: 'rtm-select',
          value: current ? current.id : '',
          onChange: function (e) { switchWorkspace(e.target.value) },
        }, workspaces.map(function (w) {
          return el('option', { key: w.id, value: w.id }, (w.title || w.path || w.id) + '（' + w.sessionCount + ' 会话）')
        })),
        // 扫描不由人触发：host 每 20 秒增量扫一遍，扫到新命中就自动交给模型判定。
        // 这里只保留「重扫」作为数据写坏时的修复入口。
        el('button', { className: 'rtm-btn', disabled: busy === 'scan', onClick: doRescan,
          title: '清空本工作区的矩阵数据后重新全量扫描。正常情况下不需要点 —— 自动扫描一直在跑。' },
          busy === 'scan' ? '重扫中…' : '重扫'),
        el('button', {
          className: 'rtm-btn' + (clearArmed ? ' rtm-danger' : ''),
          disabled: busy === 'clear',
          onClick: function () {
            if (!clearArmed) {
              setClearArmed(true)
              setToast('再点一次执行清除：会清空本工作区的命中记录与判定结论（扫描续点保留，历史事件不会重新入表）')
              return
            }
            setClearArmed(false)
            doClear()
          },
          title: clearArmed
            ? '再点一次即执行，不可直接撤销（想要回历史需「重扫」）'
            : '清空本工作区的命中记录与判定结论，但保留扫描续点：历史事件不会重新入表，从此刻起重来。与「重扫」的区别就在这里',
        }, busy === 'clear' ? '清除中…' : (clearArmed ? '确认清除' : '清除')),
        view ? el('span', { className: 'rtm-stat' }, statusText(view)) : null,
        (view && view.ignored && view.ignored.length)
          ? el('span', { className: 'rtm-ign' },
            '已忽略 ' + view.ignored.length + ' 个会话',
            el('button', {
              className: 'rtm-btn rtm-mini',
              disabled: busy === 'mark',
              onClick: doRestoreSessions,
              title: '恢复全部被忽略的会话（想让它们的历史命中回来，再点一次「重扫」）',
            }, '恢复')) : null
      ),

      error ? el('div', { className: 'rtm-err' }, error) : null,
      toast ? el('div', { className: 'rtm-toast' }, toast) : null,
      view && view.lastError ? el('div', { className: 'rtm-warn' }, view.lastError) : null,

      frameworks.length > 0 ? el('div', { className: 'rtm-tabs' }, frameworks.map(function (f) {
        const on = active && active.id === f.id
        return el('button', {
          key: f.id,
          className: 'rtm-tab' + (on ? ' rtm-tab-on' : ''),
          onClick: function () { setTab(f.id) },
          title: f.source || '',
        }, f.short, el('span', { className: 'rtm-tab-num' }, f.confirmed + '/' + f.total))
      })) : null,

      active ? el('div', { className: 'rtm-cov' },
        el('div', { className: 'rtm-cov-bar' },
          el('div', { className: 'rtm-cov-susp', style: { width: pct(active.suspected, active.total) + '%' } }),
          el('div', { className: 'rtm-cov-fill', style: { width: pct(active.confirmed, active.total) + '%' } })
        ),
        el('span', { className: 'rtm-cov-txt' },
          '已确认 ' + active.confirmed + ' / 疑似 ' + active.suspected + ' / 共 ' + active.total + ' 项 · 命中操作 ' + active.operations + ' 次')
      ) : null,

      el('div', { className: 'rtm-body' },
        el('div', { className: 'rtm-grid' },
          !active ? el('div', { className: 'rtm-dim' }, busy === 'load' ? '加载中…' : '没有框架数据')
            : (active.tactics || []).length === 0
              // OWASP 这类没有阶段的框架：平铺
              ? active.entries.map(cardOf)
              // ATLAS / ATT&CK / NVIDIA 这类有阶段的：按 tactic 分组。
              // 45 张卡片平铺是没法看的，分组之后「哪个阶段是空的」一眼就看得出来。
              : groupByTactic(active).map(function (g) {
                return el('div', { key: g.id, className: 'rtm-group' },
                  el('div', { className: 'rtm-group-h' },
                    el('span', { className: 'rtm-group-name' }, g.name),
                    el('span', { className: 'rtm-group-id' }, g.id),
                    el('span', { className: 'rtm-group-n' }, g.confirmed + '/' + g.entries.length)
                  ),
                  el('div', { className: 'rtm-group-grid' }, g.entries.map(cardOf))
                )
              })
        ),

        detail ? el('div', { className: 'rtm-detail' },
          el('div', { className: 'rtm-detail-h' },
            el('div', null,
              el('div', { className: 'rtm-detail-id' }, detail.technique.id),
              el('div', { className: 'rtm-detail-name' }, detail.technique.name)
            ),
            el('button', { className: 'rtm-x', onClick: function () { setDetail(null) }, title: '关闭' }, '×')
          ),
          detail.technique.description ? el('div', { className: 'rtm-desc' }, detail.technique.description) : null,
          detail.technique.detect_hints ? el('div', { className: 'rtm-hint' }, el('b', null, '判定线索：'), detail.technique.detect_hints) : null,
          detail.technique.detect_keywords && detail.technique.detect_keywords.length
            ? el('div', { className: 'rtm-kw' }, detail.technique.detect_keywords.map(function (k, i) { return el('span', { key: i, className: 'rtm-kw-i' }, k) }))
            : null,

          el('div', { className: 'rtm-sec' }, '攻击操作日志（' + ((detail.operations || []).length) + '）'),
          (detail.operations || []).length === 0
            ? el('div', { className: 'rtm-dim' }, '还没有命中记录')
            : detail.operations.map(function (op, i) {
              return el('div', { key: i, className: 'rtm-op' + (op.confidence === 'confirmed' ? ' rtm-op-ok' : '') },
                el('div', { className: 'rtm-op-h' },
                  el('span', { className: 'rtm-op-sess' }, op.sessionTitle || op.sessionId),
                  el('span', { className: 'rtm-op-time' }, spanText(op.firstAt, op.lastAt)),
                  el('span', { className: 'rtm-op-cnt' }, op.occurrences + ' 次')
                ),
                op.matched && op.matched.length ? el('div', { className: 'rtm-op-kw' }, '命中词：' + op.matched.join('、')) : null,
                // 打的是谁：具体到 IP、端口、URL、主机名。回溯时这一行比技术点 ID 有用得多。
                (op.targets && op.targets.length) ? el('div', { className: 'rtm-op-tgt' }, '目标：' + op.targets.join(' · ')) : null,
                // 判定依据是审计链的一部分：谁判的（AI 自动 / 人工）、为什么。
                op.reason ? el('div', { className: 'rtm-dec' },
                  el('b', null, (op.confidence === 'confirmed' ? '已确认' : '疑似') + ' · ' +
                    (op.decidedBy === 'model' ? 'AI 自动判定' : op.decidedBy === 'human' ? '人工判定' : '未判定') + '：'),
                  op.reason) : null,
                (op.snippets || []).map(function (s, j) {
                  return el('div', { key: j, className: 'rtm-snip' },
                    el('span', { className: 'rtm-snip-l' }, s.label || s.kind || ''),
                    el('span', { className: 'rtm-snip-t' }, s.text || '')
                  )
                }),
                el('div', { className: 'rtm-op-acts' },
                  el('button', {
                    className: 'rtm-btn rtm-mini' + (op.confidence === 'confirmed' ? ' rtm-primary' : ''),
                    disabled: busy === 'mark' || op.confidence === 'confirmed',
                    onClick: function () { mark(op, 'confirmed') },
                  }, op.confidence === 'confirmed' ? '已确认' : '确认覆盖'),
                  el('button', {
                    className: 'rtm-btn rtm-mini',
                    disabled: busy === 'mark',
                    onClick: function () { mark(op, 'ignore') },
                  }, '排除'),
                  el('button', {
                    className: 'rtm-btn rtm-mini',
                    disabled: busy === 'mark',
                    onClick: function () { doIgnoreSession(op.sessionId, op.sessionTitle) },
                    title: '整个会话都不是目标活动时用这个：不再扫描它，并清掉它已有的命中记录（可恢复）',
                  }, '忽略该会话')
                )
              )
            })
        ) : null
      ),

      view ? el('div', { className: 'rtm-timeline' },
        el('div', { className: 'rtm-tl-head' },
          // 「个」是 框架×技术×会话 的分组数，不是操作数；每行末尾的「N 次」才是操作数。
          // 时间一律标本地时区，否则拿去写报告说不清是哪个时区的几点。
          el('span', { className: 'rtm-sec' }, '对本组织发起测试的时间线（' + (view.timelineTotal || 0) + ' 个 框架×技术×会话 分组'
            + ((view.timelineTotal || 0) > (view.timeline || []).length ? '，显示最近 ' + (view.timeline || []).length + ' 个' : '')
            + '；本地时区 ' + tzLabel() + '）'),
          el('button', {
            className: 'rtm-btn rtm-mini',
            disabled: busy === 'csv',
            onClick: doExportCsv,
            title: '导出全部时间线为 CSV（含目标、命中词、判定依据、精确到秒的时刻），不只是面板显示的那部分',
          }, busy === 'csv' ? '导出中…' : '导出 CSV')
        ),
        csvOut ? el('a', { className: 'rtm-dl', href: csvOut.href, download: csvOut.filename },
          '下载 ' + csvOut.filename + '（' + csvOut.rows + ' 行）') : null,
        (view.timeline || []).length === 0
          ? el('div', { className: 'rtm-dim' }, '还没有记录。host 每 20 秒自动扫一次当前工作区的对话，扫到就会出现在这里。')
          : el('div', { className: 'rtm-tl-list' }, view.timeline.map(function (t, i) {
            const a = t.firstAt || t.at
            const b = t.lastAt || t.at
            const conf = t.confidence === 'confirmed'
            // 起止分两行 + grid 对齐。并排写「09-15 08:57:40 → 09-16 12:24:06」会把时间列
            // 撑到两百多像素，而且每行长短不一、右边全是对不齐的锯齿，整块看起来就是散的。
            return el('div', { key: i, className: 'rtm-tl' + (conf ? ' rtm-tl-conf' : '') },
              el('span', { className: 'rtm-tl-dot' }),
              el('span', { className: 'rtm-tl-t1' }, stamp(a, false)),
              el('span', { className: 'rtm-tl-t2' }, '→ ' + stamp(b, false) + (durText(a, b) ? ' · ' + durText(a, b) : '')),
              el('div', { className: 'rtm-tl-main' },
                el('span', { className: 'rtm-tl-fw' }, fwShort(t.frameworkId)),
                el('span', { className: 'rtm-tl-tid' }, t.techniqueId),
                el('span', { className: 'rtm-tl-tech', title: t.techniqueName }, t.techniqueName)
              ),
              el('div', { className: 'rtm-tl-sub' },
                el('span', { className: 'rtm-tl-sess', title: t.sessionTitle || t.sessionId }, t.sessionTitle || t.sessionId),
                (t.targets && t.targets.length) ? el('span', { className: 'rtm-tl-tgt', title: t.targets.join(' · ') }, t.targets.join(' · ')) : null
              ),
              el('div', { className: 'rtm-tl-meta' },
                el('span', { className: 'rtm-tl-n' }, t.pieces + ' 次'),
                el('span', { className: 'rtm-pill' + (conf ? ' rtm-pill-conf' : ' rtm-pill-susp') }, conf ? '已确认' : '疑似')
              )
            )
          }))
      ) : null
    )
  }

  // 侧边栏图标：矩阵九宫格 + 命中点
  function Glyph(props) {
    const size = props && props.size ? props.size : 16
    const active = props && props.active
    const c = active ? 'var(--dsw-alias-brand-primary, #4c8dff)' : 'currentColor'
    const cells = []
    for (let r = 0; r < 3; r++) {
      for (let col = 0; col < 3; col++) {
        const on = (r === 0 && col === 2) || (r === 1 && col === 0) || (r === 2 && col === 2)
        cells.push(React.createElement('rect', {
          key: r + '-' + col,
          x: 3.6 + col * 6.2, y: 3.6 + r * 6.2, width: 4.6, height: 4.6, rx: 1,
          fill: on ? c : 'none', stroke: c, strokeWidth: 1.2, opacity: on ? 1 : 0.55,
        }))
      }
    }
    return React.createElement.apply(React, ['svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' }].concat(cells))
  }

  ctx.effect(function () {
    return styles.insert([
      '.rtm-root{padding:12px;font-size:13px;display:flex;flex-direction:column;gap:8px;height:100%;box-sizing:border-box;overflow:hidden}',
      '.rtm-bar{display:flex;align-items:center;gap:8px;flex:0 0 auto;flex-wrap:wrap}',
      '.rtm-brand{font-weight:600;font-size:14px;margin-right:2px}',
      '.rtm-select{background:transparent;color:inherit;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:6px;padding:3px 6px;font-size:12px;max-width:320px}',
      '.rtm-btn{background:transparent;color:inherit;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}',
      '.rtm-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#4c8dff)}',
      '.rtm-btn:disabled{opacity:.5;cursor:default}',
      '.rtm-primary{border-color:var(--dsw-alias-brand-primary,#4c8dff);color:var(--dsw-alias-brand-primary,#4c8dff);font-weight:600}',
      '.rtm-danger{border-color:var(--dsw-alias-state-error-primary,#d9534f);color:var(--dsw-alias-state-error-primary,#d9534f);font-weight:600}',
      '.rtm-mini{padding:2px 8px;font-size:11px}',
      '.rtm-stat{opacity:.62;font-size:11px;margin-left:auto}',
      '.rtm-dim{opacity:.6;padding:8px 2px}',
      '.rtm-err{color:var(--dsw-alias-state-error-primary,#e05252);white-space:pre-wrap;font-size:12px}',
      '.rtm-warn{color:var(--dsw-alias-state-warn-primary,#c08a2e);font-size:12px}',
      '.rtm-toast{color:var(--dsw-alias-state-success-primary,#2f9e6b);font-size:12px}',
      '.rtm-tabs{display:flex;gap:6px;flex:0 0 auto;flex-wrap:wrap}',
      '.rtm-tab{background:transparent;color:inherit;border:1px solid transparent;border-bottom:2px solid transparent;padding:4px 10px;font-size:12.5px;cursor:pointer;opacity:.7;display:flex;align-items:center;gap:6px}',
      '.rtm-tab:hover{opacity:1}',
      '.rtm-tab-on{opacity:1;font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary,#4c8dff)}',
      '.rtm-tab-num{font-size:10.5px;opacity:.75;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:8px;padding:0 5px}',
      '.rtm-cov{display:flex;align-items:center;gap:10px;flex:0 0 auto}',
      '.rtm-cov-bar{position:relative;flex:1;height:6px;border-radius:3px;background:var(--dsw-alias-bg-l2,rgba(128,128,128,.16));overflow:hidden}',
      '.rtm-cov-fill{position:absolute;left:0;top:0;bottom:0;background:var(--dsw-alias-state-error-primary,#d9534f);opacity:.85}',
      '.rtm-cov-susp{position:absolute;left:0;top:0;bottom:0;background:var(--dsw-alias-state-warn-primary,#c08a2e);opacity:.5}',
      '.rtm-cov-txt{font-size:11px;opacity:.75;white-space:nowrap}',
      '.rtm-body{flex:1 1 auto;display:flex;gap:10px;min-height:0}',
      '.rtm-grid{flex:1 1 auto;align-content:start;overflow:auto;padding-right:2px;display:flex;flex-direction:column;gap:12px}',
      '.rtm-group{display:flex;flex-direction:column;gap:6px}',
      '.rtm-group-h{display:flex;align-items:baseline;gap:7px;font-size:11.5px;position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-l1,transparent);padding:2px 0}',
      '.rtm-group-name{font-weight:600}',
      '.rtm-group-id{opacity:.5;font-size:10px;font-family:ui-monospace,monospace}',
      '.rtm-group-n{margin-left:auto;opacity:.65;font-size:10.5px}',
      '.rtm-group-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:7px}',
      '.rtm-card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));border-radius:8px;padding:7px 9px;cursor:pointer;display:flex;flex-direction:column;gap:3px}',
      '.rtm-card:hover{border-color:var(--dsw-alias-brand-primary,#4c8dff)}',
      '.rtm-suspected{border-color:var(--dsw-alias-state-warn-primary,#c08a2e)}',
      // 「已确认」用红色：它意味着这个技术点**真的打成了**，对防守方是坏消息、
      // 对红队是一条实打实的战果。用绿色会读成「好」，语义是反的。
      '.rtm-confirmed{border-color:var(--dsw-alias-state-error-primary,#d9534f);border-left-width:3px}',
      '.rtm-card-open{outline:1px solid var(--dsw-alias-brand-primary,#4c8dff)}',
      '.rtm-card-h{display:flex;align-items:center;justify-content:space-between;gap:6px}',
      '.rtm-card-id{font-size:10.5px;opacity:.6;font-family:ui-monospace,monospace}',
      '.rtm-card-name{font-size:12.5px;font-weight:600;line-height:1.3}',
      '.rtm-card-m{font-size:10.5px;opacity:.66}',
      '.rtm-badge{font-size:10px;border:1px solid var(--dsw-alias-state-warn-primary,#c08a2e);color:var(--dsw-alias-state-warn-primary,#c08a2e);border-radius:8px;padding:0 5px;white-space:nowrap}',
      '.rtm-badge-ok{border-color:var(--dsw-alias-state-error-primary,#d9534f);color:var(--dsw-alias-state-error-primary,#d9534f);font-weight:600}',
      '.rtm-detail{flex:0 0 46%;max-width:520px;overflow:auto;border-left:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));padding-left:10px;display:flex;flex-direction:column;gap:8px}',
      '.rtm-detail-h{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}',
      '.rtm-detail-id{font-size:11px;opacity:.62;font-family:ui-monospace,monospace}',
      '.rtm-detail-name{font-size:14px;font-weight:600}',
      '.rtm-x{background:transparent;border:none;color:inherit;font-size:18px;line-height:1;cursor:pointer;opacity:.6;padding:0 4px}',
      '.rtm-x:hover{opacity:1}',
      '.rtm-desc{font-size:12px;line-height:1.5;opacity:.9}',
      '.rtm-hint{font-size:11.5px;line-height:1.5;opacity:.8}',
      '.rtm-kw{display:flex;flex-wrap:wrap;gap:4px}',
      '.rtm-kw-i{font-size:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:8px;padding:0 5px;opacity:.75;font-family:ui-monospace,monospace}',
      '.rtm-sec{font-size:12px;font-weight:600;opacity:.85;margin-top:2px}',
      '.rtm-op{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));border-left-width:3px;border-radius:6px;padding:6px 8px;display:flex;flex-direction:column;gap:5px}',
      '.rtm-op-ok{border-left-color:var(--dsw-alias-state-error-primary,#d9534f)}',
      '.rtm-op-h{display:flex;align-items:baseline;gap:8px;font-size:11px;flex-wrap:wrap}',
      '.rtm-op-sess{font-weight:600}',
      '.rtm-op-time{opacity:.7}',
      '.rtm-op-cnt{margin-left:auto;opacity:.7}',
      '.rtm-op-kw{font-size:10.5px;opacity:.7;font-family:ui-monospace,monospace}',
      '.rtm-snip{display:flex;gap:6px;font-size:11px;line-height:1.45;border-left:2px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));padding-left:6px}',
      '.rtm-snip-l{flex:0 0 auto;opacity:.6;white-space:nowrap}',
      '.rtm-snip-t{opacity:.9;word-break:break-word}',
      '.rtm-op-acts{display:flex;gap:6px}',
      '.rtm-timeline{flex:0 0 auto;max-height:32%;overflow:auto;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));padding-top:6px;display:flex;flex-direction:column;gap:4px}',
      '.rtm-tl-list{display:flex;flex-direction:column;gap:1px}',
      '.rtm-tl{display:grid;grid-template-columns:8px 176px minmax(0,1fr) auto;grid-template-rows:auto auto;column-gap:10px;row-gap:1px;align-items:baseline;padding:4px 6px;border-radius:6px;font-size:11.5px}',
      '.rtm-tl:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}',
      '.rtm-tl-dot{grid-column:1;grid-row:1/3;align-self:center;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#c08a2e)}',
      '.rtm-tl-conf .rtm-tl-dot{background:var(--dsw-alias-state-error-primary,#d9534f)}',
      '.rtm-tl-t1{grid-column:2;grid-row:1;font-family:ui-monospace,monospace;opacity:.85;white-space:nowrap}',
      '.rtm-tl-t2{grid-column:2;grid-row:2;font-family:ui-monospace,monospace;opacity:.5;font-size:10.5px;white-space:nowrap}',
      '.rtm-tl-main{grid-column:3;grid-row:1;display:flex;align-items:baseline;gap:7px;min-width:0}',
      '.rtm-tl-sub{grid-column:3;grid-row:2;display:flex;align-items:baseline;gap:8px;min-width:0;opacity:.75;font-size:11px}',
      '.rtm-tl-meta{grid-column:4;grid-row:1/3;align-self:center;display:flex;align-items:center;gap:7px;white-space:nowrap}',
      '.rtm-tl-fw{flex:0 0 auto;font-size:10px;opacity:.8;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:6px;padding:0 5px}',
      '.rtm-tl-tid{flex:0 0 auto;font-family:ui-monospace,monospace;font-weight:600}',
      '.rtm-tl-tech{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rtm-tl-sess{flex:0 1 auto;min-width:0;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rtm-tl-tgt{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace;color:var(--dsw-alias-brand-primary,#4c8dff)}',
      '.rtm-tl-n{opacity:.7;font-variant-numeric:tabular-nums}',
      '.rtm-pill{font-size:10px;line-height:1.6;padding:0 7px;border-radius:9px;border:1px solid currentColor}',
      '.rtm-pill-susp{color:var(--dsw-alias-state-warn-primary,#c08a2e)}',
      '.rtm-pill-conf{color:var(--dsw-alias-state-error-primary,#d9534f);font-weight:600}',
      '.rtm-tl-head{display:flex;align-items:center;gap:8px}',
      '.rtm-tl-head .rtm-sec{flex:1 1 auto}',
      '.rtm-dl{font-size:12px;color:var(--dsw-alias-brand-primary,#4c8dff);text-decoration:underline}',
      '.rtm-op-tgt{margin-top:2px;font-family:ui-monospace,monospace;opacity:.95;color:var(--dsw-alias-brand-primary,#4c8dff);word-break:break-all}',
      '.rtm-ign{display:inline-flex;align-items:center;gap:6px;font-size:11px;opacity:.9}',
      '.rtm-dec{margin-top:3px;padding:3px 6px;border-left:2px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));opacity:.85;font-size:11px;white-space:pre-wrap}',
    ].join('\n'))
  }, 'redteam-attack-matrix: styles')

  ctx.effect(function () {
    return slots.inject('sidebar.panellist', function () {
      return slots.register({ name: 'sidebar.panellist', id: PANEL_KEY, order: 60, label: '攻击矩阵' }, Glyph)
    })
  }, 'redteam-attack-matrix: panel button')

  ctx.effect(function () {
    return slots.inject('main', function () {
      return slots.register({ name: 'main', key: PANEL_KEY }, Panel)
    })
  }, 'redteam-attack-matrix: main panel')

  console.log('[rtmatrix] attack-matrix client half ready; panel =', PANEL_KEY)
}
    exports.inject = ['slots', 'timer']
    exports.apply = function (ctx) { return applyClient(ctx) }
    return module.exports
  }
});
