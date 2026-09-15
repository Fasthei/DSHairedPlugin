const PANEL_KEY = 'redteam-assets'
const VW = 1200
const VH = 800
const MIN_W = VW * 0.12
const MAX_W = VW * 3
const JINA_MCP_BASE = 'https://mcp.jina.ai/v1'
const KEY_PREFIX = 'jina_'
const TOOL_PRESET_REDTEAM = ['search_web', 'search_web_deep', 'read_url', 'parallel_read_url']
const TOOL_PRESET_SEARCHREAD = ['search_web', 'search_web_deep', 'search_arxiv', 'search_ssrn', 'search_jina_blog', 'search_images', 'search_bibtex', 'read_url', 'parallel_read_url', 'capture_screenshot_url']

const TYPE_COLOR = {
  domain: '#4c8dff', ip: '#f2994a', cidr: '#f2c94c', url: '#27ae60', port: '#bb6bd9',
  service: '#2d9cdb', org: '#eb5757', email: '#9b51e0', credential: '#e05252', hash: '#7f8c8d',
  path: '#0e9aa7', repo: '#16a085', note: '#95a5a6', other: '#8a8f98'
}
const TYPE_LABEL = {
  domain: '域名', ip: 'IP', cidr: '网段', url: 'URL', port: '端口', service: '服务', org: '组织',
  email: '邮箱', credential: '凭据', hash: '哈希', path: '路径', repo: '仓库', note: '备注', other: '其他'
}
const ASSET_TYPES = ['domain', 'ip', 'cidr', 'url', 'port', 'service', 'org', 'email', 'credential', 'hash', 'path', 'repo', 'note', 'other']
const RELATION_LABEL = {
  belongs_to: '归属', subdomain_of: '子域', resolves_to: '解析到', hosts_on: '托管于', in_range: '属于网段',
  exposes_port: '开放端口', mailbox_at: '邮箱域', related: '相关', has_port: '开放端口', admin_of: '管理'
}
const ALL_PROJECT = '__all__'

const RE_IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/
const RE_DOMAIN = /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z]{2,24}$/i

function jsonArgs(obj) {
  const out = {}
  const src = obj && typeof obj === 'object' ? obj : {}
  for (const k of Object.keys(src)) {
    const v = src[k]
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) {
      const arr = v.filter(function (x) { return x !== undefined && x !== null })
      if (arr.length) out[k] = arr
      continue
    }
    out[k] = v
  }
  return out
}

const ORIGIN_PHRASE = {
  user: '手动录入', model: '模型研判时登记', jina: 'Jina 检索命中',
  import: '外部导入', relay: '作为关联资产被带出', scan: '粘贴文本批量识别',
  auto: '工具结果自动捕获', search: '内置搜索命中', bash: '命令输出自动捕获',
  tool: '工具输出自动捕获'
}

function relLabel(r) {
  const s = String(r || '')
  if (s.indexOf('shares_tag:') === 0) return '共享标签'
  return RELATION_LABEL[s] || s
}

function relBasis(e) {
  const src = String(e && e.source || 'auto')
  if (src === 'manual') return '登记时人工指定'
  if (src === 'import') return '随导入数据带入'
  const r = String(e && e.relation || '')
  if (r.indexOf('shares_tag:') === 0) return '因共享标签「' + r.slice(11) + '」自动判定'
  if (r === 'belongs_to') return '按 URL 主机名归属自动判定'
  if (r === 'subdomain_of') return '按域名后缀自动判定'
  if (r === 'in_range') return '按 IP 是否落在该网段自动判定'
  if (r === 'mailbox_at') return '按邮箱域名自动判定'
  if (r === 'hosts_on') return '按 URL 主机名与 IP 一致自动判定'
  if (r === 'exposes_port') return '按 URL 端口自动判定'
  return '由本地关联规则自动判定'
}

function inputKind(v) {
  const s = String(v || '').trim()
  if (!s) return ''
  if (RE_IPV4.test(s)) {
    for (const p of s.split('.')) if (Number(p) > 255) return ''
    return 'ip'
  }
  if (RE_DOMAIN.test(s)) return 'domain'
  return ''
}

function baseOf(p) {
  const s = String(p || '')
  const parts = s.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : s
}

const CSS = [
  '.rt-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary,inherit);font-size:13px}',
  '.rt-bar{display:flex;align-items:center;gap:6px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));flex-wrap:wrap}',
  '.rt-warnbar{display:flex;align-items:center;gap:8px;padding:6px 14px;font-size:12px;background-color:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));border-bottom:1px solid var(--dsw-alias-state-warn-primary,#e0a252);color:var(--dsw-alias-state-warn-primary,#e0a252)}',
  '.rt-title{font-weight:600;font-size:14px;margin-right:4px}',
  '.rt-dim{opacity:.66;font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}',
  '.rt-btn{background-color:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;line-height:1.5;text-decoration:none;display:inline-block;flex:0 0 auto}',
  '.rt-btn:hover{background-color:var(--dsw-alias-bg-overlay,rgba(128,128,128,.22))}',
  '.rt-btn[disabled]{opacity:.45;cursor:default}',
  '.rt-btn.rt-primary{border-color:var(--dsw-alias-brand-primary,#4c8dff);color:var(--dsw-alias-brand-primary,#4c8dff);font-weight:600}',
  '.rt-btn.rt-danger{border-color:var(--dsw-alias-state-error-primary,#e05252);color:var(--dsw-alias-state-error-primary,#e05252)}',
  '.rt-btn.rt-on{background-color:var(--dsw-alias-bg-overlay,rgba(128,128,128,.22));border-color:var(--dsw-alias-brand-primary,#4c8dff)}',
  '.rt-body{display:flex;flex:1;min-height:0;position:relative}',
  '.rt-center{flex:1 1 auto;min-width:0;position:relative;background-color:var(--dsw-alias-bg-base,transparent);overflow:hidden}',
  '.rt-drawer{position:absolute;top:0;right:0;bottom:0;width:370px;background-color:var(--dsw-alias-bg-layer-1,inherit);border-left:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));padding:10px;gap:8px;z-index:5;overflow:auto;display:flex;flex-direction:column}',
  '.rt-input,.rt-select,.rt-textarea{width:100%;box-sizing:border-box;background-color:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.10));color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:6px;padding:5px 8px;font-size:12px;font-family:inherit}',
  '.rt-select option{background-color:var(--dsw-alias-bg-overlay,#ffffff);color:var(--dsw-alias-label-primary,#111111)}',
  '.rt-input::placeholder,.rt-textarea::placeholder{color:var(--dsw-alias-label-secondary,inherit);opacity:.8}',
  '.rt-textarea{resize:vertical;min-height:56px}',
  '.rt-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;flex:0 0 auto}',
  '.rt-row>*{min-width:0}',
  '.rt-list{display:flex;flex-direction:column;gap:3px}',
  '.rt-item{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:6px;cursor:pointer;border:1px solid transparent;flex:0 0 auto}',
  '.rt-item:hover{background-color:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12))}',
  '.rt-item.rt-sel{background-color:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));border-color:var(--dsw-alias-brand-primary,#4c8dff)}',
  '.rt-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}',
  '.rt-val{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.rt-tag{font-size:11px;color:var(--dsw-alias-label-secondary,inherit);padding:0 5px;border-radius:4px;background-color:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16));flex:0 0 auto}',
  '.rt-h{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,inherit);margin:4px 0 2px}',
  '.rt-err{color:var(--dsw-alias-state-error-primary,#e05252);font-size:12px;white-space:pre-wrap;flex:1;min-width:0}',
  '.rt-ok{color:var(--dsw-alias-state-success-primary,#27ae60);font-size:12px;white-space:pre-wrap;flex:1;min-width:0}',
  '.rt-msgbar{display:flex;align-items:flex-start;gap:8px;padding:5px 14px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));flex:0 0 auto}',
  '.rt-note{font-size:11px;color:var(--dsw-alias-label-secondary,inherit);opacity:.9;line-height:1.5;word-break:break-all}',
  '.rt-desc{font-size:11px;line-height:1.65;color:var(--dsw-alias-label-secondary,inherit);white-space:pre-wrap;word-break:break-word;background-color:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));border-radius:6px;padding:6px 7px}',
  '.rt-desc-h{font-size:11px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);opacity:.88;margin-bottom:2px}',
  '.rt-pre{white-space:pre-wrap;word-break:break-all;font-size:11px;max-height:190px;overflow:auto;background-color:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10));color:var(--dsw-alias-label-primary,inherit);border-radius:6px;padding:6px;font-family:ui-monospace,monospace;margin:0}',
  '.rt-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary,inherit);opacity:.7;font-size:13px;pointer-events:none}',
  '.rt-tabs{display:flex;gap:4px}',
  '.rt-badge{font-size:11px;padding:1px 6px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));color:var(--dsw-alias-label-primary,inherit)}',
  '.rt-badge.rt-badge-ok{border-color:var(--dsw-alias-state-success-primary,#27ae60);color:var(--dsw-alias-state-success-primary,#27ae60)}',
  '.rt-badge.rt-badge-warn{border-color:var(--dsw-alias-state-warn-primary,#e0a252);color:var(--dsw-alias-state-warn-primary,#e0a252);cursor:pointer}',
  '.rt-gctl{position:absolute;top:8px;right:8px;display:flex;gap:4px;z-index:2}',
  '.rt-hint{position:absolute;bottom:6px;left:10px;font-size:11px;color:var(--dsw-alias-label-secondary,inherit);opacity:.75;pointer-events:none}',
  '.rt-left{width:330px;flex:0 0 330px;border-right:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));padding:8px 10px;gap:6px;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden}',
  '.rt-secsec{display:flex;flex-direction:column;gap:4px;min-height:0;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));padding-top:6px;margin-top:2px}',
  '.rt-secfirst{border-top:none;padding-top:0;margin-top:0}',
  '.rt-log{min-height:0;overflow:auto;background-color:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));border-radius:6px;padding:6px;font-size:11px;line-height:1.65;display:flex;flex-direction:column;gap:2px}',
  '.rt-l-info{color:var(--dsw-alias-label-secondary,inherit);flex:0 0 auto}',
  '.rt-l-ok{color:var(--dsw-alias-state-success-primary,#27ae60);flex:0 0 auto}',
  '.rt-l-warn{color:var(--dsw-alias-state-warn-primary,#e0a252);flex:0 0 auto}',
  '.rt-l-err{color:var(--dsw-alias-state-error-primary,#e05252);flex:0 0 auto}',
  '.rt-l-phase{color:var(--dsw-alias-brand-primary,#4c8dff);font-weight:600;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));margin-top:3px;padding-top:3px;flex:0 0 auto}',
  '.rt-l-tool{color:var(--dsw-alias-brand-primary,#4c8dff);font-family:ui-monospace,monospace;flex:0 0 auto}',
  '.rt-l-think{color:var(--dsw-alias-label-secondary,inherit);font-style:italic;border-left:2px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));padding-left:6px;white-space:pre-wrap;word-break:break-word;flex:0 0 auto}',
  '.rt-l-model{color:var(--dsw-alias-label-primary,inherit);white-space:pre-wrap;word-break:break-word;flex:0 0 auto}',
  '.rt-live-inline{border-top:1px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.45));margin-top:4px;padding-top:4px;display:flex;flex-direction:column;gap:4px;flex:0 0 auto}',
  '.rt-sec-label{font-size:10px;color:var(--dsw-alias-label-secondary,inherit);opacity:.8}',
  '.rt-prog{font-size:11px;color:var(--dsw-alias-brand-primary,#4c8dff);flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}',
  '.rt-scroll{overflow:auto;min-height:0}',
  '.rt-addbody{overflow:auto;flex:0 0 auto}',
  '.rt-tablebar{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));flex:0 0 auto;flex-wrap:wrap}',
  '.rt-card{position:absolute;left:10px;bottom:10px;width:340px;max-height:72%;overflow:auto;background-color:var(--dsw-alias-bg-overlay,rgba(20,22,26,.95));color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));border-radius:8px;padding:10px;z-index:3;display:flex;flex-direction:column;gap:6px}',
  '.rt-table{width:100%;border-collapse:collapse;font-size:12px}',
  '.rt-table th{text-align:left;padding:4px 6px;color:var(--dsw-alias-label-secondary,inherit);border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3))}',
  '.rt-table td{padding:3px 6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.14))}',
  '.rt-table tbody tr{cursor:pointer}',
  '.rt-table tbody tr:hover{background-color:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10))}',
  '.rt-fold{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;padding:2px 0;flex:0 0 auto}',
  '.rt-fold:hover{color:var(--dsw-alias-brand-primary,#4c8dff)}',
  '.rt-fold:hover .rt-h{color:var(--dsw-alias-brand-primary,#4c8dff)}',
  '.rt-foldmark{width:11px;display:inline-block;color:var(--dsw-alias-label-secondary,inherit);font-size:10px}',
  '.rt-foldbody{display:flex;flex-direction:column;gap:6px;padding-top:6px}',
  '.rt-tools{display:flex;flex-direction:column;gap:1px;max-height:300px;overflow:auto;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;padding:6px}',
  '.rt-check{display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;padding:2px 0}',
  '.rt-check:hover{color:var(--dsw-alias-brand-primary,#4c8dff)}',
  '.rt-tname{font-family:ui-monospace,monospace;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.rt-run{display:flex;align-items:flex-start;gap:6px;font-size:11px;line-height:1.55;padding:3px 7px;border-radius:6px;background-color:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10));flex:0 0 auto;word-break:break-word}',
  '.rt-run-dot{flex:0 0 auto;font-size:10px;line-height:1.7}',
  '.rt-run-idle{opacity:.75}',
  '.rt-run-active{color:var(--dsw-alias-brand-primary,#4c8dff);border-left:2px solid var(--dsw-alias-brand-primary,#4c8dff)}',
  '.rt-run-done{color:var(--dsw-alias-state-success-primary,#27ae60);border-left:2px solid var(--dsw-alias-state-success-primary,#27ae60)}',
  '.rt-run-stopped{color:var(--dsw-alias-state-warn-primary,#e0a252);border-left:2px solid var(--dsw-alias-state-warn-primary,#e0a252)}',
  '.rt-run-error{color:var(--dsw-alias-state-error-primary,#e05252);border-left:2px solid var(--dsw-alias-state-error-primary,#e05252)}'
].join('\n')

function fmtTime(ms) {
  if (!ms) return '-'
  try { return new Date(ms).toLocaleString() } catch (e) { return String(ms) }
}

function fmtClock(ms) {
  if (!ms) return ''
  try { return new Date(ms).toLocaleTimeString() } catch (e) { return '' }
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(Number(ms || 0) / 1000))
  if (s < 60) return s + ' 秒'
  const m = Math.floor(s / 60)
  if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒'
  return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分'
}

function forceLayout(nodes, links, W, H) {
  const n = nodes.length
  const out = {}
  if (n === 0) return out
  const idx = {}
  for (let i = 0; i < n; i++) idx[nodes[i].id] = i
  const types = []
  for (const nd of nodes) if (types.indexOf(nd.type) < 0) types.push(nd.type)
  const cx = W / 2, cy = H / 2
  const anchors = {}
  for (let i = 0; i < types.length; i++) {
    const ang = (i / Math.max(1, types.length)) * Math.PI * 2 - Math.PI / 2
    anchors[types[i]] = { x: cx + Math.cos(ang) * W * 0.29, y: cy + Math.sin(ang) * H * 0.29 }
  }
  const pos = []
  for (let i = 0; i < n; i++) {
    const a = anchors[nodes[i].type] || { x: cx, y: cy }
    const ang = i * 2.399963
    const r = 10 + Math.sqrt(i) * 16
    pos.push({ x: a.x + Math.cos(ang) * r, y: a.y + Math.sin(ang) * r })
  }
  const tmp = new Array(n)
  const k = Math.sqrt((W * H) / Math.max(1, n))
  const R = 520
  const iters = n > 140 ? 110 : n > 70 ? 170 : 240
  for (let it = 0; it < iters; it++) {
    const cool = 1 - it / iters
    for (let i = 0; i < n; i++) {
      let fx = 0, fy = 0
      const pi = pos[i]
      for (let j = 0; j < n; j++) {
        if (i === j) continue
        let dx = pi.x - pos[j].x
        let dy = pi.y - pos[j].y
        let d2 = dx * dx + dy * dy
        if (d2 > R * R) continue
        if (d2 < 1) { d2 = 1; dx = (i - j) * 0.7 + 0.7; dy = 0.4 }
        const d = Math.sqrt(d2)
        const f = (k * k) / d2
        fx += (dx / d) * f
        fy += (dy / d) * f
      }
      const a = anchors[nodes[i].type]
      if (a) { fx += (a.x - pi.x) * 0.045; fy += (a.y - pi.y) * 0.045 }
      fx += (cx - pi.x) * 0.006
      fy += (cy - pi.y) * 0.006
      tmp[i] = { x: fx, y: fy }
    }
    for (const l of links) {
      const i = idx[l.from], j = idx[l.to]
      if (i === undefined || j === undefined) continue
      const dx = pos[j].x - pos[i].x
      const dy = pos[j].y - pos[i].y
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
      const f = ((d - k * 0.85) * 0.07) / d
      tmp[i].x += dx * f; tmp[i].y += dy * f
      tmp[j].x -= dx * f; tmp[j].y -= dy * f
    }
    const maxStep = 20 * cool + 0.6
    for (let i = 0; i < n; i++) {
      let mx = tmp[i].x, my = tmp[i].y
      const m = Math.sqrt(mx * mx + my * my)
      if (m > maxStep) { mx = (mx / m) * maxStep; my = (my / m) * maxStep }
      pos[i].x = Math.max(26, Math.min(W - 26, pos[i].x + mx))
      pos[i].y = Math.max(26, Math.min(H - 26, pos[i].y + my))
    }
  }
  for (let i = 0; i < n; i++) out[nodes[i].id] = pos[i]
  return out
}

function Glyph(props) {
  const size = props && props.size ? props.size : 16
  const active = props && props.active
  const c = active ? 'var(--dsw-alias-brand-primary, #4c8dff)' : 'currentColor'
  return React.createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' },
    React.createElement('path', { d: 'M12 5.5v3M12 15.5v3M7.6 9.9l2.6 1.5M13.8 12.6l2.6 1.5M6.2 14.2l3.6-2.1M14.2 11.9l3.6-2.1', stroke: c, strokeWidth: 1.5, strokeLinecap: 'round' }),
    React.createElement('circle', { cx: 12, cy: 12, r: 3.1, stroke: c, strokeWidth: 1.6 }),
    React.createElement('circle', { cx: 12, cy: 3.4, r: 1.8, fill: c }),
    React.createElement('circle', { cx: 12, cy: 20.6, r: 1.8, fill: c }),
    React.createElement('circle', { cx: 4.4, cy: 8.6, r: 1.8, fill: c }),
    React.createElement('circle', { cx: 19.6, cy: 8.6, r: 1.8, fill: c }),
    React.createElement('circle', { cx: 4.4, cy: 15.4, r: 1.8, fill: c }),
    React.createElement('circle', { cx: 19.6, cy: 15.4, r: 1.8, fill: c })
  )
}

function applyClient(ctx) {
  const slots = ctx.slots

  function readColorScheme() {
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
  function accent(name, fallback) { return 'var(' + name + ',' + fallback + ')' }

  function reportError(e, where) {
    try {
      const m = String(e && e.message ? e.message : e)
      const st = String(e && e.stack ? e.stack : '')
      host.call('clientError', { message: m, stack: st, where: String(where || '') }).catch(function () {})
    } catch (e2) {}
  }

  function Panel() {
    const [state, setState] = React.useState(null)
    const [busy, setBusy] = React.useState('')
    const [error, setError] = React.useState(null)
    const [info, setInfo] = React.useState(null)
    const [selected, setSelected] = React.useState(null)
    const [tab, setTab] = React.useState('graph')
    const [result, setResult] = React.useState(null)
    const [newValue, setNewValue] = React.useState('')
    const [filter, setFilter] = React.useState('')
    const [positions, setPositions] = React.useState({})
    const [drawer, setDrawer] = React.useState('')
    const [showAdd, setShowAdd] = React.useState(true)
    const [showList, setShowList] = React.useState(true)
    const [showLog, setShowLog] = React.useState(true)
    const [viewBox, setViewBox] = React.useState({ x: 0, y: 0, w: VW, h: VH })
    const [showEdgeLabels, setShowEdgeLabels] = React.useState(false)
    const [importText, setImportText] = React.useState('')
    const [importFormat, setImportFormat] = React.useState('auto')
    const dragRef = React.useRef(null)
    const svgRef = React.useRef(null)
    const logRef = React.useRef(null)
    const toolsTriedRef = React.useRef(false)
    const vbRef = React.useRef(viewBox)
    vbRef.current = viewBox
    const scheme = readColorScheme()

    const refresh = React.useCallback(function () {
      return host.call('snapshot').then(function (s) { setState(s); return s })
        .catch(function (e) { setError(String(e && e.message ? e.message : e)) })
    }, [])

    React.useEffect(function () { refresh() }, [])
    React.useEffect(function () {
      const live = !!(state && state.live && state.live.active)
      return ctx.interval(function () { refresh() }, live ? 900 : 2000)
    }, [state && state.live && state.live.active ? 1 : 0])
    React.useEffect(function () {
      const el = logRef.current
      if (el) el.scrollTop = el.scrollHeight
    }, [state && state.log ? state.log.length : 0, state && state.live ? (state.live.reasoning || '').length + (state.live.text || '').length : 0])

    React.useEffect(function () {
      if (typeof window === 'undefined' || !window.addEventListener) return undefined
      const onErr = function (ev) { reportError((ev && ev.error) || (ev && ev.message) || 'window.onerror', 'window.error') }
      const onRej = function (ev) { reportError((ev && ev.reason) || 'unhandledrejection', 'unhandledrejection') }
      window.addEventListener('error', onErr)
      window.addEventListener('unhandledrejection', onRej)
      return function () {
        window.removeEventListener('error', onErr)
        window.removeEventListener('unhandledrejection', onRej)
      }
    }, [])

    React.useEffect(function () {
      if (!state) return
      const have = state.toolCatalog ? state.toolCatalog.length : 0
      if (have > 0 || toolsTriedRef.current) return
      toolsTriedRef.current = true
      host.call('mcpTools', { refresh: false }).then(function (r) {
        if (r && r.snapshot) setState(r.snapshot)
      }).catch(function () {})
    }, [state ? (state.toolCatalog ? state.toolCatalog.length : -1) : -2])

    React.useEffect(function () {
      const el = svgRef.current
      if (!el || tab !== 'graph') return undefined
      const onWheel = function (ev) {
        try { ev.preventDefault() } catch (e) {}
        const vb = vbRef.current
        const rect = el.getBoundingClientRect()
        if (!rect.width || !rect.height) return
        const px = vb.x + ((ev.clientX - rect.left) / rect.width) * vb.w
        const py = vb.y + ((ev.clientY - rect.top) / rect.height) * vb.h
        const k = ev.deltaY > 0 ? 1.12 : 0.893
        const nw = Math.max(MIN_W, Math.min(MAX_W, vb.w * k))
        const nh = nw * (VH / VW)
        setViewBox({ x: px - (px - vb.x) * (nw / vb.w), y: py - (py - vb.y) * (nh / vb.h), w: nw, h: nh })
      }
      el.addEventListener('wheel', onWheel, { passive: false })
      return function () { el.removeEventListener('wheel', onWheel) }
    }, [tab])

    function run(label, fn) {
      setBusy(label)
      return Promise.resolve().then(fn)
        .catch(function (e) {
          reportError(e, 'run:' + label)
          setError(String(e && e.message ? e.message : e))
        })
        .then(function (r) { setBusy(''); return r })
    }

    const assets = state ? state.assets : []
    const edges = state ? state.edges : []
    const trash = state && Array.isArray(state.trash) ? state.trash : []
    const logs = state && Array.isArray(state.log) ? state.log : []
    const live = state && state.live && state.live.active ? state.live : null
    const prog = state && state.meta && state.meta.progress ? state.meta.progress : null
    const catalog = state && Array.isArray(state.toolCatalog) ? state.toolCatalog : []
    const projects = state && Array.isArray(state.projects) ? state.projects : []
    const activeProject = state ? String(state.activeProjectId || '') : ''
    const followWs = !!(state && state.settings && state.settings.followWorkspace)
    const activeProjectObj = projects.filter(function (p) { return p.id === activeProject })[0] || null
    const activePath = activeProjectObj && activeProjectObj.path ? String(activeProjectObj.path) : ''
    const enriching = !!(state && state.meta && state.meta.enriching)
    const runInfo = state && state.meta && state.meta.run ? state.meta.run : null
    const runState = runInfo && runInfo.state ? String(runInfo.state) : 'idle'
    const runLive = runState === 'searching' || runState === 'judging'
    const runEndedAt = runInfo && runInfo.endedAt ? runInfo.endedAt : 0
    const runElapsed = runInfo && runInfo.startedAt ? Math.max(0, (runEndedAt || Date.now()) - runInfo.startedAt) : 0
    const jinaKey = state && state.settings ? String(state.settings.jinaKey || '').trim() : ''
    const pickedTools = state && state.settings && Array.isArray(state.settings.jinaTools) ? state.settings.jinaTools : []
    const autoModel = !!(state && state.settings && state.settings.autoModel)
    const jinaReady = jinaKey.length > 0
    const keyPrefixOk = jinaKey.indexOf(KEY_PREFIX) === 0

    const allScope = activeProject === ALL_PROJECT || !activeProject
    const projectAssets = allScope ? assets : assets.filter(function (a) { return String(a.projectId || '') === activeProject })
    const scopeName = allScope ? '全部项目' : (activeProjectObj ? baseOf(activeProjectObj.path || activeProjectObj.name) : '当前项目')
    const visibleIds = {}
    for (const a of projectAssets) visibleIds[a.id] = true
    const shownEdges = edges.filter(function (e) { return visibleIds[e.from] && visibleIds[e.to] })
    const shownAssets = projectAssets

    const layoutKey = shownAssets.map(function (a) { return a.id }).join(',') + '|' + shownEdges.map(function (e) { return e.from + '>' + e.to }).join(',')
    const base = React.useMemo(function () { return forceLayout(shownAssets, shownEdges, VW, VH) }, [layoutKey])
    const pos = React.useMemo(function () {
      const merged = {}
      for (const k of Object.keys(base)) merged[k] = base[k]
      for (const k of Object.keys(positions)) merged[k] = positions[k]
      return merged
    }, [base, positions])
    const degree = React.useMemo(function () {
      const d = {}
      for (const e of shownEdges) { d[e.from] = (d[e.from] || 0) + 1; d[e.to] = (d[e.to] || 0) + 1 }
      return d
    }, [layoutKey])
    const neighbours = React.useMemo(function () {
      const nb = {}
      if (!selected) return nb
      for (const e of edges) {
        if (e.from === selected) (nb[e.to] = nb[e.to] || []).push(e)
        else if (e.to === selected) (nb[e.from] = nb[e.from] || []).push(e)
      }
      return nb
    }, [selected, layoutKey])

    function svgPoint(ev) {
      const el = svgRef.current
      if (!el) return null
      const rect = el.getBoundingClientRect()
      if (!rect.width || !rect.height) return null
      const vb = vbRef.current
      return { x: vb.x + ((ev.clientX - rect.left) / rect.width) * vb.w, y: vb.y + ((ev.clientY - rect.top) / rect.height) * vb.h }
    }
    function onNodeDown(id) {
      return function (ev) {
        ev.stopPropagation()
        try { ev.currentTarget.setPointerCapture(ev.pointerId) } catch (e) {}
        dragRef.current = { kind: 'node', id: id }
        setSelected(id)
      }
    }
    function onBgDown(ev) {
      try { ev.currentTarget.setPointerCapture(ev.pointerId) } catch (e) {}
      const vb = vbRef.current
      dragRef.current = { kind: 'pan', cx: ev.clientX, cy: ev.clientY, vx: vb.x, vy: vb.y }
    }
    function onSvgMove(ev) {
      const d = dragRef.current
      if (!d || !svgRef.current) return
      const rect = svgRef.current.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      if (d.kind === 'pan') {
        const vb = vbRef.current
        setViewBox({ x: d.vx - ((ev.clientX - d.cx) / rect.width) * vb.w, y: d.vy - ((ev.clientY - d.cy) / rect.height) * vb.h, w: vb.w, h: vb.h })
        return
      }
      const p = svgPoint(ev)
      if (!p) return
      setPositions(function (prev) {
        const n = Object.assign({}, prev)
        n[d.id] = { x: Math.max(26, Math.min(VW - 26, p.x)), y: Math.max(26, Math.min(VH - 26, p.y)) }
        return n
      })
    }
    function onSvgUp() { dragRef.current = null }
    function zoomBy(k) {
      const vb = vbRef.current
      const nw = Math.max(MIN_W, Math.min(MAX_W, vb.w * k))
      const nh = nw * (VH / VW)
      const cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2
      setViewBox({ x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh })
    }

    function doAdd() {
      const v = newValue.trim()
      if (!v) return
      const kind = inputKind(v)
      if (!kind) { setError('只能录入 IP 或域名，例如 example.com 或 10.0.0.1'); return }
      setError(null)
      run('add', function () {
        return host.call('addAsset', jsonArgs({ asset: { type: kind, value: v, source: 'user' } })).then(function (r) {
          if (!r) { setError('录入无响应'); return }
          if (r.result && r.result.ok === false) { setError('录入失败：' + String(r.result.error || '未知')); return }
          if (r.snapshot) setState(r.snapshot)
          setNewValue('')
          setInfo('已录入 ' + v + '—— 下一步可点下方「关联分析」')
        })
      })
    }
    function doAddFromResult(a) {
      return host.call('addAsset', jsonArgs({ asset: { type: a && a.type, value: a && a.value, source: 'jina' } })).then(function (r) { if (r && r.snapshot) setState(r.snapshot) })
    }
    function doEnrich() {
      if (!jinaReady) { setError('未配置 Jina API Key —— 检索与关联分析依赖 Jina，请先在设置中填写'); setDrawer('settings'); return }
      run('enrich', function () {
        return host.call('enrich', jsonArgs({ projectId: allScope ? '' : activeProject })).then(function (r) {
          if (r && r.snapshot) setState(r.snapshot)
          if (r && !r.ok) { setError('无法启动关联分析：' + String(r.error || '未知')); if (r.needKey || r.needTools) setDrawer('settings') }
        })
      })
    }
    function doStop() {
      run('stop', function () {
        return host.call('enrichStop').then(function (r) {
          if (r && r.snapshot) setState(r.snapshot)
          if (r && r.ok) setInfo('已请求停止 —— 当前这条检索结束后停下')
          else setError(String((r && r.error) || '无法停止'))
        })
      })
    }
    function doMcpTest() {
      run('mcptest', function () {
        return host.call('mcpTest').then(function (r) {
          if (r && r.snapshot) setState(r.snapshot)
          if (r && r.ok) setInfo('Jina MCP 已连接，当前端点暴露 ' + (r.tools ? r.tools.length : 0) + ' 个工具')
          else setError('Jina MCP 连接失败：' + ((r && r.error) || '未知'))
        })
      })
    }
    function doRefreshTools() {
      run('tools', function () {
        return host.call('mcpTools', { refresh: true }).then(function (r) {
          if (r && r.snapshot) setState(r.snapshot)
          if (!r || !r.ok) { setError('获取工具列表失败：' + ((r && r.error) || '未知')); return }
          setInfo('已刷新：' + r.tools.length + ' 个工具')
        })
      })
    }
    function toggleTool(name) {
      const next = pickedTools.indexOf(name) >= 0
        ? pickedTools.filter(function (x) { return x !== name })
        : pickedTools.concat([name])
      return commitSettings({ jinaTools: next })
    }
    function setToolPreset(list) { return commitSettings({ jinaTools: list }) }
    function doAnalyze() {
      run('analyze', function () {
        return host.call('analyze').then(function (r) {
          if (r && r.snapshot) setState(r.snapshot)
          setResult({ ok: true, via: '本地关联规则完成，当前共 ' + ((r && r.result && r.result.total) || 0) + ' 条关系' })
        })
      })
    }
    function doExport(format) {
      run('export', function () {
        return host.call('exportData', { format: format, write: true }).then(function (r) {
          setResult({
            ok: true, via: '导出 ' + format + (r && r.path ? '（已写入 ' + r.path + '）' : '（仅内存）'),
            content: r && r.content ? String(r.content).slice(0, 3000) : '',
            download: r && r.base64 ? { href: 'data:application/octet-stream;base64,' + r.base64, name: r.filename } : null
          })
        })
      })
    }
    function doImport() {
      const t = importText
      if (!t.trim()) { setError('导入内容为空'); return }
      run('import', function () {
        return host.call('importData', jsonArgs({ text: t, format: importFormat, projectId: allScope ? '' : activeProject })).then(function (r) {
          if (r && r.snapshot) setState(r.snapshot)
          if (!r || !r.ok) { setError('导入失败：' + ((r && r.error) || '未知')); return }
          setInfo('导入完成：新增 ' + r.added + '，合并 ' + r.merged + '，关系 ' + r.edges + '（' + r.format + '）')
          setImportText('')
        })
      })
    }
    function pickFile(ev) {
      const f = ev.target && ev.target.files && ev.target.files[0]
      if (!f) return
      run('file', function () {
        return Promise.resolve().then(function () { return f.text() })
          .then(function (text) { setImportText(String(text)); setInfo('已读取 ' + f.name + '（' + String(text).length + ' 字符），点导入生效') })
          .catch(function (e) { setError('读取文件失败，请直接粘贴内容：' + String(e && e.message ? e.message : e)) })
      })
    }

    function selectProject(id) {
      run('proj', function () { return host.call('projects', { action: 'select', id: String(id || '') }).then(function (r) { if (r && r.snapshot) setState(r.snapshot); setSelected(null) }) })
    }
    function setFollow(v) {
      run('proj', function () { return host.call('projects', { action: 'follow', follow: !!v }).then(function (r) { if (r && r.snapshot) setState(r.snapshot); setSelected(null) }) })
    }
    function doTrash(action, ids) {
      const args = jsonArgs({ action: String(action || ''), ids: Array.isArray(ids) ? ids.map(String) : undefined })
      run('trash:' + action, function () {
        return host.call('trash', args).then(function (r) {
          if (!r) { setError('垃圾箱操作无响应（host 未返回结果）'); return }
          if (r.snapshot) setState(r.snapshot)
          if (!r.ok) { setError('垃圾箱操作失败：' + String(r.error || '未知')); return }
          setInfo(action === 'clear' ? '已清空垃圾箱' : action === 'restore' ? '已恢复' : '已删除')
          setSelected(null)
        })
      })
    }
    function doClearAssets() {
      run('clearAssets', function () {
        return host.call('clearAssets', jsonArgs({ projectId: allScope ? '' : activeProject })).then(function (r) {
          if (!r) { setError('清除无响应（host 未返回结果）'); return }
          if (r.snapshot) setState(r.snapshot)
          if (!r.ok) { setError('清除失败：' + String(r.error || '未知')); return }
          setSelected(null)
          setInfo('已清除 ' + r.changed + ' 个资产（范围：' + scopeName + '）—— 已移入垃圾箱，可恢复')
        })
      })
    }

    function commitPatch(id, patch) {
      return host.call('updateAsset', jsonArgs({ id: id, patch: patch })).then(function (r) { if (r && r.snapshot) setState(r.snapshot) })
    }
    function patchLocal(id, patch) {
      setState(function (s) {
        if (!s) return s
        const n = Object.assign({}, s)
        n.assets = s.assets.map(function (a) { return a.id === id ? Object.assign({}, a, patch) : a })
        return n
      })
    }
    function commitSettings(patch) {
      return host.call('settings', jsonArgs({ patch: patch })).then(function () { return refresh() })
    }
    function saveKey(v) {
      const k = String(v || '').trim()
      if (!k) { setError('Jina API Key 不能为空 —— 本插件的检索与关联分析依赖 Jina'); return Promise.resolve() }
      if (k.indexOf(KEY_PREFIX) !== 0) setInfo('已保存，但密钥通常以 ' + KEY_PREFIX + ' 开头，请确认没有复制错')
      return commitSettings({ jinaKey: k })
    }

    const filtered = shownAssets.filter(function (a) {
      if (!filter.trim()) return true
      const q = filter.trim().toLowerCase()
      return (a.value + ' ' + (a.tags || []).join(' ') + ' ' + (a.note || '')).toLowerCase().indexOf(q) >= 0
    })
    const sel = selected ? assets.filter(function (a) { return a.id === selected })[0] : null
    const selEdges = sel ? edges.filter(function (e) { return e.from === sel.id || e.to === sel.id }) : []
    const selAssoc = assocInfo(sel, selEdges)

    function originText(a) {
      const list = (Array.isArray(a.sources) ? a.sources : []).map(function (s) { return ORIGIN_PHRASE[s] || s })
      const hits = a.hits || 1
      return fmtTime(a.createdAt) + ' 首次录入' +
        (list.length ? '，方式：' + list.join('、') : '') +
        (hits > 1 ? '；其后又被发现 ' + (hits - 1) + ' 次' : '') +
        (typeof a.confidence === 'number' ? '；置信度 ' + a.confidence + '%' : '') + '。'
    }
    function relTag(e) {
      const src = String(e && e.source || 'auto')
      if (src === 'manual') return '人工指定'
      if (src === 'import') return '随导入带入'
      return ''
    }
    function assocInfo(a, list) {
      const byOther = {}
      const order = []
      for (const e of list) {
        const otherId = e.from === a.id ? e.to : e.from
        if (!byOther[otherId]) { byOther[otherId] = { rels: [], tags: [] }; order.push(otherId) }
        const g = byOther[otherId]
        const lab = relLabel(e.relation)
        if (g.rels.indexOf(lab) < 0) g.rels.push(lab)
        const tg = relTag(e)
        if (tg && g.tags.indexOf(tg) < 0) g.tags.push(tg)
      }
      const lines = []
      for (const oid of order) {
        const other = assets.filter(function (x) { return x.id === oid })[0]
        if (!other) continue
        const g = byOther[oid]
        lines.push(other.value + ' —— ' + g.rels.join('、') + (g.tags.length ? '（' + g.tags.join('、') + '）' : ''))
      }
      return { count: lines.length, lines: lines }
    }
    function uniqBasis(list) {
      const out = []
      for (const e of list) { const b = relBasis(e); if (out.indexOf(b) < 0) out.push(b) }
      return out.join('\n')
    }

    function nodeRadius(a) { return Math.min(15, 4.5 + Math.sqrt(degree[a.id] || 0) * 2.4) }
    const hotColor = accent('--dsw-alias-brand-primary', '#4c8dff')

    const edgeEls = []
    for (const e of shownEdges) {
      const p1 = pos[e.from], p2 = pos[e.to]
      if (!p1 || !p2) continue
      const hot = selected && (e.from === selected || e.to === selected)
      edgeEls.push(React.createElement('line', {
        key: e.id, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
        stroke: hot ? hotColor : 'currentColor', strokeOpacity: hot ? 1 : 0.35,
        strokeWidth: hot ? 2 : Math.min(1.6, 0.6 + (e.weight || 1) * 0.25),
        strokeDasharray: e.source === 'auto' ? undefined : '4 3'
      }))
      if (showEdgeLabels && (hot || (e.weight || 1) >= 2)) {
        edgeEls.push(React.createElement('text', {
          key: e.id + '-l', x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 - 2,
          fontSize: 9, fill: 'currentColor', opacity: hot ? 0.95 : 0.55, textAnchor: 'middle',
          style: { pointerEvents: 'none', userSelect: 'none' }
        }, relLabel(e.relation)))
      }
    }
    const nodeEls = shownAssets.map(function (a) {
      const p = pos[a.id]
      if (!p) return null
      const dim = selected && a.id !== selected && !neighbours[a.id]
      const r = nodeRadius(a)
      const color = TYPE_COLOR[a.type] || TYPE_COLOR.other
      const label = a.label || a.value
      return React.createElement('g', { key: a.id, transform: 'translate(' + p.x + ',' + p.y + ')', opacity: dim ? 0.25 : 1 },
        React.createElement('circle', {
          r: r, fill: color, fillOpacity: 0.85,
          stroke: a.id === selected ? hotColor : 'currentColor', strokeOpacity: a.id === selected ? 1 : 0.3,
          strokeWidth: a.id === selected ? 2 : 1,
          style: { cursor: 'grab' }, onPointerDown: onNodeDown(a.id)
        }),
        React.createElement('text', {
          x: r + 4, y: 4, fontSize: 11, fill: 'currentColor', opacity: 0.92,
          style: { pointerEvents: 'none', userSelect: 'none' }
        }, label.length > 28 ? label.slice(0, 27) + '…' : label)
      )
    })

    const projectOpts = [React.createElement('option', { key: ALL_PROJECT, value: ALL_PROJECT }, '全部项目 (' + assets.length + ')')]
    for (const p of projects) {
      const n = assets.filter(function (a) { return String(a.projectId || '') === p.id }).length
      const label = p.path ? baseOf(p.path) : p.name
      projectOpts.push(React.createElement('option', { key: p.id, value: p.id }, label + ' (' + n + ')'))
    }

    const bar = React.createElement('div', { className: 'rt-bar' },
      React.createElement('span', { className: 'rt-title' }, '资产图谱'),
      React.createElement('select', {
        className: 'rt-select', style: { flex: '0 0 190px', width: 190 },
        value: activeProject || ALL_PROJECT,
        title: activePath || '',
        disabled: followWs,
        onChange: function (e) { selectProject(e.target.value) }
      }, projectOpts),
      React.createElement('label', { className: 'rt-note', title: '开启后项目自动跟随当前会话的工作区目录' },
        React.createElement('input', { type: 'checkbox', checked: followWs, onChange: function (e) { setFollow(e.target.checked) } }),
        ' 跟随工作区'),
      React.createElement('span', { className: 'rt-dim' }, shownAssets.length + ' 节点 / ' + shownEdges.length + ' 边'),
      trash.length ? React.createElement('span', { className: 'rt-badge' }, '垃圾箱 ' + trash.length) : null,
      runLive ? React.createElement('span', { className: 'rt-badge rt-badge-warn' }, runState === 'searching' ? '检索中…' : '研判中…') : null,
      jinaReady
        ? React.createElement('span', { className: 'rt-badge rt-badge-ok' }, 'Jina ✓ ' + pickedTools.length + ' 工具')
        : React.createElement('span', { className: 'rt-badge rt-badge-warn', onClick: function () { setDrawer('settings') } }, 'Jina 未配置 · 点此设置'),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('div', { className: 'rt-tabs' },
        React.createElement('button', { className: 'rt-btn' + (tab === 'graph' ? ' rt-on' : ''), onClick: function () { setTab('graph') } }, '网状图'),
        React.createElement('button', { className: 'rt-btn' + (tab === 'table' ? ' rt-on' : ''), onClick: function () { setTab('table') } }, '列表'),
        React.createElement('button', { className: 'rt-btn' + (tab === 'trash' ? ' rt-on' : ''), onClick: function () { setTab('trash') } }, '垃圾箱' + (trash.length ? '(' + trash.length + ')' : ''))),
      React.createElement('button', { className: 'rt-btn' + (drawer === 'data' ? ' rt-on' : ''), onClick: function () { setDrawer(drawer === 'data' ? '' : 'data') } }, '数据'),
      React.createElement('button', { className: 'rt-btn' + (drawer === 'settings' ? ' rt-on' : ''), onClick: function () { setDrawer(drawer === 'settings' ? '' : 'settings') } }, '设置'),
      React.createElement('button', { className: 'rt-btn', onClick: function () { refresh() } }, '刷新')
    )

    const warnBar = state && !jinaReady
      ? React.createElement('div', { className: 'rt-warnbar' },
          React.createElement('span', { style: { flex: 1 } }, '⚠ 未配置 Jina API Key —— 本插件的检索与关联分析依赖 Jina，填好后才能工作'),
          React.createElement('button', { className: 'rt-btn rt-primary', onClick: function () { setDrawer('settings') } }, '去填写'))
      : null

    const addForm = React.createElement('div', { className: 'rt-foldbody' },
      React.createElement('div', { className: 'rt-row', style: { flexWrap: 'nowrap' } },
        React.createElement('input', {
          className: 'rt-input', style: { flex: '1 1 auto' },
          value: newValue, placeholder: 'example.com 或 10.0.0.1',
          onChange: function (e) { setNewValue(e.target.value) },
          onKeyDown: function (e) { if (e.key === 'Enter') doAdd() }
        }),
        React.createElement('button', { className: 'rt-btn rt-primary', disabled: !!busy || !newValue.trim(), onClick: doAdd }, '保存录入')))

    const logItems = logs.map(function (l) {
      return React.createElement('div', { key: l.seq, className: 'rt-l-' + (l.level || 'info') },
        (l.level === 'think' || l.level === 'model' || l.level === 'phase' ? '' : (l.t ? new Date(l.t).toLocaleTimeString() + ' ' : '')) + l.text)
    })
    if (live) {
      logItems.push(React.createElement('div', { key: 'liveblock', className: 'rt-live-inline' },
        live.reasoning ? React.createElement('div', null,
          React.createElement('div', { className: 'rt-sec-label' }, '思考'),
          React.createElement('div', { className: 'rt-l-think' }, live.reasoning)) : null,
        live.tools && live.tools.length ? React.createElement('div', null,
          React.createElement('div', { className: 'rt-sec-label' }, '工具'),
          live.tools.map(function (t, i) {
            return React.createElement('div', { key: i, className: 'rt-live-tool' }, '▸ ' + t.name + (t.args ? ' ' + String(t.args).slice(0, 120) : ''))
          })) : null,
        live.text ? React.createElement('div', null,
          React.createElement('div', { className: 'rt-sec-label' }, '输出'),
          React.createElement('div', { className: 'rt-l-model' }, live.text)) : null,
        !live.reasoning && !live.text && !(live.tools && live.tools.length)
          ? React.createElement('div', { className: 'rt-l-info' }, '已唤醒模型，等待首个输出帧…') : null))
    }

    const RUN_LABEL = { idle: '未运行', searching: '运行中', judging: '运行中', done: '已完成', stopped: '已停止', error: '分析失败' }
    const RUN_MARK = { idle: '○', searching: '●', judging: '●', done: '✓', stopped: '■', error: '✕' }
    const runLine = React.createElement('div', { className: 'rt-run rt-run-' + (runLive ? 'active' : runState) },
      React.createElement('span', { className: 'rt-run-dot' }, RUN_MARK[runState] || '○'),
      React.createElement('span', null,
        (RUN_LABEL[runState] || runState) +
        (runInfo && runInfo.text ? ' · ' + runInfo.text : '') +
        (runElapsed ? ' · ' + (runLive ? '已用 ' : '耗时 ') + fmtDur(runElapsed) : '') +
        (!runLive && runEndedAt ? ' · ' + fmtClock(runEndedAt) : '')))

    const left = React.createElement('div', { className: 'rt-left' },
      React.createElement('div', { className: 'rt-secsec rt-secfirst', style: { flex: '0 0 auto' } },
        React.createElement('div', { className: 'rt-fold', title: '点击收起/展开录入', onClick: function () { setShowAdd(!showAdd) } },
          React.createElement('span', { className: 'rt-foldmark' }, showAdd ? '▾' : '▸'),
          React.createElement('span', { className: 'rt-h', style: { margin: 0 } }, '新增资产')),
        showAdd ? React.createElement('div', { className: 'rt-addbody' }, addForm) : null),

      React.createElement('div', { className: 'rt-secsec', style: { flex: showLog ? '1 1 0' : '0 0 auto' } },
        React.createElement('div', { className: 'rt-row', style: { justifyContent: 'space-between' } },
          React.createElement('div', { className: 'rt-fold', style: { flex: '1 1 auto' }, title: '点击收起/展开日志', onClick: function () { setShowLog(!showLog) } },
            React.createElement('span', { className: 'rt-foldmark' }, showLog ? '▾' : '▸'),
            React.createElement('span', { className: 'rt-h', style: { margin: 0 } }, '关联分析')),
          logs.length ? React.createElement('button', { className: 'rt-btn', onClick: function () { host.call('logClear').then(function (r) { if (r && r.snapshot) setState(r.snapshot) }) } }, '清空日志') : null),
        React.createElement('div', { className: 'rt-row' },
          enriching
            ? React.createElement('button', { className: 'rt-btn rt-danger', disabled: !!busy, onClick: doStop }, busy === 'stop' ? '停止中…' : '停止')
            : React.createElement('button', {
                className: 'rt-btn rt-primary',
                disabled: !!busy || !jinaReady,
                title: jinaReady ? '' : '需先在设置中填写 Jina API Key',
                onClick: doEnrich
              }, '关联分析'),
          React.createElement('button', { className: 'rt-btn', disabled: !!busy, onClick: doAnalyze }, '重建关系'),
          React.createElement('label', { className: 'rt-note', style: { flex: '0 0 auto' } },
            React.createElement('input', { type: 'checkbox', checked: autoModel, onChange: function (e) { commitSettings({ autoModel: e.target.checked }) } }),
            ' 自动研判')),
        runLine,
        prog ? React.createElement('div', { className: 'rt-prog', style: { textAlign: 'left' }, title: prog.text }, prog.text) : null,
        showLog ? React.createElement('div', { className: 'rt-log rt-scroll', ref: logRef, style: { flex: '1 1 auto', minHeight: 76 } },
          logItems.length ? logItems : React.createElement('div', { className: 'rt-l-info' }, '等待任务…')) : null),

      React.createElement('div', { className: 'rt-secsec', style: { flex: showList ? '1 1 0' : '0 0 auto' } },
        React.createElement('div', { className: 'rt-row', style: { justifyContent: 'space-between' } },
          React.createElement('div', { className: 'rt-fold', style: { flex: '1 1 auto' }, title: '点击收起/展开清单', onClick: function () { setShowList(!showList) } },
            React.createElement('span', { className: 'rt-foldmark' }, showList ? '▾' : '▸'),
            React.createElement('span', { className: 'rt-h', style: { margin: 0 } }, '资产清单（' + filtered.length + '）')),
          projectAssets.length ? React.createElement('button', {
            className: 'rt-btn rt-danger', disabled: !!busy, onClick: doClearAssets,
            title: '清除「' + scopeName + '」范围内的全部资产（移入垃圾箱，可恢复）'
          }, '清除所有') : null),
        showList ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 auto', minHeight: 0 } },
          React.createElement('input', { className: 'rt-input', value: filter, placeholder: '过滤…', onChange: function (e) { setFilter(e.target.value) } }),
          React.createElement('div', { className: 'rt-list rt-scroll', style: { flex: '1 1 auto', minHeight: 54 } }, filtered.map(function (a) {
            return React.createElement('div', { key: a.id, className: 'rt-item' + (a.id === selected ? ' rt-sel' : ''), onClick: function () { setSelected(a.id) } },
              React.createElement('span', { className: 'rt-dot', style: { background: TYPE_COLOR[a.type] || '#888' } }),
              React.createElement('span', { className: 'rt-val', title: a.value + (a.note ? '\n' + a.note : '') }, a.value),
              (a.tags || []).slice(0, 2).map(function (t) { return React.createElement('span', { key: t, className: 'rt-tag' }, t) }))
          }))) : null)
    )

    const detailCard = sel
      ? React.createElement('div', { className: 'rt-card' },
          React.createElement('div', { className: 'rt-row', style: { flexWrap: 'nowrap' } },
            React.createElement('span', { className: 'rt-dot', style: { background: TYPE_COLOR[sel.type] || '#888' } }),
            React.createElement('input', { className: 'rt-input', style: { flex: '1 1 auto', fontWeight: 600 }, value: sel.value, onChange: function (e) { patchLocal(sel.id, { value: e.target.value }) }, onBlur: function (e) { commitPatch(sel.id, { value: e.target.value }) } }),
            React.createElement('button', { className: 'rt-btn', onClick: function () { setSelected(null) } }, '×')),
          React.createElement('div', { className: 'rt-desc' },
            React.createElement('div', { className: 'rt-desc-h' }, '来源'),
            React.createElement('div', null, originText(sel)),
            React.createElement('div', { className: 'rt-desc-h', style: { marginTop: 6 } }, '关联资产（' + selAssoc.count + '）'),
            selAssoc.count
              ? React.createElement('div', { title: uniqBasis(selEdges) }, selAssoc.lines.map(function (t, i) {
                  return React.createElement('div', { key: i }, '· ' + t)
                }))
              : React.createElement('div', { className: 'rt-dim' }, '暂无关联')),
          React.createElement('div', { className: 'rt-note' }, '标签'),
          React.createElement('input', { className: 'rt-input', placeholder: '空格分隔', value: (sel.tags || []).join(' '), onChange: function (e) { patchLocal(sel.id, { tags: e.target.value.split(/\s+/).filter(Boolean) }) }, onBlur: function (e) { commitPatch(sel.id, { tags: e.target.value.split(/\s+/).filter(Boolean) }) } }),
          React.createElement('div', { className: 'rt-note' }, '备注 / 证据'),
          React.createElement('textarea', { className: 'rt-textarea', value: sel.note || '', onChange: function (e) { patchLocal(sel.id, { note: e.target.value }) }, onBlur: function (e) { commitPatch(sel.id, { note: e.target.value }) } }),
          React.createElement('div', { className: 'rt-row' },
            React.createElement('button', { className: 'rt-btn rt-danger', onClick: function () { doTrash('delete', [sel.id]) } }, '移入垃圾箱')))
      : null

    let center
    if (tab === 'graph') {
      center = React.createElement('div', { className: 'rt-center', style: { display: 'flex', flexDirection: 'column' } },
        React.createElement('div', { className: 'rt-gctl' },
          React.createElement('button', { className: 'rt-btn', onClick: function () { zoomBy(0.8) } }, '＋'),
          React.createElement('button', { className: 'rt-btn', onClick: function () { zoomBy(1.25) } }, '－'),
          React.createElement('button', { className: 'rt-btn', onClick: function () { setViewBox({ x: 0, y: 0, w: VW, h: VH }); setPositions({}) } }, '重置'),
          React.createElement('button', { className: 'rt-btn' + (showEdgeLabels ? ' rt-on' : ''), onClick: function () { setShowEdgeLabels(!showEdgeLabels) } }, '边标签')),
        React.createElement('svg', {
          ref: svgRef, viewBox: viewBox.x + ' ' + viewBox.y + ' ' + viewBox.w + ' ' + viewBox.h,
          width: '100%', height: '100%', style: { display: 'block', touchAction: 'none', color: 'var(--dsw-alias-label-primary, currentColor)' },
          onPointerMove: onSvgMove, onPointerUp: onSvgUp, onPointerLeave: onSvgUp
        },
          React.createElement('rect', { x: viewBox.x, y: viewBox.y, width: viewBox.w, height: viewBox.h, fill: 'transparent', onPointerDown: onBgDown }),
          React.createElement('g', null, edgeEls),
          React.createElement('g', null, nodeEls)),
        assets.length === 0 ? React.createElement('div', { className: 'rt-empty' }, '该项目暂无资产：在「新增资产」录入，点「数据」导入，或让模型调用 asset_record') : null,
        React.createElement('div', { className: 'rt-hint' }, '滚轮缩放 · 拖背景平移 · 拖节点钉位'),
        detailCard)
    } else if (tab === 'table') {
      center = React.createElement('div', { className: 'rt-center', style: { display: 'flex', flexDirection: 'column' } },
        React.createElement('div', { className: 'rt-tablebar' },
          React.createElement('button', { className: 'rt-btn rt-danger', disabled: !!busy || !projectAssets.length, onClick: doClearAssets }, '清除所有'),
          React.createElement('span', { className: 'rt-dim' }, '清除「' + scopeName + '」内全部资产，移入垃圾箱可恢复')),
        React.createElement('div', { style: { padding: 12, overflow: 'auto', flex: 1 } },
          React.createElement('table', { className: 'rt-table' },
            React.createElement('thead', null, React.createElement('tr', null,
              ['类型', '值', '来源', '置信度', '命中', '项目', '首次发现', '备注'].map(function (h) {
                return React.createElement('th', { key: h }, h)
              }))),
            React.createElement('tbody', null, filtered.map(function (a) {
              return React.createElement('tr', { key: a.id, onClick: function () { setSelected(a.id) } },
                React.createElement('td', null, TYPE_LABEL[a.type] || a.type),
                React.createElement('td', { style: { wordBreak: 'break-all' } }, a.value),
                React.createElement('td', null, (a.sources || []).map(function (s) { return ORIGIN_PHRASE[s] || s }).join('、')),
                React.createElement('td', null, a.confidence),
                React.createElement('td', null, a.hits || 1),
                React.createElement('td', null, (projects.filter(function (p) { return p.id === a.projectId })[0] || {}).name || '-'),
                React.createElement('td', { className: 'rt-dim' }, fmtTime(a.createdAt)),
                React.createElement('td', { className: 'rt-dim' }, String(a.note || '').slice(0, 60)))
            })))),
        detailCard)
    } else {
      center = React.createElement('div', { className: 'rt-center', style: { display: 'flex', flexDirection: 'column' } },
        React.createElement('div', { style: { padding: 12, overflow: 'auto', flex: 1 } },
          React.createElement('div', { className: 'rt-row', style: { marginBottom: 8 } },
            React.createElement('button', { className: 'rt-btn rt-primary', disabled: !!busy || !trash.length, onClick: function () { doTrash('restore') } }, '全部恢复'),
            React.createElement('button', { className: 'rt-btn rt-danger', disabled: !!busy || !trash.length, onClick: function () { doTrash('clear') } }, '清空垃圾箱'),
            React.createElement('span', { className: 'rt-dim' }, '删除的资产先进入这里，可随时找回；清空后不可恢复')),
          React.createElement('div', { className: 'rt-list' }, trash.slice().reverse().map(function (t, i) {
            const a = (t && t.asset) || {}
            const k = (t && t.id) || a.id || ('t' + i)
            return React.createElement('div', { key: k, className: 'rt-item', style: { cursor: 'default' } },
              React.createElement('span', { className: 'rt-dot', style: { background: TYPE_COLOR[a.type] || '#888' } }),
              React.createElement('span', { className: 'rt-val', title: a.value }, String(a.value || '?')),
              React.createElement('span', { className: 'rt-tag' }, TYPE_LABEL[a.type] || a.type || '?'),
              React.createElement('span', { className: 'rt-tag' }, (Array.isArray(a.sources) ? a.sources : []).map(function (s) { return ORIGIN_PHRASE[s] || s }).join('、')),
              React.createElement('span', { className: 'rt-tag' }, '删于 ' + fmtTime(t && t.deletedAt)),
              React.createElement('button', { className: 'rt-btn', disabled: !!busy, onClick: function () { if (t && t.id) doTrash('restore', [t.id]) } }, '恢复'),
              React.createElement('button', { className: 'rt-btn rt-danger', disabled: !!busy, onClick: function () { if (t && t.id) doTrash('purge', [t.id]) } }, '彻底删除'))
          })),
          !trash.length ? React.createElement('div', { className: 'rt-dim' }, '垃圾箱为空') : null)
      )
    }

    const dataEls = []
    if (state) {
      dataEls.push(React.createElement('div', { key: 'h', className: 'rt-h' }, '导出'))
      dataEls.push(React.createElement('div', { key: 'e', className: 'rt-row' },
        React.createElement('button', { className: 'rt-btn', onClick: function () { doExport('json') } }, 'JSON'),
        React.createElement('button', { className: 'rt-btn', onClick: function () { doExport('markdown') } }, 'Markdown'),
        React.createElement('button', { className: 'rt-btn', onClick: function () { doExport('csv') } }, 'CSV')))
      dataEls.push(React.createElement('div', { key: 'en', className: 'rt-note' }, '导出写入 $HOME，并在下方给出下载链接'))
      dataEls.push(React.createElement('div', { key: 'sh', className: 'rt-h' }, '导入'))
      dataEls.push(React.createElement('div', { key: 'd', className: 'rt-note' }, '批量录入走这里（支持本插件导出的 JSON / CSV，或逐行列表）。导入到：' + (activeProjectObj ? baseOf(activeProjectObj.path || activeProjectObj.name) : '当前项目')))
      dataEls.push(React.createElement('select', { key: 'f', className: 'rt-select', value: importFormat, onChange: function (e) { setImportFormat(e.target.value) } },
        React.createElement('option', { value: 'auto' }, '自动识别格式'),
        React.createElement('option', { value: 'json' }, 'JSON'),
        React.createElement('option', { value: 'csv' }, 'CSV'),
        React.createElement('option', { value: 'lines' }, '逐行列表')))
      dataEls.push(React.createElement('input', { key: 'file', type: 'file', accept: '.json,.csv,.txt', onChange: pickFile }))
      dataEls.push(React.createElement('textarea', { key: 't', className: 'rt-textarea', style: { minHeight: 150 }, value: importText, placeholder: '或直接粘贴 JSON / CSV / 每行一个资产', onChange: function (e) { setImportText(e.target.value) } }))
      dataEls.push(React.createElement('div', { key: 'b', className: 'rt-row' },
        React.createElement('button', { className: 'rt-btn rt-primary', disabled: !!busy || !importText.trim(), onClick: doImport }, busy === 'import' ? '导入中…' : '导入'),
        React.createElement('button', { className: 'rt-btn', onClick: function () { setImportText('') } }, '清空')))
      dataEls.push(React.createElement('div', { key: 'res', className: 'rt-h' }, '结果'))
      dataEls.push(React.createElement('div', { key: 'res2', className: 'rt-note' }, result ? (result.ok ? '✓ ' : '✗ ') + String(result.via || result.error || '') : '（无）'))
      if (result && result.download) dataEls.push(React.createElement('a', { key: 'dl', className: 'rt-btn', href: result.download.href, download: result.download.name }, '下载 ' + result.download.name))
      if (result && result.assets && result.assets.length) {
        dataEls.push(React.createElement('div', { key: 'al', className: 'rt-list' }, result.assets.slice(0, 60).map(function (a, i) {
          return React.createElement('div', { key: a.type + i + a.value, className: 'rt-item' },
            React.createElement('span', { className: 'rt-dot', style: { background: TYPE_COLOR[a.type] || '#888' } }),
            React.createElement('span', { className: 'rt-val' }, a.value),
            React.createElement('button', { className: 'rt-btn', onClick: function () { doAddFromResult(a) } }, '入库'))
        })))
      }
      if (result && result.content) dataEls.push(React.createElement('pre', { key: 'c', className: 'rt-pre' }, String(result.content)))
      if (result) dataEls.push(React.createElement('button', { key: 'rc', className: 'rt-btn', onClick: function () { setResult(null) } }, '清除结果'))
    }

    const setEls = []
    if (state) {
      setEls.push(React.createElement('div', { key: 'h2', className: 'rt-h' }, 'Jina（必填）'))
      setEls.push(React.createElement('div', { key: 'j0', className: 'rt-note' }, 'API Key —— 本插件的检索与关联分析依赖 Jina，未填写时「关联分析」不可用'))
      setEls.push(React.createElement('input', { key: 'j1', className: 'rt-input', type: 'password', defaultValue: state.settings.jinaKey, placeholder: 'jina_xxxxxxxxxxxxxxxx', onBlur: function (e) { saveKey(e.target.value) } }))
      if (jinaReady && !keyPrefixOk) setEls.push(React.createElement('div', { key: 'jw', className: 'rt-err' }, '密钥未以 ' + KEY_PREFIX + ' 开头，请确认没有复制错'))
      setEls.push(React.createElement('div', { key: 'j2', className: 'rt-row' },
        React.createElement('button', { key: 'a', className: 'rt-btn', disabled: !!busy, onClick: doMcpTest }, busy === 'mcptest' ? '测试中…' : '测试连接')))

      setEls.push(React.createElement('div', { key: 't0', className: 'rt-row', style: { marginTop: 4 } },
        React.createElement('span', { className: 'rt-h', style: { flex: 1, margin: 0 } }, '工具（按需勾选）'),
        React.createElement('span', { className: 'rt-dim' }, '已选 ' + pickedTools.length + (catalog.length ? ' / 共 ' + catalog.length : ''))))
      setEls.push(React.createElement('div', { key: 't2', className: 'rt-note' },
        '阶段 1 只调用其中一个检索类工具（优先 search_web），只产出候选不写图谱；其余勾选只决定研判阶段模型能看到哪些工具。'))
      setEls.push(React.createElement('div', { key: 't1', className: 'rt-row' },
        React.createElement('button', { key: 'b', className: 'rt-btn', onClick: function () { setToolPreset(TOOL_PRESET_REDTEAM) } }, '红队常用'),
        React.createElement('button', { key: 'c', className: 'rt-btn', onClick: function () { setToolPreset(TOOL_PRESET_SEARCHREAD) } }, '搜索+读取'),
        React.createElement('button', { key: 'd', className: 'rt-btn', onClick: function () { setToolPreset(catalog.map(function (t) { return t.name })) } }, '全选'),
        React.createElement('button', { key: 'e', className: 'rt-btn', onClick: function () { setToolPreset([]) } }, '清空'),
        React.createElement('button', { key: 'f', className: 'rt-btn', disabled: !!busy, onClick: doRefreshTools }, busy === 'tools' ? '…' : '重拉')
      ))
      if (catalog.length) {
        setEls.push(React.createElement('div', { key: 't3', className: 'rt-tools' }, catalog.map(function (t) {
          const on = pickedTools.indexOf(t.name) >= 0
          return React.createElement('label', { key: t.name, className: 'rt-check', title: t.description || '' },
            React.createElement('input', { type: 'checkbox', checked: on, onChange: function () { toggleTool(t.name) } }),
            React.createElement('span', { className: 'rt-tname' }, t.name))
        })))
      } else {
        setEls.push(React.createElement('div', { key: 't4', className: 'rt-note' }, '正在向 Jina 拉取工具列表…'))
      }

      setEls.push(React.createElement('div', { key: 'h4', className: 'rt-h' }, '项目'))
      setEls.push(React.createElement('div', { key: 'w1', className: 'rt-note' },
        '项目就是工作区目录，自动创建、自动删除，不需手动管理。'))
      setEls.push(React.createElement('label', { key: 'w2', className: 'rt-note' },
        React.createElement('input', { type: 'checkbox', checked: followWs, onChange: function (e) { setFollow(e.target.checked) } }),
        ' 跟随当前会话的工作区目录自动切换'))
      setEls.push(React.createElement('div', { key: 'w4', className: 'rt-list' }, projects.map(function (p) {
        const n = assets.filter(function (a) { return String(a.projectId || '') === p.id }).length
        return React.createElement('div', { key: p.id, className: 'rt-item', style: { cursor: 'default' } },
          React.createElement('span', { className: 'rt-dot', style: { background: p.id === activeProject ? 'var(--dsw-alias-brand-primary,#4c8dff)' : 'transparent', border: '1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4))' } }),
          React.createElement('span', { className: 'rt-val', title: p.path || p.name }, p.path ? baseOf(p.path) : p.name),
          React.createElement('span', { className: 'rt-tag' }, n + ' 项'))
      })))

      setEls.push(React.createElement('div', { key: 'h1', className: 'rt-h' }, '存储'))
      setEls.push(React.createElement('div', { key: 'p0', className: 'rt-note' }, '相对路径基于用户主目录，绝对路径直接使用'))
      setEls.push(React.createElement('input', { key: 'p1', className: 'rt-input', defaultValue: state.settings.storePath, onBlur: function (e) { commitSettings({ storePath: e.target.value }) } }))
      setEls.push(React.createElement('div', { key: 'p2', className: 'rt-row' },
        React.createElement('button', { className: 'rt-btn', disabled: !!busy, onClick: function () { run('reload', function () { return host.call('reload').then(function (r) { if (r && r.snapshot) setState(r.snapshot); setViewBox({ x: 0, y: 0, w: VW, h: VH }); setPositions({}); setInfo('已重载：' + ((r && r.snapshot && r.snapshot.meta && r.snapshot.meta.persistence) || '?') + ' ← ' + ((r && r.snapshot && r.snapshot.meta && r.snapshot.meta.storePathAbs) || '')) }) }) } }, '切换路径并重载')))
      setEls.push(React.createElement('div', { key: 'm1', className: 'rt-note' }, '当前: ' + state.meta.persistence + ' → ' + (state.meta.storePathAbs || '(未解析)')))
      setEls.push(React.createElement('div', { key: 'm2', className: 'rt-note' }, '上次保存 ' + fmtTime(state.meta.lastSavedAt)))
      if (state.meta.lastError) setEls.push(React.createElement('div', { key: 'm3', className: 'rt-err' }, state.meta.lastError))

      setEls.push(React.createElement('div', { key: 'h3', className: 'rt-h' }, '采集'))
      setEls.push(React.createElement('label', { key: 'c1', className: 'rt-note' },
        React.createElement('input', { type: 'checkbox', checked: !!state.settings.autoCapture, onChange: function (e) { commitSettings({ autoCapture: e.target.checked }) } }),
        ' 自动从工具结果捕获资产（模型自己搜索出的域名会被当成目标资产，建议保持关闭）'))
      setEls.push(React.createElement('div', { key: 'c2', className: 'rt-note' },
        '「关联分析」现在不会直接入库：阶段 1 只产出候选，由阶段 2 的模型决定登记哪些。内网段（10/8、172.16/12、192.168/16）正常收录，已跳过保留/代理地址段'))
    }

    const body = React.createElement('div', { className: 'rt-body' }, left, center,
      drawer
        ? React.createElement('div', { className: 'rt-drawer' },
            React.createElement('div', { className: 'rt-row' },
              React.createElement('b', { style: { flex: 1 } }, drawer === 'data' ? '导入 / 导出' : '设置'),
              React.createElement('button', { className: 'rt-btn', onClick: function () { setDrawer('') } }, '×')),
            drawer === 'data' ? dataEls : setEls)
        : null)

    return React.createElement('div', { className: 'rt-root', style: { colorScheme: scheme } }, bar, warnBar, body,
      error ? React.createElement('div', { className: 'rt-msgbar' },
        React.createElement('span', { className: 'rt-err' }, '⚠ ' + error),
        React.createElement('button', { className: 'rt-btn', onClick: function () { setError(null) } }, '知道了')) : null,
      info ? React.createElement('div', { className: 'rt-msgbar' },
        React.createElement('span', { className: 'rt-ok' }, '✓ ' + info),
        React.createElement('button', { className: 'rt-btn', onClick: function () { setInfo(null) } }, '知道了')) : null)
  }

  ctx.effect(function () { return styles.insert(CSS) }, 'rtasset: styles')
  ctx.effect(function () {
    return slots.inject('sidebar.panellist', function () {
      return slots.register({ name: 'sidebar.panellist', id: PANEL_KEY, order: 45, label: '资产图谱' }, Glyph)
    })
  }, 'rtasset: panel button')
  ctx.effect(function () {
    return slots.inject('main', function () {
      return slots.register({ name: 'main', key: PANEL_KEY }, Panel)
    })
  }, 'rtasset: main panel')

  console.log('[rtasset] client half ready; panel =', PANEL_KEY)
}

return {
  name: 'redteam-asset-graph',
  inject: ['slots', 'timer'],
  apply: applyClient
}
