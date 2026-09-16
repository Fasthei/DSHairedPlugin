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
  const RPC_PATH = '/dsh-redteam-asset-graph/rpc'
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

  function shortTime(ms) {
    if (!ms) return '—'
    try {
      const d = new Date(ms)
      const p = function (n) { return n < 10 ? '0' + n : String(n) }
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    } catch (e) { return '—' }
  }

  function fmtTime(ms) {
    if (!ms) return '—'
    try {
      const d = new Date(ms)
      const p = function (n) { return n < 10 ? '0' + n : String(n) }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    } catch (e) { return '—' }
  }

  function pct(a, b) { return b > 0 ? Math.round((a / b) * 100) : 0 }

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

    function doScan(reset) {
      setBusy('scan')
      setToast('')
      host.call('scan', { workspaceId: current ? current.id : undefined, reset: !!reset })
        .then(function (r) {
          if (!r || r.ok !== true) { setError((r && r.error) || '扫描失败'); return }
          setError(null)
          setWorkspaces(workspaces)
          setCurrent(r.current || null)
          setView(r.view || null)
          const s = r.stats || {}
          setToast('扫描完成：' + (s.scannedSessions || 0) + ' 个会话，命中 ' + (s.newMatches || 0) + ' 处操作')
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
    function groupByTactic(fw) {
      const byId = {}
      for (const e of fw.entries) {
        const tids = (e.tactics && e.tactics.length) ? e.tactics : ['__none__']
        for (const tid of tids) {
          if (!byId[tid]) byId[tid] = []
          byId[tid].push(e)
        }
      }
      const out = []
      for (const t of fw.tactics) {
        const list = byId[t.id]
        if (!list || list.length === 0) continue
        const confirmed = list.filter(function (e) { return e.confirmed }).length
        // 有命中的排前面，让缺口之外的重点先被看到
        list.sort(function (a, b) { return (b.occurrences || 0) - (a.occurrences || 0) })
        out.push({ id: t.id, name: t.name, description: t.description || '', entries: list, confirmed: confirmed })
      }
      // 未挂 tactic 的技术点兜底
      if (byId['__none__'] && byId['__none__'].length) {
        out.push({ id: '__none__', name: '未归类', description: '', entries: byId['__none__'], confirmed: byId['__none__'].filter(function (e) { return e.confirmed }).length })
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
        el('button', { className: 'rtm-btn rtm-primary', disabled: busy === 'scan', onClick: function () { doScan(false) } },
          busy === 'scan' ? '扫描中…' : '扫描对话'),
        el('button', { className: 'rtm-btn', disabled: busy === 'scan', onClick: function () { doScan(true) }, title: '清空本工作区的矩阵数据后重新扫描' }, '重扫'),
        view ? el('span', { className: 'rtm-stat' },
          '会话 ' + (view.sessions || 0) + ' · 操作 ' + (view.timelineTotal || 0) + ' 条 · ' + (view.lastScanAt ? '最近扫描 ' + shortTime(view.lastScanAt) : '未扫描')) : null
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
                  el('span', { className: 'rtm-op-time' }, fmtTime(op.firstAt) + (op.lastAt !== op.firstAt ? ' → ' + fmtTime(op.lastAt) : '')),
                  el('span', { className: 'rtm-op-cnt' }, op.occurrences + ' 次')
                ),
                op.matched && op.matched.length ? el('div', { className: 'rtm-op-kw' }, '命中词：' + op.matched.join('、')) : null,
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
                  }, '排除')
                )
              )
            })
        ) : null
      ),

      view ? el('div', { className: 'rtm-timeline' },
        el('div', { className: 'rtm-sec' }, '对本组织发起测试的时间线（' + (view.timelineTotal || 0) + ' 条'
          + ((view.timelineTotal || 0) > (view.timeline || []).length ? '，显示最近 ' + (view.timeline || []).length + ' 条' : '') + '）'),
        (view.timeline || []).length === 0
          ? el('div', { className: 'rtm-dim' }, '还没有记录。点上方「扫描对话」把工作区里的对话读进来。')
          : el('div', { className: 'rtm-tl-list' }, view.timeline.map(function (t, i) {
            return el('div', { key: i, className: 'rtm-tl' + (t.confidence === 'confirmed' ? ' rtm-tl-ok' : '') },
              el('span', { className: 'rtm-tl-dot' }),
              el('span', { className: 'rtm-tl-time' }, shortTime(t.at)),
              el('span', { className: 'rtm-tl-fw' }, t.frameworkId),
              el('span', { className: 'rtm-tl-tech' }, t.techniqueId + ' ' + t.techniqueName),
              el('span', { className: 'rtm-tl-sess' }, t.sessionTitle || t.sessionId),
              el('span', { className: 'rtm-tl-n' }, t.pieces + ' 次')
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
      '.rtm-cov-fill{position:absolute;left:0;top:0;bottom:0;background:var(--dsw-alias-state-success-primary,#2f9e6b);opacity:.85}',
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
      '.rtm-confirmed{border-color:var(--dsw-alias-state-success-primary,#2f9e6b)}',
      '.rtm-card-open{outline:1px solid var(--dsw-alias-brand-primary,#4c8dff)}',
      '.rtm-card-h{display:flex;align-items:center;justify-content:space-between;gap:6px}',
      '.rtm-card-id{font-size:10.5px;opacity:.6;font-family:ui-monospace,monospace}',
      '.rtm-card-name{font-size:12.5px;font-weight:600;line-height:1.3}',
      '.rtm-card-m{font-size:10.5px;opacity:.66}',
      '.rtm-badge{font-size:10px;border:1px solid var(--dsw-alias-state-warn-primary,#c08a2e);color:var(--dsw-alias-state-warn-primary,#c08a2e);border-radius:8px;padding:0 5px;white-space:nowrap}',
      '.rtm-badge-ok{border-color:var(--dsw-alias-state-success-primary,#2f9e6b);color:var(--dsw-alias-state-success-primary,#2f9e6b)}',
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
      '.rtm-op-ok{border-left-color:var(--dsw-alias-state-success-primary,#2f9e6b)}',
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
      '.rtm-tl-list{display:flex;flex-direction:column;gap:2px}',
      '.rtm-tl{display:flex;align-items:baseline;gap:8px;font-size:11.5px;padding:2px 0}',
      '.rtm-tl-dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#c08a2e);margin-top:4px}',
      '.rtm-tl-ok .rtm-tl-dot{background:var(--dsw-alias-state-success-primary,#2f9e6b)}',
      '.rtm-tl-time{flex:0 0 auto;opacity:.66;font-family:ui-monospace,monospace}',
      '.rtm-tl-fw{flex:0 0 auto;opacity:.5;font-size:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:6px;padding:0 4px}',
      '.rtm-tl-tech{flex:0 0 auto;font-weight:600}',
      '.rtm-tl-sess{opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rtm-tl-n{margin-left:auto;opacity:.6;flex:0 0 auto}',
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
