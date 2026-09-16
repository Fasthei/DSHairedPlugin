// 红队报告 · Client 半边
//
// lib/client.js 由 `npm run build:lib` 从本文件生成，不要手改 lib/。
// 生成器以函数名 `applyClient` 为入口锚点，并在其中注入 host.call / styles.insert 垫片
// ——静态 bundle 里没有这两个闭包符号，原因见 ../../docs/DEVELOPMENT.md。
//
// 注意：本文件必须以 `return { name, inject, apply }` 块【结尾】，生成器据此剥离动态包装。
//
// ── 界面结构 ──────────────────────────────────────────────────────────────────
// ┌ 顶栏：标题 + 状态（报告份数 / 字数 / 证据规模 / 落盘）+ 生成进度
// ├ 标签页：报告 / 设置 / 日志
// ├ 报告：生成 · 新建并生成 · 保存 · 导出（MD/HTML/Word）· 导入记忆 · 删除
// │        报告列表（切换）· 标题 · 左编辑右预览
// ├ 设置：撰写模型（默认用当前会话的）· 证据预算 · 路径 · 额外要求 · 试算证据
// └ 日志：最近操作与错误
//
// 预览为什么走宿主：宿主那份 markdown→HTML 就是导出时用的同一份实现，前端再写一遍必然漂移；
// iframe.srcdoc 把整篇文档隔离进去，样式也不会污染面板。
//
// 为什么不用 setTimeout：动态客户端的沙箱只给了 ctx / React / host / styles / console
// （见 Cordis 的 Builtin 目录），定时器一律走 ctx.get('timer')。

function applyClient(ctx) {
  const slots = ctx.slots

  const PANEL_KEY = 'redteam-report'
  const TABS = [['doc', '报告'], ['set', '设置'], ['log', '日志']]
  const PREVIEW_DEBOUNCE_MS = 400

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

  function Panel() {
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
      if (typeof ctx.interval !== 'function') return undefined
      return ctx.interval(function () {
        if (!liveRef.current.generating) return
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

    function statLine() {
      if (!st) return null
      const bits = ['报告 ' + reports.length + ' 份']
      if (cur) bits.push(fmtNum(markdown.length) + ' 字' + (dirty ? '（未保存）' : ''))
      if (evMeta) bits.push('证据：会话 ' + (evMeta.sessions || 0) + ' · 矩阵 ' + (evMeta.matrixConfirmed || 0) + '/' + (evMeta.matrixSuspected || 0) + ' · 记忆 ' + (evMeta.memoryHits || 0))
      bits.push('落盘 ' + (st.persistence || '?'))
      return bits.join(' · ')
    }

    return el('div', { className: 'rtr-root' },
      el('div', { className: 'rtr-bar' },
        el('span', { className: 'rtr-brand' }, '红队报告'),
        el('span', { className: 'rtr-stat' }, statLine()),
        st && st.progress ? el('span', { className: 'rtr-prog' }, st.progress.text) : null,
        el('span', { className: 'rtr-sp' }),
        el('button', { className: 'rtr-btn', disabled: !!busy, onClick: refresh }, busy === 'load' ? '刷新中…' : '刷新')),

      error ? el('div', { className: 'rtr-errbar' }, error, el('button', { className: 'rtr-x', onClick: function () { setError(null) } }, '×')) : null,
      toast ? el('div', { className: 'rtr-toast' }, toast) : null,
      st && st.persistence === 'memory' ? el('div', { className: 'rtr-warn' }, 'fs 服务不可用：报告只存在内存里，重启会丢') : null,
      st && st.lastError && st.persistence === 'error' ? el('div', { className: 'rtr-warn' }, st.lastError) : null,

      el('div', { className: 'rtr-tabs' }, TABS.map(function (t) {
        return el('button', { key: t[0], className: 'rtr-tab' + (tab === t[0] ? ' rtr-tab-on' : ''), onClick: function () { setTab(t[0]) } }, t[1])
      })),

      !snap ? el('div', { className: 'rtr-body rtr-dim' }, busy === 'load' ? '加载中…' : '正在读取报告库…') : null,

      tab === 'doc' && snap ? el('div', { className: 'rtr-body' },
        el('div', { className: 'rtr-tools' },
          el('button', { className: 'rtr-btn rtr-primary', disabled: !!busy || generating, onClick: function () { doGenerate(false) } },
            generating ? '生成中…' : (cur && markdown ? '重新生成' : '生成报告')),
          el('button', { className: 'rtr-btn', disabled: !!busy || generating, onClick: function () { doGenerate(true) } }, '新建并生成'),
          el('button', { className: 'rtr-btn', disabled: !!busy || generating, onClick: doNew }, '新建空白'),
          el('button', { className: 'rtr-btn', disabled: !!busy || generating || !curId || !dirty, onClick: doSave }, dirty ? '保存 *' : '保存'),
          el('span', { className: 'rtr-sp' }),
          el('button', { className: 'rtr-btn', disabled: !!busy || !markdown, onClick: function () { doExport('md') } }, '导出 MD'),
          el('button', { className: 'rtr-btn', disabled: !!busy || !markdown, onClick: function () { doExport('html') } }, '导出 HTML'),
          el('button', { className: 'rtr-btn rtr-primary', disabled: !!busy || !markdown, onClick: function () { doExport('docx') }, title: '导出成 Word（.docx），落盘路径显示在下面' }, '导出 Word'),
          el('button', { className: 'rtr-btn', disabled: !!busy || !markdown, onClick: doImport, title: '把报告按章节切段写进红队记忆库' }, '导入记忆'),
          el('button', { className: 'rtr-btn rtr-danger', disabled: !!busy || !curId, onClick: doRemove }, '删除')),

        reports.length ? el('div', { className: 'rtr-list' }, reports.map(function (r) {
          return el('button', {
            key: r.id, className: 'rtr-chip' + (r.id === curId ? ' rtr-chip-on' : ''), disabled: !!busy,
            title: (r.provider ? r.provider + '/' + r.model + ' · ' : '') + '更新于 ' + fmtTime(r.updatedAt),
            onClick: function () { if (r.id === curId) return; setDirty(false); call('select', { id: r.id }, '') },
          }, (r.title || '未命名') + ' · ' + fmtNum(r.chars) + ' 字')
        })) : el('div', { className: 'rtr-dim' }, '还没有报告。点「生成报告」让 AI 基于工作区对话、攻击矩阵命中与记忆库写一份。'),

        curId ? el('div', { className: 'rtr-edit' },
          el('input', {
            className: 'rtr-in rtr-title', value: title, placeholder: '报告标题',
            onChange: function (e) { setTitle(e.target.value); setDirty(true) },
          }),
          el('div', { className: 'rtr-panes' },
            el('div', { className: 'rtr-pane' },
              el('div', { className: 'rtr-pane-h' }, 'Markdown（可直接改）'),
              el('textarea', {
                className: 'rtr-ta', value: markdown, placeholder: '点「生成报告」让 AI 写，或者直接在这里手写…',
                onChange: function (e) { setMarkdown(e.target.value); setDirty(true) },
              })),
            el('div', { className: 'rtr-pane' },
              el('div', { className: 'rtr-pane-h' }, '预览（与导出的 HTML / Word 同一套渲染）'),
              html
                ? el('iframe', { className: 'rtr-frame', srcDoc: html, sandbox: 'allow-same-origin' })
                : el('div', { className: 'rtr-dim rtr-pane-pad' }, '预览生成中…'))),
          exportInfo ? el('div', { className: exportInfo.writeError ? 'rtr-warn' : 'rtr-ok' },
            '已导出 ' + exportInfo.name + '（' + exportInfo.bytes + ' 字节）'
            + (exportInfo.path ? '：' + exportInfo.path : '（未落盘）')
            + (exportInfo.writeError ? '｜落盘失败：' + exportInfo.writeError : '')) : null,
          cur && cur.meta && cur.meta.generatedAt
            ? el('div', { className: 'rtr-hint' }, '生成于 ' + fmtTime(cur.meta.generatedAt) + ' · 模型 ' + (cur.meta.provider || '?') + '/' + (cur.meta.model || '?')
              + (cur.meta.evidence ? ' · 证据 digest ' + fmtNum(cur.meta.evidence.digestChars) + ' 字' : ''))
            : null) : null
      ) : null,

      tab === 'set' && snap ? el('div', { className: 'rtr-body' },
        !draft ? el('div', { className: 'rtr-dim' }, '加载中…') : el('div', null,
          el('div', { className: 'rtr-tools' },
            el('button', { className: 'rtr-btn rtr-primary', disabled: !!busy, onClick: function () { call('saveSettings', draft, '保存设置') } }, '保存设置'),
            el('button', { className: 'rtr-btn', disabled: !!busy, onClick: doCollect }, busy === 'collect' ? '试算中…' : '试算证据'),
            el('button', { className: 'rtr-btn', disabled: !!busy, onClick: function () { setModelField('provider', ''); setModelField('model', '') } }, '用当前会话默认模型')),

          el('div', { className: 'rtr-grid' },
            el('div', { className: 'rtr-grp' },
              el('div', { className: 'rtr-sec' }, '撰写模型'),
              el('div', { className: 'rtr-hint' }, '留空 = 用当前会话正在用的那个模型（' + ((snap.model && snap.model.provider) || '?') + '/' + ((snap.model && snap.model.model) || '?') + '，来源 ' + ((snap.model && snap.model.from) || '?') + '）'),
              el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-fl' }, 'provider'),
                el('input', { className: 'rtr-in', value: (draft.model && draft.model.provider) || '', placeholder: '例如 deepseek', onChange: function (e) { setModelField('provider', e.target.value) } })),
              el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-fl' }, 'model'),
                el('input', { className: 'rtr-in', value: (draft.model && draft.model.model) || '', placeholder: '例如 deepseek-chat', onChange: function (e) { setModelField('model', e.target.value) } })),
              el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-fl' }, 'maxTokens'),
                el('input', { className: 'rtr-in', type: 'number', value: draft.maxTokens, onChange: function (e) { setField('maxTokens', Number(e.target.value)) } }))),

            el('div', { className: 'rtr-grp' },
              el('div', { className: 'rtr-sec' }, '证据预算（喂给模型多少材料）'),
              el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-fl' }, '最多读几个会话'),
                el('input', { className: 'rtr-in', type: 'number', value: draft.sessionLimit, onChange: function (e) { setField('sessionLimit', Number(e.target.value)) } })),
              el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-fl' }, '每个会话最多取多少字'),
                el('input', { className: 'rtr-in', type: 'number', value: draft.sessionChars, onChange: function (e) { setField('sessionChars', Number(e.target.value)) } })),
              el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-fl' }, '已确认命中上限'),
                el('input', { className: 'rtr-in', type: 'number', value: draft.maxConfirmed, onChange: function (e) { setField('maxConfirmed', Number(e.target.value)) } })),
              el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-fl' }, '疑似命中上限'),
                el('input', { className: 'rtr-in', type: 'number', value: draft.maxSuspected, onChange: function (e) { setField('maxSuspected', Number(e.target.value)) } })),
              el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-fl' }, 'digest 总上限（字）'),
                el('input', { className: 'rtr-in', type: 'number', value: draft.digestMax, onChange: function (e) { setField('digestMax', Number(e.target.value)) } })),
              el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-fl' }, '记忆：每条条数 / 查询数'),
                el('div', { className: 'rtr-row' },
                  el('input', { className: 'rtr-in rtr-in-xs', type: 'number', value: draft.memoryTopK, onChange: function (e) { setField('memoryTopK', Number(e.target.value)) } }),
                  el('input', { className: 'rtr-in rtr-in-xs', type: 'number', value: draft.memoryQueries, onChange: function (e) { setField('memoryQueries', Number(e.target.value)) } })))),

            el('div', { className: 'rtr-grp' },
              el('div', { className: 'rtr-sec' }, '路径'),
              el('div', { className: 'rtr-hint' }, '存储与导出默认用相对名，由宿主按插件自己的工作区解析（本机实测是 /home/kali/桌面）；写不进去时改成能写的绝对路径。'),
              el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-fl' }, '攻击矩阵存储（留空 = 工作区里的 .redteam-attack-matrix.json）'),
                el('input', { className: 'rtr-in', value: draft.matrixStore || '', placeholder: (st && st.matrixPath) || '', onChange: function (e) { setField('matrixStore', e.target.value) } })),
              el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-fl' }, '报告库文件'),
                el('input', { className: 'rtr-in', value: draft.storePath || '', onChange: function (e) { setField('storePath', e.target.value) } })),
              el('label', { className: 'rtr-f' }, el('span', { className: 'rtr-fl' }, '导出目录（留空 = 与报告库同目录）'),
                el('input', { className: 'rtr-in', value: draft.exportDir || '', placeholder: '例如 /home/kali/桌面', onChange: function (e) { setField('exportDir', e.target.value) } })),
              el('div', { className: 'rtr-hint' }, '当前落盘：' + ((st && st.storePath) || '（未解析）'))),

            el('div', { className: 'rtr-grp rtr-grp-wide' },
              el('div', { className: 'rtr-sec' }, '额外要求（每次生成都会带上）'),
              el('textarea', {
                className: 'rtr-ta rtr-ta-sm', value: draft.instruction || '', placeholder: '例如：重点写未授权访问链路，每条发现给出修复优先级；不要写攻击载荷细节。',
                onChange: function (e) { setField('instruction', e.target.value) },
              }))),

          evidence ? el('div', { className: 'rtr-evi' },
            el('div', { className: 'rtr-sec' }, '试算结果：AI 这次会看到什么'),
            el('div', { className: 'rtr-hint' },
              '工作区 ' + ((evidence.workspace && evidence.workspace.path) || '（无）')
              + ' · 会话 ' + evidence.sessions.length
              + ' · 矩阵 ' + evidence.matrix.confirmed + ' 已确认 / ' + evidence.matrix.suspected + ' 疑似（来源 ' + evidence.matrix.from + '）'
              + ' · 记忆 ' + evidence.memory.count + (evidence.memory.available ? '' : '（记忆插件未运行）')
              + ' · digest ' + evidence.digestChars + ' 字'),
            evidence.matrix.error ? el('div', { className: 'rtr-warn' }, '矩阵读取问题：' + evidence.matrix.error) : null,
            evidence.queries && evidence.queries.length ? el('div', { className: 'rtr-hint' }, '记忆检索词：' + evidence.queries.join(' / ')) : null,
            evidence.sessions.length ? el('table', { className: 'rtr-tbl' },
              el('thead', null, el('tr', null, el('th', null, '会话'), el('th', null, '用户要求'), el('th', null, '操作'), el('th', null, '结果'), el('th', null, '时间'))),
              el('tbody', null, evidence.sessions.map(function (s) {
                return el('tr', { key: s.id },
                  el('td', null, s.title || String(s.id).slice(0, 14)),
                  el('td', null, String(s.users)),
                  el('td', null, String(s.ops)),
                  el('td', null, String(s.results)),
                  el('td', null, fmtTime(s.firstAt) + ' → ' + fmtTime(s.lastAt)))
              }))) : el('div', { className: 'rtr-dim' }, '没有采到会话（工作区里还没有对话，或者 sessions 服务不可用）'),
            el('div', { className: 'rtr-sec' }, 'digest（前 ' + fmtNum(evidence.digest.length) + ' 字' + (evidence.truncated ? '，实际 ' + fmtNum(evidence.digestChars) + ' 字' : '') + '）'),
            el('pre', { className: 'rtr-pre' }, evidence.digest)) : null
        )) : null,

      tab === 'log' && snap ? el('div', { className: 'rtr-body' },
        el('div', { className: 'rtr-tools' },
          el('button', { className: 'rtr-btn', disabled: !!busy, onClick: refresh }, '刷新'),
          el('button', { className: 'rtr-btn', disabled: !!busy, onClick: function () { call('logClear', {}, '清空日志') } }, '清空日志')),
        el('div', { className: 'rtr-logs' }, (snap.log || []).slice().reverse().map(function (l) {
          return el('div', { key: l.seq, className: 'rtr-ln rtr-ln-' + (l.level || 'info') },
            el('span', { className: 'rtr-lt' }, fmtTime(l.at)),
            el('span', { className: 'rtr-ll' }, l.level || ''),
            el('span', { className: 'rtr-lx' }, l.text))
        }))) : null
    )
  }

  // 侧边栏图标：一份带批注点的文档
  function Glyph(props) {
    const size = props && props.size ? props.size : 16
    const active = props && props.active
    const c = active ? 'var(--dsw-alias-brand-primary, #4c8dff)' : 'currentColor'
    return React.createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' },
      React.createElement('path', { d: 'M6 3.5h8.5L19 8v12.5H6z', stroke: c, strokeWidth: 1.6, strokeLinejoin: 'round' }),
      React.createElement('path', { d: 'M14.2 3.6V8H19', stroke: c, strokeWidth: 1.4, strokeLinejoin: 'round' }),
      React.createElement('path', { d: 'M9 12h6M9 15h6M9 18h3.5', stroke: c, strokeWidth: 1.4, strokeLinecap: 'round' }),
      React.createElement('circle', { cx: 5.2, cy: 12, r: 1.5, fill: c }),
      React.createElement('circle', { cx: 5.2, cy: 16.6, r: 1.5, fill: c })
    )
  }

  ctx.effect(function () {
    return styles.insert([
      '.rtr-root{padding:12px;font-size:13px;display:flex;flex-direction:column;gap:8px}',
      '.rtr-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.rtr-brand{font-weight:600;font-size:14px}',
      '.rtr-stat{font-size:11.5px;opacity:.72;font-family:ui-monospace,monospace}',
      '.rtr-prog{font-size:11.5px;color:var(--dsw-alias-brand-primary,#4c8dff)}',
      '.rtr-sp{flex:1 1 auto}',
      '.rtr-dim{opacity:.66}',
      '.rtr-hint{font-size:11px;opacity:.7}',
      '.rtr-warn{color:var(--dsw-alias-state-warn-primary,#c08a2e);font-size:12px}',
      '.rtr-ok{color:var(--dsw-alias-state-success-primary,#2f9e6b);font-size:12px;word-break:break-all}',
      '.rtr-errbar{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;color:var(--dsw-alias-state-error-primary,#e05252);white-space:pre-wrap;font-size:12px}',
      '.rtr-toast{font-size:12px;color:var(--dsw-alias-state-success-primary,#2f9e6b)}',
      '.rtr-x{background:transparent;border:none;color:inherit;font-size:16px;line-height:1;cursor:pointer;opacity:.6;padding:0 4px}',
      '.rtr-tabs{display:flex;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}',
      '.rtr-tab{background:transparent;color:inherit;border:none;border-bottom:2px solid transparent;padding:5px 10px;font-size:12.5px;cursor:pointer;opacity:.75}',
      '.rtr-tab-on{border-bottom-color:var(--dsw-alias-brand-primary,#4c8dff);color:var(--dsw-alias-brand-primary,#4c8dff);font-weight:600;opacity:1}',
      '.rtr-body{display:flex;flex-direction:column;gap:8px}',
      '.rtr-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.rtr-btn{background:var(--dsw-alias-bg-l2,rgba(128,128,128,.12));color:inherit;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));border-radius:6px;padding:4px 9px;font-size:12px;cursor:pointer}',
      '.rtr-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.rtr-primary{background:var(--dsw-alias-brand-primary,#4c8dff);border-color:transparent;color:#fff}',
      '.rtr-danger{color:var(--dsw-alias-state-error-primary,#e05252)}',
      '.rtr-list{display:flex;gap:6px;flex-wrap:wrap}',
      '.rtr-chip{background:transparent;color:inherit;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));border-radius:999px;padding:3px 10px;font-size:11.5px;cursor:pointer;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rtr-chip-on{border-color:var(--dsw-alias-brand-primary,#4c8dff);color:var(--dsw-alias-brand-primary,#4c8dff);font-weight:600}',
      '.rtr-edit{display:flex;flex-direction:column;gap:6px}',
      '.rtr-in{background:var(--dsw-alias-bg-l1,transparent);color:inherit;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));border-radius:6px;padding:4px 7px;font-size:12px;font-family:inherit;width:100%}',
      '.rtr-in-xs{width:64px}',
      '.rtr-title{font-weight:600;font-size:13px}',
      '.rtr-panes{display:grid;grid-template-columns:1fr 1fr;gap:8px;min-height:52vh}',
      '.rtr-pane{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.rtr-pane-h{font-size:11px;opacity:.65}',
      '.rtr-pane-pad{padding:8px}',
      '.rtr-ta{flex:1 1 auto;min-height:46vh;background:var(--dsw-alias-bg-l1,transparent);color:inherit;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));border-radius:8px;padding:8px;font-size:12px;font-family:ui-monospace,monospace;line-height:1.5;resize:vertical}',
      '.rtr-ta-sm{min-height:70px}',
      '.rtr-frame{flex:1 1 auto;min-height:46vh;width:100%;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));border-radius:8px;background:#fff}',
      '.rtr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px}',
      '.rtr-grp{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px}',
      '.rtr-grp-wide{grid-column:1/-1}',
      '.rtr-sec{font-weight:600;font-size:12px}',
      '.rtr-f{display:flex;flex-direction:column;gap:3px;font-size:11.5px}',
      '.rtr-fl{opacity:.7}',
      '.rtr-row{display:flex;gap:6px;align-items:center}',
      '.rtr-tbl{width:100%;border-collapse:collapse;font-size:11.5px}',
      '.rtr-tbl th{text-align:left;opacity:.6;font-weight:500;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));padding:3px 6px}',
      '.rtr-tbl td{border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12));padding:3px 6px}',
      '.rtr-evi{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));padding-top:8px}',
      '.rtr-pre{white-space:pre-wrap;word-break:break-word;font-size:11px;max-height:44vh;overflow:auto;background:var(--dsw-alias-bg-l2,rgba(128,128,128,.06));border-radius:8px;padding:8px;margin:0}',
      '.rtr-logs{max-height:60vh;overflow:auto;font-size:11.5px;display:flex;flex-direction:column;gap:2px}',
      '.rtr-ln{display:flex;gap:8px;align-items:baseline}',
      '.rtr-lt{opacity:.5;font-family:ui-monospace,monospace;flex:0 0 auto}',
      '.rtr-ll{opacity:.7;flex:0 0 auto;min-width:34px}',
      '.rtr-lx{white-space:pre-wrap;word-break:break-word}',
      '.rtr-ln-err .rtr-lx{color:var(--dsw-alias-state-error-primary,#e05252)}',
      '.rtr-ln-warn .rtr-lx{color:var(--dsw-alias-state-warn-primary,#c08a2e)}',
    ].join('\n'))
  }, 'redteam-report: styles')

  ctx.effect(function () {
    return slots.inject('sidebar.panellist', function () {
      return slots.register({ name: 'sidebar.panellist', id: PANEL_KEY, order: 60, label: '红队报告' }, Glyph)
    })
  }, 'redteam-report: panel button')

  ctx.effect(function () {
    return slots.inject('main', function () {
      return slots.register({ name: 'main', key: PANEL_KEY }, Panel)
    })
  }, 'redteam-report: main panel')

  console.log('[rtreport] redteam-report client half ready; panel =', PANEL_KEY)
}

return {
  name: 'redteam-report',
  inject: ['slots', 'timer'],
  apply: applyClient
}
