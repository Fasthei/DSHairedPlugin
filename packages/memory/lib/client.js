// 常驻（静态）客户端半边 —— 浏览器 bundle 形态（由 tools/build-lib.mjs 生成）。
//
// client-modules 是 CJS 懒执行模型：bundle 只【注册】工厂，副作用留在闭包内，
// 首次 require 时物化。因此这里用 window.__ModuleLoader__.load({id, factory}) 注册。
//
// 包装刻意保持极薄（只做作用域与导出），全部改造集中在主体自己的 applyClient 里，
// 见 lib/parts/client.shim.js。
window.__ModuleLoader__.load({
  id: 'dsh-redteam-memory',
  factory: (require) => {
    let React = require('react');
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

// 红队记忆 · Client 半边
//
// lib/client.js 由 `npm run build:lib` 从本文件生成，不要手改 lib/。
// 生成器以函数名 `applyClient` 为入口锚点，并在其中注入 host.call / styles.insert 垫片
// ——静态 bundle 里没有这两个闭包符号，原因见 ../../docs/DEVELOPMENT.md。
//
// 注意：本文件必须以 `return { name, inject, apply }` 块【结尾】，生成器据此剥离动态包装。
//
// ── 两个界面，各管一件事 ──────────────────────────────────────────────────────
//   红队记忆（main 面板）      知识库 / 检索 / 日志 —— 只用不管配
//   红队设置（settings 页）    Milvus / 向量模型 / 重排 / MinIO / 本地库 —— 只配不管用
//
// 分开的理由很具体：数据库地址、向量模型 Key 这些东西一年改两次，却原来占着记忆面板的
// 一个大 tab；而「导入一份报告」「查一条技巧」每天都要用。配置挪到 DSH 设置里（settings.section
// 插槽，注册成「红队设置」一页），数据面板回到只有三件事。
//
// ── 导入只认四类格式 ─────────────────────────────────────────────────────────
//   pdf / word(.docx) / md / txt。格式越多，「导入失败」的成因越多，而这几类覆盖了
//   红队现场真正会拿到的东西：报告(pdf/docx)、笔记(md)、扫描导出(txt)。
//
// ── 样式 ─────────────────────────────────────────────────────────────────────
//   颜色一律用主题 token（--dsw-alias-bg-layer-1/2、--dsw-alias-label-secondary…），
//   不写死、也不用 opacity 凑层级：写死的色在深色主题下会脏，opacity 会让可读性飘。

function applyClient(ctx) {
  // ── 静态形态垫片（动态半边的闭包符号在静态包里不存在）──
  //
  // 1) host.call：转到宿主 HTTP 路由（见 lib/host.js 的 /dsh-redteam-memory/rpc）。
  //    选 HTTP 而非 ctx.remote：Remote 需 typert 代码生成（zod schema + 生成绑定），
  //    而本插件有 20 个无类型 JSON 句柄，为此引入整套生成链不划算；
  //    且 fetch 只被【动态】半边屏蔽，静态模块可直接用。
  // 2) styles.insert：动态 runner 把它作为闭包参数注入，静态 bundle 里没有，
  //    故自行插入 <style> 元素（浏览器全局可用），并登记到 fiber 便于卸载清理。
  // 路径必须由生成器按包名填充（/dsh-redteam-memory）。这里曾经写死成
  // `/dsh-redteam-asset-graph/rpc` —— 那是从资产图谱早期版本复制骨架时带过来的缺陷：
  // 本插件的面板会去打资产图谱的路由，请求全 404，两者同时安装还会读到对方的数据
  // （资产图谱 README 记的那次事故是同一个根因）。测试里钉住了实际请求的 url。
  const RPC_PATH = '/dsh-redteam-memory/rpc'
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
            throw new Error('redteam-memory rpc ' + method + ' 失败：' + detail)
          }
          return payload.result
        })
      })
    },
  }

  const STYLE_ID = 'redteam-memory-styles'
  const styles = {
    insert(css) {
      if (typeof document === 'undefined') return function () {}
      let el = document.getElementById(STYLE_ID)
      if (!el) { el = document.createElement('style'); el.id = STYLE_ID; document.head.appendChild(el) }
      el.textContent += String(css) + '\n'
      const dispose = function () { if (el && el.parentNode) el.parentNode.removeChild(el) }
      try { ctx.effect(function () { return dispose }, 'redteam-memory: styles') } catch (e) { return dispose }
      return dispose
    },
  }

  const slots = ctx.slots

  // Shared settings contribution point. Values are React components, never JSON/RPC data.
  let reportComponent = null
  let settingsClosed = false
  const settingsListeners = new Set()
  function notifySettings() {
    for (const listener of settingsListeners) listener()
  }
  const settingsHub = {
    current() { return reportComponent },
    subscribe(listener) {
      if (settingsClosed) throw new Error('红队设置页已卸载')
      if (typeof listener !== 'function') throw new TypeError('设置订阅者必须是函数')
      settingsListeners.add(listener)
      listener()
      return function () { settingsListeners.delete(listener) }
    },
    register(component) {
      if (settingsClosed) throw new Error('红队设置页已卸载')
      if (typeof component !== 'function' && (!component || typeof component !== 'object')) throw new TypeError('报告设置必须提供 React 组件')
      if (reportComponent !== null) throw new Error('报告设置已注册，请先卸载旧组件')
      reportComponent = component
      notifySettings()
      let registered = true
      return function () {
        if (!registered) return
        registered = false
        if (reportComponent !== component) return
        reportComponent = null
        notifySettings()
      }
    },
  }
  ctx.effect(function () {
    const dispose = ctx.provide('redteamSettingsUI', settingsHub)
    return function () {
      settingsClosed = true
      reportComponent = null
      settingsListeners.clear()
      dispose()
    }
  }, 'redteam-memory: shared settings hub')

  const PANEL_KEY = 'redteam-memory'
  const SETTINGS_KEY = 'redteam-memory'
  const PAGE = 30

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

  function fmtSize(n) {
    const v = Number(n) || 0
    if (v < 1024) return v + ' B'
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB'
    return (v / 1024 / 1024).toFixed(1) + ' MB'
  }

  function reportError(e) { return String((e && e.message) || e) }

  // UI 基元：按钮 / 卡片 / 字段 / 徽标。写一次，两个面板共用，样式才可能一致。
  function btn(label, opts, onClick) {
    const o = opts || {}
    const cls = 'rtm-btn' + (o.primary ? ' rtm-btn-primary' : '') + (o.danger ? ' rtm-btn-danger' : '') + (o.mini ? ' rtm-btn-mini' : '')
    return el('button', {
      key: o.key || label, className: cls, disabled: o.disabled === true,
      title: o.title || '', onClick: onClick,
    }, label)
  }

  function card(title, sub, children, extra) {
    return el('section', { className: 'rtm-card' },
      el('div', { className: 'rtm-card-h' },
        el('span', { className: 'rtm-card-t' }, title),
        sub ? el('span', { className: 'rtm-card-s' }, sub) : null,
        el('span', { className: 'rtm-sp' }),
        extra || null),
      el('div', { className: 'rtm-card-b' }, children))
  }

  function badge(text, kind) {
    return el('span', { className: 'rtm-badge' + (kind ? ' rtm-badge-' + kind : '') }, text)
  }

  // 用一张字段表渲染四组配置，免得把同样的表单写四遍。
  // 注意按**草稿**里的 provider 算候选项，不是已保存的设置 —— 否则你在界面上切到
  // 「智谱 BigModel」时，模型下拉还是阿里的那几个，得先保存一次才生效。
  function fieldSpecs(snap, draft) {
    const embed = (snap && snap.embedPresets) || []
    const rerank = (snap && snap.rerankPresets) || []
    const cur = draft || (snap && snap.settings) || {}
    const curEmbedProvider = (cur.embed && cur.embed.provider) || ''
    const curRerankProvider = (cur.rerank && cur.rerank.provider) || ''
    const embedCur = (embed.filter(function (x) { return x.id === curEmbedProvider })[0] || {}).models || []
    const rerankCur = (rerank.filter(function (x) { return x.id === curRerankProvider })[0] || {}).models || []
    return [
      { g: 'milvus', k: 'uri', label: 'Milvus 地址', ph: 'http://127.0.0.1:19530' },
      { g: 'milvus', k: 'token', label: 'Token', ph: 'Zilliz 云必填；自建留空', secret: true },
      { g: 'milvus', k: 'dbName', label: '数据库', ph: 'default' },
      { g: 'milvus', k: 'collection', label: 'Collection', ph: 'redteam_memory' },
      { g: 'milvus', k: 'metric', label: '距离度量', options: ['COSINE', 'L2', 'IP'] },

      { g: 'embed', k: 'provider', label: '服务', options: embed.map(function (x) { return { v: x.id, t: x.label } }) },
      { g: 'embed', k: 'model', label: '模型', options: embedCur.map(function (m) { return { v: m.id, t: m.id + '（' + m.dimension + ' 维）' } }), free: true },
      { g: 'embed', k: 'dimension', label: '维度', num: true, ph: '与模型匹配，例如 1024' },
      { g: 'embed', k: 'apiKey', label: 'API Key', secret: true },
      { g: 'embed', k: 'baseUrl', label: '自定义接口地址', ph: '留空用官方默认' },

      { g: 'rerank', k: 'enabled', label: '启用重排', bool: true },
      { g: 'rerank', k: 'provider', label: '服务', options: rerank.map(function (x) { return { v: x.id, t: x.label } }) },
      { g: 'rerank', k: 'model', label: '模型', options: rerankCur.map(function (m) { return { v: m, t: m } }), free: true },
      { g: 'rerank', k: 'topN', label: '保留条数', num: true },
      { g: 'rerank', k: 'apiKey', label: 'API Key', secret: true },
      { g: 'rerank', k: 'baseUrl', label: '自定义接口地址', ph: '留空用官方默认' },

      { g: 's3', k: 'enabled', label: '关联 MinIO（Milvus 存储桶）', bool: true },
      { g: 's3', k: 'endpoint', label: '端点', ph: 'http://minio:9000' },
      { g: 's3', k: 'bucket', label: '桶名', ph: 'mimo' },
      { g: 's3', k: 'region', label: 'Region', ph: 'us-east-1' },
      { g: 's3', k: 'prefix', label: '前缀（可选）', ph: '' },
      { g: 's3', k: 'accessKey', label: 'Access Key', secret: true },
      { g: 's3', k: 'secretKey', label: 'Secret Key', secret: true },
      { g: 's3', k: 'pathStyle', label: 'path-style 寻址', bool: true, hint: 'MinIO / 自建一般要开；AWS 关掉' },

      // top: true 表示这是 settings 的顶层字段（不挂在任何分组下）
      { top: true, k: 'storePath', label: '本地库文件', ph: '.redteam-memory.json', hint: '相对名由宿主解析；写不进去时改成能写的绝对路径' },
      { top: true, k: 'searchTopK', label: '默认返回条数', num: true, hint: 'memory_search 不传 topK 时用它，也用作这里「检索」页的默认值' },
    ]
  }

  function renderFieldNode(f, cur, onChange) {
    if (f.bool) {
      return el('label', { key: f.g + f.k, className: 'rtm-f rtm-f-row' },
        el('input', { type: 'checkbox', checked: cur === true, onChange: function (e) { onChange(e.target.checked) } }),
        el('span', null, f.label),
        f.hint ? el('span', { className: 'rtm-hint' }, f.hint) : null)
    }
    if (f.options) {
      const opts = f.options.map(function (o) { return typeof o === 'string' ? { v: o, t: o } : o })
      const known = opts.some(function (o) { return o.v === cur })
      return el('label', { key: f.g + f.k, className: 'rtm-f' },
        el('span', { className: 'rtm-f-l' }, f.label),
        el('select', { className: 'rtm-in', value: known ? cur : '__custom__', onChange: function (e) { if (e.target.value !== '__custom__') onChange(e.target.value) } },
          opts.map(function (o) { return el('option', { key: o.v, value: o.v }, o.t) }),
          f.free ? el('option', { value: '__custom__' }, '（自定义，用下面的输入框）') : null),
        f.free ? el('input', { className: 'rtm-in', value: cur || '', placeholder: f.ph || '', onChange: function (e) { onChange(e.target.value) } }) : null,
        f.hint ? el('span', { className: 'rtm-hint' }, f.hint) : null)
    }
    return el('label', { key: 'x' + (f.g || '') + f.k, className: 'rtm-f' },
      el('span', { className: 'rtm-f-l' }, f.label),
      el('input', {
        className: 'rtm-in',
        type: f.secret ? 'password' : (f.num ? 'number' : 'text'),
        value: cur === undefined || cur === null ? '' : String(cur),
        placeholder: f.ph || '',
        onChange: function (e) { onChange(f.num ? Number(e.target.value) : e.target.value) },
      }),
      f.hint ? el('span', { className: 'rtm-hint' }, f.hint) : null)
  }

  // 打开设置页的提示。DSH 没有「打开设置」的客户端服务（layout.selectPanel 只选主面板），
  // 所以这里给出确切路径，而不是放一个点了没反应的按钮。
  function settingsHint() {
    return el('span', { className: 'rtm-hint' }, '数据库 / 向量模型 / 重排 / MinIO 在「设置 → 红队设置」里')
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 红队记忆（main 面板）
  // ══════════════════════════════════════════════════════════════════════════
  function MemoryPanel() {
    const [snap, setSnap] = React.useState(null)
    const [tab, setTab] = React.useState('kb')
    const [busy, setBusy] = React.useState('')
    const [error, setError] = React.useState(null)
    const [toast, setToast] = React.useState('')
    const [draft, setDraft] = React.useState(null)
    const [list, setList] = React.useState({ entries: [], total: 0, offset: 0 })
    const [selected, setSelected] = React.useState([])
    const [detail, setDetail] = React.useState(null)
    const [importPath, setImportPath] = React.useState('')
    const [capOpen, setCapOpen] = React.useState(false)
    const [capTest, setCapTest] = React.useState('')
    const [capInfo, setCapInfo] = React.useState(null)
    const [query, setQuery] = React.useState('')
    const [topK, setTopK] = React.useState(8)
    const [useRerank, setUseRerank] = React.useState(true)
    const [hits, setHits] = React.useState(null)

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

    // 面板自己刷新：导入/向量化可能耗时，捕获是「悄悄发生的」，状态得能自己走
    const liveRef = React.useRef({ busy: '' })
    liveRef.current = { busy: busy }
    React.useEffect(function () {
      if (typeof ctx.interval !== 'function') return undefined
      return ctx.interval(function () {
        if (liveRef.current.busy) return
        host.call('snapshot', {}).then(function (r) {
          if (!r || r.ok !== true) return
          setSnap(r.snapshot)
          setDraft(function (d) { return d || JSON.parse(JSON.stringify(r.snapshot.settings)) })
        }).catch(function () {})
      }, 4000)
    }, [])

    function loadList(offset) {
      const off = typeof offset === 'number' ? offset : list.offset
      setBusy('list')
      return host.call('listKnowledge', jsonArgs({ limit: PAGE, offset: off }))
        .then(function (r) {
          if (!r || r.ok !== true) { setError((r && r.error) || '读取列表失败'); return }
          setError(null)
          setList({ entries: r.entries || [], total: r.total || 0, offset: off })
        })
        .catch(function (e) { setError(reportError(e)) })
        .then(function () { setBusy('') })
    }

    // 依赖必须带上本地条数：snapshot 是挂载之后才到的，只依赖 tab 的话这个效果永远不会重跑；
    // 而条数变化恰好是「刚导入 / 刚捕获」的信号，列表因此能自己刷新。
    React.useEffect(function () {
      if (tab === 'kb' && snap) loadList(0)
    }, [tab, snap && snap.status && snap.status.localCount])

    function doImport() {
      if (!importPath.trim()) { setError('先填文件路径（建议绝对路径）'); return }
      call('importFile', { path: importPath.trim() }, '导入').then(function (r) {
        if (r && r.ok === true) {
          setImportPath('')
          setToast('已导入 ' + r.parsed + ' 条（' + r.ext + '，' + r.chars + ' 字，' + r.how + '）' + (r.indexError ? '｜本地已存，索引未同步' : ''))
          loadList(0)
        }
      })
    }

    function doSyncIndex(all) {
      call('syncIndex', { all: all === true }, all === true ? '整库重建索引' : '同步索引').then(function (r) {
        if (r && r.ok === true) setToast((r.entries || 0) + ' 条本地条目 → ' + (r.synced || 0) + ' 行索引')
      })
    }

    // 内置知识包：16 条 AI 安全知识与进攻技巧。先落本地库（一定成功），
    // 索引同步失败也不影响内容 —— 配好后点「同步索引」补齐。
    function doSeed() {
      call('seed', {}, '导入内置知识包').then(function (r) {
        if (r && r.ok === true) {
          const pending = (r.snapshot && r.snapshot.status && r.snapshot.status.pending) || 0
          setToast('已导入内置知识包 ' + (r.added || 0) + ' 条' + (pending ? '｜待同步 ' + pending + ' 条' : '｜已进索引'))
          loadList(0)
        }
      })
    }

    function doRemove() {
      if (!selected.length) { setError('先勾选要删除的条目'); return }
      call('removeKnowledge', { ids: selected }, '删除 ' + selected.length + ' 条').then(function (r) {
        if (r && r.ok === true) { setSelected([]); setDetail(null); loadList(list.offset) }
      })
    }

    function doDrop() {
      call('dropCollection', {}, '删除向量索引').then(function (r) {
        if (r && r.ok === true) { setSelected([]); setDetail(null); loadList(0) }
      })
    }

    function toggle(id) {
      setSelected(function (s) { return s.indexOf(id) >= 0 ? s.filter(function (x) { return x !== id }) : s.concat([id]) })
    }

    function openEntry(id) {
      setBusy('detail')
      host.call('getEntry', { id: id })
        .then(function (r) { if (r && r.ok === true) { setDetail(r.entry); setError(null) } else { setError((r && r.error) || '读取失败') } })
        .catch(function (e) { setError(reportError(e)) })
        .then(function () { setBusy('') })
    }

    function doSearch() {
      if (!query.trim()) { setError('先填检索内容'); return }
      setBusy('search')
      setToast('')
      host.call('search', jsonArgs({ query: query.trim(), topK: topK, rerank: useRerank }))
        .then(function (r) {
          if (!r || r.ok !== true) { setError((r && r.error) || '检索失败'); setHits(null); return }
          setError(null)
          setHits(r)
        })
        .catch(function (e) { setError(reportError(e)) })
        .then(function () { setBusy('') })
    }

    function setCaptureField(k, v) {
      setDraft(function (d) {
        const n = JSON.parse(JSON.stringify(d || {}))
        if (!n.capture) n.capture = { enabled: true, phrases: '', kind: 'note', withContext: true }
        n.capture[k] = v
        return n
      })
    }

    // 触发词干跑：只判断会不会被捕，不写入 —— 调触发词时先用它验，免得写进一堆噪声。
    function doCaptureTest() {
      setBusy('capTest')
      host.call('captureTest', jsonArgs({ text: capTest }))
        .then(function (r) { setCapInfo(r || { matched: false }); if (r && r.ok === false) setError(r.error || '试跑失败') })
        .catch(function (e) { setError(reportError(e)) })
        .then(function () { setBusy('') })
    }

    function doCaptureAdd() {
      call('captureAdd', { text: capTest, kind: (draft && draft.capture.kind) || 'note' }, '捕获入库').then(function (r) {
        if (r && r.ok === true) { setCapTest(''); setCapInfo(null); loadList(0) }
      })
    }

    const st = snap ? snap.status : null
    const cap = (draft && draft.capture) || { enabled: true, phrases: '' }
    const captures = (snap && snap.captures) || []
    const tabs = [['kb', '知识库'], ['search', '检索'], ['log', '日志']]

    function head() {
      return el('div', { className: 'rtm-head' },
        el('span', { className: 'rtm-brand' }, '红队记忆'),
        st ? el('span', { className: 'rtm-stat' },
          '本地 ' + (st.localCount || 0) + ' 条 · 索引 ' + (st.indexed || 0) + ' 条' + (st.pending ? '（待同步 ' + st.pending + '）' : '')
          + ' · ' + (st.embedReady ? '向量模型已配' : '未配向量模型')) : null,
        st && st.progress ? el('span', { className: 'rtm-stat rtm-brand-c' }, st.progress.text) : null,
        el('span', { className: 'rtm-sp' }),
        settingsHint(),
        btn('刷新', { disabled: !!busy }, refresh))
    }

    function kbTab() {
      return el('div', { className: 'rtm-body' },
        // 知识库只保留两个入口：同步索引与内置知识包；查询在独立检索页，导入走文件入口。
        el('div', { className: 'rtm-tools' },
          btn('同步索引' + (st && st.pending ? '（' + st.pending + '）' : ''), {
            disabled: !!busy || !(st && st.pending > 0),
            title: st && st.pending > 0 ? '把本地还没进索引的 ' + st.pending + ' 条同步到 Milvus' : '本地条目都已进索引',
          }, function () { doSyncIndex(false) }),
          btn('导入内置知识包', { disabled: !!busy, title: '16 条 AI 安全知识与进攻技巧；先落本地库，不依赖向量模型' }, doSeed)),

        // 导入：只有一条路、四种格式
        card('导入文件', snap.importLabel || 'pdf / word(.docx) / md / txt', [
          el('div', { className: 'rtm-row' },
            el('input', {
              className: 'rtm-in rtm-grow', value: importPath, placeholder: '文件绝对路径，例如 /home/you/report.pdf',
              onChange: function (e) { setImportPath(e.target.value) }, onKeyDown: function (e) { if (e.key === 'Enter') doImport() },
            }),
            btn('导入', { primary: true, disabled: !!busy }, doImport)),
          el('div', { className: 'rtm-hint' }, 'md / txt 直接读；word(.docx) 用 unzip 取正文；pdf 用 pdftotext 抽文本。换成别的格式会被直接拒绝并说明原因 —— 不猜、也不静默失败。'),
        ]),

        // 对话捕获：默认折叠成一行 —— 它开着就行，不需要天天看
        el('section', { className: 'rtm-card' },
          el('div', { className: 'rtm-card-h' },
            el('label', { className: 'rtm-f rtm-f-row' },
              el('input', { type: 'checkbox', checked: cap.enabled === true, onChange: function (e) { setCaptureField('enabled', e.target.checked) } }),
              el('span', { className: 'rtm-card-t' }, '对话捕获')),
            badge(cap.enabled === true ? '开' : '关', cap.enabled === true ? 'ok' : 'warn'),
            el('span', { className: 'rtm-card-s' }, '触发词 ' + ((snap.capturePhrases || []).length) + ' 个 · 最近捕获 ' + captures.length + ' 条'),
            el('span', { className: 'rtm-sp' }),
            btn(capOpen ? '收起' : '展开', { mini: true }, function () { setCapOpen(!capOpen) })),
          capOpen ? el('div', { className: 'rtm-card-b' },
            el('div', { className: 'rtm-row' },
              el('input', {
                className: 'rtm-in rtm-grow', value: String(cap.phrases || ''), placeholder: '触发词，逗号分隔',
                onChange: function (e) { setCaptureField('phrases', e.target.value) },
              }),
              btn('保存触发词', { disabled: !!busy }, function () { call('saveSettings', draft, '保存触发词') })),
            el('div', { className: 'rtm-row' },
              el('input', {
                className: 'rtm-in rtm-grow', value: capTest, placeholder: '试一句，例如：这台机的指纹写入记忆',
                onChange: function (e) { setCapTest(e.target.value) }, onKeyDown: function (e) { if (e.key === 'Enter') doCaptureTest() },
              }),
              btn('干跑', { disabled: !!busy || !capTest.trim(), title: '只判断会不会被捕，不写入' }, doCaptureTest),
              btn('直接入库', { disabled: !!busy || !capTest.trim() }, doCaptureAdd)),
            capInfo ? el('div', { className: capInfo.matched === true ? 'rtm-ok' : 'rtm-warn' },
              capInfo.matched === true
                ? ('会捕获：触发词「' + capInfo.phrase + '」→ ' + capInfo.text)
                : (capInfo.error || '不会捕获：没有一个触发词命中')) : null,
            captures.length ? el('div', { className: 'rtm-caps' }, captures.slice(0, 6).map(function (c, i) {
              return el('div', { key: i, className: 'rtm-cap-i' },
                el('span', { className: 'rtm-lt' }, fmtTime(c.at)),
                badge(c.phrase || '人工', 'brand'),
                el('span', { className: 'rtm-cap-x' }, c.text),
                el('span', { className: 'rtm-hint' }, c.error ? '索引未同步' : (c.indexed ? '已进索引' : '仅本地')))
            })) : null,
            captures.length ? el('div', { className: 'rtm-row' }, btn('清空捕获记录', { mini: true }, function () { call('captureClear', {}, '清空捕获记录') })) : null
          ) : null),

        // 列表
        card('知识库', '本地 ' + ((st && st.localCount) || 0) + ' 条 · 命中 ' + list.total + ' 条',
          el('div', null,
            (list.entries || []).length === 0
              ? el('div', { className: 'rtm-dim' }, '本地库还没有条目。请导入一份 pdf / word / md / txt。')
              : el('table', { className: 'rtm-tbl' },
                el('thead', null, el('tr', null,
                  el('th', { className: 'rtm-th-x' }, ''),
                  el('th', null, '标题'),
                  el('th', null, '类型'),
                  el('th', null, '标签'),
                  el('th', null, '索引'),
                  el('th', null, '更新时间'))),
                el('tbody', null, list.entries.map(function (e1) {
                  return el('tr', { key: e1.id, className: selected.indexOf(e1.id) >= 0 ? 'rtm-tr-on' : '' },
                    el('td', null, el('input', { type: 'checkbox', checked: selected.indexOf(e1.id) >= 0, onChange: function () { toggle(e1.id) } })),
                    el('td', null, el('a', { className: 'rtm-lnk', onClick: function () { openEntry(e1.id) }, title: e1.source || '' }, e1.title || '(无标题)')),
                    el('td', null, e1.kind || ''),
                    el('td', { className: 'rtm-tagc' }, e1.tags || ''),
                    el('td', null, e1.indexed ? badge('已索引', 'ok') : badge('仅本地')),
                    el('td', { className: 'rtm-hint' }, fmtTime(e1.updated_at)))
                }))),
            list.total > PAGE ? el('div', { className: 'rtm-pager' },
              btn('上一页', { mini: true, disabled: !!busy || list.offset <= 0 }, function () { loadList(Math.max(0, list.offset - PAGE)) }),
              el('span', { className: 'rtm-hint' }, (list.offset + 1) + '–' + Math.min(list.offset + PAGE, list.total) + ' / ' + list.total),
              btn('下一页', { mini: true, disabled: !!busy || list.offset + PAGE >= list.total }, function () { loadList(list.offset + PAGE) })) : null),
          el('div', { className: 'rtm-row' },
            btn('删除选中' + (selected.length ? '（' + selected.length + '）' : ''), { danger: true, mini: true, disabled: !!busy || !selected.length }, doRemove),
            btn('删除向量索引', { danger: true, mini: true, disabled: !!busy || !(snap.settings.milvus && snap.settings.milvus.uri), title: '删掉整个 collection；本地库不动，重新同步会自动重建' }, doDrop))),

        detail ? el('section', { className: 'rtm-card' },
          el('div', { className: 'rtm-card-h' },
            el('span', { className: 'rtm-card-t' }, detail.title || '(无标题)'),
            el('span', { className: 'rtm-card-s' }, (detail.kind || '') + ' · ' + (detail.source || '—') + ' · ' + fmtTime(detail.created_at)),
            el('span', { className: 'rtm-sp' }),
            btn('关闭', { mini: true }, function () { setDetail(null) })),
          el('pre', { className: 'rtm-pre' }, detail.text)) : null)
    }

    function searchTab() {
      return el('div', { className: 'rtm-body' },
        el('div', { className: 'rtm-tools' },
          el('input', {
            className: 'rtm-in rtm-grow', value: query, placeholder: '例如：间接提示词注入怎么验证',
            onChange: function (e) { setQuery(e.target.value) }, onKeyDown: function (e) { if (e.key === 'Enter') doSearch() },
          }),
          el('label', { className: 'rtm-f rtm-f-row' }, el('span', { className: 'rtm-f-l' }, 'topK'),
            el('input', { className: 'rtm-in rtm-in-xs', type: 'number', value: topK, onChange: function (e) { setTopK(Number(e.target.value)) } })),
          el('label', { className: 'rtm-f rtm-f-row' },
            el('input', { type: 'checkbox', checked: useRerank, onChange: function (e) { setUseRerank(e.target.checked) } }),
            el('span', null, '用重排')),
          btn('检索', { primary: true, disabled: !!busy }, doSearch)),

        hits ? (hits.ok !== true
          ? el('div', { className: 'rtm-err' }, hits.error || '检索失败')
          : el('div', { className: 'rtm-body' },
            el('div', { className: 'rtm-row' },
              el('span', { className: 'rtm-card-t' }, '命中 ' + hits.hits.length + ' 条'),
              badge(hits.mode === 'vector' ? '向量检索' : (hits.mode === 'hybrid' ? '向量 + 本地关键词' : '本地关键词'), hits.mode === 'local' ? 'warn' : 'brand'),
              hits.reranked ? badge('已重排', 'ok') : null),
            hits.vectorError ? el('div', { className: 'rtm-warn' }, '向量检索失败，已退回本地：' + hits.vectorError) : null,
            hits.hits.map(function (h, i) {
              return el('div', { key: i, className: 'rtm-hit' },
                el('div', { className: 'rtm-row' },
                  el('span', { className: 'rtm-hit-t' }, h.title),
                  badge(h.mode === 'vector' ? '召回 ' + Number(h.score).toFixed(3) : '本地 ' + Number(h.score).toFixed(0), h.mode === 'vector' ? 'brand' : 'warn'),
                  h.rerankScore !== null ? badge('重排 ' + Number(h.rerankScore).toFixed(3), 'ok') : null,
                  h.indexed ? null : badge('仅本地')),
                el('div', { className: 'rtm-hit-b' }, h.text))
            })))
          : card('这里做什么', null, el('div', { className: 'rtm-hint' },
            '填一句话点「检索」，看到的就是模型调用 memory_search 时拿到的内容。没配向量模型时走本地关键词检索（标题×3 / 标签×2 / 正文×1）。')))
    }

    function logTab() {
      return el('div', { className: 'rtm-body' },
        el('div', { className: 'rtm-tools' },
          btn('刷新', { disabled: !!busy }, refresh),
          btn('清空日志', { disabled: !!busy }, function () { call('logClear', {}, '清空日志') })),
        el('div', { className: 'rtm-logs' }, (snap.log || []).slice().reverse().map(function (l) {
          return el('div', { key: l.seq, className: 'rtm-ln rtm-ln-' + (l.level || 'info') },
            el('span', { className: 'rtm-lt' }, fmtTime(l.at)),
            el('span', { className: 'rtm-ll' }, l.level || ''),
            el('span', { className: 'rtm-lx' }, l.text))
        })))
    }

    return el('div', { className: 'rtm-root' },
      head(),
      error ? el('div', { className: 'rtm-errbar' }, el('span', null, error), el('button', { className: 'rtm-x', onClick: function () { setError(null) } }, '×')) : null,
      toast ? el('div', { className: 'rtm-ok' }, toast) : null,
      st && st.persistence === 'memory' ? el('div', { className: 'rtm-warn' }, 'fs 服务不可用：设置与条目只存在内存里，重启会丢') : null,
      st && st.lastError && st.persistence === 'error' ? el('div', { className: 'rtm-warn' }, st.lastError) : null,
      el('div', { className: 'rtm-tabs' }, tabs.map(function (t) {
        return el('button', { key: t[0], className: 'rtm-tab' + (tab === t[0] ? ' rtm-tab-on' : ''), onClick: function () { setTab(t[0]) } }, t[1])
      })),
      !snap ? el('div', { className: 'rtm-body rtm-dim' }, busy === 'load' ? '加载中…' : '正在读取本地库…') : null,
      snap && tab === 'kb' ? kbTab() : null,
      snap && tab === 'search' ? searchTab() : null,
      snap && tab === 'log' ? logTab() : null
    )
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 红队设置（DSH 设置里的一页）
  // ══════════════════════════════════════════════════════════════════════════
  function UnifiedSettingsPage() {
    const [Report, setReport] = React.useState(function () { return settingsHub.current() })
    React.useEffect(function () {
      return settingsHub.subscribe(function () { setReport(function () { return settingsHub.current() }) })
    }, [])
    return el('div', { className: 'rtm-body' },
      el(SettingsPage),
      Report ? el(Report) : el('div', { className: 'rtm-set' }, '报告设置尚未加载；启用红队报告插件后将在此显示。'))
  }

  function SettingsPage() {
    const [snap, setSnap] = React.useState(null)
    const [draft, setDraft] = React.useState(null)
    const [busy, setBusy] = React.useState('')
    const [error, setError] = React.useState(null)
    const [toast, setToast] = React.useState('')
    const [tests, setTests] = React.useState({})
    const [s3objs, setS3objs] = React.useState(null)

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

    React.useEffect(function () { refresh() }, [])

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

    function test(kind, method) {
      setBusy(method)
      setToast('')
      host.call(method, {})
        .then(function (r) {
          setTests(function (t) { const n = Object.assign({}, t); n[kind] = r || { ok: false, error: '无响应' }; return n })
          if (r && r.ok === true) { setError(null); setToast(kind + '连通') } else { setError((r && r.error) || (kind + '测试失败')) }
        })
        .catch(function (e) {
          setTests(function (t) { const n = Object.assign({}, t); n[kind] = { ok: false, error: reportError(e) }; return n })
          setError(reportError(e))
        })
        .then(function () { setBusy('') })
    }

    function testLine(kind) {
      const t = tests[kind]
      if (!t) return null
      if (t.ok === true) {
        const extra = kind === 'Milvus'
          ? ('collection ' + (t.exists ? '存在，' + t.rowCount + ' 行' : '尚未创建') + '，共 ' + ((t.collections || []).length) + ' 个，' + t.ms + 'ms')
          : kind === '向量模型' ? ('维度 ' + t.dimension + '，' + t.ms + 'ms')
            : kind === '重排模型' ? ('返回 ' + ((t.order || []).length) + ' 条排序，' + t.ms + 'ms')
              : ('桶 ' + t.bucket + ' 可列举')
        return el('div', { className: 'rtm-ok' }, '✓ ' + kind + '：' + extra)
      }
      return el('div', { className: 'rtm-err' }, '✗ ' + kind + '：' + (t.error || '失败'))
    }

    const st = snap ? snap.status : null
    const fields = snap && draft ? fieldSpecs(snap, draft) : []
    const group = function (g) { return fields.filter(function (f) { return f.g === g }).map(function (f) { return renderField0(f, draft, setDraft, snap) }) }

    return el('div', { className: 'rtm-set' },
      el('div', { className: 'rtm-head' },
        el('span', { className: 'rtm-brand' }, '记忆与向量存储'),
        st ? el('span', { className: 'rtm-stat' },
          '本地 ' + (st.localCount || 0) + ' 条 · 索引 ' + (st.indexed || 0) + ' 条' + (st.pending ? '（待同步 ' + st.pending + '）' : '')) : null,
        el('span', { className: 'rtm-sp' }),
        btn('保存记忆设置', { primary: true, disabled: !!busy }, function () { call('saveSettings', draft, '保存记忆设置') })),

      error ? el('div', { className: 'rtm-errbar' }, el('span', null, error), el('button', { className: 'rtm-x', onClick: function () { setError(null) } }, '×')) : null,
      toast ? el('div', { className: 'rtm-ok' }, toast) : null,

      !draft ? el('div', { className: 'rtm-dim' }, '加载中…') : el('div', null,
        el('div', { className: 'rtm-hint' }, '只有想用「向量检索」时才需要 Milvus 与向量模型；不配也能记、也能按关键词查，配好后点「同步索引」把已有条目补进索引。'),
        el('div', { className: 'rtm-row' },
          btn('测试 Milvus', { disabled: !!busy }, function () { test('Milvus', 'testMilvus') }),
          btn('测试向量模型', { disabled: !!busy }, function () { test('向量模型', 'testEmbed') }),
          btn('测试重排', { disabled: !!busy }, function () { test('重排模型', 'testRerank') }),
          btn('测试 MinIO', { disabled: !!busy }, function () { test('MinIO', 'testS3') }),
          el('span', { className: 'rtm-sp' }),
          btn('同步索引' + (st && st.pending ? '（' + st.pending + '）' : ''), { disabled: !!busy || !(st && st.pending > 0) }, function () { call('syncIndex', { all: false }, '同步索引') }),
          btn('整库重建索引', { disabled: !!busy, title: '把本地全部条目重新写一遍索引（换过向量模型或维度后用它）' }, function () { call('syncIndex', { all: true }, '整库重建索引') })),
        testLine('Milvus'), testLine('向量模型'), testLine('重排模型'), testLine('MinIO'),

        el('div', { className: 'rtm-grid' },
          card('Milvus', '向量库', group('milvus')),
          card('向量模型', 'Embedding', group('embed')),
          card('重排模型', '可选', group('rerank')),
          card('MinIO', 'Milvus 的存储桶', group('s3')),
          card('本地库', '权威数据', groupTop(fields, draft, setDraft, snap),
            el('div', { className: 'rtm-row' },
              btn('删除向量索引', { danger: true, mini: true, disabled: !!busy || !(draft.milvus && draft.milvus.uri), title: '删掉整个 collection；本地库不动' }, function () { call('dropCollection', {}, '删除向量索引') }),
              btn('列举 MinIO 对象', { mini: true, disabled: !!busy }, function () {
                setBusy('s3')
                host.call('s3List', jsonArgs({ prefix: (draft.s3.prefix) || '', limit: 30 }))
                  .then(function (r) { if (r && r.ok === true) { setS3objs(r); setError(null) } else setError((r && r.error) || 'MinIO 列举失败') })
                  .catch(function (e) { setError(reportError(e)) })
                  .then(function () { setBusy('') })
              }),
              btn('导出到 MinIO', { mini: true, disabled: !!busy, title: '把整个知识库导出成 JSON 放进 MinIO 桶（导出源是本地库）' }, function () { call('s3Backup', {}, '导出到 MinIO') }))),

        s3objs ? card('s3://' + s3objs.bucket, s3objs.objects.length + ' 个对象' + (s3objs.truncated ? '（已截断）' : ''),
          el('table', { className: 'rtm-tbl' },
            el('thead', null, el('tr', null, el('th', null, 'Key'), el('th', null, '大小'), el('th', null, '修改时间'))),
            el('tbody', null, s3objs.objects.map(function (o, i) {
              return el('tr', { key: i }, el('td', null, o.key), el('td', null, fmtSize(o.size)), el('td', { className: 'rtm-hint' }, o.lastModified))
            })))) : null))
    )
  }

  // 顶层字段（本地库文件 / 默认返回条数）与分组字段拆开，卡片里才排得整齐。
  function groupTop(fields, draft, setDraft, snap) {
    return fields.filter(function (f) { return f.top === true }).map(function (f) { return renderField0(f, draft, setDraft, snap) })
  }

  // 真正渲染一个字段：provider 联动需要看预设，所以这里把 snap 一起带上。
  function renderField0(f, draft, setDraft, snap) {
    const cur = f.top ? (draft ? draft[f.k] : '') : (draft ? draft[f.g][f.k] : '')
    function onChange(v) {
      setDraft(function (d) {
        const n = JSON.parse(JSON.stringify(d))
        if (f.top) { n[f.k] = v; return n }
        n[f.g][f.k] = v
        // 换服务商时把模型与接口地址一起重置：避免「智谱的服务 + 阿里的模型」这种自相矛盾的组合
        if (f.k === 'provider') {
          const groups = f.g === 'embed' ? ((snap && snap.embedPresets) || []) : ((snap && snap.rerankPresets) || [])
          const p = groups.filter(function (x) { return x.id === v })[0]
          if (p) {
            const first = p.models && p.models[0]
            n[f.g].model = first ? (first.id || first) : ''
            n[f.g].baseUrl = ''
            if (f.g === 'embed' && first && first.dimension) n.embed.dimension = first.dimension
          }
        }
        if (f.k === 'model' && f.g === 'embed') {
          const p = ((snap && snap.embedPresets) || []).filter(function (x) { return x.id === n.embed.provider })[0]
          const mm = p && p.models ? p.models.filter(function (x) { return x.id === v })[0] : null
          if (mm && mm.dimension) n.embed.dimension = mm.dimension
        }
        return n
      })
    }
    return renderFieldNode(f, cur, onChange)
  }

  // ── 侧边栏图标：书脊 + 搜索结果点 ────────────────────────────────────────────
  function Glyph(props) {
    const size = props && props.size ? props.size : 16
    const active = props && props.active
    const c = active ? 'var(--dsw-alias-brand-primary)' : 'currentColor'
    return React.createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' },
      React.createElement('path', { d: 'M5 4.5h6.2c1.6 0 2.8 1.2 2.8 2.8v12.2H7.8C6.2 19.5 5 18.3 5 16.7z', stroke: c, strokeWidth: 1.6, strokeLinejoin: 'round' }),
      React.createElement('path', { d: 'M19 6.5v13H13.9', stroke: c, strokeWidth: 1.6, strokeLinecap: 'round' }),
      React.createElement('circle', { cx: 15.4, cy: 10.2, r: 2.4, stroke: c, strokeWidth: 1.4 }),
      React.createElement('path', { d: 'M17.2 12l2.4 2.4', stroke: c, strokeWidth: 1.4, strokeLinecap: 'round' })
    )
  }

  // ── 样式：全部走主题 token ──────────────────────────────────────────────────
  ctx.effect(function () {
    return styles.insert([
      '.rtm-root{padding:14px 16px;display:flex;flex-direction:column;gap:12px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.rtm-set{padding:16px 18px;display:flex;flex-direction:column;gap:12px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.rtm-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.rtm-brand{font-size:14px;font-weight:600;letter-spacing:.2px}',
      '.rtm-brand-c{color:var(--dsw-alias-brand-primary)}',
      '.rtm-stat{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.rtm-sp{flex:1 1 auto}',
      '.rtm-dim{color:var(--dsw-alias-label-secondary)}',
      '.rtm-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.rtm-err{color:var(--dsw-alias-state-error-primary);font-size:12px}',
      '.rtm-ok{color:var(--dsw-alias-state-success-primary);font-size:12px}',
      '.rtm-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px}',
      '.rtm-errbar{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;color:var(--dsw-alias-state-error-primary);font-size:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px}',
      '.rtm-x{background:transparent;border:none;color:inherit;font-size:16px;line-height:1;cursor:pointer;padding:0 4px}',

      '.rtm-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.rtm-tab{background:transparent;border:none;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);padding:6px 12px;font-size:12.5px;cursor:pointer;font-family:inherit}',
      '.rtm-tab:hover{color:var(--dsw-alias-label-primary)}',
      '.rtm-tab-on{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.rtm-body{display:flex;flex-direction:column;gap:12px}',

      '.rtm-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.rtm-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
      '.rtm-card-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.rtm-card-t{font-size:12.5px;font-weight:600}',
      '.rtm-card-s{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.rtm-card-b{display:flex;flex-direction:column;gap:8px}',

      '.rtm-btn{height:26px;padding:0 10px;border-radius:7px;font-size:12px;font-family:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.rtm-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}',
      '.rtm-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.rtm-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}',
      '.rtm-btn-primary:hover:not(:disabled){filter:brightness(1.06)}',
      '.rtm-btn-danger{color:var(--dsw-alias-state-error-primary)}',
      '.rtm-btn-mini{height:22px;padding:0 8px;font-size:11.5px}',

      '.rtm-in{height:26px;box-sizing:border-box;width:100%;padding:0 8px;border-radius:7px;font-size:12px;font-family:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1)}',
      '.rtm-in:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.rtm-in-xs{width:64px;flex:0 0 auto}',
      '.rtm-grow{flex:1 1 240px;min-width:160px;width:auto}',
      '.rtm-ta{min-height:64px;box-sizing:border-box;width:100%;padding:7px 8px;border-radius:7px;font-size:12px;font-family:ui-monospace,monospace;line-height:1.55;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);resize:vertical}',
      '.rtm-ta:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',

      '.rtm-badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:5px;font-size:11px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.rtm-badge-ok{color:var(--dsw-alias-state-success-primary)}',
      '.rtm-badge-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.rtm-badge-err{color:var(--dsw-alias-state-error-primary)}',
      '.rtm-badge-brand{color:var(--dsw-alias-brand-primary)}',

      '.rtm-tbl{width:100%;border-collapse:collapse;font-size:12px}',
      '.rtm-tbl th{text-align:left;font-weight:500;font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.rtm-tbl td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}',
      '.rtm-tbl tbody tr:hover td{background:var(--dsw-alias-bg-layer-2)}',
      '.rtm-tbl tbody tr:last-child td{border-bottom:none}',
      '.rtm-th-x{width:28px}',
      '.rtm-tr-on td{background:var(--dsw-alias-bg-layer-2)}',
      '.rtm-lnk{color:var(--dsw-alias-brand-primary);cursor:pointer;text-decoration:none}',
      '.rtm-lnk:hover{text-decoration:underline}',
      '.rtm-tagc{color:var(--dsw-alias-label-secondary);font-size:11.5px}',
      '.rtm-pager{display:flex;align-items:center;gap:10px;padding:6px 0}',

      '.rtm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px;align-items:start}',
      '.rtm-f{display:flex;flex-direction:column;gap:4px}',
      '.rtm-f-row{flex-direction:row;align-items:center;gap:6px}',
      '.rtm-f-l{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.rtm-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',

      '.rtm-hit{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-brand-primary);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:5px;background:var(--dsw-alias-bg-layer-1)}',
      '.rtm-hit-t{font-weight:600;font-size:12.5px}',
      '.rtm-hit-b{font-size:12px;line-height:1.55;white-space:pre-wrap}',
      '.rtm-pre{white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.6;max-height:44vh;overflow:auto;margin:0;font-family:inherit}',

      '.rtm-caps{display:flex;flex-direction:column;gap:4px}',
      '.rtm-cap-i{display:flex;gap:8px;align-items:baseline;font-size:11.5px}',
      '.rtm-cap-x{flex:1 1 auto;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

      '.rtm-logs{display:flex;flex-direction:column;gap:2px;font-size:11.5px;max-height:60vh;overflow:auto}',
      '.rtm-ln{display:flex;gap:8px;align-items:baseline}',
      '.rtm-lt{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,monospace}',
      '.rtm-ll{flex:0 0 auto;min-width:34px;color:var(--dsw-alias-label-secondary)}',
      '.rtm-lx{white-space:pre-wrap;word-break:break-word}',
      '.rtm-ln-err .rtm-lx{color:var(--dsw-alias-state-error-primary)}',
      '.rtm-ln-warn .rtm-lx{color:var(--dsw-alias-state-warn-primary)}',
      '.rtm-ln-ok .rtm-lx{color:var(--dsw-alias-state-success-primary)}',
    ].join('\n'))
  }, 'redteam-memory: styles')

  ctx.effect(function () {
    return slots.inject('sidebar.panellist', function () {
      return slots.register({ name: 'sidebar.panellist', id: PANEL_KEY, order: 70, label: '红队记忆' }, Glyph)
    })
  }, 'redteam-memory: panel button')

  ctx.effect(function () {
    return slots.inject('main', function () {
      return slots.register({ name: 'main', key: PANEL_KEY }, MemoryPanel)
    })
  }, 'redteam-memory: main panel')

  // 配置进 DSH 设置里的一页，而不是占着数据面板的 tab。
  ctx.effect(function () {
    return slots.inject('settings.section', function () {
      return slots.register({ name: 'settings.section', id: SETTINGS_KEY, order: 100, label: '红队设置' }, UnifiedSettingsPage)
    })
  }, 'redteam-memory: 设置页')

  console.log('[rtmemory] redteam-memory client half ready; panels =', PANEL_KEY, '+ 设置页 红队设置')
}
    exports.inject = ['slots', 'timer']
    exports.apply = function (ctx) { return applyClient(ctx) }
    return module.exports
  }
});
