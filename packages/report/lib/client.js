// 常驻（静态）客户端半边 —— 浏览器 bundle 形态（由 tools/build-lib.mjs 生成）。
//
// client-modules 是 CJS 懒执行模型：bundle 只【注册】工厂，副作用留在闭包内，
// 首次 require 时物化。因此这里用 window.__ModuleLoader__.load({id, factory}) 注册。
//
// 包装刻意保持极薄（只做作用域与导出），全部改造集中在主体自己的 applyClient 里，
// 见 lib/parts/client.shim.js。
window.__ModuleLoader__.load({
  id: 'dsh-redteam-report',
  factory: (require) => {
    let React = require('react');
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

// 红队报告 · Client 半边
//
// lib/client.js 由 `npm run build:lib` 从本文件生成，不要手改 lib/。
// 生成器以函数名 `applyClient` 为入口锚点，并在其中注入 host.call / styles.insert 垫片
// ——静态 bundle 里没有这两个闭包符号，原因见 ../../docs/DEVELOPMENT.md。
//
// 注意：本文件必须以 `return { name, inject, apply }` 块【结尾】，生成器据此剥离动态包装。
//
// ── 界面结构 ──────────────────────────────────────────────────────────────────
// ┌ 顶栏：报告份数 · 当前字数（未保存）· 证据规模 · 生成进度 + 刷新
// ├ 标签页：报告 / 证据 / 设置 / 日志
// ├ 报告：报告列表（切换）· 标题 · 操作行（生成 / 保存 ｜ 导出 MD·HTML·Word ｜ 导入记忆 / 删除）
// │        左编辑（Markdown，带字数）右预览（宿主渲染的完整 HTML，所见即导出）
// ├ 证据：试算证据 —— 会话采集表 + **真正喂给模型的那份 digest**
// ├ 设置：撰写模型 · 证据预算 · 路径 · 额外要求
// └ 日志：最近操作与错误
//
// ── 两条设计纪律 ─────────────────────────────────────────────────────────────
// 1. **一屏只留一个主操作**。原来九个按钮挤在一行里（生成 / 新建×2 / 保存 / 导出×3 /
//    导入 / 删除），主次不分；现在生成与保存是主，导出归成一组，删除这类破坏性操作
//    弱化到右侧并带二次语义（红色文字而不是红色实心块）。
// 2. **颜色只用真实存在的主题 token**。之前写的 --dsw-alias-bg-l1/l2/l3 并不存在，
//    于是背景一直掉回硬编码 rgba —— 深浅色主题下观感不一致，看着「脏」。

function applyClient(ctx) {
  // ── 静态形态垫片（动态半边的闭包符号在静态包里不存在）──
  //
  // 1) host.call：转到宿主 HTTP 路由（见 lib/host.js 的 /dsh-redteam-report/rpc）。
  //    选 HTTP 而非 ctx.remote：Remote 需 typert 代码生成（zod schema + 生成绑定），
  //    而本插件有 20 个无类型 JSON 句柄，为此引入整套生成链不划算；
  //    且 fetch 只被【动态】半边屏蔽，静态模块可直接用。
  // 2) styles.insert：动态 runner 把它作为闭包参数注入，静态 bundle 里没有，
  //    故自行插入 <style> 元素（浏览器全局可用），并登记到 fiber 便于卸载清理。
  // 路径必须由生成器按包名填充（/dsh-redteam-report）。这里曾经写死成
  // `/dsh-redteam-asset-graph/rpc` —— 那是从资产图谱早期版本复制骨架时带过来的缺陷：
  // 本插件的面板会去打资产图谱的路由，请求全 404，两者同时安装还会读到对方的数据
  // （资产图谱 README 记的那次事故是同一个根因）。测试里钉住了实际请求的 url。
  const RPC_PATH = '/dsh-redteam-report/rpc'
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
            throw new Error('redteam-report rpc ' + method + ' 失败：' + detail)
          }
          return payload.result
        })
      })
    },
  }

  const STYLE_ID = 'redteam-report-styles'
  const styles = {
    insert(css) {
      if (typeof document === 'undefined') return function () {}
      let el = document.getElementById(STYLE_ID)
      if (!el) { el = document.createElement('style'); el.id = STYLE_ID; document.head.appendChild(el) }
      el.textContent += String(css) + '\n'
      const dispose = function () { if (el && el.parentNode) el.parentNode.removeChild(el) }
      try { ctx.effect(function () { return dispose }, 'redteam-report: styles') } catch (e) { return dispose }
      return dispose
    },
  }

  const settingsHub = ctx.get('redteamSettingsUI');
  if (!settingsHub) throw new Error('请先安装并启用 dsh-redteam-memory >= 0.4.0');
  const slots = ctx.slots;
  const reportHost = host;
  let selection = { id:'', path:'', title:'', sessionId:'' };
  let activationError = '';
  let switchSequence = 0;
  const subscribers = new Set();
  const viewId = 'report-view-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  function publish(next) {
    if (selection.id === next.id && selection.path === next.path && selection.title === next.title && selection.sessionId === next.sessionId) return;
    selection = next;
    activationError = '';
    for (const notify of subscribers) notify();
  }
  function useWorkspace() {
    const [value, setValue] = React.useState(() => selection);
    React.useEffect(() => {
      const notify = () => setValue(selection);
      subscribers.add(notify); notify();
      return () => subscribers.delete(notify);
    }, []);
    return value;
  }
  function WorkspaceObserver(props) {
    const sessionId = props.useSessions(s => s.current || '');
    const workspaceId = props.useWorkspaces(s => {
      const w = s.items.find(item => item.sessionIds.includes(sessionId));
      return w ? w.workspaceId : '';
    });
    const path = props.useWorkspaces(s => {
      const w = s.items.find(item => item.workspaceId === workspaceId);
      return w ? w.path : '';
    });
    const title = props.useWorkspaces(s => {
      const w = s.items.find(item => item.workspaceId === workspaceId);
      return w ? w.title : '';
    });
    React.useEffect(() => { publish({id:workspaceId,path:path,title:title,sessionId:sessionId}); }, [workspaceId,path,title,sessionId]);
    React.useEffect(() => {
      let live = true;
      const sequence = ++switchSequence;
      reportHost.call('activate', {workspaceId:'', viewId:viewId, sequence:sequence}).catch(() => {});
      const cancel = ctx.timeout(() => {
        reportHost.call('activate', {workspaceId:workspaceId, viewId:viewId, sequence:sequence}).then(result => {
          if (live && result && result.ok === false) activationError = result.error || '自动报告启动失败';
        }).catch(error => { if (live) activationError = String(error.message || error); });
      }, 1200);
      return () => { live = false; cancel(); };
    }, [workspaceId]);
    return null;
  }
  function ScopedPanel(props) {
    const current = useWorkspace();
    if (!current.id) return el('div', {className:'rtr-root', style:{colorScheme:reportColorScheme()}}, props && props.settingsOnly ? '报告设置：请先选择工作区' : '请先选择工作区；报告不会回退到其他工作区。');
    return el(Panel, {key:current.id, workspaceId:current.id, workspacePath:current.path, workspaceTitle:current.title, settingsOnly:!!(props && props.settingsOnly)});
  }
  ctx.effect(() => slots.inject('shell.overlay', () => slots.register({name:'shell.overlay',id:'redteam-report-workspace-observer',order:0}, WorkspaceObserver)));
  ctx.effect(() => settingsHub.register(function ReportSettings() { return el(ScopedPanel, {settingsOnly:true}); }));
  ctx.effect(() => () => { subscribers.clear(); reportHost.call('activate', {workspaceId:'',viewId:viewId,sequence:++switchSequence}).catch(() => {}); });

  // 主题跟随：面板里的原生控件（checkbox、数字输入的微调箭头、select 的弹出层、滚动条）
  // 走的是浏览器浅色默认渲染 —— 黑夜模式下会变成刺眼的纯白块。
  // color-scheme 必须显式挂到面板根元素上，宿主不会替插件设（资产图谱半边一直这么做）。
  // 注意：这个函数名被 workspace-client.js 的源码补丁一起引用，改名要同步改那边。
  function reportColorScheme() {
    try {
      const t = ctx.get('theme')
      if (t && typeof t.getTheme === 'function') {
        const snap = t.getTheme()
        const cs = snap && snap.active && snap.active.colorScheme
        if (cs === 'light' || cs === 'dark') return cs
      }
    } catch (e) {}
    return 'dark'
  }

  const PANEL_KEY = 'redteam-report'
  const TABS = [['doc', '报告'], ['evi', '证据'], ['log', '日志']]
  const PREVIEW_DEBOUNCE_MS = 400

  // ── 通用小工具 ──────────────────────────────────────────────────────────────
  function el(tag, props) {
    const children = Array.prototype.slice.call(arguments, 2)
    return React.createElement.apply(React, [tag, props || {}].concat(children))
  }

  // 过桥的参数必须是 JSON：丢掉 undefined / null，否则 bridge 会直接拒绝
  function jsonArgs(o) {
    const out = {}
    for (const k of Object.keys(o || {})) {
      const v = o[k]
      if (v === undefined || v === null) continue
      out[k] = v
    }
    return out
  }

  function fmtTime(ms) {
    if (!ms) return '—'
    const n = Number(ms)
    if (!isFinite(n) || n <= 0) return String(ms)
    const d = new Date(n)
    if (isNaN(d.getTime())) return String(ms)
    const p = function (x) { return x < 10 ? '0' + x : String(x) }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  function reportError(e) { return String((e && e.message) || e) }
  function fmtNum(n) { const v = Number(n) || 0; return v >= 10000 ? (v / 1000).toFixed(1) + 'k' : String(v) }

  // UI 基元：按钮 / 卡片 / 徽标 / 按钮组。两个层级（主/次）就够，
  // 全部平铺才是「丑」的根源 —— 人看不出该点哪个。
  function btn(label, opts, onClick) {
    const o = opts || {}
    const cls = 'rtr-btn' + (o.primary ? ' rtr-btn-primary' : '') + (o.danger ? ' rtr-btn-danger' : '') + (o.mini ? ' rtr-btn-mini' : '')
    return el('button', { key: o.key || label, className: cls, disabled: o.disabled === true, title: o.title || '', onClick: onClick }, label)
  }

  function card(title, sub, children, extra) {
    return el('section', { className: 'rtr-card' },
      el('div', { className: 'rtr-card-h' },
        el('span', { className: 'rtr-card-t' }, title),
        sub ? el('span', { className: 'rtr-card-s' }, sub) : null,
        el('span', { className: 'rtr-sp' }),
        extra || null),
      el('div', { className: 'rtr-card-b' }, children))
  }

  function badge(text, kind) {
    return el('span', { className: 'rtr-badge' + (kind ? ' rtr-badge-' + kind : '') }, text)
  }

  function group(label, children) {
    return el('div', { className: 'rtr-group' }, el('span', { className: 'rtr-group-l' }, label), children)
  }

  function hint(text) { return el('span', { className: 'rtr-hint' }, text) }

  function Panel(props) {
    const settingsOnly = !!(props && props.settingsOnly);
    const workspaceId = props.workspaceId;
    const host = { call(method, args) { return reportHost.call(method, Object.assign({}, args || {}, {workspaceId:workspaceId})); } };
    const [snap, setSnap] = React.useState(null)
    const [tab, setTab] = React.useState('doc')
    const [busy, setBusy] = React.useState('')
    const [error, setError] = React.useState(null)
    const [toast, setToast] = React.useState('')
    const [draft, setDraft] = React.useState(null)
    const [title, setTitle] = React.useState('')
    const [markdown, setMarkdown] = React.useState('')
    const [dirty, setDirty] = React.useState(false)
    const [html, setHtml] = React.useState('')
    const [instruction, setInstruction] = React.useState('')
    const [evidence, setEvidence] = React.useState(null)
    const [exportInfo, setExportInfo] = React.useState(null)

    function applySnap(r) {
      if (!r || r.ok !== true) { setError((r && r.error) || '宿主没有返回数据'); return }
      setError(null)
      setSnap(r.snapshot)
      setDraft(function (d) { return d || JSON.parse(JSON.stringify(r.snapshot.settings)) })
    }

    function refresh() {
      setBusy('load')
      return host.call('snapshot', {}).then(applySnap)
        .catch(function (e) { setError(reportError(e)) })
        .then(function () { setBusy('') })
    }

    function call(method, args, label) {
      setBusy(method)
      setToast('')
      return host.call(method, jsonArgs(args || {}))
        .then(function (r) {
          if (r && r.snapshot) applySnap({ ok: true, snapshot: r.snapshot })
          if (r && r.ok === false) { setError(r.error || (label + '失败')); return r }
          setError(null)
          if (label) setToast(label + '完成')
          return r
        })
        .catch(function (e) { setError(reportError(e)); return null })
        .then(function (r) { setBusy(''); return r })
    }

    React.useEffect(function () { refresh() }, [])

    // 生成是后台任务：轮询 snapshot 才能看到进度与正在长出来的正文。
    const liveRef = React.useRef({ generating: false, dirty: false })
    liveRef.current = { generating: !!(snap && snap.status && snap.status.generating), dirty: dirty }
    React.useEffect(function () {
      if (settingsOnly || typeof ctx.interval !== 'function') return undefined
      return ctx.interval(function () {
        // Always poll this scoped panel: automatic jobs can start while it is open.
        host.call('snapshot', {}).then(function (r) {
          if (!r || r.ok !== true) return
          setSnap(r.snapshot)
          // 用户改过就不覆盖他的字；没改过就把流出来的正文同步进来。
          if (!liveRef.current.dirty && r.snapshot.current) {
            setMarkdown(r.snapshot.current.markdown || '')
            setTitle(r.snapshot.current.title || '')
          }
        }).catch(function () {})
      }, 2500)
    }, [])

    // 切换当前报告时同步编辑框（用户有未保存的改动就不动）
    const curId = snap && snap.currentId ? snap.currentId : ''
    React.useEffect(function () {
      if (!snap || !snap.current || dirty) return
      setTitle(snap.current.title || '')
      setMarkdown(snap.current.markdown || '')
    }, [curId])

    // 预览：防抖后让宿主渲染，拿到完整 HTML 文档塞进 iframe。
    // 定时器走 ctx.get('timer')：动态客户端沙箱里没有 setTimeout。
    React.useEffect(function () {
      if (settingsOnly) return undefined;
      const timer = ctx.get('timer')
      const run = function () {
        host.call('preview', jsonArgs({ id: curId, title: title, markdown: markdown }))
          .then(function (r) { if (r && r.ok === true) setHtml(r.html) })
          .catch(function () {})
      }
      if (timer && typeof timer.timeout === 'function') {
        const dispose = timer.timeout(run, PREVIEW_DEBOUNCE_MS)
        return function () { try { dispose() } catch (e) {} }
      }
      run()
      return undefined
    }, [markdown, title, curId])

    function doGenerate(createNew) {
      setToast('')
      setExportInfo(null)
      call('generate', { reportId: createNew ? undefined : curId, createNew: createNew === true, instruction: instruction.trim() || undefined }, '已开始生成')
        .then(function (r) {
          if (r && r.ok === true) { setDirty(false); setMarkdown(''); setTitle(''); setTab('doc') }
        })
    }

    function doSave() {
      call('saveDraft', { id: curId, title: title, markdown: markdown }, '保存').then(function (r) {
        if (r && r.ok === true) setDirty(false)
      })
    }

    function doExport(format) {
      setExportInfo(null)
      call('export', { id: curId, format: format }).then(function (r) {
        if (r && r.ok === true) setExportInfo(r)
      })
    }

    function doImport() {
      call('importToMemory', { id: curId }, '导入记忆').then(function (r) {
        if (r && r.ok === true) setToast('已导入记忆：新增 ' + r.added + ' 条 / 覆盖 ' + r.updated + ' 条' + (r.indexError ? '（索引未同步，本地已存）' : ''))
      })
    }

    function doCollect() {
      setEvidence(null)
      call('collect', { preview: 12000 }, '试算证据').then(function (r) {
        if (r && r.ok === true) setEvidence(r.evidence)
      })
    }

    function doNew() {
      call('create', { title: '' }, '新建').then(function (r) {
        if (r && r.ok === true) { setDirty(false); setMarkdown(''); setTitle(''); setTab('doc') }
      })
    }

    function doRemove() {
      if (!curId) { setError('先选中一份报告'); return }
      call('remove', { ids: [curId] }, '删除报告').then(function (r) {
        if (r && r.ok === true) { setDirty(false); setMarkdown(''); setTitle(''); setEvidence(null) }
      })
    }

    function setField(k, v) {
      setDraft(function (d) {
        const n = JSON.parse(JSON.stringify(d || {}))
        n[k] = v
        return n
      })
    }

    function setModelField(k, v) {
      setDraft(function (d) {
        const n = JSON.parse(JSON.stringify(d || {}))
        if (!n.model) n.model = { provider: '', model: '' }
        n.model[k] = v
        return n
      })
    }

    const st = snap ? snap.status : null
    const reports = (snap && snap.reports) || []
    const cur = snap && snap.current ? snap.current : null
    const generating = !!(st && st.generating)
    const evMeta = (cur && cur.meta && cur.meta.evidence) || (st && st.evidence) || null
    const hasBody = !!String(markdown || '').trim()

    function head() {
      const bits = ['报告 ' + reports.length + ' 份']
      if (cur) bits.push(fmtNum(markdown.length) + ' 字' + (dirty ? '（未保存）' : ''))
      if (evMeta) bits.push('证据：会话 ' + (evMeta.sessions || 0) + ' · 矩阵 ' + (evMeta.matrixConfirmed || 0) + '/' + (evMeta.matrixSuspected || 0) + ' · 记忆 ' + (evMeta.memoryHits || 0))
      return el('div', { className: 'rtr-head' },
        el('span', { className: 'rtr-brand' }, '红队报告'),
        el('span', { className: 'rtr-stat' }, bits.join(' · ')),
        st && st.progress ? el('span', { className: 'rtr-stat rtr-brand-c' }, st.progress.text) : null,
        el('span', { className: 'rtr-sp' }),
        btn('刷新', { disabled: !!busy }, refresh))
    }

    // ── 报告 tab ──────────────────────────────────────────────────────────────
    function docTab() {
      if (!reports.length) {
        return el('div', { className: 'rtr-body' },
          card('还没有报告', '一句话说清它读什么', [
            el('div', { className: 'rtr-hint' },
              '点下面的按钮，AI 会自动收集三样东西再动笔：**当前工作区的对话**（用户要求 / 关键操作 / 结果与结论）、'
              + '**攻击矩阵的命中**（已确认与疑似分开，带技术点名字与判据）、**记忆库里相关的知识条目**。'
              + '写完之后可以在「证据」页看到它到底读到了什么。'),
            el('div', { className: 'rtr-row' },
              btn('生成报告', { primary: true, disabled: !!busy || generating }, function () { doGenerate(false) }),
              btn('新建空白报告', { disabled: !!busy }, doNew)),
          ]))
      }
      return el('div', { className: 'rtr-body' },
        // 报告列表：切换用，带字数与时间，比一行纯标题好认
        card('报告', reports.length + ' 份', [
          el('div', { className: 'rtr-chips' }, reports.map(function (r) {
            return el('button', {
              key: r.id, className: 'rtr-chip' + (r.id === curId ? ' rtr-chip-on' : ''), disabled: !!busy,
              title: (r.provider ? r.provider + '/' + r.model + ' · ' : '') + '更新于 ' + fmtTime(r.updatedAt),
              onClick: function () { if (r.id === curId) return; setDirty(false); call('select', { id: r.id }, '') },
            },
              el('span', { className: 'rtr-chip-t' }, r.title || '未命名'),
              el('span', { className: 'rtr-chip-m' }, fmtNum(r.chars) + ' 字 · ' + fmtTime(r.updatedAt)))
          })),
        ], btn('新建空白', { mini: true, disabled: !!busy }, doNew)),

        curId ? el('div', { className: 'rtr-edit' },
          el('input', {
            className: 'rtr-in rtr-title', value: title, placeholder: '报告标题',
            onChange: function (e) { setTitle(e.target.value); setDirty(true) },
          }),

          // 一条操作行：主操作在左，导出成组在中间，破坏性操作弱化在右
          el('div', { className: 'rtr-tools' },
            btn(generating ? '生成中…' : (hasBody ? '重新生成' : '生成报告'), { primary: true, disabled: !!busy || generating }, function () { doGenerate(false) }),
            btn(dirty ? '保存 *' : '保存', { disabled: !!busy || generating || !dirty }, doSave),
            el('span', { className: 'rtr-sep' }),
            group('导出', el('span', { className: 'rtr-seg' },
              btn('Markdown', { mini: true, disabled: !!busy || !hasBody }, function () { doExport('md') }),
              btn('HTML', { mini: true, disabled: !!busy || !hasBody }, function () { doExport('html') }),
              btn('Word', { mini: true, primary: true, disabled: !!busy || !hasBody, title: '导出 .docx（落盘路径显示在下面）' }, function () { doExport('docx') }))),
            btn('导入记忆', { disabled: !!busy || !hasBody, title: '把报告按章节切段写进红队记忆库' }, doImport),
            el('span', { className: 'rtr-sp' }),
            btn('删除', { danger: true, mini: true, disabled: !!busy, title: '删除这份报告（不可恢复）' }, doRemove)),

          el('div', { className: 'rtr-panes' },
            el('div', { className: 'rtr-pane' },
              el('div', { className: 'rtr-pane-h' },
                el('span', null, 'Markdown'),
                el('span', { className: 'rtr-sp' }),
                hint(fmtNum(markdown.length) + ' 字') + ''),
              el('textarea', {
                className: 'rtr-ta', value: markdown, placeholder: '点「生成报告」让 AI 写，或者直接在这里手写…',
                onChange: function (e) { setMarkdown(e.target.value); setDirty(true) },
              })),
            el('div', { className: 'rtr-pane' },
              el('div', { className: 'rtr-pane-h' }, el('span', null, '预览'), el('span', { className: 'rtr-sp' }), hint('与导出的 HTML / Word 同一套渲染')),
              html
                ? el('iframe', { className: 'rtr-frame', srcDoc: html, sandbox: 'allow-same-origin' })
                : el('div', { className: 'rtr-frame rtr-frame-empty' }, '预览生成中…'))),

          exportInfo ? el('div', { className: exportInfo.writeError ? 'rtr-warn' : 'rtr-ok' },
            '已导出 ' + exportInfo.name + '（' + exportInfo.bytes + ' 字节）'
            + (exportInfo.path ? '：' + exportInfo.path : '（未落盘）')
            + (exportInfo.writeError ? '｜落盘失败：' + exportInfo.writeError : '')) : null,

          cur && cur.meta && cur.meta.generatedAt
            ? el('div', { className: 'rtr-hint' }, '生成于 ' + fmtTime(cur.meta.generatedAt) + ' · 模型 ' + (cur.meta.provider || '?') + '/' + (cur.meta.model || '?')
              + (cur.meta.evidence ? ' · 证据 digest ' + fmtNum(cur.meta.evidence.digestChars) + ' 字' : ''))
            : null) : null
      )
    }

    // ── 证据 tab ──────────────────────────────────────────────────────────────
    function eviTab() {
      return el('div', { className: 'rtr-body' },
        el('div', { className: 'rtr-tools' },
          btn(busy === 'collect' ? '试算中…' : '试算证据', { primary: true, disabled: !!busy }, doCollect),
          hint('把真正喂给模型的那份材料打出来 —— 报告写得不对，九成是证据没采到或提示词没说清')),

        !evidence ? card('还没试算', null, [
          el('div', { className: 'rtr-hint' }, '点「试算证据」：它会真的跑一遍采集（读工作区会话、攻击矩阵、记忆库），并把裁剪后的 digest 原样显示在这里。不写任何文件、不调模型。'),
        ]) : el('div', { className: 'rtr-body' },
          el('div', { className: 'rtr-row' },
            badge('会话 ' + evidence.sessions.length, evidence.sessions.length ? 'brand' : 'warn'),
            badge('已确认 ' + evidence.matrix.confirmed, evidence.matrix.confirmed ? 'ok' : 'warn'),
            badge('疑似 ' + evidence.matrix.suspected, evidence.matrix.suspected ? 'warn' : ''),
            badge('记忆 ' + evidence.memory.count, evidence.memory.count ? 'brand' : 'warn'),
            badge('digest ' + fmtNum(evidence.digestChars) + ' 字', 'brand')),
          hint('工作区 ' + ((evidence.workspace && evidence.workspace.path) || '（无）')
            + ' · 矩阵来源 ' + evidence.matrix.from
            + (evidence.memory.available ? '' : ' · 记忆插件未在运行')),
          evidence.matrix.error ? el('div', { className: 'rtr-warn' }, '矩阵读取问题：' + evidence.matrix.error) : null,
          evidence.queries && evidence.queries.length ? hint('记忆检索词：' + evidence.queries.join(' / ')) : null,

          card('会话采集', evidence.sessions.length + ' 个',
            evidence.sessions.length
              ? el('table', { className: 'rtr-tbl' },
                el('thead', null, el('tr', null,
                  el('th', null, '会话'), el('th', null, '用户要求'), el('th', null, '操作'), el('th', null, '结果'), el('th', null, '时间'))),
                el('tbody', null, evidence.sessions.map(function (s) {
                  return el('tr', { key: s.id },
                    el('td', null, s.title || String(s.id).slice(0, 14)),
                    el('td', null, String(s.users)),
                    el('td', null, String(s.ops)),
                    el('td', null, String(s.results)),
                    el('td', { className: 'rtr-hint' }, fmtTime(s.firstAt) + ' → ' + fmtTime(s.lastAt)))
                })))
              : el('div', { className: 'rtr-dim' }, '没有采到会话（工作区里还没有对话，或者 sessions 服务不可用）')),

          evidence.files ? card('工作区文件采集', '清单与限制', [
            hint(JSON.stringify(evidence.files.stats)),
            el('div',{className:'rtr-hint'},evidence.files.notes.join('；')),
            el('pre',{className:'rtr-pre'},evidence.files.inventory.map(f=>f.path+' ['+f.status+']'+(f.reason?' '+f.reason:'')).join('\n'))
          ]) : null,
          card('digest', '前 ' + fmtNum(evidence.digest.length) + ' 字' + (evidence.truncated ? '，实际 ' + fmtNum(evidence.digestChars) + ' 字' : ''),
            el('pre', { className: 'rtr-pre' }, evidence.digest)))
      )
    }

    // ── 设置 tab ──────────────────────────────────────────────────────────────
    function setTab_() {
      if (!draft) return el('div', { className: 'rtr-body rtr-dim' }, '加载中…')
      return el('div', { className: 'rtr-body' },
        el('div', { className: 'rtr-tools' },
          btn('保存报告设置', { primary: true, disabled: !!busy }, function () { call('saveSettings', draft, '保存设置') }),
          btn('用当前会话默认模型', { disabled: !!busy }, function () { setModelField('provider', ''); setModelField('model', '') }),
          hint('留空 provider / model = 用你正在对话的那个模型（' + ((snap.model && snap.model.provider) || '?') + '/' + ((snap.model && snap.model.model) || '?') + '，来源 ' + ((snap.model && snap.model.from) || '?') + '）')),

        el('div', { className: 'rtr-grid' },
          card('工作区自动报告', '切换触发', [
            el('label',{className:'rtr-f'},
              el('span',null,'启用此工作区的自动报告'),
              el('input',{type:'checkbox',checked:draft.autoGenerate !== false,onChange:e=>setField('autoGenerate',e.target.checked)})),
            hint('先保存配置。快速切换只保留最后一个待处理工作区；已开始的报告完成后只写回原工作区。'),
            hint('文件枚举有数量、深度与摘录预算；跳过凭据、依赖、二进制和符号链接。采集边界写入报告。')
          ]),
          card('撰写模型', '报告由它写', [
            el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-f-l' }, 'provider'),
              el('input', { className: 'rtr-in', value: (draft.model && draft.model.provider) || '', placeholder: '留空 = 当前会话默认（例如 deepseek-official）', onChange: function (e) { setModelField('provider', e.target.value) } })),
            el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-f-l' }, 'model'),
              el('input', { className: 'rtr-in', value: (draft.model && draft.model.model) || '', placeholder: '留空 = 当前会话默认（例如 deepseek-flash）', onChange: function (e) { setModelField('model', e.target.value) } })),
            el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-f-l' }, 'maxTokens'),
              el('input', { className: 'rtr-in rtr-in-xs', type: 'number', value: draft.maxTokens, onChange: function (e) { setField('maxTokens', Number(e.target.value)) } })),
          ]),

          card('证据预算', '喂给模型多少材料', [
            el('div', { className: 'rtr-grid2' },
              el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-f-l' }, '最多读几个会话'),
                el('input', { className: 'rtr-in', type: 'number', value: draft.sessionLimit, onChange: function (e) { setField('sessionLimit', Number(e.target.value)) } })),
              el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-f-l' }, '每个会话最多取多少字'),
                el('input', { className: 'rtr-in', type: 'number', value: draft.sessionChars, onChange: function (e) { setField('sessionChars', Number(e.target.value)) } })),
              el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-f-l' }, '已确认命中上限'),
                el('input', { className: 'rtr-in', type: 'number', value: draft.maxConfirmed, onChange: function (e) { setField('maxConfirmed', Number(e.target.value)) } })),
              el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-f-l' }, '疑似命中上限'),
                el('input', { className: 'rtr-in', type: 'number', value: draft.maxSuspected, onChange: function (e) { setField('maxSuspected', Number(e.target.value)) } })),
              el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-f-l' }, 'digest 总上限（字）'),
                el('input', { className: 'rtr-in', type: 'number', value: draft.digestMax, onChange: function (e) { setField('digestMax', Number(e.target.value)) } })),
              el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-f-l' }, '记忆：条数 / 查询数'),
                el('div', { className: 'rtr-row' },
                  el('input', { className: 'rtr-in rtr-in-xs', type: 'number', value: draft.memoryTopK, onChange: function (e) { setField('memoryTopK', Number(e.target.value)) } }),
                  el('input', { className: 'rtr-in rtr-in-xs', type: 'number', value: draft.memoryQueries, onChange: function (e) { setField('memoryQueries', Number(e.target.value)) } })))),
          ]),

          card('路径', '留空就用默认', [
            hint('相对名由宿主按插件自己的工作区解析（实际路径见下方）；写不进去时改成能写的绝对路径。'),
            el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-f-l' }, '攻击矩阵存储'),
              el('input', { className: 'rtr-in', value: draft.matrixStore || '', placeholder: (st && st.matrixPath) || '', onChange: function (e) { setField('matrixStore', e.target.value) } })),
            el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-f-l' }, '报告库文件'),
              el('input', { className: 'rtr-in', value: (st && st.storePath) || '', readOnly: true })),
            el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-f-l' }, '导出目录'),
              el('input', { className: 'rtr-in', value: draft.exportDir || '', placeholder: '留空 = 与报告库同目录', onChange: function (e) { setField('exportDir', e.target.value) } })),
            hint('当前落盘：' + ((st && st.storePath) || '（未解析）')),
          ]),

          card('额外要求', '每次生成都会带上', [
            el('textarea', {
              className: 'rtr-ta rtr-ta-sm', value: draft.instruction || '',
              placeholder: '例如：重点写未授权访问链路，每条发现给出修复优先级；不要写攻击载荷细节。',
              onChange: function (e) { setField('instruction', e.target.value) },
            }),
          ]))
      )
    }

    function logTab() {
      return el('div', { className: 'rtr-body' },
        el('div', { className: 'rtr-tools' },
          btn('刷新', { disabled: !!busy }, refresh),
          btn('清空日志', { disabled: !!busy }, function () { call('logClear', {}, '清空日志') })),
        el('div', { className: 'rtr-logs' }, (snap.log || []).slice().reverse().map(function (l) {
          return el('div', { key: l.seq, className: 'rtr-ln rtr-ln-' + (l.level || 'info') },
            el('span', { className: 'rtr-lt' }, fmtTime(l.at)),
            el('span', { className: 'rtr-ll' }, l.level || ''),
            el('span', { className: 'rtr-lx' }, l.text))
        })))
    }

    if (settingsOnly) return el('section', {className:'rtr-root', style:{borderTop:'1px solid var(--dsw-alias-border-l1)', colorScheme:reportColorScheme()}},
      el('h2',{className:'rtr-brand'},'报告设置 · ' + (props.workspaceTitle || props.workspacePath)),
      hint('以下配置仅用于当前工作区；报告库按工作区隔离。'),
      error ? el('div',{className:'rtr-errbar'},error) : null,
      toast ? el('div',{className:'rtr-ok'},toast) : null,
      snap && draft ? setTab_() : el('div',{className:'rtr-dim'},'加载报告设置…'));
    return el('div', { className: 'rtr-root', style: { colorScheme: reportColorScheme() } },
      head(),
      activationError ? el('div',{className:'rtr-warn'},activationError) : null,
      st && st.queued ? hint('等待自动报告任务…') : null,
      st && st.lastError ? el('div',{className:'rtr-warn'},st.lastError) : null,
      error ? el('div', { className: 'rtr-errbar' }, el('span', null, error), el('button', { className: 'rtr-x', onClick: function () { setError(null) } }, '×')) : null,
      toast ? el('div', { className: 'rtr-ok' }, toast) : null,
      st && st.persistence === 'memory' ? el('div', { className: 'rtr-warn' }, 'fs 服务不可用：报告只存在内存里，重启会丢') : null,
      st && st.lastError && st.persistence === 'error' ? el('div', { className: 'rtr-warn' }, st.lastError) : null,

      el('div', { className: 'rtr-tabs' }, TABS.map(function (t) {
        return el('button', { key: t[0], className: 'rtr-tab' + (tab === t[0] ? ' rtr-tab-on' : ''), onClick: function () { setTab(t[0]) } }, t[1])
      })),

      !snap ? el('div', { className: 'rtr-body rtr-dim' }, busy === 'load' ? '加载中…' : '正在读取报告库…') : null,
      snap && tab === 'doc' ? docTab() : null,
      snap && tab === 'evi' ? eviTab() : null,

      snap && tab === 'log' ? logTab() : null
    )
  }

  // 侧边栏图标：一份带批注点的文档
  function Glyph(props) {
    const size = props && props.size ? props.size : 16
    const active = props && props.active
    const c = active ? 'var(--dsw-alias-brand-primary)' : 'currentColor'
    return React.createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' },
      React.createElement('path', { d: 'M6 3.5h8.5L19 8v12.5H6z', stroke: c, strokeWidth: 1.6, strokeLinejoin: 'round' }),
      React.createElement('path', { d: 'M14.2 3.6V8H19', stroke: c, strokeWidth: 1.4, strokeLinejoin: 'round' }),
      React.createElement('path', { d: 'M9 12h6M9 15h6M9 18h3.5', stroke: c, strokeWidth: 1.4, strokeLinecap: 'round' }),
      React.createElement('circle', { cx: 5.2, cy: 12, r: 1.5, fill: c }),
      React.createElement('circle', { cx: 5.2, cy: 16.6, r: 1.5, fill: c })
    )
  }

  // ── 样式：全部走主题 token ──────────────────────────────────────────────────
  ctx.effect(function () {
    return styles.insert([
      '.rtr-root{padding:14px 16px;display:flex;flex-direction:column;gap:12px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.rtr-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.rtr-brand{font-size:14px;font-weight:600;letter-spacing:.2px}',
      '.rtr-brand-c{color:var(--dsw-alias-brand-primary)}',
      '.rtr-stat{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.rtr-sp{flex:1 1 auto}',
      '.rtr-dim{color:var(--dsw-alias-label-secondary)}',
      '.rtr-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.rtr-err{color:var(--dsw-alias-state-error-primary);font-size:12px}',
      '.rtr-ok{color:var(--dsw-alias-state-success-primary);font-size:12px;word-break:break-all}',
      '.rtr-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px}',
      '.rtr-errbar{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;color:var(--dsw-alias-state-error-primary);font-size:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px}',
      '.rtr-x{background:transparent;border:none;color:inherit;font-size:16px;line-height:1;cursor:pointer;padding:0 4px}',

      '.rtr-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.rtr-tab{background:transparent;border:none;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);padding:6px 12px;font-size:12.5px;cursor:pointer;font-family:inherit}',
      '.rtr-tab:hover{color:var(--dsw-alias-label-primary)}',
      '.rtr-tab-on{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.rtr-body{display:flex;flex-direction:column;gap:12px}',

      '.rtr-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.rtr-sep{width:1px;height:18px;background:var(--dsw-alias-border-l1)}',
      '.rtr-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.rtr-group{display:flex;align-items:center;gap:6px}',
      '.rtr-group-l{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.rtr-seg{display:inline-flex}',

      '.rtr-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
      '.rtr-card-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.rtr-card-t{font-size:12.5px;font-weight:600}',
      '.rtr-card-s{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.rtr-card-b{display:flex;flex-direction:column;gap:8px}',

      '.rtr-btn{height:26px;padding:0 10px;border-radius:7px;font-size:12px;font-family:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.rtr-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}',
      '.rtr-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.rtr-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}',
      '.rtr-btn-primary:hover:not(:disabled){filter:brightness(1.06)}',
      '.rtr-btn-danger{color:var(--dsw-alias-state-error-primary)}',
      '.rtr-btn-mini{height:22px;padding:0 8px;font-size:11.5px}',
      '.rtr-seg .rtr-btn{border-radius:0;margin-left:-1px}',
      '.rtr-seg .rtr-btn:first-child{border-radius:7px 0 0 7px;margin-left:0}',
      '.rtr-seg .rtr-btn:last-child{border-radius:0 7px 7px 0}',

      '.rtr-in{height:26px;box-sizing:border-box;width:100%;padding:0 8px;border-radius:7px;font-size:12px;font-family:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1)}',
      '.rtr-in:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.rtr-in-xs{width:64px}',
      '.rtr-title{height:32px;font-size:14px;font-weight:600}',
      '.rtr-ta{min-height:120px;box-sizing:border-box;width:100%;padding:8px;border-radius:8px;font-size:12px;font-family:ui-monospace,monospace;line-height:1.6;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);resize:vertical;flex:1 1 auto}',
      '.rtr-ta:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.rtr-ta-sm{min-height:74px}',

      '.rtr-badge{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:5px;font-size:11.5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.rtr-badge-ok{color:var(--dsw-alias-state-success-primary)}',
      '.rtr-badge-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.rtr-badge-brand{color:var(--dsw-alias-brand-primary)}',

      '.rtr-chips{display:flex;gap:6px;flex-wrap:wrap}',
      '.rtr-chip{display:flex;flex-direction:column;align-items:flex-start;gap:1px;text-align:left;max-width:280px;padding:5px 10px;border-radius:8px;cursor:pointer;font-family:inherit;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}',
      '.rtr-chip:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}',
      '.rtr-chip-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.rtr-chip-t{font-size:12px;font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rtr-chip-m{font-size:11px;color:var(--dsw-alias-label-secondary)}',

      '.rtr-edit{display:flex;flex-direction:column;gap:8px}',
      '.rtr-panes{display:grid;grid-template-columns:1fr 1fr;gap:10px;min-height:52vh}',
      '.rtr-pane{display:flex;flex-direction:column;gap:5px;min-width:0}',
      '.rtr-pane-h{display:flex;align-items:baseline;gap:8px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.rtr-frame{flex:1 1 auto;min-height:46vh;width:100%;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:#fff}',
      '.rtr-frame-empty{padding:10px;font-size:12px;color:var(--dsw-alias-label-secondary)}',

      '.rtr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px;align-items:start}',
      '.rtr-grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '.rtr-f{display:flex;flex-direction:column;gap:4px}',
      '.rtr-f-l{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',

      '.rtr-tbl{width:100%;border-collapse:collapse;font-size:12px}',
      '.rtr-tbl th{text-align:left;font-weight:500;font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.rtr-tbl td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}',
      '.rtr-tbl tbody tr:hover td{background:var(--dsw-alias-bg-layer-2)}',
      '.rtr-tbl tbody tr:last-child td{border-bottom:none}',

      '.rtr-pre{white-space:pre-wrap;word-break:break-word;font-size:11.5px;line-height:1.6;max-height:52vh;overflow:auto;margin:0;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);font-family:ui-monospace,monospace}',

      '.rtr-logs{display:flex;flex-direction:column;gap:2px;font-size:11.5px;max-height:60vh;overflow:auto}',
      '.rtr-ln{display:flex;gap:8px;align-items:baseline}',
      '.rtr-lt{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,monospace}',
      '.rtr-ll{flex:0 0 auto;min-width:34px;color:var(--dsw-alias-label-secondary)}',
      '.rtr-lx{white-space:pre-wrap;word-break:break-word}',
      '.rtr-ln-err .rtr-lx{color:var(--dsw-alias-state-error-primary)}',
      '.rtr-ln-warn .rtr-lx{color:var(--dsw-alias-state-warn-primary)}',
      '.rtr-ln-ok .rtr-lx{color:var(--dsw-alias-state-success-primary)}',
    ].join('\n'))
  }, 'redteam-report: styles')

  ctx.effect(function () {
    return slots.inject('sidebar.panellist', function () {
      return slots.register({ name: 'sidebar.panellist', id: PANEL_KEY, order: 60, label: '红队报告' }, Glyph)
    })
  }, 'redteam-report: panel button')

  ctx.effect(function () {
    return slots.inject('main', function () {
      return slots.register({ name: 'main', key: PANEL_KEY }, ScopedPanel)
    })
  }, 'redteam-report: main panel')

  console.log('[rtreport] redteam-report client half ready; panel =', PANEL_KEY)
}
    exports.inject = ['slots', 'timer', 'redteamSettingsUI']
    exports.apply = function (ctx) { return applyClient(ctx) }
    return module.exports
  }
});
