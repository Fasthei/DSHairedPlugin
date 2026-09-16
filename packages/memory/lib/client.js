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
// ── 界面结构 ──────────────────────────────────────────────────────────────────
// ┌ 顶栏：标题 + 状态（collection / 维度 / 条数 / 落盘）+ 进度
// ├ 标签页：知识库 / 检索 / 连接 / 日志
// ├ 知识库：关键词 · 刷新 · 导入内置知识包 · 粘贴导入 · 从文件导入 · 删除选中 · 删除 collection
// │        列表（勾选 / 标题 / 类型 / 标签 / 来源 / 时间）→ 点标题看全文
// ├ 检索：query + topK + 是否重排 → 命中列表（同时显示召回分与重排分）
// ├ 连接：Milvus / 向量模型 / 重排模型 / S3 四组配置，各自可单独测连通、可列举桶、可整库导出
// └ 日志：最近操作与错误（含向量化/写入进度）

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

  const PANEL_KEY = 'redteam-memory'
  const PAGE = 50

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
      { g: 'milvus', k: 'uri', label: 'Milvus 地址', ph: 'http://127.0.0.1:19530 / https://xxx.api.region.zillizcloud.com' },
      { g: 'milvus', k: 'token', label: 'Milvus Token', ph: 'Zilliz 云必填；自建一般留空', secret: true },
      { g: 'milvus', k: 'dbName', label: '数据库', ph: 'default' },
      { g: 'milvus', k: 'collection', label: 'Collection', ph: 'redteam_memory' },
      { g: 'milvus', k: 'metric', label: '距离度量', options: ['COSINE', 'L2', 'IP'] },
      { g: 'embed', k: 'provider', label: '向量服务', options: embed.map(function (x) { return { v: x.id, t: x.label } }) },
      { g: 'embed', k: 'model', label: '向量模型', options: embedCur.map(function (m) { return { v: m.id, t: m.id + '（' + m.dimension + ' 维）' } }), free: true },
      { g: 'embed', k: 'dimension', label: '向量维度', num: true, ph: '与模型匹配，例如 1024' },
      { g: 'embed', k: 'apiKey', label: '向量 API Key', secret: true },
      { g: 'embed', k: 'baseUrl', label: '自定义接口地址', ph: '留空用官方默认' },

      { g: 'rerank', k: 'enabled', label: '启用重排', bool: true },
      { g: 'rerank', k: 'provider', label: '重排服务', options: rerank.map(function (x) { return { v: x.id, t: x.label } }) },
      { g: 'rerank', k: 'model', label: '重排模型', options: rerankCur.map(function (m) { return { v: m, t: m } }), free: true },
      { g: 'rerank', k: 'topN', label: '重排保留条数', num: true },
      { g: 'rerank', k: 'apiKey', label: '重排 API Key', secret: true },
      { g: 'rerank', k: 'baseUrl', label: '自定义接口地址', ph: '留空用官方默认' },

      { g: 's3', k: 'enabled', label: '关联 S3（Milvus 存储桶）', bool: true },
      { g: 's3', k: 'endpoint', label: 'S3 端点', ph: 'https://s3.amazonaws.com / http://minio:9000' },
      { g: 's3', k: 'bucket', label: '桶名', ph: 'mimo' },
      { g: 's3', k: 'region', label: 'Region', ph: 'us-east-1' },
      { g: 's3', k: 'prefix', label: '前缀（可选）', ph: '' },
      { g: 's3', k: 'accessKey', label: 'Access Key', secret: true },
      { g: 's3', k: 'secretKey', label: 'Secret Key', secret: true },
      { g: 's3', k: 'pathStyle', label: 'path-style 寻址', bool: true, hint: 'MinIO / 自建一般要开；AWS 关掉' },

      // top: true 表示这是 settings 的顶层字段（不挂在任何分组下）
      { top: true, k: 'storePath', label: '存储文件', ph: '.redteam-memory.json', hint: '相对名由宿主解析；写不进去时就改成能写的绝对路径' },
      { top: true, k: 'searchTopK', label: '默认返回条数', num: true, hint: 'memory_search 不传 topK 时用它' },
    ]
  }

  function Panel() {
    const [snap, setSnap] = React.useState(null)
    const [tab, setTab] = React.useState('kb')
    const [busy, setBusy] = React.useState('')
    const [error, setError] = React.useState(null)
    const [toast, setToast] = React.useState('')
    const [draft, setDraft] = React.useState(null)
    const [list, setList] = React.useState({ entries: [], total: 0, offset: 0 })
    const [keyword, setKeyword] = React.useState('')
    const [selected, setSelected] = React.useState([])
    const [detail, setDetail] = React.useState(null)
    const [pasteText, setPasteText] = React.useState('')
    const [pasteTitle, setPasteTitle] = React.useState('')
    const [pasteKind, setPasteKind] = React.useState('knowledge')
    const [pasteTags, setPasteTags] = React.useState('')
    const [filePath, setFilePath] = React.useState('')
    const [query, setQuery] = React.useState('')
    const [topK, setTopK] = React.useState(8)
    const [useRerank, setUseRerank] = React.useState(true)
    const [hits, setHits] = React.useState(null)
    const [tests, setTests] = React.useState({})
    const [s3objs, setS3objs] = React.useState(null)
    const [capTest, setCapTest] = React.useState('')
    const [capInfo, setCapInfo] = React.useState(null)

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

    // 面板自己刷新：导入/向量化可能耗时，状态与进度得能自己走
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
      return host.call('listKnowledge', jsonArgs({ keyword: keyword.trim(), limit: PAGE, offset: off }))
        .then(function (r) {
          if (!r || r.ok !== true) { setError((r && r.error) || '读取列表失败'); return }
          setError(null)
          setList({ entries: r.entries || [], total: r.total || 0, offset: off })
        })
        .catch(function (e) { setError(reportError(e)) })
        .then(function () { setBusy('') })
    }

    React.useEffect(function () {
      // 依赖必须带上本地条数：snapshot 是挂载之后才到的，只依赖 tab 的话这个效果
      // 永远不会重跑 —— 首屏列表就一直是空的（真实浏览器里也一样）。
      // 而条数变化恰好是「刚捕获 / 刚导入」的信号，列表因此能自己刷新。
      if (tab === 'kb' && snap) loadList(0)
    }, [tab, snap && snap.status && snap.status.localCount])

    function saveSettings() { call('saveSettings', draft, '保存设置') }

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

    function doAdd() {
      if (!pasteText.trim()) { setError('先粘贴要导入的内容'); return }
      call('addKnowledge', { text: pasteText, title: pasteTitle, kind: pasteKind, tags: pasteTags, source: 'panel' }, '导入')
        .then(function (r) { if (r && r.ok === true) { setPasteText(''); setPasteTitle(''); loadList(0) } })
    }

    function doImportFile() {
      if (!filePath.trim()) { setError('先填文件路径（相对路径按 $HOME 解析，建议绝对路径）'); return }
      call('importFile', { path: filePath.trim() }, '文件导入')
        .then(function (r) { if (r && r.ok === true) { setFilePath(''); loadList(0) } })
    }

    function doSeed() {
      call('seed', {}, '导入内置知识包').then(function (r) { if (r && r.ok === true) loadList(0) })
    }

    function doRemove() {
      if (!selected.length) { setError('先勾选要删除的条目'); return }
      call('removeKnowledge', { ids: selected }, '删除 ' + selected.length + ' 条').then(function (r) {
        if (r && r.ok === true) { setSelected([]); setDetail(null); loadList(list.offset) }
      })
    }

    function doDrop() {
      call('dropCollection', {}, '删除 collection').then(function (r) {
        if (r && r.ok === true) { setSelected([]); setDetail(null); setList({ entries: [], total: 0, offset: 0 }) }
      })
    }

    function doS3List() {
      setBusy('s3')
      host.call('s3List', jsonArgs({ prefix: (draft && draft.s3.prefix) || '', limit: 30 }))
        .then(function (r) {
          if (!r || r.ok !== true) { setError((r && r.error) || 'S3 列举失败'); setS3objs(null); return }
          setError(null)
          setS3objs(r)
        })
        .catch(function (e) { setError(reportError(e)) })
        .then(function () { setBusy('') })
    }

    // 快照可能来自还没写进 capture 这一组的旧存储，读它一律走这里，缺字段用默认值补齐。
    function capOf(d) {
      return (d && d.capture) || { enabled: true, phrases: '', kind: 'note', withContext: true }
    }

    function setCaptureField(k, v) {      setDraft(function (d) {
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

    function doSyncIndex(all) {
      call('syncIndex', { all: all === true }, all === true ? '整库重建索引' : '同步索引').then(function (r) {
        if (r && r.ok === true) setToast((r.entries || 0) + ' 条本地条目 -> ' + (r.synced || 0) + ' 行索引')
      })
    }

    function renderField(f) {
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
      if (f.bool) {
        return el('label', { key: f.g + f.k, className: 'rtm-f rtm-fb' },
          el('input', { type: 'checkbox', checked: cur === true, onChange: function (e) { onChange(e.target.checked) } }),
          el('span', null, f.label),
          f.hint ? el('span', { className: 'rtm-hint' }, f.hint) : null)
      }
      if (f.options) {
        const opts = f.options.map(function (o) { return typeof o === 'string' ? { v: o, t: o } : o })
        const known = opts.some(function (o) { return o.v === cur })
        return el('label', { key: f.g + f.k, className: 'rtm-f' },
          el('span', { className: 'rtm-fl' }, f.label),
          el('select', { className: 'rtm-in', value: known ? cur : '__custom__', onChange: function (e) { if (e.target.value !== '__custom__') onChange(e.target.value) } },
            opts.map(function (o) { return el('option', { key: o.v, value: o.v }, o.t) }),
            f.free ? el('option', { value: '__custom__' }, '（自定义，用下面的输入框）') : null),
          f.free ? el('input', { className: 'rtm-in', value: cur || '', placeholder: f.ph || '', onChange: function (e) { onChange(e.target.value) } }) : null)
      }
      return el('label', { key: f.g + f.k, className: 'rtm-f' },
        el('span', { className: 'rtm-fl' }, f.label),
        el('input', {
          className: 'rtm-in',
          type: f.secret ? 'password' : (f.num ? 'number' : 'text'),
          value: cur === undefined || cur === null ? '' : String(cur),
          placeholder: f.ph || '',
          onChange: function (e) { onChange(f.num ? Number(e.target.value) : e.target.value) },
        }))
    }

    function renderTest(kind) {
      const t = tests[kind]
      if (!t) return null
      if (t.ok === true) {
        const extra = kind === 'Milvus'
          ? ('collection ' + (t.exists ? '存在，' + t.rowCount + ' 行' : '尚未创建') + '，共 ' + ((t.collections || []).length) + ' 个，耗时 ' + t.ms + 'ms')
          : kind === '向量模型' ? ('维度 ' + t.dimension + '，耗时 ' + t.ms + 'ms')
            : kind === '重排模型' ? ('返回 ' + ((t.order || []).length) + ' 条排序，耗时 ' + t.ms + 'ms')
              : ('桶 ' + t.bucket + ' 可列举')
        return el('div', { className: 'rtm-ok' }, '✓ ' + kind + '：' + extra)
      }
      return el('div', { className: 'rtm-err' }, '✗ ' + kind + '：' + (t.error || '失败'))
    }

    const st = snap ? snap.status : null
    const tabs = [['kb', '知识库'], ['search', '检索'], ['conn', '连接'], ['log', '日志']]

    return el('div', { className: 'rtm-root' },
      el('div', { className: 'rtm-bar' },
        el('span', { className: 'rtm-brand' }, '红队记忆'),
        st ? el('span', { className: 'rtm-stat' },
          '本地 ' + (st.localCount || 0) + ' 条 · 索引 ' + (st.indexed || 0) + ' 条' + (st.pending ? '（待同步 ' + st.pending + '）' : '') +
          ' · 维度 ' + (st.dimension || '?') + ' · 落盘 ' + st.persistence) : null,
        st && st.progress ? el('span', { className: 'rtm-prog' }, st.progress.text) : null,
        el('span', { className: 'rtm-sp' }),
        el('button', { className: 'rtm-btn', disabled: !!busy, onClick: refresh }, busy === 'load' ? '刷新中…' : '刷新')),

      error ? el('div', { className: 'rtm-errbar' }, error, el('button', { className: 'rtm-x', onClick: function () { setError(null) } }, '×')) : null,
      toast ? el('div', { className: 'rtm-toast' }, toast) : null,
      st && st.persistence === 'memory' ? el('div', { className: 'rtm-warn' }, 'fs 服务不可用：设置与日志只存在内存里，重启会丢') : null,
      st && st.lastError && st.persistence === 'error' ? el('div', { className: 'rtm-warn' }, st.lastError) : null,

      el('div', { className: 'rtm-tabs' }, tabs.map(function (t) {
        return el('button', { key: t[0], className: 'rtm-tab' + (tab === t[0] ? ' rtm-tab-on' : ''), onClick: function () { setTab(t[0]) } }, t[1])
      })),

      // 首屏边界：snapshot 还没回来时 snap 是 null，下面每个分支都要先过这一关，
      // 否则第一个 render 就会因为读 snap.settings 抛错、整块面板白屏。
      !snap ? el('div', { className: 'rtm-body rtm-dim' }, busy === 'load' ? '加载中…' : '正在读取设置…') : null,

      tab === 'kb' && snap ? el('div', { className: 'rtm-body' },
        el('div', { className: 'rtm-tools' },
          el('input', { className: 'rtm-in rtm-in-sm', value: keyword, placeholder: '关键词（标题/正文/标签/来源）', onChange: function (e) { setKeyword(e.target.value) }, onKeyDown: function (e) { if (e.key === 'Enter') loadList(0) } }),
          el('button', { className: 'rtm-btn', disabled: !!busy, onClick: function () { loadList(0) } }, '查询'),
          el('button', { className: 'rtm-btn rtm-primary', disabled: !!busy, onClick: doSeed, title: '把内置的 AI 安全知识与进攻技巧导入知识库（先落本地库，不依赖向量模型）' }, '导入内置知识包'),
          el('span', { className: 'rtm-sp' }),
          el('button', {
            className: 'rtm-btn', disabled: !!busy || !(st && st.pending > 0), onClick: function () { doSyncIndex(false) },
            title: st && st.pending > 0 ? ('把本地还没进索引的 ' + st.pending + ' 条同步到 Milvus') : '本地条目都已进索引',
          }, '同步索引' + (st && st.pending > 0 ? '（' + st.pending + '）' : '')),
          el('button', { className: 'rtm-btn rtm-danger', disabled: !!busy || !selected.length, onClick: doRemove }, '删除选中' + (selected.length ? '（' + selected.length + '）' : '')),
          el('button', { className: 'rtm-btn rtm-danger', disabled: !!busy || !snap.settings.milvus.uri, onClick: doDrop, title: '删掉整个 collection（本地库不动，下次同步会自动重建）' }, '删除 collection')),

        // 对话捕获：工作区里有人说「写入记忆」就自动入库。放在列表上方，因为它是「看不见的写入」，
        // 得让人一眼看到它开着、触发词是什么、最近捕到了什么。
        el('div', { className: 'rtm-cap' },
          el('div', { className: 'rtm-cap-h' },
            el('span', { className: 'rtm-sec rtm-sec-in' }, '对话捕获'),
            el('label', { className: 'rtm-f rtm-fb' },
              el('input', { type: 'checkbox', checked: capOf(draft).enabled === true, onChange: function (e) { setCaptureField('enabled', e.target.checked) } }),
              el('span', null, '开启'),
              el('span', { className: 'rtm-hint' }, '工作区对话里出现触发词就自动写进记忆')),
            el('span', { className: 'rtm-sp' }),
            el('span', { className: 'rtm-hint' }, '最近捕获 ' + ((snap.captures || []).length) + ' 条')),
          el('div', { className: 'rtm-row' },
            el('input', { className: 'rtm-in rtm-in-sm rtm-flex', value: String(capOf(draft).phrases || ''), placeholder: '触发词，逗号分隔', onChange: function (e) { setCaptureField('phrases', e.target.value) } }),
            el('button', { className: 'rtm-btn', disabled: !!busy, onClick: function () { call('saveSettings', draft, '保存触发词') } }, '保存触发词')),
          el('div', { className: 'rtm-row' },
            el('input', { className: 'rtm-in rtm-in-sm rtm-flex', value: capTest, placeholder: '试一句，例如：这台机的指纹写入记忆', onChange: function (e) { setCapTest(e.target.value) }, onKeyDown: function (e) { if (e.key === 'Enter') doCaptureTest() } }),
            el('button', { className: 'rtm-btn', disabled: !!busy || !capTest.trim(), onClick: doCaptureTest }, '干跑'),
            el('button', { className: 'rtm-btn', disabled: !!busy || !capTest.trim(), onClick: doCaptureAdd, title: '不走会话事件，直接把这句话收进记忆' }, '直接入库')),
          capInfo ? el('div', { className: capInfo.matched === true ? 'rtm-ok' : 'rtm-warn' },
            capInfo.matched === true
              ? ('会捕获：触发词「' + capInfo.phrase + '」，入库内容 = ' + capInfo.text)
              : (capInfo.error || '不会捕获：没有一个触发词命中')) : null,
          (snap.captures || []).length
            ? el('div', { className: 'rtm-caps' }, snap.captures.slice(0, 6).map(function (c, i) {
              return el('div', { key: i, className: 'rtm-cap-i' },
                el('span', { className: 'rtm-lt' }, fmtTime(c.at)),
                el('span', { className: 'rtm-cap-tag' }, c.phrase || '人工'),
                el('span', { className: 'rtm-cap-x' }, c.text),
                el('span', { className: 'rtm-hint' }, c.error ? '索引未同步' : (c.indexed ? '已进索引' : '仅本地')))
            })) : null),

        el('div', { className: 'rtm-imports' },
          el('div', { className: 'rtm-imp' },
            el('div', { className: 'rtm-sec' }, '粘贴导入'),
            el('input', { className: 'rtm-in', value: pasteTitle, placeholder: '标题（可留空，取正文首行）', onChange: function (e) { setPasteTitle(e.target.value) } }),
            el('div', { className: 'rtm-row' },
              el('select', { className: 'rtm-in rtm-in-sm', value: pasteKind, onChange: function (e) { setPasteKind(e.target.value) } },
                (snap.kinds || []).map(function (k) { return el('option', { key: k, value: k }, k) })),
              el('input', { className: 'rtm-in rtm-in-sm', value: pasteTags, placeholder: '标签，逗号分隔', onChange: function (e) { setPasteTags(e.target.value) } })),
            el('textarea', { className: 'rtm-ta', value: pasteText, placeholder: '一段一个主题的知识正文…', onChange: function (e) { setPasteText(e.target.value) } }),
            el('button', { className: 'rtm-btn rtm-primary', disabled: !!busy, onClick: doAdd }, '导入')),
          el('div', { className: 'rtm-imp' },
            el('div', { className: 'rtm-sec' }, '从文件导入'),
            el('div', { className: 'rtm-hint' }, '.json（数组或 {entries:[…]}）/ .md / .txt（按 ## 标题切段）。路径建议用绝对路径。'),
            el('div', { className: 'rtm-row' },
              el('input', { className: 'rtm-in rtm-in-sm', value: filePath, placeholder: '/home/you/knowledge.md', onChange: function (e) { setFilePath(e.target.value) } }),
              el('button', { className: 'rtm-btn', disabled: !!busy, onClick: doImportFile }, '导入文件')))),

        el('div', { className: 'rtm-list' },
          (list.entries || []).length === 0
            ? el('div', { className: 'rtm-dim' }, keyword.trim() ? '没有匹配「' + keyword.trim() + '」的条目。' : '本地库还没有条目。可以「导入内置知识包」，或粘贴 / 从文件导入 —— 不需要先配向量模型。')
            : el('table', { className: 'rtm-tbl' },
              el('thead', null, el('tr', null,
                el('th', null, ''),
                el('th', null, '标题'),
                el('th', null, '类型'),
                el('th', null, '标签'),
                el('th', null, '来源'),
                el('th', null, '索引'),
                el('th', null, '创建时间'))),
              el('tbody', null, list.entries.map(function (e1) {
                return el('tr', { key: e1.id, className: selected.indexOf(e1.id) >= 0 ? 'rtm-tr-on' : '' },
                  el('td', null, el('input', { type: 'checkbox', checked: selected.indexOf(e1.id) >= 0, onChange: function () { toggle(e1.id) } })),
                  el('td', null, el('a', { className: 'rtm-lnk', onClick: function () { openEntry(e1.id) }, title: '查看全文' }, e1.title || '(无标题)')),
                  el('td', null, e1.kind || ''),
                  el('td', { className: 'rtm-tagc' }, e1.tags || ''),
                  el('td', { className: 'rtm-srcc', title: e1.source || '' }, e1.source || ''),
                  el('td', null, e1.indexed ? '✓' : el('span', { className: 'rtm-hint' }, '待同步')),
                  el('td', null, fmtTime(e1.created_at)))
              }))),
          list.total > PAGE ? el('div', { className: 'rtm-pager' },
            el('button', { className: 'rtm-btn rtm-mini', disabled: !!busy || list.offset <= 0, onClick: function () { loadList(Math.max(0, list.offset - PAGE)) } }, '上一页'),
            el('span', null, (list.offset + 1) + '–' + Math.min(list.offset + PAGE, list.total) + ' / 共 ' + list.total + '（本地库命中数）'),
            el('button', { className: 'rtm-btn rtm-mini', disabled: !!busy || list.offset + PAGE >= list.total, onClick: function () { loadList(list.offset + PAGE) } }, '下一页')) : null),

        detail ? el('div', { className: 'rtm-detail' },
          el('div', { className: 'rtm-detail-h' },
            el('div', null,
              el('div', { className: 'rtm-detail-t' }, detail.title),
              el('div', { className: 'rtm-hint' }, 'id ' + detail.id + ' · ' + (detail.kind || '') + ' · 来源 ' + (detail.source || '—') + ' · ' + fmtTime(detail.created_at))),
            el('button', { className: 'rtm-x', onClick: function () { setDetail(null) } }, '×')),
          el('pre', { className: 'rtm-pre' }, detail.text)) : null
      ) : null,

      tab === 'search' && snap ? el('div', { className: 'rtm-body' },
        el('div', { className: 'rtm-tools' },
          el('input', { className: 'rtm-in rtm-in-sm', value: query, placeholder: '例如：间接提示词注入怎么验证', onChange: function (e) { setQuery(e.target.value) }, onKeyDown: function (e) { if (e.key === 'Enter') doSearch() } }),
          el('label', { className: 'rtm-f rtm-fb' }, el('span', null, 'topK'), el('input', { className: 'rtm-in rtm-in-xs', type: 'number', value: topK, onChange: function (e) { setTopK(Number(e.target.value)) } })),
          el('label', { className: 'rtm-f rtm-fb' }, el('input', { type: 'checkbox', checked: useRerank, onChange: function (e) { setUseRerank(e.target.checked) } }), el('span', null, '用重排')),
          el('button', { className: 'rtm-btn rtm-primary', disabled: !!busy, onClick: doSearch }, busy === 'search' ? '检索中…' : '检索')),
        hits ? (hits.ok !== true
          ? el('div', { className: 'rtm-err' }, hits.error || '检索失败')
          : el('div', null,
            el('div', { className: 'rtm-sec' }, '命中 ' + hits.hits.length + ' 条 · ' +
              (hits.mode === 'vector' ? '向量检索' : (hits.mode === 'hybrid' ? '向量 + 本地关键词（索引可能落后）' : '本地关键词检索')) +
              (hits.reranked ? ' · 已重排' : (snap.settings.rerank.enabled ? ' · 重排未生效' : ' · 未启用重排'))),
            hits.vectorError ? el('div', { className: 'rtm-warn' }, '向量检索失败，已退回本地：' + hits.vectorError) : null,
            hits.hits.map(function (h, i) {
              return el('div', { key: i, className: 'rtm-hit' },
                el('div', { className: 'rtm-hit-h' },
                  el('span', { className: 'rtm-hit-t' }, h.title),
                  el('span', { className: 'rtm-hit-s' }, (h.mode === 'vector' ? '召回 ' : '本地 ') + Number(h.score).toFixed(3) + (h.rerankScore !== null ? ' · 重排 ' + Number(h.rerankScore).toFixed(3) : '') + (h.indexed ? '' : ' · 未进索引')),
                  el('span', { className: 'rtm-hint' }, h.id)),
                el('div', { className: 'rtm-hit-b' }, h.text))
            }))) : el('div', { className: 'rtm-dim' }, '填检索内容后点「检索」。这里展示的正是模型调用 memory_search 时拿到的内容；没配向量模型时走本地关键词检索。')) : null,

      tab === 'conn' ? el('div', { className: 'rtm-body' },
        !draft ? el('div', { className: 'rtm-dim' }, '加载中…') : el('div', null,
          el('div', { className: 'rtm-tools' },
            el('button', { className: 'rtm-btn rtm-primary', disabled: !!busy, onClick: saveSettings }, '保存设置'),
            el('button', { className: 'rtm-btn', disabled: !!busy, onClick: function () { test('Milvus', 'testMilvus') } }, '测试 Milvus'),
            el('button', { className: 'rtm-btn', disabled: !!busy, onClick: function () { test('向量模型', 'testEmbed') } }, '测试向量模型'),
            el('button', { className: 'rtm-btn', disabled: !!busy, onClick: function () { test('重排模型', 'testRerank') } }, '测试重排'),
            el('button', { className: 'rtm-btn', disabled: !!busy, onClick: function () { test('S3', 'testS3') } }, '测试 S3'),
            el('span', { className: 'rtm-sp' }),
            el('button', { className: 'rtm-btn', disabled: !!busy, onClick: function () { doSyncIndex(true) }, title: '把本地全部条目重新写一遍索引（换过向量模型或维度后用它）' }, '整库重建索引'),
            el('button', { className: 'rtm-btn', disabled: !!busy, onClick: doS3List }, '列举 S3 对象'),
            el('button', { className: 'rtm-btn', disabled: !!busy, onClick: function () { call('s3Backup', {}, '导出到 S3') }, title: '把整个知识库导出成 JSON 放进 S3 桶（导出源是本地库）' }, '导出到 S3')),

          renderTest('Milvus'), renderTest('向量模型'), renderTest('重排模型'), renderTest('S3'),

          el('div', { className: 'rtm-grid' },
            el('div', { className: 'rtm-grp' }, el('div', { className: 'rtm-sec' }, 'Milvus'), fieldSpecs(snap, draft).filter(function (f) { return f.g === 'milvus' }).map(renderField)),
            el('div', { className: 'rtm-grp' }, el('div', { className: 'rtm-sec' }, '向量模型'), fieldSpecs(snap, draft).filter(function (f) { return f.g === 'embed' }).map(renderField)),
            el('div', { className: 'rtm-grp' }, el('div', { className: 'rtm-sec' }, '重排模型'), fieldSpecs(snap, draft).filter(function (f) { return f.g === 'rerank' }).map(renderField)),
            el('div', { className: 'rtm-grp' }, el('div', { className: 'rtm-sec' }, 'S3（Milvus 存储桶）'), fieldSpecs(snap, draft).filter(function (f) { return f.g === 's3' }).map(renderField)),
            el('div', { className: 'rtm-grp' }, el('div', { className: 'rtm-sec' }, '本地库（权威数据）'), fieldSpecs(snap, draft).filter(function (f) { return f.top === true }).map(renderField))),

          s3objs ? el('div', null,
            el('div', { className: 'rtm-sec' }, 's3://' + s3objs.bucket + ' 的对象（' + s3objs.objects.length + ' 个' + (s3objs.truncated ? '，已截断' : '') + '）'),
            el('table', { className: 'rtm-tbl' },
              el('thead', null, el('tr', null, el('th', null, 'Key'), el('th', null, '大小'), el('th', null, '修改时间'))),
              el('tbody', null, s3objs.objects.map(function (o, i) {
                return el('tr', { key: i }, el('td', null, o.key), el('td', null, fmtSize(o.size)), el('td', null, o.lastModified))
              })))) : null,

          el('div', { className: 'rtm-hint' }, '本地库文件（含 API Key，已在 .gitignore 里）：' + (st && st.storePath ? st.storePath : '（还没解析出来）')),
          el('div', { className: 'rtm-hint' }, '相对路径由宿主按插件自己的工作区解析（本机实测落在 /home/kali/桌面）；该目录之外的绝对路径会被沙箱拒绝写入，此时把「存储文件」改成能写的绝对路径即可。'))) : null,

      tab === 'log' && snap ? el('div', { className: 'rtm-body' },
        el('div', { className: 'rtm-tools' },
          el('button', { className: 'rtm-btn', disabled: !!busy, onClick: refresh }, '刷新'),
          el('button', { className: 'rtm-btn', disabled: !!busy, onClick: function () { call('logClear', {}, '清空日志') } }, '清空日志')),
        el('div', { className: 'rtm-logs' }, (snap.log || []).slice().reverse().map(function (l) {
          return el('div', { key: l.seq, className: 'rtm-ln rtm-ln-' + (l.level || 'info') },
            el('span', { className: 'rtm-lt' }, fmtTime(l.at)),
            el('span', { className: 'rtm-ll' }, l.level || ''),
            el('span', { className: 'rtm-lx' }, l.text))
        }))) : null
    )
  }

  // 侧边栏图标
  function Glyph(props) {
    const size = props && props.size ? props.size : 16
    const active = props && props.active
    const c = active ? 'var(--dsw-alias-brand-primary, #4c8dff)' : 'currentColor'
    return React.createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' },
      React.createElement('circle', { cx: 12, cy: 12, r: 3.1, stroke: c, strokeWidth: 1.6 }),
      React.createElement('path', { d: 'M12 5.5v3M12 15.5v3M6.2 14.2l3.6-2.1M14.2 11.9l3.6-2.1', stroke: c, strokeWidth: 1.5, strokeLinecap: 'round' }),
      React.createElement('circle', { cx: 12, cy: 3.4, r: 1.8, fill: c }),
      React.createElement('circle', { cx: 12, cy: 20.6, r: 1.8, fill: c }),
      React.createElement('circle', { cx: 4.4, cy: 15.4, r: 1.8, fill: c }),
      React.createElement('circle', { cx: 19.6, cy: 15.4, r: 1.8, fill: c })
    )
  }

  ctx.effect(function () {
    return styles.insert([
      '.rtm-root{padding:12px;font-size:12.5px;display:flex;flex-direction:column;gap:8px}',
      '.rtm-bar{display:flex;align-items:center;gap:10px}',
      '.rtm-brand{font-weight:600;font-size:14px}',
      '.rtm-stat{opacity:.7;font-size:11.5px}',
      '.rtm-prog{opacity:.9;font-size:11.5px;color:var(--dsw-alias-brand-primary,#4c8dff)}',
      '.rtm-sp{flex:1 1 auto}',
      '.rtm-dim{opacity:.66}', '.rtm-hint{opacity:.6;font-size:11px}',
      '.rtm-err{color:var(--dsw-alias-state-error-primary,#e05252);white-space:pre-wrap;font-size:12px}',
      '.rtm-warn{color:var(--dsw-alias-state-warn-primary,#c08a2e);font-size:12px}',
      '.rtm-ok{color:var(--dsw-alias-state-success-primary,#2f9e6b);font-size:12px}',
      '.rtm-toast{color:var(--dsw-alias-state-success-primary,#2f9e6b);font-size:12px}',
      '.rtm-errbar{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-state-error-primary,#e05252);font-size:12px;background:rgba(224,82,82,.08);padding:4px 8px;border-radius:6px}',
      '.rtm-btn{background:transparent;color:inherit;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}',
      '.rtm-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#4c8dff)}',
      '.rtm-btn:disabled{opacity:.5;cursor:default}',
      '.rtm-primary{border-color:var(--dsw-alias-brand-primary,#4c8dff);color:var(--dsw-alias-brand-primary,#4c8dff);font-weight:600}',
      '.rtm-danger{border-color:var(--dsw-alias-state-error-primary,#d9534f);color:var(--dsw-alias-state-error-primary,#d9534f)}',
      '.rtm-mini{padding:2px 8px;font-size:11px}',
      '.rtm-tabs{display:flex;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}',
      '.rtm-tab{background:transparent;color:inherit;border:none;border-bottom:2px solid transparent;padding:5px 10px;font-size:12.5px;cursor:pointer;opacity:.75}',
      '.rtm-tab-on{border-bottom-color:var(--dsw-alias-brand-primary,#4c8dff);color:var(--dsw-alias-brand-primary,#4c8dff);font-weight:600;opacity:1}',
      '.rtm-body{display:flex;flex-direction:column;gap:8px;min-height:0}',
      '.rtm-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.rtm-in{background:var(--dsw-alias-bg-base,#1b1b1b);color:inherit;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:6px;padding:3px 8px;font-size:12px;min-width:120px;color-scheme:dark}',
      '.rtm-in-sm{flex:1 1 240px}', '.rtm-in-xs{min-width:60px;width:64px}',
      '.rtm-ta{background:var(--dsw-alias-bg-base,#1b1b1b);color:inherit;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:6px;padding:6px 8px;font-size:12px;min-height:90px;resize:vertical;color-scheme:dark;font-family:inherit}',
      '.rtm-imports{display:flex;gap:10px;flex-wrap:wrap}',
      '.rtm-imp{flex:1 1 320px;display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:8px;padding:8px}',
      '.rtm-row{display:flex;gap:6px;align-items:center}',
      '.rtm-sec{font-size:12px;font-weight:600;opacity:.85}',
      '.rtm-list{max-height:44vh;overflow:auto}',
      '.rtm-tbl{width:100%;border-collapse:collapse;font-size:11.5px}',
      '.rtm-tbl th{text-align:left;opacity:.6;font-weight:500;padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}',
      '.rtm-tbl td{padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12));vertical-align:top}',
      '.rtm-tr-on{background:rgba(76,141,255,.12)}',
      '.rtm-lnk{color:var(--dsw-alias-brand-primary,#4c8dff);cursor:pointer;text-decoration:underline}',
      '.rtm-tagc{font-family:ui-monospace,monospace;opacity:.85}',
      '.rtm-srcc{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.7}',
      '.rtm-pager{display:flex;align-items:center;gap:10px;font-size:11.5px;opacity:.8;padding:6px 0}',
      '.rtm-cap{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:8px;padding:7px 8px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-l2,rgba(128,128,128,.04))}',
      '.rtm-cap-h{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.rtm-sec-in{margin:0}',
      '.rtm-flex{flex:1 1 auto;min-width:180px}',
      '.rtm-caps{display:flex;flex-direction:column;gap:3px;font-size:11.5px}',
      '.rtm-cap-i{display:flex;gap:8px;align-items:baseline}',
      '.rtm-cap-tag{flex:0 0 auto;opacity:.75;background:var(--dsw-alias-bg-l3,rgba(128,128,128,.14));border-radius:4px;padding:0 5px}',
      '.rtm-cap-x{flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.9}',
      '.rtm-detail{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:8px;padding:8px;margin-top:6px}',
      '.rtm-detail-h{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px}',
      '.rtm-detail-t{font-weight:600}',
      '.rtm-x{background:transparent;border:none;color:inherit;font-size:16px;line-height:1;cursor:pointer;opacity:.6;padding:0 4px}',
      '.rtm-pre{white-space:pre-wrap;word-break:break-word;font-size:11.5px;max-height:40vh;overflow:auto;margin:0;font-family:inherit}',
      '.rtm-hit{border-left:2px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));padding:4px 8px;margin:6px 0}',
      '.rtm-hit-h{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
      '.rtm-hit-t{font-weight:600}', '.rtm-hit-s{font-size:11px;opacity:.75;font-family:ui-monospace,monospace}',
      '.rtm-hit-b{font-size:11.5px;opacity:.9;white-space:pre-wrap;margin-top:3px}',
      '.rtm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px}',
      '.rtm-grp{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px}',
      '.rtm-f{display:flex;flex-direction:column;gap:3px;font-size:11.5px}',
      '.rtm-fb{flex-direction:row;align-items:center;gap:6px}',
      '.rtm-fl{opacity:.7}',
      '.rtm-logs{max-height:60vh;overflow:auto;font-size:11.5px;display:flex;flex-direction:column;gap:2px}',
      '.rtm-ln{display:flex;gap:8px;align-items:baseline}',
      '.rtm-lt{opacity:.5;font-family:ui-monospace,monospace;flex:0 0 auto}',
      '.rtm-ll{opacity:.7;flex:0 0 auto;min-width:34px}',
      '.rtm-lx{white-space:pre-wrap;word-break:break-word}',
      '.rtm-ln-err .rtm-lx{color:var(--dsw-alias-state-error-primary,#e05252)}',
      '.rtm-ln-warn .rtm-lx{color:var(--dsw-alias-state-warn-primary,#c08a2e)}',
    ].join('\n'))
  }, 'redteam-memory: styles')

  ctx.effect(function () {
    return slots.inject('sidebar.panellist', function () {
      return slots.register({ name: 'sidebar.panellist', id: PANEL_KEY, order: 70, label: '红队记忆' }, Glyph)
    })
  }, 'redteam-memory: panel button')

  ctx.effect(function () {
    return slots.inject('main', function () {
      return slots.register({ name: 'main', key: PANEL_KEY }, Panel)
    })
  }, 'redteam-memory: main panel')

  console.log('[rtmemory] redteam-memory client half ready; panel =', PANEL_KEY)
}
    exports.inject = ['slots', 'timer']
    exports.apply = function (ctx) { return applyClient(ctx) }
    return module.exports
  }
});
