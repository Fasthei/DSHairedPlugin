// 常驻（静态）Host 半边。
//
// 主体逻辑与 src/host.js 完全一致（未改一行），差异只在于动态半边的三个符号
// （harness.defineTool / harness.registerTool / harness.handle）在静态包里不存在，
// 因此这里提供一个薄垫片 harness：
//
//   defineTool / registerTool -> @deepseek-ai/dsh-tools 的 defineTool + ctx.tools.register
//   handle                    -> 收进 handlers 表，供宿主 HTTP 路由转发（见 rpcRoute）
//
// 这样做的理由：机械改写 1600 行主体逻辑的风险远高于加一层适配，
// 而且适配层把「动态 ↔ 静态」的差异集中在一个地方，便于日后核对。
import { defineTool } from '@deepseek-ai/dsh-tools'

function applyHost(ctx) {
  const handlers = Object.create(null)
  const harness = {
    defineTool,
    registerTool(c, tool) { return c.tools.register(tool) },
    handle(method, handler) { handlers[method] = handler; return () => { delete handlers[method] } },
  }

const ASSET_TYPES = ['domain', 'ip', 'cidr', 'url', 'port', 'service', 'org', 'email', 'credential', 'hash', 'path', 'repo', 'note', 'other']
const FILE_EXT = ['js','mjs','cjs','ts','tsx','jsx','json','md','txt','png','jpg','jpeg','gif','svg','py','go','rs','rb','php','java','sh','bash','zsh','yml','yaml','html','htm','css','scss','log','csv','zip','tar','gz','tgz','7z','rar','exe','dll','so','dylib','conf','ini','toml','xml','pdf','doc','docx','xls','xlsx','ppt','pptx','mp4','mp3','wav','lock','map','min','d','o','a','h','c','cpp','cs','kt','sql','bak','tmp','old','orig']
const TLD_OK = ['com','net','org','edu','gov','mil','int','info','biz','name','pro','aero','coop','museum','jobs','mobi','travel','asia','cat','tel','xxx','post','app','dev','cloud','tech','online','site','xyz','top','club','vip','shop','store','work','live','life','world','today','space','website','host','press','wiki','link','click','fun','icu','plus','team','group','digital','media','agency','solutions','services','systems','network','software','design','studio','art','blog','news','chat','social','email','codes','tools','zone','city','company','center','support','finance','bank','one','run','page','wang','xin','ren','pub','ltd','inc','llc','care','health','law','legal','tax','money','market','capital','fund','exchange','credit','cards','insurance','realty','properties','estate','rentals','house','land','farm','garden','food','restaurant','cafe','pizza','coffee','wine','beer','buy','sale','deals','discount','coupon','gift','toys','games','play','movie','film','music','band','show','theater','dance','photography','photos','gallery','pictures','video','audio','radio','stream','forum','dating','family','love','crypto','bitcoin','trading','forex','stock','loan','attorney','doctor','dentist','hospital','pharmacy','fitness','gym','yoga','coach','training','education','courses','college','degree','school','academy','institute','university','science','engineering','computer','technology','security','hosting','domains','marketing','consulting','management','accounting','construction','contractors','plumbing','electrician','cleaning','repair','moving','shipping','logistics','transport','taxi','tours','flights','hotel','holiday','vacation','cruise','camp','golf','ski','surf','soccer','football','basketball','baseball','tennis','hockey','racing','motorcycles','cars','auto','trucks','boats','yachts','jet','energy','solar','green','eco','organic','pets','vet','flowers','furniture','kitchen','home','builders','lighting','paint','glass','steel','parts','supply','industrial','machinery','equipment','corp','internal','intranet','lan','local','arpa','localdomain','localhost']
const JS_NOISE = ['message','push','slice','splice','replace','tolowercase','touppercase','indexof','lastindexof','length','foreach','filter','reduce','concat','split','join','trim','test','match','exec','search','keys','values','entries','assign','freeze','create','defineproperty','getownpropertynames','hasownproperty','prototype','constructor','tostring','valueof','then','catch','finally','resolve','reject','apply','call','bind','now','random','floor','ceil','round','parse','stringify','max','min','sort','reverse','pop','shift','unshift','includes','startswith','endswith','padstart','padend','repeat','charat','charcodeat','substring','substr','localecompare','isarray','from','of','map','set','get','has','add','delete','clear','size','name','type','value','data','props','state','args','opts','config','options','result','error','err','json','text','body','head','item','items','list','node','nodes','edge','edges','id','ids','key','path','paths','file','files','dir','url','host','port','user','pass','token','code','line','lines','row','rows','col','cols','width','height','left','right','top','bottom','style','classname','children','parent','first','last','next','prev','count','total','index','offset','limit','start','end','before','after','obj','req','res','ctx','self','this']
const JINA_MCP_BASE = 'https://mcp.jina.ai/v1'
const DEFAULT_TOOLS = ['search_web', 'search_web_deep', 'read_url', 'parallel_read_url']
const STORE_VERSION = 15
const RULES_FILE = '.redteam-asset-graph.rules.md'

function msgOf(e) { return e && e.message ? String(e.message) : String(e) }
function uniq(arr) { const out = []; for (const v of arr) if (v !== undefined && v !== null && v !== '' && out.indexOf(v) < 0) out.push(v); return out }
function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n }
function nowMs() { return Date.now() }
function iso(ms) { try { return new Date(ms).toISOString() } catch (e) { return '' } }
function baseName(p) {
  const parts = String(p || '').split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : String(p || '')
}

function isNonTargetIp(v) {
  const p = String(v || '').split('.')
  if (p.length !== 4) return false
  for (const x of p) if (!/^\d{1,3}$/.test(x)) return false
  const a = Number(p[0]), b = Number(p[1])
  if (a === 0) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

function normalizeValue(type, raw) {
  let v = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!v) return ''
  v = v.replace(/[\u0000-\u001f\u007f]/g, '')
  if (v.length > 500) v = v.slice(0, 500)
  if (type === 'domain' || type === 'url' || type === 'email') v = v.toLowerCase()
  if (type === 'domain') v = v.replace(/^[.`'"\s]+/, '').replace(/[.`'"\s]+$/, '').replace(/:\d+$/, '')
  if (type === 'url') v = v.replace(/[.,;:)\]}'"`]+$/, '').replace(/#$/, '')
  if (type === 'ip') v = v.replace(/^\[/, '').replace(/\]$/, '')
  return v
}

function guessType(value) {
  const v = String(value || '').trim()
  if (/^https?:\/\//i.test(v)) return 'url'
  if (/^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(v)) return 'cidr'
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(v)) return 'ip'
  if (/^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/.test(v)) return 'email'
  if (/^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z]{2,24}$/i.test(v)) return 'domain'
  if (/^\d{1,5}$/.test(v) && Number(v) > 0 && Number(v) <= 65535) return 'port'
  if (/^(?:[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})$/i.test(v)) return 'hash'
  if (/^\/\S*\/\S+/.test(v)) return 'path'
  return 'other'
}

function looksLikeDomain(v) {
  if (typeof v !== 'string' || v.length < 4 || v.length > 253) return false
  const parts = v.split('.')
  if (parts.length < 2) return false
  const tld = parts[parts.length - 1].toLowerCase()
  if (FILE_EXT.indexOf(tld) >= 0) return false
  const twoLetter = tld.length === 2
  if (!twoLetter && TLD_OK.indexOf(tld) < 0) return false
  if (twoLetter && JS_NOISE.indexOf(tld) >= 0) return false
  if (parts.length === 2) {
    const head = parts[0].toLowerCase()
    if (head.length < 2 && !/^\d+$/.test(head)) return false
    if (twoLetter && JS_NOISE.indexOf(head) >= 0) return false
  }
  for (const p of parts) if (!/^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i.test(p)) return false
  return true
}

function validIpv4(v) {
  const parts = String(v).split('.')
  if (parts.length !== 4) return false
  for (const p of parts) { if (!/^\d{1,3}$/.test(p)) return false; if (Number(p) > 255) return false }
  return true
}

function validAssetValue(type, value) {
  const v = String(value || '')
  if (!v) return false
  if (type === 'domain') return looksLikeDomain(v)
  if (type === 'ip') return validIpv4(v)
  if (type === 'url') return /^https?:\/\/[^\s]+$/i.test(v)
  return true
}

const INTEL_TOOLS = ['web_search', 'web_fetch', 'search_web', 'search_web_deep', 'read_url', 'parallel_read_url', 'search_arxiv', 'search_ssrn', 'search_jina_blog', 'search_images', 'search_bibtex', 'capture_screenshot_url']
function isIntelTool(name) {
  if (!name) return false
  if (INTEL_TOOLS.indexOf(name) >= 0) return true
  if (name.indexOf('search_') === 0) return true
  if (name.indexOf('web_') === 0) return true
  return false
}

const CAPTURE_SKIP = ['asset_record','asset_query','asset_remove','cordis_define','cordis_run','cordis_stop','cordis_undefine','cordis_inspect_list','cordis_inspect_query','cordis_inspect_self','skill','todo_write','ask_user_question','job_list','job_output','job_kill','present','exit_plan_mode','write','edit']

function extract(text, limit, evidenceSource) {
  const out = []
  const seen = {}
  const src = String(text === undefined || text === null ? '' : text)
  if (!src) return out
  const cap = typeof limit === 'number' && limit > 0 ? limit : 120
  const ev = evidenceSource ? String(evidenceSource).slice(0, 60) : ''
  const mark = function (type, value) {
    const t = ASSET_TYPES.indexOf(type) >= 0 ? type : 'other'
    const v = normalizeValue(t, value)
    if (v) seen[t + '\u0000' + v] = true
  }
  const push = function (type, value) {
    if (out.length >= cap) return
    const t = ASSET_TYPES.indexOf(type) >= 0 ? type : 'other'
    const v = normalizeValue(t, value)
    if (!v) return
    if (t === 'ip' && !validIpv4(v)) return
    if (t === 'domain' && !looksLikeDomain(v)) return
    const key = t + '\u0000' + v
    if (seen[key]) return
    seen[key] = true
    out.push({ type: t, value: v, evidence: ev })
  }
  let m
  let re = /\b(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}\b/g
  while ((m = re.exec(src)) && out.length < cap) { push('cidr', m[0]); mark('ip', String(m[0]).split('/')[0]) }
  re = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g
  while ((m = re.exec(src)) && out.length < cap) push('ip', m[0])
  re = /\bhttps?:\/\/[^\s'"<>()\[\]{},;|\\]+/gi
  while ((m = re.exec(src)) && out.length < cap) push('url', m[0])
  re = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}\b/gi
  while ((m = re.exec(src)) && out.length < cap) push('email', m[0])
  re = /\b(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z]{2,24}\b/gi
  while ((m = re.exec(src)) && out.length < cap) { if (looksLikeDomain(m[0])) push('domain', m[0]) }
  re = /\b(?:[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})\b/gi
  while ((m = re.exec(src)) && out.length < cap) push('hash', m[0])
  return out
}

function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  const s = String(text)
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i)
    if (quoted) {
      if (c === '"') { if (s.charAt(i + 1) === '"') { cell += '"'; i++ } else quoted = false }
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (c !== '\r') cell += c
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row) }
  return rows
}

function detectFormat(text, hint) {
  const h = String(hint || 'auto')
  if (h !== 'auto') return h
  const t = String(text).trim()
  if (t.charAt(0) === '{' || t.charAt(0) === '[') return 'json'
  const first = t.split('\n')[0] || ''
  if (first.indexOf(',') >= 0 && /type|value|类型|资产|domain|ip/i.test(first)) return 'csv'
  return 'lines'
}

function parseImport(text, format) {
  const s = String(text)
  if (format === 'json') {
    const doc = JSON.parse(s)
    const list = Array.isArray(doc) ? doc : (doc && Array.isArray(doc.assets) ? doc.assets : [])
    const assets = []
    const idToValue = {}
    for (const a of list) {
      if (typeof a === 'string') { assets.push({ value: a }); continue }
      if (a === null || typeof a !== 'object') continue
      const value = String(a.value === undefined ? '' : a.value)
      if (!value) continue
      if (a.id !== undefined) idToValue[String(a.id)] = a.value
      assets.push({ type: a.type, value: value, label: a.label, note: a.note, tags: a.tags, confidence: a.confidence })
    }
    const edges = []
    const rawEdges = doc && Array.isArray(doc.edges) ? doc.edges : []
    for (const e of rawEdges) {
      if (e === null || typeof e !== 'object') continue
      const fv = idToValue[String(e.from)] || String(e.from === undefined ? '' : e.from)
      const tv = idToValue[String(e.to)] || String(e.to === undefined ? '' : e.to)
      if (fv && tv) edges.push({ fromValue: fv, toValue: tv, relation: e.relation })
    }
    return { assets: assets, edges: edges }
  }
  if (format === 'csv') {
    const rows = parseCsv(s)
    if (rows.length === 0) return { assets: [], edges: [] }
    const head = rows[0].map(function (h) { return String(h).trim().toLowerCase() })
    const col = function (names) { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i } return -1 }
    const cValue = col(['value','值','资产','asset'])
    const cType = col(['type','类型'])
    const cLabel = col(['label','名称','name'])
    const cConf = col(['confidence','置信度'])
    const cTags = col(['tags','标签'])
    const cNote = col(['note','备注'])
    const assets = []
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r]
      const v = cValue >= 0 ? String(row[cValue] === undefined ? '' : row[cValue]).trim() : String(row[0] === undefined ? '' : row[0]).trim()
      if (!v) continue
      assets.push({
        type: cType >= 0 && row[cType] ? String(row[cType]).trim() : undefined,
        value: v,
        label: cLabel >= 0 && row[cLabel] ? String(row[cLabel]) : '',
        confidence: cConf >= 0 && row[cConf] ? Number(row[cConf]) : undefined,
        tags: cTags >= 0 && row[cTags] ? String(row[cTags]).split(/[|,;\s]+/).filter(Boolean) : [],
        note: cNote >= 0 && row[cNote] ? String(row[cNote]) : ''
      })
    }
    return { assets: assets, edges: [] }
  }
  const assets = []
  for (const line of s.split(/\r?\n/)) {
    const v = line.trim()
    if (!v || v.charAt(0) === '#') continue
    const parts = v.split(/\s*[\t|]\s*/)
    if (parts.length === 2 && ASSET_TYPES.indexOf(parts[0].trim()) >= 0) assets.push({ type: parts[0].trim(), value: parts[1].trim() })
    else assets.push({ value: v })
  }
  return { assets: assets, edges: [] }
}

function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'" }

function parseMcpReply(text) {
  const s = String(text)
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim()
    if (t.indexOf('data:') !== 0) continue
    const payload = t.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let obj = null
    try { obj = JSON.parse(payload) } catch (e) { continue }
    if (obj && obj.error) throw new Error('MCP 错误：' + JSON.stringify(obj.error).slice(0, 300))
    if (obj && obj.result) return obj.result
  }
  try {
    const obj = JSON.parse(s)
    if (obj && obj.error) throw new Error('MCP 错误：' + JSON.stringify(obj.error).slice(0, 300))
    if (obj && obj.result) return obj.result
  } catch (e) { if (String(e && e.message || '').indexOf('MCP 错误') === 0) throw e }
  throw new Error('无法解析 MCP 响应：' + s.slice(0, 200))
}

function mcpText(result) {
  const parts = []
  const content = result && Array.isArray(result.content) ? result.content : []
  for (const c of content) if (c && typeof c.text === 'string') parts.push(c.text)
  if (parts.length === 0 && result && result.structuredContent) {
    try { parts.push(JSON.stringify(result.structuredContent)) } catch (e) {}
  }
  return parts.join('\n')
}

function mcpEmpty(result) {
  const c = result && Array.isArray(result.content) ? result.content : null
  return c === null || c.length === 0
}

function isTrashEntry(t) { return !!t && typeof t === 'object' && !!t.asset && typeof t.asset === 'object' }

function blankStore() {
  return {
    version: STORE_VERSION, updatedAt: 0, projects: [],
    assets: [], edges: [], trash: [], log: [], logSeq: 0, toolCatalog: [], candidates: [],
    settings: {
      jinaKey: '', jinaTools: DEFAULT_TOOLS.slice(), autoModel: true, autoCapture: false,
      followWorkspace: true, storePath: '.redteam-assets.json', activeProjectId: ''
    },
    meta: { storePathAbs: null, persistence: 'memory', lastError: null, lastSavedAt: 0, captured: 0, enriching: false, progress: null, run: { state: 'idle', text: '', startedAt: 0, endedAt: 0 } }
  }
}

function applyHost(ctx) {
  const store = blankStore()
  let seq = 1
  let writeChain = Promise.resolve()
  let loaded = false
  let lastAgent = null

  let liveActive = false
  let live = { reasoning: '', text: '', tools: [] }
  let liveLastFrameAt = 0
  let enrichCancelled = false
  let noiseNoticeLogged = false

  const toolsInFlight = {}

  function nextId(prefix) { return prefix + (seq++).toString(36) + '-' + nowMs().toString(36) }
  function touch() { store.updatedAt = nowMs() }
  function runActive() {
    const s = store.meta.run && store.meta.run.state
    return s === 'searching' || s === 'judging'
  }
  function setRun(state, text) {
    const prev = store.meta.run && typeof store.meta.run === 'object' ? store.meta.run : {}
    const terminal = state === 'done' || state === 'stopped' || state === 'error' || state === 'idle'
    store.meta.run = {
      state: state,
      text: text === undefined ? String(prev.text || '') : String(text).slice(0, 200),
      startedAt: state === 'searching' ? nowMs() : (prev.startedAt || nowMs()),
      endedAt: terminal ? nowMs() : 0
    }
    store.meta.enriching = state === 'searching' || state === 'judging'
    touch()
  }
  function log(level, text) {
    store.logSeq++
    store.log.push({ seq: store.logSeq, t: nowMs(), level: level, text: String(text).slice(0, 1600) })
    if (store.log.length > 300) store.log = store.log.slice(store.log.length - 300)
  }
  function logFailure(prefix, e, extra) {
    log('err', prefix + '：' + msgOf(e) + (extra ? ' [' + extra + ']' : ''))
    const st = e && e.stack ? String(e.stack) : ''
    if (st) {
      const lines = st.split('\n').slice(0, 10)
      for (let i = 0; i < lines.length; i++) log('err', '    ' + lines[i].trim().slice(0, 400))
    }
  }
  function logBlock(level, text) {
    const s = String(text === undefined || text === null ? '' : text).trim()
    if (!s) return
    for (const part of s.split(/\n{2,}/)) {
      const t = part.trim()
      if (!t) continue
      if (t.length <= 1500) { log(level, t); continue }
      for (let i = 0; i < t.length; i += 1500) log(level, t.slice(i, i + 1500))
    }
  }
  function resetLive() { liveActive = false; live = { reasoning: '', text: '', tools: [] }; liveLastFrameAt = 0 }
  function startLive() { liveActive = true; live = { reasoning: '', text: '', tools: [] }; liveLastFrameAt = nowMs() }
  function finishLive() {
    if (!liveActive) return
    liveActive = false
    const judged = live.reasoning.length > 0 || live.text.length > 0 || live.tools.length > 0
    if (live.reasoning) logBlock('think', live.reasoning)
    if (live.text) logBlock('model', live.text)
    live = { reasoning: '', text: '', tools: [] }
    liveLastFrameAt = 0
    if (runActive()) {
      if (judged) {
        const n = settleCandidates()
        log('ok', '模型研判结束' + (n > 0 ? '：' + n + ' 条候选未获采纳，已出待研判池（排除理由见推理）' : ''))
      } else {
        const r = requeueCandidates()
        log('warn', '模型研判未产生输出：' + r.requeued + ' 条候选退回待研判' + (r.dropped > 0 ? '，' + r.dropped + ' 条重推 ' + REQUEUE_MAX + ' 次未果已出池' : ''))
      }
      setRun('done', '模型研判结束')
    }
    touch()
    persist()
  }

  function findAsset(id) { for (const a of store.assets) if (a.id === id) return a; return null }
  function findProject(id) { for (const p of store.projects) if (p.id === id) return p; return null }
  function findAssetByValue(type, value) { for (const a of store.assets) if (a.type === type && a.value === value) return a; return null }
  function findAssetByValueLoose(value) { for (const a of store.assets) if (a.value === value) return a; return null }
  function jinaKey() { return String(store.settings.jinaKey || '').trim() }
  function jinaTools() { return Array.isArray(store.settings.jinaTools) ? store.settings.jinaTools : [] }

  function rememberAgent(exec) {
    try { if (exec && exec.agent) lastAgent = exec.agent } catch (e) {}
  }
  function findAgent() {
    if (lastAgent) return lastAgent
    const agents = ctx.get('agents')
    if (agents === undefined || agents === null) return null
    try {
      const current = typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : null
      if (current) return current
    } catch (e) {}
    try {
      const roots = agents.roots()
      if (Array.isArray(roots) && roots.length === 1) return roots[0]
      const all = agents.list()
      if (Array.isArray(all) && all.length > 0) return all[0]
    } catch (e) {}
    return null
  }

  function currentWorkspacePath() {
    const reg = ctx.get('workspaceRegistry')
    if (!reg || typeof reg.list !== 'function') return ''
    const agent = findAgent()
    if (!agent) return ''
    try {
      const sid = String(agent.id)
      const list = reg.list()
      if (!Array.isArray(list)) return ''
      for (const w of list) {
        const ids = w && Array.isArray(w.sessionIds) ? w.sessionIds : []
        for (const x of ids) if (String(x) === sid) return String(w.path || '')
      }
    } catch (e) {}
    return ''
  }

  function syncWorkspaces() {
    try {
      const reg = ctx.get('workspaceRegistry')
      if (!reg || typeof reg.list !== 'function') return 0
      let list = null
      try {
        const raw = reg.list()
        if (Array.isArray(raw)) list = raw
      } catch (e) {}
      if (!list || list.length === 0) return 0

      let changed = 0
      const live = {}
      for (const w of list) {
        const path = String(w && w.path || '')
        if (!path) continue
        live[path] = true
        let hit = null
        for (const p of store.projects) if (p.path === path) { hit = p; break }
        if (hit) continue
        store.projects.push({
          id: nextId('p'),
          name: String(w.title || baseName(path) || path).slice(0, 60),
          path: path,
          createdAt: nowMs()
        })
        changed++
      }

      const keep = []
      const doomed = {}
      for (const p of store.projects) {
        if (p.path && live[p.path]) { keep.push(p); continue }
        doomed[p.id] = true
        changed++
      }
      if (Object.keys(doomed).length > 0) {
        let trashed = 0
        for (const a of store.assets) {
          if (!doomed[a.projectId]) continue
          store.trash.push({ id: a.id, asset: a, deletedAt: nowMs() })
          trashed++
        }
        if (store.trash.length > 2000) store.trash = store.trash.slice(store.trash.length - 2000)
        store.assets = store.assets.filter(function (a) { return !doomed[a.projectId] })
        const alive = {}
        for (const a of store.assets) alive[a.id] = true
        store.edges = store.edges.filter(function (e) { return alive[e.from] && alive[e.to] })
        store.projects = keep
        if (trashed > 0) log('warn', '工作区已删除，' + trashed + ' 个资产移入垃圾箱')
      }
      if (changed > 0) touch()
      return changed
    } catch (e) {
      logFailure('syncWorkspaces 失败', e, '项目同步')
      return 0
    }
  }

  function effectiveProjectId() {
    if (store.settings.followWorkspace) {
      const path = currentWorkspacePath()
      if (path) {
        for (const p of store.projects) if (p.path === path) return p.id
      }
    }
    if (findProject(store.settings.activeProjectId)) return store.settings.activeProjectId
    return store.projects.length ? store.projects[0].id : ''
  }

  function ensureProjects() {
    let changed = 0
    if (!Array.isArray(store.projects)) store.projects = []
    changed += syncWorkspaces()
    if (store.settings.followWorkspace) {
      const cur = effectiveProjectId()
      if (cur && cur !== store.settings.activeProjectId) { store.settings.activeProjectId = cur; changed++ }
    }
    if (store.projects.length === 0) { store.projects.push({ id: 'p-default', name: '默认项目', path: null, createdAt: nowMs() }); changed++ }
    if (!findProject(store.settings.activeProjectId)) store.settings.activeProjectId = store.projects[0].id
    for (const a of store.assets) if (!a.projectId || !findProject(a.projectId)) a.projectId = store.projects[0].id
    return changed
  }

  function mcpUrl() {
    const sel = jinaTools()
    if (!sel.length) return JINA_MCP_BASE
    return JINA_MCP_BASE + '?include_tools=' + sel.join(',')
  }
  function pickSearchTool() {
    const sel = jinaTools()
    if (!sel.length) return 'search_web'
    if (sel.indexOf('search_web') >= 0) return 'search_web'
    if (sel.indexOf('search_web_deep') >= 0) return 'search_web_deep'
    for (const n of sel) if (n.indexOf('search') === 0) return n
    return ''
  }

  async function mcpPost(bodyObj, timeoutMs, urlOverride) {
    const shell = ctx.get('shell')
    if (shell === undefined || shell === null) throw new Error('shell 服务不可用')
    const t = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 60000
    const body = JSON.stringify(bodyObj)
    const key = jinaKey()
    const target = urlOverride || mcpUrl()
    const parts = [
      'curl -sS -m ' + Math.ceil(t / 1000),
      '-X POST ' + shQuote(target),
      '-H ' + shQuote('Content-Type: application/json'),
      '-H ' + shQuote('Accept: application/json, text/event-stream')
    ]
    if (key) parts.push('-H ' + shQuote('Authorization: Bearer ' + key))
    parts.push('--data-binary ' + shQuote(body))
    const spec = shell.resolve({ command: parts.join(' '), timeoutMs: t + 8000, stdoutMaxBytes: 900000 })
    const res = await shell.run(spec)
    const stdout = res && res.stdout ? res.stdout.text : ''
    if (res && res.timedOut) throw new Error('curl 超时（' + Math.round(t / 1000) + 's）')
    if (res && res.exitCode !== 0) throw new Error('curl 退出码 ' + res.exitCode + '：' + String(res.stderr && res.stderr.text || '').slice(0, 200))
    return parseMcpReply(stdout)
  }

  async function mcpCall(tool, args, timeoutMs) {
    return await mcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args || {} } }, timeoutMs)
  }
  async function mcpToolList(urlOverride) {
    const r = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, 30000, urlOverride)
    const list = r && Array.isArray(r.tools) ? r.tools : []
    return list.map(function (t) {
      return { name: String(t && t.name || ''), description: String(t && t.description || '').slice(0, 260) }
    }).filter(function (t) { return t.name })
  }
  function mcpToolListShared(urlOverride) {
    const target = urlOverride || mcpUrl()
    if (toolsInFlight[target]) return toolsInFlight[target]
    const p = mcpToolList(urlOverride).then(
      function (v) { delete toolsInFlight[target]; return v },
      function (e) { delete toolsInFlight[target]; throw e }
    )
    toolsInFlight[target] = p
    return p
  }

  async function searchOnce(tool, query) {
    const res = await mcpCall(tool, { query: query }, 60000)
    return { empty: mcpEmpty(res), text: mcpText(res) }
  }

  function enrichQuery(a) {
    return String(a && a.value || '')
  }

  function dumpCandidates(list) {
    if (!list.length) return
    for (let i = 0; i < list.length; i += 6) {
      const chunk = list.slice(i, i + 6).map(function (c) { return c.value })
      log('info', '  候选：' + chunk.join('、'))
    }
  }

  function buildEnrichPrompt(project, pool, candidates, rules, source) {
    const L = []
    L.push(source === 'capture'
      ? '以下候选来自**工具输出的自动捕获**（不是 Jina 检索），只在待研判池里，**没有写入图谱**。'
      : '第一阶段（Jina 检索）已完成。检索只产出候选，**没有写入图谱**。')
    L.push('')
    L.push('已知资产（图谱现有 ' + pool.length + ' 个）：')
    for (const a of pool.slice(0, 60)) L.push('- [' + a.type + '] ' + a.value)
    if (pool.length > 60) L.push('- …其余 ' + (pool.length - 60) + ' 个')
    L.push('')
    if (candidates.length) {
      L.push('检索候选（' + candidates.length + ' 个，均未入库）：')
      for (const c of candidates.slice(0, 120)) L.push('- [' + c.type + '] ' + c.value + (source === 'capture' ? '（来自 ' + c.from + ' 输出）' : '（来自对 ' + c.from + ' 的检索）'))
      if (candidates.length > 120) L.push('- …其余 ' + (candidates.length - 120) + ' 个')
    } else {
      L.push('检索候选：无。')
    }
    L.push('')
    L.push(String(rules || defaultRules()))
    L.push('')
    L.push('请边推理边说明依据；你的思考与输出会被记录到资产图谱面板的日志里。')
    return L.join('\n')
  }

  function defaultRules() {
    const L = []
    L.push('你的任务：筛掉与目标无关的候选，**只把相关的登记进图谱**。')
    L.push('')
    L.push('最高准则：图谱里只允许存在与目标相关的资产。任何与此冲突的做法一律作废。')
    L.push('')
    L.push('每条候选只有三种去向：')
    L.push('1. 与目标相关 → 调用 asset_record 登记；能归属到同一主体的，用 relay + relation 连到对应的已知资产（同域子域、同组织账号、同 IP、同网段）。')
    L.push('2. 可能相关但无法确证 → 调用 asset_record 登记，加 tag「待验证」，note 写明具体疑点和你的假设。只有能说出它为何可能与目标有关时才走这条。')
    L.push('3. 确认与目标无关 → **不要调用任何工具**，直接排除，并在推理里说明排除理由。排除理由会随推理写入图谱日志，审计链不会丢。')
    L.push('')
    L.push('无关候选包括但不限于：同名但无关的组织、社交平台页面、whois/教程类通用服务域名、搜索引擎自身域名、无关企业站点。')
    L.push('')
    L.push('两条硬性禁止（上一版在这里出过错）：')
    L.push('- 不要把无关候选登记进图谱，也不要「先登记再删」，更不要用 asset_remove 来留档 —— 那只会让图谱变脏；排除理由写在推理里就是完整审计。')
    L.push('- asset_remove 只有一个用途：清理**已经存在于图谱中**、且经你确认是误报的资产，并在 reason 里写明理由（进垃圾箱，可恢复）。')
    L.push('')
    L.push('需要外部查证时用检索类工具（web_search，或设置里已加载的 Jina 检索工具）。本环境的 web_fetch 不可用，不要调用。不要臆造。')
    L.push('')
    L.push('结束时输出两部分，各自独立成段：')
    L.push('- 「收录清单」：登记了哪些、各自依据。')
    L.push('- 「排除清单」：被排除的候选逐个列出，每个一行，格式「资产值 —— 排除理由」。')
    return L.join('\n')
  }

  async function enrichRules() {
    const fallback = { text: defaultRules(), source: 'builtin' }
    try {
      const fs = ctx.get('fs')
      if (fs === undefined || fs === null) return fallback
      const target = await fs.resolve(RULES_FILE)
      const info = await fs.stat(target)
      if (!info) return fallback
      const t = String(await fs.readText(target) || '').trim()
      if (!t) return fallback
      return { text: t, source: RULES_FILE }
    } catch (e) { return fallback }
  }

  async function handoffToModel(project, candidates, source) {
    const pool = project ? store.assets.filter(function (a) { return a.projectId === project.id }) : []
    if (pool.length === 0) { log('warn', '无可研判资产，跳过模型阶段'); return false }
    const agent = findAgent()
    if (!agent) {
      log('err', '找不到可唤醒的会话 Agent，无法研判 —— 候选未入库，以下为候选清单（可手动录入）')
      dumpCandidates(candidates)
      return false
    }
    const rules = await enrichRules()
    log('info', '研判规则来源：' + (rules.source === 'builtin' ? '内置默认' : rules.source))
    const text = buildEnrichPrompt(project, pool, candidates, rules.text, source)
    const base = { id: 'rt-' + nowMs().toString(36) + '-' + Math.random().toString(36).slice(2, 8), role: 'user', content: [{ type: 'text', text: text }] }
    startLive()
    try {
      agent.followup(Object.assign({}, base, { source: { kind: 'plugin', plugin: 'redteam-asset-graph' } }))
    } catch (e1) {
      try {
        agent.followup(Object.assign({}, base, { id: base.id + 'b', source: { kind: 'user' } }))
      } catch (e2) {
        resetLive()
        log('err', '唤醒模型失败：' + msgOf(e2) + ' —— 候选未入库')
        dumpCandidates(candidates)
        return false
      }
    }
    return true
  }

  function addAsset(input) {
    const raw = input && typeof input === 'object' ? input : {}
    const value0 = normalizeValue('other', raw.value)
    if (!value0) return { ok: false, error: '资产值为空' }
    const type = ASSET_TYPES.indexOf(raw.type) >= 0 ? raw.type : guessType(value0)
    const value = normalizeValue(type, value0)
    const now = nowMs()
    const wanted = raw.projectId ? String(raw.projectId) : effectiveProjectId()
    const projectId = wanted && findProject(wanted) ? wanted : (store.settings.activeProjectId || null)
    dropCandidate(type, value)
    const existing = findAssetByValue(type, value)
    if (existing) {
      if (raw.note) existing.note = (existing.note ? existing.note + '\n' : '') + String(raw.note).slice(0, 4000)
      if (raw.label) existing.label = String(raw.label).slice(0, 200)
      if (Array.isArray(raw.tags)) existing.tags = uniq(existing.tags.concat(raw.tags.map(function (t) { return String(t).slice(0, 40) }))).slice(0, 20)
      if (typeof raw.confidence === 'number') existing.confidence = clamp(Math.round(raw.confidence), 0, 100)
      if (raw.source) existing.sources = uniq(existing.sources.concat([String(raw.source).slice(0, 60)]))
      existing.hits = (existing.hits || 1) + 1
      existing.updatedAt = now
      touch()
      return { ok: true, asset: existing, created: false }
    }
    const asset = {
      id: nextId('a'), projectId: projectId, type: type, value: value,
      label: raw.label ? String(raw.label).slice(0, 200) : '',
      note: raw.note ? String(raw.note).slice(0, 4000) : '',
      tags: Array.isArray(raw.tags) ? uniq(raw.tags.map(function (t) { return String(t).slice(0, 40) })).slice(0, 20) : [],
      confidence: typeof raw.confidence === 'number' ? clamp(Math.round(raw.confidence), 0, 100) : 50,
      sessionId: raw.sessionId ? String(raw.sessionId) : (lastAgent && lastAgent.id ? String(lastAgent.id) : null),
      sources: [raw.source ? String(raw.source).slice(0, 60) : 'user'],
      hits: 1, createdAt: now, updatedAt: now
    }
    store.assets.push(asset)
    touch()
    return { ok: true, asset: asset, created: true }
  }

  function trashAsset(id) {
    const a = findAsset(id)
    if (!a) return false
    store.assets = store.assets.filter(function (x) { return x.id !== id })
    store.edges = store.edges.filter(function (e) { return e.from !== id && e.to !== id })
    store.trash.push({ id: a.id, asset: a, deletedAt: nowMs() })
    if (store.trash.length > 2000) store.trash = store.trash.slice(store.trash.length - 2000)
    touch()
    return true
  }

  function addEdgeRaw(from, to, relation, weight, source, evidence) {
    if (!from || !to || from === to) return null
    if (!findAsset(from) || !findAsset(to)) return null
    for (const e of store.edges) {
      if (((e.from === from && e.to === to) || (e.from === to && e.to === from)) && e.relation === relation) return e
    }
    const edge = { id: nextId('e'), from: from, to: to, relation: relation, weight: typeof weight === 'number' ? weight : 1, source: source || 'manual', evidence: evidence ? String(evidence).slice(0, 300) : '', createdAt: nowMs() }
    store.edges.push(edge)
    return edge
  }

  function hostOf(url) { const m = /^https?:\/\/([^\/?#]+)/i.exec(String(url)); return m ? m[1].toLowerCase() : '' }
  function hostNoPort(h) { return String(h).replace(/:\d+$/, '') }
  function portOf(h) { const m = /:(\d{1,5})$/.exec(String(h)); return m ? m[1] : '' }
  function ipInCidr(ip, cidr) {
    const parts = String(cidr).split('/')
    if (parts.length !== 2) return false
    const base = parts[0].split('.')
    const bits = Number(parts[1])
    if (base.length !== 4 || !(bits >= 0 && bits <= 32)) return false
    const toInt = function (o) { return ((Number(o[0]) << 24) >>> 0) + (Number(o[1]) << 16) + (Number(o[2]) << 8) + Number(o[3]) }
    const mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0)
    const ipParts = String(ip).split('.')
    if (ipParts.length !== 4) return false
    return (toInt(base) & mask) === (toInt(ipParts) & mask)
  }

  function hostMatchesDomain(hn, dom) {
    if (!hn || !dom) return false
    if (hn === dom) return true
    const sfx = '.' + dom
    return hn.length > sfx.length && hn.slice(hn.length - sfx.length) === sfx
  }

  function analyzePool(pool) {
    const domains = pool.filter(function (a) { return a.type === 'domain' })
    const ips = pool.filter(function (a) { return a.type === 'ip' })
    const cidrs = pool.filter(function (a) { return a.type === 'cidr' })
    const urls = pool.filter(function (a) { return a.type === 'url' })
    const mails = pool.filter(function (a) { return a.type === 'email' })
    const ports = pool.filter(function (a) { return a.type === 'port' })
    for (const u of urls) {
      const h = hostOf(u.value)
      if (!h) continue
      const hn = hostNoPort(h)
      const pt = portOf(h)
      for (const d of domains) if (hostMatchesDomain(hn, d.value)) addEdgeRaw(u.id, d.id, 'belongs_to', 3, 'auto', h)
      if (validIpv4(hn)) for (const ip of ips) if (ip.value === hn) addEdgeRaw(u.id, ip.id, 'hosts_on', 3, 'auto', h)
      if (pt) for (const p of ports) if (p.value === pt) addEdgeRaw(u.id, p.id, 'exposes_port', 2, 'auto', h)
    }
    for (const a of domains) for (const b of domains) {
      if (a.id === b.id) continue
      const suffix = '.' + b.value
      if (a.value.length > suffix.length && a.value.slice(a.value.length - suffix.length) === suffix) addEdgeRaw(a.id, b.id, 'subdomain_of', 3, 'auto', a.value)
    }
    for (const ip of ips) for (const c of cidrs) if (ipInCidr(ip.value, c.value)) addEdgeRaw(ip.id, c.id, 'in_range', 3, 'auto', c.value)
    for (const ml of mails) {
      const at = ml.value.split('@')[1]
      if (!at) continue
      for (const d of domains) if (d.value === at) addEdgeRaw(ml.id, d.id, 'mailbox_at', 2, 'auto', at)
    }
  }

  function analyze() {
    const autoBefore = store.edges.filter(function (e) { return e.source !== 'manual' }).length
    const manual = store.edges.filter(function (e) { return e.source === 'manual' })
    store.edges = manual.slice()
    const pids = []
    for (const a of store.assets) { const pid = String(a.projectId || ''); if (pids.indexOf(pid) < 0) pids.push(pid) }
    for (const pid of pids) analyzePool(store.assets.filter(function (a) { return String(a.projectId || '') === pid }))
    const autoAfter = store.edges.length - manual.length
    touch()
    return { ok: true, created: autoAfter, removed: Math.max(0, autoBefore - autoAfter), total: store.edges.length }
  }

  function dropCandidate(type, value) {
    for (let i = store.candidates.length - 1; i >= 0; i--) {
      const k = store.candidates[i]
      if (k.type === type && k.value === value) store.candidates.splice(i, 1)
    }
  }

  function collectCandidates(list, source) {
    if (!store.settings.autoCapture) return 0
    let added = 0, skipped = 0
    for (const c of list) {
      if (!validAssetValue(c.type, c.value)) continue
      if (c.type === 'ip' && isNonTargetIp(c.value)) { skipped++; continue }
      if (findAssetByValue(c.type, c.value)) continue
      let hit = null
      for (const k of store.candidates) if (k.type === c.type && k.value === c.value) { hit = k; break }
      if (hit) { hit.hits = (hit.hits || 1) + 1; continue }
      store.candidates.push({ type: c.type, value: c.value, from: String(source || 'auto').slice(0, 40), at: nowMs(), hits: 1, sentAt: 0 })
      added++
    }
    if (store.candidates.length > 300) store.candidates = store.candidates.slice(store.candidates.length - 300)
    if (skipped > 0 && !noiseNoticeLogged) {
      noiseNoticeLogged = true
      log('info', '已跳过 ' + skipped + ' 个保留/代理地址（127/169.254/198.18-19/组播），内网段仍正常收录')
    }
    return added
  }

  let lastCandAt = 0
  let reviewInFlight = false
  const REVIEW_MIN = 6
  const REVIEW_IDLE_MS = 45000
  const REQUEUE_MAX = 3

  function pendingCandidates() {
    const out = []
    for (const k of store.candidates) if (!k.sentAt) out.push(k)
    return out
  }

  // 已研判：本轮送出、且没有被 asset_record 采纳的候选一律出池。
  // 规则里「确认无关 → 不调用任何工具，理由写在推理里」是设计如此，所以排除动作在候选池这一侧收口，
  // 否则被排除的候选会永远留在池子里：sentAt 已置位，pendingCandidates() 再也看不到它们。
  function settleCandidates() {
    if (!store.candidates.length) return 0
    const keep = []
    let n = 0
    for (const k of store.candidates) {
      if (k.sentAt) { n++; continue }
      keep.push(k)
    }
    if (n > 0) store.candidates = keep
    return n
  }

  // 未研判：模型这一轮没留下任何推理/输出，说明研判请求没被接手，候选退回待研判。
  // 重推 REQUEUE_MAX 次仍无果的直接出池，避免「退回 → 重推 → 再退回」空转。
  function requeueCandidates() {
    const keep = []
    let requeued = 0, dropped = 0
    for (const k of store.candidates) {
      if (!k.sentAt) { keep.push(k); continue }
      k.tries = (k.tries || 0) + 1
      if (k.tries >= REQUEUE_MAX) { dropped++; continue }
      k.sentAt = 0
      requeued++
      keep.push(k)
    }
    store.candidates = keep
    return { requeued: requeued, dropped: dropped }
  }

  function maybeAutoReview() {
    if (reviewInFlight || liveActive) return
    if (!store.settings.autoCapture || !store.settings.autoModel) return
    if (runActive()) return
    const pending = pendingCandidates()
    if (pending.length === 0) return
    const quiet = lastCandAt > 0 && (nowMs() - lastCandAt > REVIEW_IDLE_MS)
    if (pending.length < REVIEW_MIN && !quiet) return
    const project = findProject(effectiveProjectId()) || store.projects[0] || null
    if (!project) return
    reviewInFlight = true
    autoReview(project, pending).catch(function (e) {
      reviewInFlight = false
      logFailure('自动研判候选异常', e, 'autoReview')
    })
  }

  async function autoReview(project, pending) {
    const list = pending.map(function (k) { return { type: k.type, value: k.value, from: k.from } })
    for (const k of pending) k.sentAt = nowMs()
    touch()
    await persist()
    log('phase', '自动研判候选（' + list.length + ' 个，来自工具输出捕获，不写图谱）')
    setRun('judging', '模型研判候选（' + list.length + ' 个）')
    const ok = await handoffToModel(project, list, 'capture')
    if (!ok) setRun('error', '模型研判未启动，候选仍留在待研判池')
    reviewInFlight = false
    await persist()
  }

  async function resolveTarget() {
    const fs = ctx.get('fs')
    if (fs === undefined || fs === null) return null
    const target = await fs.resolve(store.settings.storePath)
    try { store.meta.storePathAbs = fs.processPath(target) } catch (e) { store.meta.storePathAbs = target.displayPath || null }
    return { fs: fs, target: target }
  }

  async function doLoad() {
    try {
      const r = await resolveTarget()
      if (!r) { store.meta.persistence = 'memory'; store.meta.lastError = 'fs 服务不可用，仅内存保存'; ensureProjects(); return 0 }
      const info = await r.fs.stat(r.target)
      const parsed = info ? JSON.parse(await r.fs.readText(r.target)) : null
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.projects)) store.projects = parsed.projects
        if (Array.isArray(parsed.assets)) store.assets = parsed.assets
        if (Array.isArray(parsed.edges)) store.edges = parsed.edges
        if (Array.isArray(parsed.trash)) store.trash = parsed.trash.filter(isTrashEntry)
        if (Array.isArray(parsed.log)) store.log = parsed.log
        if (Array.isArray(parsed.toolCatalog)) store.toolCatalog = parsed.toolCatalog
        if (Array.isArray(parsed.candidates)) store.candidates = parsed.candidates
        if (typeof parsed.logSeq === 'number') store.logSeq = parsed.logSeq
        if (parsed.settings && typeof parsed.settings === 'object') {
          for (const k of Object.keys(store.settings)) if (parsed.settings[k] !== undefined) store.settings[k] = parsed.settings[k]
        }
        if (parsed.meta && typeof parsed.meta === 'object' && parsed.meta.captured) store.meta.captured = parsed.meta.captured
        store.updatedAt = parsed.updatedAt || 0
      }
      store.meta.persistence = 'ready'
      let changed = ensureProjects()
      const staleSent = settleCandidates()
      if (staleSent > 0) { log('info', '候选池清理：' + staleSent + ' 条上一轮已研判的候选出池'); changed++ }
      if (changed > 0) analyze()
      const stale = !parsed || parsed.version !== STORE_VERSION
      if (changed > 0 || stale) await doWrite()
      return 0
    } catch (e) {
      store.meta.persistence = 'error'
      store.meta.lastError = '读取失败: ' + msgOf(e)
      ensureProjects()
      return 0
    }
  }

  async function doWrite() {
    try {
      const r = await resolveTarget()
      if (!r) { store.meta.persistence = 'memory'; return }
      const payload = {
        version: STORE_VERSION, updatedAt: store.updatedAt,
        projects: store.projects,
        assets: store.assets, edges: store.edges,
        trash: store.trash.filter(isTrashEntry), log: store.log.slice(-100), logSeq: store.logSeq,
        toolCatalog: store.toolCatalog,
        candidates: store.candidates.slice(-300),
        settings: store.settings, meta: { captured: store.meta.captured }
      }
      await r.fs.writeText(r.target, JSON.stringify(payload, null, 2))
      store.meta.persistence = 'ready'
      store.meta.lastSavedAt = nowMs()
      store.meta.lastError = null
    } catch (e) {
      store.meta.persistence = 'error'
      store.meta.lastError = '写入失败: ' + msgOf(e)
    }
  }

  function persist() { writeChain = writeChain.then(doWrite, doWrite); return writeChain }
  function csvCell(v) { const s = v === undefined || v === null ? '' : String(v); return '"' + s.replace(/"/g, '""') + '"' }

  function exportContent(format) {
    const stamp = iso(nowMs()).replace(/[:.]/g, '-').slice(0, 19)
    const byId = {}
    for (const a of store.assets) byId[a.id] = a
    if (format === 'csv') {
      const cols = ['type', 'value', 'label', 'confidence', 'tags', 'sources', 'hits', 'project', 'note', 'createdAt']
      const lines = [cols.join(',')]
      for (const a of store.assets) {
        const p = findProject(a.projectId)
        lines.push([csvCell(a.type), csvCell(a.value), csvCell(a.label), csvCell(a.confidence), csvCell((a.tags || []).join('|')), csvCell((a.sources || []).join('|')), csvCell(a.hits), csvCell(p ? (p.path || p.name) : ''), csvCell(a.note), csvCell(iso(a.createdAt))].join(','))
      }
      return { filename: 'redteam-assets-' + stamp + '.csv', content: lines.join('\n') }
    }
    if (format === 'markdown') {
      const byType = {}
      for (const a of store.assets) byType[a.type] = (byType[a.type] || 0) + 1
      const L = []
      L.push('# 红队资产图谱导出'); L.push('')
      L.push('- 导出时间: ' + iso(nowMs()))
      L.push('- 项目数: ' + store.projects.length + ' · 资产 ' + store.assets.length + ' · 关系 ' + store.edges.length)
      L.push('- 类型分布: ' + Object.keys(byType).map(function (k) { return k + '=' + byType[k] }).join(', '))
      for (const p of store.projects) {
        const pool = store.assets.filter(function (a) { return a.projectId === p.id })
        L.push(''); L.push('## 项目：' + (p.path || p.name) + '（' + pool.length + ' 项）'); L.push('')
        L.push('| 类型 | 值 | 来源 | 置信度 | 命中 | 标签 | 备注 |')
        L.push('| --- | --- | --- | --- | --- | --- | --- |')
        for (const a of pool) L.push('| ' + a.type + ' | ' + String(a.value).replace(/\|/g, '\\|') + ' | ' + (a.sources || []).join('/') + ' | ' + a.confidence + ' | ' + (a.hits || 1) + ' | ' + (a.tags || []).join(' ') + ' | ' + String(a.note || '').replace(/\n/g, ' ').replace(/\|/g, '\\|').slice(0, 120) + ' |')
      }
      L.push(''); L.push('## 关联关系'); L.push('')
      L.push('| 项目 | 源 | 关系 | 目标 | 权重 | 来源 |')
      L.push('| --- | --- | --- | --- | --- | --- |')
      for (const e of store.edges) {
        const f = byId[e.from]
        const t = byId[e.to]
        const pr = f ? findProject(f.projectId) : null
        L.push('| ' + (pr ? (pr.path || pr.name) : '') + ' | ' + (f ? f.value : e.from) + ' | ' + e.relation + ' | ' + (t ? t.value : e.to) + ' | ' + e.weight + ' | ' + e.source + ' |')
      }
      L.push('')
      return { filename: 'redteam-assets-' + stamp + '.md', content: L.join('\n') }
    }
    return { filename: 'redteam-assets-' + stamp + '.json', content: JSON.stringify({ exportedAt: iso(nowMs()), assetCount: store.assets.length, edgeCount: store.edges.length, projects: store.projects, assets: store.assets, edges: store.edges }, null, 2) }
  }

  async function runEnrich(project, pool, tool) {
    if (!runActive()) setRun('searching', 'Jina 检索中')
    enrichCancelled = false
    const targets = pool.filter(function (a) { return ['domain','ip','cidr','url','email','org'].indexOf(a.type) >= 0 })
    const pid = project ? project.id : null
    let okCount = 0, failCount = 0, emptyCount = 0
    const seenCand = {}
    const candidates = []
    log('phase', '阶段 1/2 · Jina 检索产出候选（' + targets.length + ' 个资产，不写图谱）')
    try {
      for (let i = 0; i < targets.length; i++) {
        if (enrichCancelled) { log('warn', '已停止：完成 ' + i + ' / ' + targets.length); break }
        const a = targets[i]
        store.meta.progress = { text: '(' + (i + 1) + '/' + targets.length + ') ' + a.value, done: i, total: targets.length }
        const q = enrichQuery(a)
        let text = ''
        try {
          let r = await searchOnce(tool, q)
          if (r.empty) r = await searchOnce(tool, q)
          if (r.empty) throw new Error('检索返回空 content（已重试）')
          text = r.text
          if (/^\s*Error:/i.test(text) || text.indexOf('Unauthorized') >= 0) throw new Error(text.replace(/\s+/g, ' ').slice(0, 160))
          okCount++
        } catch (e) { failCount++; if (/空 content/.test(msgOf(e))) emptyCount++; log('err', '检索失败 ' + a.value + '：' + msgOf(e)); continue }
        const found = extract(text, 40, 'jina')
        for (const c of found) {
          if (c.type === a.type && c.value === a.value) continue
          if (findAssetByValue(c.type, c.value)) continue
          const key = c.type + '\u0000' + c.value
          if (seenCand[key]) continue
          seenCand[key] = true
          candidates.push({ type: c.type, value: c.value, from: a.value })
        }
      }
      store.meta.progress = null
      log('ok', '阶段 1 ' + (enrichCancelled ? '已中断' : '完成') + '：检索成功 ' + okCount + ' 失败 ' + failCount + (emptyCount ? '（空结果 ' + emptyCount + '）' : '') + '，发现候选 ' + candidates.length + ' 个（未入库）')
    } catch (e) {
      store.meta.progress = null
      logFailure('检索中断', e, 'runEnrich')
    } finally {
      touch()
      await persist()
    }
    if (enrichCancelled) {
      enrichCancelled = false
      log('info', '已按请求停止，未进入模型研判阶段')
      setRun('stopped', '已按请求停止，未进入模型研判')
      await persist()
      return
    }
    if (!store.settings.autoModel) {
      log('warn', '已跳过模型研判（设置中未开启）——候选未入库；开启「自动研判」后重跑即可')
      dumpCandidates(candidates)
      setRun('done', '检索成功 ' + okCount + ' 失败 ' + failCount + '，候选 ' + candidates.length + ' 个；未开启自动研判，候选未入库')
      await persist()
      return
    }
    log('phase', '阶段 2/2 · 模型研判（候选 ' + candidates.length + ' 个待筛）')
    setRun('judging', '模型研判中（候选 ' + candidates.length + ' 个）')
    const ok = await handoffToModel(project, candidates)
    if (!ok) setRun('error', '模型研判未启动，候选未入库')
    await persist()
  }

  function safeSnapshot() {
    try { return snapshot() } catch (e) { logFailure('snapshot 失败', e, 'snapshot'); return null }
  }

  function snapshot() {
    if (syncWorkspaces() > 0) persist()
    try { maybeAutoReview() } catch (e) {}
    if (liveActive && liveLastFrameAt && nowMs() - liveLastFrameAt > 30000) {
      log('warn', '模型流静默超过 30 秒，判定研判结束')
      finishLive()
    }
    const byType = {}
    for (const a of store.assets) byType[a.type] = (byType[a.type] || 0) + 1
    return {
      updatedAt: store.updatedAt,
      projects: store.projects,
      activeProjectId: effectiveProjectId(),
      activeWorkspacePath: currentWorkspacePath(),
      assets: store.assets,
      edges: store.edges,
      trash: store.trash.filter(isTrashEntry).slice(-300).map(function (t) {
        const a = t.asset
        return { id: t.id, deletedAt: t.deletedAt, asset: { id: a.id, type: a.type, value: a.value, sources: a.sources, projectId: a.projectId } }
      }),
      trashTotal: store.trash.length,
      log: store.log.slice(-120),
      live: liveActive ? { active: true, reasoning: live.reasoning.slice(-9000), text: live.text.slice(-9000), tools: live.tools.slice(-12) } : null,
      toolCatalog: store.toolCatalog,
      jinaUrl: mcpUrl(),
      jinaReady: jinaKey().length > 0,
      settings: store.settings,
      candidates: { pending: pendingCandidates().length, total: store.candidates.length },
      meta: store.meta,
      stats: { typeCounts: byType, autoEdges: store.edges.filter(function (e) { return e.source === 'auto' }).length }
    }
  }

  async function ensureLoaded() { if (loaded) return 0; loaded = true; return await doLoad() }

  ctx.on('agent/assistant-stream', function (payload) {
    try {
      if (!liveActive) return
      const frame = payload && payload.frame
      if (!frame || frame.type !== 'chunk') return
      const c = frame.chunk
      if (!c) return
      liveLastFrameAt = nowMs()
      if (c.type === 'reasoning-delta' && typeof c.text === 'string') live.reasoning += c.text
      else if (c.type === 'text-delta' && typeof c.text === 'string') live.text += c.text
      else if (c.type === 'tool-call-delta') {
        const name = typeof c.name === 'string' ? c.name : ''
        if (name) {
          const last = live.tools[live.tools.length - 1]
          if (last && last.name === name) last.args += (c.argumentsDelta || '')
          else live.tools.push({ name: name, args: c.argumentsDelta || '' })
        }
      }
      if (live.reasoning.length > 40000) live.reasoning = live.reasoning.slice(-40000)
      if (live.text.length > 40000) live.text = live.text.slice(-40000)
    } catch (e) {}
  })

  ctx.on('agent/status', function (payload) {
    try {
      if (!liveActive) return
      if (!payload || payload.status !== 'idle') return
      finishLive()
    } catch (e) {}
  })

  harness.handle('snapshot', async function () { await ensureLoaded(); return snapshot() })
  harness.handle('reload', async function () {
    loaded = true
    resetLive()
    store.projects = []; store.assets = []; store.edges = []; store.trash = []; store.log = []
    await doLoad()
    return { ok: true, snapshot: snapshot() }
  })
  harness.handle('logClear', async function () { store.log = []; await persist(); return { ok: true, snapshot: snapshot() } })

  harness.handle('clientError', async function (args) {
    try {
      const m = String(args && args.message || '?').slice(0, 1200)
      const st = String(args && args.stack || '')
      const where = String(args && args.where || '')
      log('err', '客户端错误' + (where ? '（' + where + '）' : '') + '：' + m)
      if (st) for (const line of st.split('\n').slice(0, 10)) log('err', '    ' + line.trim().slice(0, 400))
      await persist()
      return { ok: true }
    } catch (e) { return { ok: false } }
  })

  harness.handle('clearAssets', async function (args) {
    try {
      await ensureLoaded()
      const pid = String(args && args.projectId || '')
      const all = !pid || pid === '__all__'
      let n = 0
      const keep = []
      for (const a of store.assets) {
        if (all || String(a.projectId || '') === pid) {
          store.trash.push({ id: a.id, asset: a, deletedAt: nowMs() })
          n++
        } else keep.push(a)
      }
      if (store.trash.length > 2000) store.trash = store.trash.slice(store.trash.length - 2000)
      store.assets = keep
      const alive = {}
      for (const a of store.assets) alive[a.id] = true
      store.edges = store.edges.filter(function (e) { return alive[e.from] && alive[e.to] })
      touch()
      log('warn', '已清除 ' + n + ' 个资产（移入垃圾箱，可恢复）')
      await persist()
      return { ok: true, changed: n, snapshot: safeSnapshot() }
    } catch (e) {
      logFailure('清除资产失败', e, 'clearAssets')
      await persist().catch(function () {})
      return { ok: false, error: msgOf(e), snapshot: safeSnapshot() }
    }
  })

  harness.handle('trash', async function (args) {
    const action = String(args && args.action || '?')
    try {
      await ensureLoaded()
      const ids = Array.isArray(args && args.ids) ? args.ids.filter(function (x) { return typeof x === 'string' && x }).map(String) : null
      let n = 0
      if (action === 'delete') {
        for (const id of (ids || [])) if (trashAsset(id)) n++
      } else if (action === 'restore') {
        const keep = []
        for (const t of store.trash) {
          if (!isTrashEntry(t)) continue
          if (!ids || ids.indexOf(t.id) >= 0) { if (!findAsset(t.asset.id)) { store.assets.push(t.asset); n++ } }
          else keep.push(t)
        }
        store.trash = keep
        analyze()
      } else if (action === 'purge') {
        const keep = []
        for (const t of store.trash) {
          if (!isTrashEntry(t)) continue
          if (ids && ids.indexOf(t.id) >= 0) n++
          else keep.push(t)
        }
        store.trash = keep
      } else if (action === 'clear') {
        n = store.trash.length
        store.trash = []
      } else {
        return { ok: false, error: '未知的垃圾箱操作：' + action, snapshot: safeSnapshot() }
      }
      if (n > 0) {
        if (action === 'delete') log('warn', '手动删除 ' + n + ' 个资产（移入垃圾箱，可恢复）')
        else if (action === 'restore') log('info', '从垃圾箱恢复 ' + n + ' 个资产')
        else if (action === 'purge') log('warn', '彻底删除 ' + n + ' 个资产（不可恢复）')
        else if (action === 'clear') log('warn', '清空垃圾箱：' + n + ' 个资产被彻底删除（不可恢复）')
      }
      touch()
      await persist()
      return { ok: true, changed: n, snapshot: safeSnapshot() }
    } catch (e) {
      logFailure('垃圾箱操作失败', e, action)
      await persist().catch(function () {})
      return { ok: false, error: msgOf(e), snapshot: safeSnapshot() }
    }
  })

  harness.handle('projects', async function (args) {
    await ensureLoaded()
    const action = String(args && args.action || '')
    if (action === 'follow') {
      store.settings.followWorkspace = !!(args && args.follow)
      if (store.settings.followWorkspace) store.settings.activeProjectId = effectiveProjectId()
      touch(); await persist()
      return { ok: true, snapshot: snapshot() }
    }
    if (action === 'rename') {
      const p = findProject(String(args && args.id || ''))
      if (p) p.name = String(args && args.name || '').trim().slice(0, 60) || p.name
      touch(); await persist()
      return { ok: true, snapshot: snapshot() }
    }
    if (action === 'select') {
      const id = String(args && args.id || '')
      if (id !== '__all__' && !findProject(id)) return { ok: false, error: '项目不存在', snapshot: snapshot() }
      store.settings.followWorkspace = false
      store.settings.activeProjectId = id
      touch(); await persist()
      return { ok: true, snapshot: snapshot() }
    }
    return { ok: false, error: '未知操作', snapshot: snapshot() }
  })

  harness.handle('mcpTools', async function (args) {
    await ensureLoaded()
    const refresh = !!(args && args.refresh)
    if (!refresh && Array.isArray(store.toolCatalog) && store.toolCatalog.length) {
      return { ok: true, tools: store.toolCatalog, cached: true, snapshot: snapshot() }
    }
    try {
      const tools = await mcpToolListShared(JINA_MCP_BASE)
      store.toolCatalog = tools
      touch(); await persist()
      return { ok: true, tools: tools, cached: false, snapshot: snapshot() }
    } catch (e) {
      log('err', '获取工具目录失败：' + msgOf(e))
      await persist()
      return { ok: false, error: msgOf(e), snapshot: snapshot() }
    }
  })

  harness.handle('mcpTest', async function () {
    await ensureLoaded()
    const hasKey = jinaKey().length > 0
    try {
      const tools = await mcpToolListShared()
      const names = tools.map(function (t) { return t.name })
      if (!hasKey) log('warn', '未填写密钥：tools/call 会返回 Unauthorized')
      return { ok: true, tools: names, hasKey: hasKey, snapshot: snapshot() }
    } catch (e) {
      log('err', 'MCP 连接失败：' + msgOf(e))
      return { ok: false, error: msgOf(e), hasKey: hasKey, snapshot: snapshot() }
    }
  })

  harness.handle('enrich', async function (args) {
    await ensureLoaded()
    if (store.meta.enriching) return { ok: false, error: '已有分析在运行', snapshot: snapshot() }
    if (!jinaKey()) {
      log('err', '未配置 Jina API Key，无法执行关联分析（设置 → Jina）')
      await persist()
      return { ok: false, error: '未配置 Jina API Key', needKey: true, snapshot: snapshot() }
    }
    const tool = pickSearchTool()
    if (!tool) {
      log('err', '所选工具中没有检索类工具，请在设置中勾选 search_web 或 search_web_deep')
      await persist()
      return { ok: false, error: '所选工具中没有检索类工具', needTools: true, snapshot: snapshot() }
    }
    const wantId = String(args && args.projectId || '') || effectiveProjectId()
    const project = findProject(wantId) || store.projects[0] || null
    const pool = project ? store.assets.filter(function (a) { return a.projectId === project.id }) : []
    if (pool.length === 0) {
      log('warn', '该项目暂无可分析资产，先录入或导入一些资产')
      await persist()
      return { ok: false, error: '项目内没有资产', snapshot: snapshot() }
    }
    resetLive()
    enrichCancelled = false
    setRun('searching', 'Jina 检索中')
    runEnrich(project, pool, tool).catch(function (e) {
      store.meta.progress = null
      setRun('error', '分析异常：' + msgOf(e).slice(0, 120))
      logFailure('分析异常', e, 'enrich')
    })
    return { ok: true, started: true, tool: tool, autoModel: !!store.settings.autoModel, snapshot: snapshot() }
  })

  harness.handle('enrichStop', async function () {
    await ensureLoaded()
    if (!runActive()) return { ok: false, error: '当前没有分析在运行', snapshot: snapshot() }
    enrichCancelled = true
    if (store.meta.run && store.meta.run.state === 'judging') {
      resetLive()
      setRun('stopped', '已请求停止 —— 模型已开始研判，无法中断')
      log('warn', '收到停止请求 —— 模型研判已开始，无法中断；模型后续的登记仍会生效')
    } else {
      log('warn', '收到停止请求 —— 当前这条检索结束后停下')
    }
    await persist()
    return { ok: true, snapshot: snapshot() }
  })

  harness.handle('addAsset', async function (args) {
    await ensureLoaded()
    const r = addAsset(args && args.asset ? args.asset : args)
    if (r.ok) {
      if (args && args.relay) {
        const relay = addAsset({ value: args.relay, source: 'relay' })
        if (relay.ok) addEdgeRaw(r.asset.id, relay.asset.id, args.relation || 'related', 2, 'manual')
      }
      analyze()
      await persist()
    }
    return { result: r, snapshot: snapshot() }
  })

  harness.handle('importData', async function (args) {
    await ensureLoaded()
    const text = String(args && args.text || '')
    if (!text.trim()) return { ok: false, error: '内容为空' }
    const format = detectFormat(text, args && args.format)
    let parsed
    try { parsed = parseImport(text, format) } catch (e) { return { ok: false, error: '解析失败：' + msgOf(e), format: format } }
    if (!parsed.assets.length && !parsed.edges.length) return { ok: false, error: '未解析出任何资产（格式可能选错）', format: format }
    const wantProject = args && args.projectId && findProject(String(args.projectId)) ? String(args.projectId) : effectiveProjectId()
    let added = 0, merged = 0
    for (const a of parsed.assets) {
      const r = addAsset({ type: a.type, value: a.value, label: a.label, note: a.note, tags: a.tags, confidence: a.confidence, source: 'import', projectId: wantProject })
      if (!r.ok) continue
      if (r.created) added++; else merged++
    }
    let edgesAdded = 0
    for (const e of parsed.edges) {
      const f = findAssetByValueLoose(e.fromValue)
      const t = findAssetByValueLoose(e.toValue)
      if (f && t && addEdgeRaw(f.id, t.id, String(e.relation || 'related'), 2, 'import', '')) edgesAdded++
    }
    analyze()
    log('ok', '导入 ' + format + '：新增 ' + added + '，合并 ' + merged + '，关系 ' + edgesAdded)
    touch(); await persist()
    return { ok: true, format: format, added: added, merged: merged, edges: edgesAdded, snapshot: snapshot() }
  })

  harness.handle('updateAsset', async function (args) {
    const a = findAsset(String(args && args.id || ''))
    if (!a) return { ok: false, error: '资产不存在' }
    const patch = args && args.patch && typeof args.patch === 'object' ? args.patch : {}
    if (typeof patch.type === 'string' && ASSET_TYPES.indexOf(patch.type) >= 0) a.type = patch.type
    if (typeof patch.value === 'string' && patch.value.trim()) a.value = normalizeValue(a.type, patch.value)
    if (typeof patch.label === 'string') a.label = patch.label.slice(0, 200)
    if (typeof patch.note === 'string') a.note = patch.note.slice(0, 4000)
    if (typeof patch.confidence === 'number') a.confidence = clamp(Math.round(patch.confidence), 0, 100)
    if (Array.isArray(patch.tags)) a.tags = uniq(patch.tags.map(function (t) { return String(t).slice(0, 40) })).slice(0, 20)
    a.updatedAt = nowMs()
    touch(); await persist()
    return { ok: true, asset: a, snapshot: snapshot() }
  })

  harness.handle('removeAsset', async function (args) {
    const r = trashAsset(String(args && args.id || ''))
    await persist()
    return { ok: r, snapshot: snapshot() }
  })

  harness.handle('analyze', async function () {
    await ensureLoaded()
    const r = analyze()
    log('info', '重建关系：' + r.total + ' 条')
    await persist()
    return { result: r, snapshot: snapshot() }
  })

  harness.handle('clearAll', async function (args) {
    const what = String(args && args.what || 'all')
    if (what === 'all' || what === 'assets') { store.assets = []; store.edges = [] }
    if (what === 'all' || what === 'trash') store.trash = []
    log('warn', '已清空：' + what)
    touch(); await persist()
    return { ok: true, snapshot: snapshot() }
  })

  harness.handle('exportData', async function (args) {
    const f = String(args && args.format)
    const format = ['json', 'csv', 'markdown'].indexOf(f) >= 0 ? f : 'json'
    const r = exportContent(format)
    let path = null
    if (args && args.write) {
      try {
        const fs = ctx.get('fs')
        const target = await fs.resolve(r.filename)
        await fs.writeText(target, r.content)
        path = fs.processPath(target)
      } catch (e) { path = null }
    }
    log('ok', '导出 ' + format + (path ? ' → ' + path : '（仅下载）'))
    await persist()
    return { ok: true, filename: r.filename, content: r.content, base64: btoa(r.content), path: path, snapshot: snapshot() }
  })

  harness.handle('scanText', async function (args) {
    const text = String(args && args.text || '')
    if (!text.trim()) return { ok: false, error: '文本为空' }
    const found = extract(text, 300, args && args.source ? String(args.source) : 'paste')
    if (args && args.autoAdd) {
      let added = 0
      for (const c of found) { const r = addAsset({ type: c.type, value: c.value, source: 'scan' }); if (r.ok && r.created) added++ }
      analyze()
      log('ok', '批量识别：提取 ' + found.length + '，入库 ' + added)
      touch(); await persist()
      return { ok: true, added: added, found: found, snapshot: snapshot() }
    }
    return { ok: true, found: found, added: 0, snapshot: snapshot() }
  })

  harness.handle('settings', async function (args) {
    const patch = args && args.patch && typeof args.patch === 'object' ? args.patch : {}
    const pathChanged = typeof patch.storePath === 'string' && patch.storePath.trim() && patch.storePath !== store.settings.storePath
    for (const k of Object.keys(store.settings)) {
      if (patch[k] === undefined) continue
      if (k === 'autoCapture' || k === 'autoModel' || k === 'followWorkspace') store.settings[k] = !!patch[k]
      else if (k === 'jinaTools') store.settings[k] = Array.isArray(patch[k]) ? uniq(patch[k].map(function (x) { return String(x).slice(0, 60) })).slice(0, 60) : store.settings[k]
      else store.settings[k] = String(patch[k])
    }
    if (pathChanged) await doWrite(); else await persist()
    return { ok: true, settings: store.settings, snapshot: snapshot() }
  })

  ctx.on('tools/result', function (exec, result) {
    try {
      rememberAgent(exec)
      const name = exec && typeof exec.name === 'string' ? exec.name : ''
      if (result && result.isError) {
        if (name === 'asset_record' || name === 'asset_remove') log('warn', name + ' 失败')
        return
      }
      if (CAPTURE_SKIP.indexOf(name) >= 0) return
      // 只从外部情报工具捕获。bash / read / grep 等本地工具的返回里同样会出现域名
      // 与哈希（实测：git commit SHA 被当成 hash 资产、relay.ok 被当成域名、
      // 我自己诊断输出的截断串被当成 URL），那不是目标情报而是工作噪声。
      if (!isIntelTool(name)) return
      const blocks = result ? result.content : null
      if (!Array.isArray(blocks)) return
      let text = ''
      for (const b of blocks) { if (!b || b.type !== 'text' || typeof b.text !== 'string') continue; text += b.text + '\n'; if (text.length > 200000) break }
      if (text.length < 8) return
      const found = extract(text, 60, name || 'tool')
      if (found.length === 0) return
      const added = collectCandidates(found, name || 'auto')
      if (added > 0) { store.meta.captured += added; lastCandAt = nowMs(); persist() }
    } catch (e) { console.error('[rtasset] capture failed:', msgOf(e)) }
  })

  const recordTool = harness.defineTool({
    name: 'asset_record',
    description: '登记一个红队测试资产到本地资产图谱（面板：左侧一级菜单「资产图谱」）。资产归入当前会话工作区对应的项目。可用 relay + relation 同时登记一个关联资产并建立关系边。重复登记会合并并累加命中次数。',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string', description: '资产值，例如 example.com / 10.0.0.1 / http://a.example.com:8080/x / 8080 / admin@example.com' },
        type: { type: 'string', enum: ASSET_TYPES, description: '资产类型；省略时由系统自动推断' },
        label: { type: 'string', description: '可读名称' },
        note: { type: 'string', description: '证据 / 来源 / 备注（写明依据）' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，如 生产 / 对外 / 高危' },
        confidence: { type: 'integer', description: '置信度 0-100' },
        relay: { type: 'string', description: '要与之建立关系的另一个资产值（会被自动登记）' },
        relation: { type: 'string', description: '关系名，如 resolves_to / has_port / belongs_to / admin_of' },
        evidence: { type: 'string', description: '这条关系成立的依据 —— 你看到了什么内容才把它连起来（与 relay 同用时填写，会显示在详情卡片的关联行「依据」上）' }
      },
      required: ['value']
    },
    output: {
      schema: { type: 'json' },
      render: function (args, value) {
        if (!value || value.ok !== true) return [{ type: 'text', text: '登记失败：' + (value && value.error ? value.error : '未知错误') }]
        return [{ type: 'text', text: '已登记 ' + value.type + ' = ' + value.value + '（' + (value.created ? '新增' : '已存在，已合并') + '）到项目「' + value.project + '」。图谱当前：' + value.total + ' 个资产 / ' + value.edges + ' 条关系。' }]
      }
    },
    execute: async function (args, exec) {
      rememberAgent(exec)
      await ensureLoaded()
      const r = addAsset({ type: args.type, value: args.value, label: args.label, note: args.note, tags: args.tags, confidence: args.confidence, source: 'model' })
      if (!r.ok) { log('err', '登记失败：' + r.error); await persist(); return { ok: false, error: r.error } }
      if (args.relay) {
        const relay = addAsset({ value: args.relay, source: 'relay' })
        if (relay.ok) addEdgeRaw(r.asset.id, relay.asset.id, args.relation || 'related', 2, 'manual', args.evidence ? String(args.evidence).slice(0, 300) : '')
      }
      analyze()
      touch()
      await persist()
      const p = findProject(r.asset.projectId)
      return { ok: true, id: r.asset.id, type: r.asset.type, value: r.asset.value, created: r.created, project: p ? (p.path || p.name) : '未分组', total: store.assets.length, edges: store.edges.length }
    }
  })
  harness.registerTool(ctx, recordTool)

  const removeTool = harness.defineTool({
    name: 'asset_remove',
    description: '从本地资产图谱移除一个资产（移入垃圾箱，可恢复）。用于删除经研判确认为误报、与目标无关的资产。',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string', description: '要移除的资产值' },
        reason: { type: 'string', description: '移除理由，会写入图谱日志' }
      },
      required: ['value']
    },
    output: {
      schema: { type: 'json' },
      render: function (args, value) {
        if (!value || value.ok !== true) return [{ type: 'text', text: '移除失败：' + (value && value.error ? value.error : '未知错误') }]
        return [{ type: 'text', text: '已移除「' + value.removed + '」，图谱剩余 ' + value.total + ' 个资产（可从垃圾箱恢复）。' }]
      }
    },
    execute: async function (args, exec) {
      rememberAgent(exec)
      await ensureLoaded()
      const raw = String(args && args.value || '').trim()
      if (!raw) return { ok: false, error: '资产值为空' }
      let target = findAssetByValueLoose(raw)
      if (!target) {
        const gt = guessType(raw)
        target = findAssetByValue(gt, normalizeValue(gt, raw))
      }
      if (!target) {
        log('warn', 'asset_remove：图谱中没有 ' + raw)
        await persist()
        return { ok: false, error: '图谱中没有该资产：' + raw }
      }
      const removed = target.value
      trashAsset(target.id)
      analyze()
      touch()
      log('warn', '移除 [' + target.type + '] ' + removed + (args && args.reason ? ' —— ' + String(args.reason).slice(0, 240) : ''))
      await persist()
      return { ok: true, removed: removed, total: store.assets.length }
    }
  })
  harness.registerTool(ctx, removeTool)

  const queryTool = harness.defineTool({
    name: 'asset_query',
    description: '查询本地红队资产图谱：返回当前工作区项目的资产清单与关联关系，可按类型或关键词过滤，也可指定项目。在继续推理前用它确认已有资产，避免重复收集。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '子串过滤（匹配值 / 标签 / 备注）' },
        type: { type: 'string', enum: ASSET_TYPES, description: '只返回该类型' },
        project: { type: 'string', description: '项目名或目录路径；省略则返回当前项目' },
        limit: { type: 'integer', description: '最多返回条数，默认 50' }
      }
    },
    output: {
      schema: { type: 'json' },
      render: function (args, value) {
        const lines = ['资产图谱：' + value.total + ' 个资产 / ' + value.edges + ' 条关系', '项目：' + value.projectNames.join('、'), '本次返回 ' + value.items.length + ' 条：']
        for (const a of value.items) lines.push('- [' + a.type + '] ' + a.value + '（来源 ' + (a.sources || []).join('/') + '）' + (a.tags && a.tags.length ? ' #' + a.tags.join(' #') : '') + (a.note ? '  // ' + String(a.note).replace(/\n/g, ' ').slice(0, 80) : ''))
        if (value.relations.length) {
          lines.push('关联：')
          for (const r of value.relations) lines.push('- ' + r.from + ' --' + r.relation + '--> ' + r.to)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      }
    },
    execute: async function (args, exec) {
      rememberAgent(exec)
      await ensureLoaded()
      const kw = args && args.keyword ? String(args.keyword).toLowerCase() : ''
      const wantType = args && args.type ? String(args.type) : ''
      const wantProject = args && args.project ? String(args.project) : ''
      const limit = args && args.limit ? clamp(Math.round(args.limit), 1, 500) : 50
      let pool = store.assets
      let projectNames = []
      if (wantProject) {
        let p = null
        for (const q of store.projects) if (q.name === wantProject || q.id === wantProject || q.path === wantProject) { p = q; break }
        pool = p ? store.assets.filter(function (a) { return a.projectId === p.id }) : []
        projectNames = [p ? (p.path || p.name) : wantProject]
      } else {
        const cur = findProject(effectiveProjectId())
        if (cur) {
          pool = store.assets.filter(function (a) { return a.projectId === cur.id })
          projectNames = [cur.path || cur.name]
        } else for (const p of store.projects) projectNames.push(p.path || p.name)
      }
      const poolIds = {}
      for (const a of pool) poolIds[a.id] = true
      const items = []
      for (const a of pool) {
        if (wantType && a.type !== wantType) continue
        if (kw) {
          const hay = (a.value + ' ' + (a.tags || []).join(' ') + ' ' + (a.note || '')).toLowerCase()
          if (hay.indexOf(kw) < 0) continue
        }
        if (items.length >= limit) break
        items.push({ id: a.id, type: a.type, value: a.value, label: a.label, confidence: a.confidence, hits: a.hits, tags: a.tags, sources: a.sources, note: String(a.note || '').slice(0, 400) })
      }
      const ids = {}
      for (const it of items) ids[it.id] = true
      const byId = {}
      for (const a of store.assets) byId[a.id] = a
      const relations = []
      for (const e of store.edges) {
        if (!poolIds[e.from] || !poolIds[e.to]) continue
        if (!ids[e.from] && !ids[e.to]) continue
        if (relations.length >= 100) break
        const f = byId[e.from]
        const t = byId[e.to]
        relations.push({ from: f ? f.value : e.from, relation: e.relation, to: t ? t.value : e.to })
      }
      return { total: pool.length, edges: store.edges.length, projectNames: projectNames, items: items, relations: relations }
    }
  })
  harness.registerTool(ctx, queryTool)

  ctx.effect(function () {
    doLoad().catch(function (e) { console.error('[rtasset] load failed:', msgOf(e)) }).then(function () { loaded = true })
  }, 'rtasset: initial load')

  // 自动研判的心跳必须由 host 自己驱动。客户端 snapshot 轮询只在面板打开时才跑，
  // 只靠它会变成「关掉面板就永不研判」。timer 是 host Service，其返回值即 disposer。
  ctx.effect(function () {
    const t = ctx.get('timer')
    if (t === undefined || t === null || typeof t.interval !== 'function') {
      console.error('[rtasset] timer 服务不可用：自动研判将退回只依赖客户端轮询（面板未打开时不会触发）')
      return
    }
    return t.interval(function () {
      try { maybeAutoReview() } catch (e) {}
    }, 5000)
  }, 'rtasset: auto review tick')

  console.log('[rtasset] host half ready; base =', JINA_MCP_BASE)
}

  // 把 20 个动态 RPC 句柄经宿主 HTTP 路由暴露给客户端半边。
  // 客户端是普通模块，可以直接 fetch（动态半边才有 fetch 屏蔽）。
  ctx.effect(() => ctx.webServer.register({
    method: 'POST',
    path: '/rtasset/rpc',
    handler: async (req, res) => {
      let body = ''
      try { for await (const chunk of req) body += chunk } catch (e) {}
      let payload = null
      try { payload = JSON.parse(body || '{}') } catch (e) {}
      const method = payload && typeof payload.method === 'string' ? payload.method : ''
      const fn = handlers[method]
      res.setHeader('content-type', 'application/json; charset=utf-8')
      if (!fn) { res.statusCode = 404; res.end(JSON.stringify({ error: 'unknown method: ' + method })); return }
      try {
        const result = await fn(payload.args === undefined ? null : payload.args)
        res.statusCode = 200
        res.end(JSON.stringify({ ok: true, result: result === undefined ? null : result }))
      } catch (e) {
        res.statusCode = 500
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
      }
    },
  }), 'rtasset: host rpc route')
}

export const name = 'redteam-asset-graph'
// 三个工具注册进宿主 tools 注册表；这里声明本半边硬依赖的服务。
export const inject = ['fs', 'shell', 'timer', 'webServer']
export { applyHost as apply }
