// 红队报告 · Markdown → 自包含 HTML / 真·DOCX（纯 JS，零依赖）
//
// 为什么单独成文件：这部分逻辑有测试价值，而 src/host.js 只是 applyHost 的「函数体片段」，
// 没法被测试 import。本文件按仓库约定写成 ESM，顶层只用 `export function` / `export const`，
// tools/build-lib.mjs 拼接时剥掉行首的 `export `，于是同一份源码既能被 node 测试 import，
// 也能原样落进 lib/host.js 的函数体。
//
// 由此得出三条不能破的约束（改这里之前先读一遍）：
//   1. 不 import / 不 require / 不 export default / 不写 `export { a, b }` 聚合导出；
//   2. 所有顶层名字带 rpt / RPT_ 前缀 —— 它们会和宿主函数体里已有的局部变量同处一个作用域；
//   3. 不依赖 btoa / Buffer / TextEncoder / DOM —— 宿主沙箱里这些不保证存在，
//      所以 UTF-8 编码与 base64 都是手写实现，ZIP 与 CRC-32 也是。
//
// 三份输出（块结构 / HTML / DOCX）共用同一个 rptParseMarkdown，行内格式只解析一次，
// 这样「网页预览」与「Word 交付件」不可能出现粗体、链接对不上的情况。

// 报告 HTML 的内联样式。与 rptBuildHtml 同源，导出是为了让调用方（面板预览）能只取样式。
export const RPT_REPORT_STYLES = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 40px 24px; background: #f5f6f8; color: #1f2329;
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Helvetica Neue", Arial, sans-serif;
  font-size: 15px; line-height: 1.75;
}
.rpt { max-width: 880px; margin: 0 auto; background: #fff; padding: 48px 56px 64px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.rpt-title { margin: 0 0 6px; font-size: 30px; line-height: 1.35; font-weight: 700; letter-spacing: .5px; }
.rpt-meta { width: 100%; border-collapse: collapse; margin: 18px 0 30px; font-size: 14px; }
.rpt-meta th, .rpt-meta td { border: 1px solid #d0d5dd; padding: 7px 10px; text-align: left; }
.rpt-meta th { width: 8em; background: #f2f4f7; font-weight: 600; white-space: nowrap; }
h1, h2, h3, h4 { line-height: 1.4; margin: 28px 0 12px; font-weight: 700; }
h1 { font-size: 24px; } h2 { font-size: 20px; } h3 { font-size: 17px; } h4 { font-size: 15px; }
p { margin: 12px 0; }
.rpt-list { margin: 12px 0; padding-left: 26px; }
.rpt-list li { margin: 4px 0; }
.rpt-code {
  margin: 16px 0; padding: 14px 16px; overflow: auto; white-space: pre; border-radius: 6px;
  background: #1f2329; color: #e8e8e8; font-size: 13px; line-height: 1.6;
  font-family: Consolas, "SFMono-Regular", Menlo, Consolas, monospace;
}
.rpt-code code { background: none; color: inherit; padding: 0; font-size: inherit; }
code { background: #f0f1f3; padding: 1px 5px; border-radius: 4px; font-size: .92em; font-family: Consolas, Menlo, monospace; }
blockquote { margin: 16px 0; padding: 8px 16px; border-left: 4px solid #9aa4b2; background: #f7f8fa; color: #4b5563; }
blockquote p { margin: 0; }
.rpt-table { width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 14px; }
.rpt-table th, .rpt-table td { border: 1px solid #d0d5dd; padding: 8px 10px; text-align: left; vertical-align: top; }
.rpt-table thead th { background: #f2f4f7; font-weight: 600; }
a { color: #1a56db; }
@media print {
  body { background: #fff; padding: 0; }
  .rpt { box-shadow: none; max-width: none; padding: 0; }
}
`

// base64 字母表（手写实现用，避免 btoa/Buffer）
const RPT_BASE64_TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// ZIP 里所有条目都用固定时间戳：同一份 markdown 必须产出逐字节相同的 docx，
// 否则「产物比对」这类测试与缓存都会失效。
const RPT_DOS_TIME = 0
const RPT_DOS_DATE = 0x21 // 1980-01-01

// 超链接关系从 rId2 起编号：rId1 固定留给 styles.xml。
const RPT_FIRST_LINK_RID = 2

// ── 编码原语 ────────────────────────────────────────────────────────────────

// 手写 UTF-8：宿主沙箱里没有 TextEncoder，而且必须正确处理 emoji 的代理对。
// 内容里的孤立代理项会产出非法 UTF-8 字节，调用方（转义层）负责先过滤掉。
export function rptUtf8Encode(str) {
  const s = String(str == null ? '' : str)
  const out = []
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i)
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1)
      // 高低代理项配对后是一个 BMP 之外的码点，占 4 字节
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00)
        i++
      }
    }
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
  }
  return Uint8Array.from(out)
}

// 手写 base64：不换行，标准 +/ 字母表，末组补 =。
export function rptBytesToBase64(bytes) {
  const b = bytes || []
  const n = b.length
  let out = ''
  let i = 0
  for (; i + 3 <= n; i += 3) {
    const v = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2]
    out += RPT_BASE64_TABLE[(v >>> 18) & 63] + RPT_BASE64_TABLE[(v >>> 12) & 63] +
      RPT_BASE64_TABLE[(v >>> 6) & 63] + RPT_BASE64_TABLE[v & 63]
  }
  const rest = n - i
  if (rest === 1) {
    const v = b[i] << 16
    out += RPT_BASE64_TABLE[(v >>> 18) & 63] + RPT_BASE64_TABLE[(v >>> 12) & 63] + '=='
  } else if (rest === 2) {
    const v = (b[i] << 16) | (b[i + 1] << 8)
    out += RPT_BASE64_TABLE[(v >>> 18) & 63] + RPT_BASE64_TABLE[(v >>> 12) & 63] +
      RPT_BASE64_TABLE[(v >>> 6) & 63] + '='
  }
  return out
}

// ── 文本与行内格式 ──────────────────────────────────────────────────────────

// HTML 转义。markdown 是外部输入（可能来自目标站点或抓取结果），
// 不转义就等于把「报告里的 <script>」直接变成活代码，所以这里连同引号一起转。
function rptEscapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// 剔掉 XML 1.0 不允许的字符（除 \t \n \r 外的 C0 控制符、孤立代理项、0xFFFE/0xFFFF）。
// 不做这步 Word 会直接报「文档已损坏」——它比标签配对错误更难定位。
function rptXmlClean(text) {
  const s = String(text == null ? '' : text)
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd)) {
      out += s[i]
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1)
      if (lo >= 0xdc00 && lo <= 0xdfff) { out += s[i] + s[i + 1]; i++ }
    }
  }
  return out
}

// 引号也转：同一个函数同时用于文本节点与 r:id/链接 Target 等属性值。
function rptXmlEscape(text) {
  return rptXmlClean(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// 只放行明确安全的协议：报告里的链接同样来自外部数据，
// javascript:/data: 这类在 Word 与浏览器里都是可执行面，一律降级成纯文本。
function rptSafeUrl(url) {
  const u = String(url == null ? '' : url).replace(/[\u0000-\u0020\u007f]/g, '').trim()
  if (u === '') return ''
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(u)
  if (!m) return u // 相对路径
  const scheme = m[1].toLowerCase()
  return (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'ftp') ? u : ''
}

function rptRunsToText(runs) {
  let out = ''
  for (const r of runs || []) out += r && r.text != null ? r.text : ''
  return out
}

// 行内解析：**粗体** / `行内代码` / [文字](url)。
// 刻意不做嵌套（单趟扫描，非重叠匹配）——报告里的行内格式几乎不会嵌套，
// 而支持嵌套会让 HTML 与 DOCX 两条渲染路径的分支数翻倍、更难保持一致。
function rptParseInline(text) {
  const src = String(text == null ? '' : text)
  const runs = []
  const re = /\*\*([\s\S]+?)\*\*|`([^`]+)`|\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g
  let last = 0
  let m
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) runs.push({ text: src.slice(last, m.index) })
    if (m[1] !== undefined) runs.push({ text: m[1], bold: true })
    else if (m[2] !== undefined) runs.push({ text: m[2], code: true })
    else runs.push({ text: m[3], href: rptSafeUrl(m[4]) })
    last = m.index + m[0].length
  }
  if (last < src.length) runs.push({ text: src.slice(last) })
  if (runs.length === 0) runs.push({ text: '' })
  return runs
}

// text 一律是「去掉行内标记的纯文本」，runs 才是结构化形式：
// 调用方想直接拿文本做检索/摘要时不该还看到 ** 和 []()，而两条渲染路径都只吃 runs。
function rptTextBlock(type, text, ordered) {
  const runs = rptParseInline(text)
  const block = { type: type, text: rptRunsToText(runs), runs: runs }
  if (ordered !== undefined) block.ordered = ordered
  return block
}

// ── Markdown 块解析 ─────────────────────────────────────────────────────────

function rptSplitRow(line) {
  let t = String(line).trim()
  if (t.charAt(0) === '|') t = t.slice(1)
  if (t.charAt(t.length - 1) === '|') t = t.slice(0, -1)
  return t.split('|').map(function (c) { return c.trim() })
}

function rptIsTableSeparator(line) {
  const t = String(line).trim()
  if (t.indexOf('-') < 0) return false
  if (!/^\|?[\s:|-]+\|?$/.test(t)) return false
  const cells = rptSplitRow(t)
  if (cells.length === 0) return false
  for (const c of cells) if (!/^:?-+:?$/.test(c.replace(/\s/g, ''))) return false
  return true
}

function rptIsFence(line) {
  return /^(```|~~~)/.test(String(line).trim())
}

function rptIsHeading(line) {
  return /^#{1,6}\s+/.test(String(line).trim())
}

function rptIsList(line) {
  const t = String(line).trim()
  return /^[-*]\s+/.test(t) || /^\d+[.)]\s+/.test(t)
}

function rptIsQuote(line) {
  return /^\s*>\s?/.test(String(line))
}

// 段落收集时的「下一行是否另起块」判断：段落与表格行都以 | 出现，只能靠后一行是不是分隔行区分。
function rptStartsNewBlock(lines, i) {
  const line = lines[i]
  if (rptIsHeading(line) || rptIsFence(line) || rptIsList(line) || rptIsQuote(line)) return true
  const t = String(line).trim()
  if (t.indexOf('|') >= 0 && i + 1 < lines.length && rptIsTableSeparator(lines[i + 1])) return true
  return false
}

function rptTableRows(rows) {
  let width = 0
  for (const r of rows) if (r.length > width) width = r.length
  const out = []
  for (const r of rows) {
    const cells = r.slice()
    while (cells.length < width) cells.push('')
    out.push(cells)
  }
  return out
}

// markdown → 结构化块。返回块类型：
//   h1..h4 | p | li | oli | code | quote | table
// 段落/列表项给出 text（纯文本）与 runs（行内结构）；表格给出 rows（纯文本）、
// cellRuns（每格的行内结构）与 text（表头行）。DOCX 与 HTML 都只消费 runs/cellRuns，
// 因此「网页预览」与「Word 交付件」在粗体、链接上不可能对不上。
export function rptParseMarkdown(md) {
  const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (trimmed === '') { i++; continue }

    // 围栏代码块：内容逐字保留，语言标记丢弃（两种输出都不做语法高亮）
    const fence = /^(```|~~~)/.exec(trimmed)
    if (fence) {
      const mark = fence[1]
      const body = []
      i++
      while (i < lines.length && lines[i].trim().indexOf(mark) !== 0) { body.push(lines[i]); i++ }
      if (i < lines.length) i++ // 吃掉收尾围栏；未闭合时就是到文件末尾
      blocks.push({ type: 'code', lines: body, text: body.join('\n') })
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      // #### 及以上统一按 h4：报告排版到四级标题就够，再深也只是字号差异
      const level = Math.min(heading[1].length, 4)
      blocks.push(rptTextBlock('h' + level, heading[2].trim()))
      i++
      continue
    }

    // 表格必须先于段落判断：表格行同样是普通文本行，只有「下一行是分隔行」能区分
    if (trimmed.indexOf('|') >= 0 && i + 1 < lines.length && rptIsTableSeparator(lines[i + 1])) {
      const rows = [rptSplitRow(trimmed)]
      i += 2
      while (i < lines.length && lines[i].trim() !== '' && lines[i].trim().indexOf('|') >= 0) {
        rows.push(rptSplitRow(lines[i].trim()))
        i++
      }
      const normalized = rptTableRows(rows)
      const cellRuns = normalized.map(function (r) { return r.map(rptParseInline) })
      const plain = cellRuns.map(function (r) { return r.map(rptRunsToText) })
      blocks.push({
        type: 'table',
        rows: plain,
        cellRuns: cellRuns,
        text: plain[0].join(' | '),
      })
      continue
    }

    if (rptIsQuote(raw)) {
      const parts = []
      while (i < lines.length && rptIsQuote(lines[i])) {
        parts.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      blocks.push(rptTextBlock('quote', parts.join(' ').trim()))
      continue
    }

    const ul = /^[-*]\s+(.*)$/.exec(trimmed)
    if (ul) {
      blocks.push(rptTextBlock('li', ul[1].trim(), false))
      i++
      continue
    }

    const ol = /^\d+[.)]\s+(.*)$/.exec(trimmed)
    if (ol) {
      blocks.push(rptTextBlock('oli', ol[1].trim(), true))
      i++
      continue
    }

    // 普通段落：连续非空行合并为一段，段内换行按 markdown 语义转成空格
    const para = []
    while (i < lines.length && lines[i].trim() !== '' && !rptStartsNewBlock(lines, i)) {
      para.push(lines[i].trim())
      i++
    }
    blocks.push(rptTextBlock('p', para.join(' ')))
  }
  return blocks
}

// ── HTML 渲染 ───────────────────────────────────────────────────────────────

function rptRunsHtml(runs) {
  let out = ''
  for (const r of runs || []) {
    const text = rptEscapeHtml(r && r.text != null ? r.text : '')
    if (r && r.code) out += '<code>' + text + '</code>'
    else if (r && r.href) out += '<a href="' + rptEscapeHtml(r.href) + '" rel="noopener noreferrer">' + text + '</a>'
    else if (r && r.bold) out += '<strong>' + text + '</strong>'
    else out += text
  }
  return out
}

function rptCellRuns(cell) {
  // rptParseMarkdown 已经给出 cellRuns；这里只兜底手工构造的 rows
  if (Array.isArray(cell)) return cell
  return rptParseInline(cell)
}

function rptTableHtml(rows, headerRow) {
  const body = (rows || []).map(function (row, ri) {
    const tag = headerRow && ri === 0 ? 'th' : 'td'
    const cells = row.map(function (c) { return '<' + tag + '>' + rptRunsHtml(rptCellRuns(c)) + '</' + tag + '>' })
    return '<tr>' + cells.join('') + '</tr>'
  })
  if (body.length === 0) return ''
  const head = headerRow && body.length > 0 ? '<thead>' + body[0] + '</thead>' : ''
  const tail = (headerRow ? body.slice(1) : body).join('')
  return '<table class="rpt-table">' + head + (tail ? '<tbody>' + tail + '</tbody>' : '') + '</table>'
}

function rptMetaHtml(meta) {
  const keys = meta ? Object.keys(meta) : []
  if (keys.length === 0) return ''
  const rows = keys.map(function (k) {
    return '<tr><th>' + rptEscapeHtml(k) + '</th><td>' + rptEscapeHtml(String(meta[k])) + '</td></tr>'
  })
  return '<table class="rpt-meta"><tbody>' + rows.join('') + '</tbody></table>'
}

function rptBlocksHtml(blocks) {
  const out = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3' || b.type === 'h4') {
      out.push('<' + b.type + '>' + rptRunsHtml(b.runs) + '</' + b.type + '>')
      continue
    }
    if (b.type === 'p') { out.push('<p>' + rptRunsHtml(b.runs) + '</p>'); continue }
    if (b.type === 'quote') { out.push('<blockquote><p>' + rptRunsHtml(b.runs) + '</p></blockquote>'); continue }
    if (b.type === 'code') {
      out.push('<pre class="rpt-code"><code>' + rptEscapeHtml((b.lines || []).join('\n')) + '</code></pre>')
      continue
    }
    if (b.type === 'table') {
      out.push(rptTableHtml(b.cellRuns || b.rows || [], true))
      continue
    }
    if (b.type === 'li' || b.type === 'oli') {
      // 相邻同类列表项合并成一个 <ul>/<ol>，否则每项都会被迫套一层列表
      const tag = b.type === 'oli' ? 'ol' : 'ul'
      const items = []
      let j = i
      while (j < blocks.length && blocks[j].type === b.type) {
        items.push('<li>' + rptRunsHtml(blocks[j].runs) + '</li>')
        j++
      }
      out.push('<' + tag + ' class="rpt-list">' + items.join('') + '</' + tag + '>')
      i = j - 1
      continue
    }
  }
  return out.join('\n')
}

// markdown → 完整自包含 HTML（无外部资源，可直接进浏览器或另存为 .html）。
// 必须是完整文档而不是片段：交付时经常直接 base64 内联或写盘双击打开，
// 片段在那种场景下会因缺 <meta charset> 而把中文显示成乱码。
export function rptBuildHtml(options) {
  const opts = options || {}
  const title = String(opts.title == null ? '' : opts.title)
  const meta = opts.meta && typeof opts.meta === 'object' ? opts.meta : null
  const blocks = rptParseMarkdown(opts.markdown == null ? '' : opts.markdown)
  const parts = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>' + rptEscapeHtml(title) + '</title>',
    '<style>' + RPT_REPORT_STYLES + '</style>',
    '</head>',
    '<body>',
    '<article class="rpt">',
    '<h1 class="rpt-title">' + rptEscapeHtml(title) + '</h1>',
    rptMetaHtml(meta),
    rptBlocksHtml(blocks),
    '</article>',
    '</body>',
    '</html>',
  ]
  return parts.filter(function (p) { return p !== '' }).join('\n') + '\n'
}

// ── DOCX（OOXML）渲染 ───────────────────────────────────────────────────────

// 链接关系表：同一 URL 只建一条关系（Word 对重复 rId 目标不报错，但产物会无谓膨胀）。
// links 是 { id, target } 数组，渲染 document.xml 时按需追加。
function rptLinkId(links, target) {
  for (const l of links) if (l.target === target) return l.id
  const id = 'rId' + (links.length + RPT_FIRST_LINK_RID)
  links.push({ id: id, target: target })
  return id
}

function rptDocxRun(run, links, mono) {
  const r = run || {}
  const rPr = []
  if (mono || r.code) rPr.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>')
  if (r.bold) rPr.push('<w:b/>')
  if (r.href) rPr.push('<w:color w:val="0563C1"/><w:u w:val="single"/>')
  const text = '<w:t xml:space="preserve">' + rptXmlEscape(r.text == null ? '' : r.text) + '</w:t>'
  const inner = '<w:r>' + (rPr.length ? '<w:rPr>' + rPr.join('') + '</w:rPr>' : '') + text + '</w:r>'
  if (r.href) {
    const id = rptLinkId(links, r.href)
    return '<w:hyperlink r:id="' + id + '">' + inner + '</w:hyperlink>'
  }
  return inner
}

function rptDocxRuns(runs, links, mono) {
  let out = ''
  for (const r of runs || []) out += rptDocxRun(r, links, mono)
  return out
}

function rptDocxPara(style, runs, links) {
  const body = rptDocxRuns(runs, links, false)
  const pPr = style ? '<w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>' : ''
  if (body === '') return '<w:p>' + pPr + '</w:p>'
  return '<w:p>' + pPr + body + '</w:p>'
}

// 代码块：每行一个等宽段落。用段落而不是 <w:br/>，因为报告里的行号/缩进对齐
// 在段落下更稳，且复制到别处时仍是按行的。
function rptDocxCode(lines, links) {
  const out = []
  const src = lines && lines.length ? lines : ['']
  for (const line of src) {
    const run = line === '' ? '' : rptDocxRun({ text: line }, links, true)
    out.push('<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr>' + run + '</w:p>')
  }
  return out.join('')
}

const RPT_TBL_BORDERS =
  '<w:tblBorders>' +
  '<w:top w:val="single" w:sz="4" w:space="0" w:color="999999"/>' +
  '<w:left w:val="single" w:sz="4" w:space="0" w:color="999999"/>' +
  '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="999999"/>' +
  '<w:right w:val="single" w:sz="4" w:space="0" w:color="999999"/>' +
  '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="999999"/>' +
  '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="999999"/>' +
  '</w:tblBorders>'

function rptDocxTable(rows, links, headerBold, totalWidth) {
  const src = rows || []
  if (src.length === 0) return ''
  let cols = 0
  for (const r of src) if (r.length > cols) cols = r.length
  if (cols === 0) return ''
  const colW = Math.floor((totalWidth || 9000) / cols)
  const grid = []
  for (let c = 0; c < cols; c++) grid.push('<w:gridCol w:w="' + colW + '"/>')
  const trs = []
  for (let ri = 0; ri < src.length; ri++) {
    const row = src[ri]
    const tcs = []
    for (let ci = 0; ci < cols; ci++) {
      const cell = row[ci]
      let runs = rptCellRuns(cell === undefined ? '' : cell)
      if (headerBold && ri === 0) runs = runs.map(function (r) { return { text: r.text, bold: true, code: r.code, href: r.href } })
      // 单元格至少要有一个块级元素，空 <w:tc/> 会让 Word 判为损坏
      const para = '<w:p>' + rptDocxRuns(runs, links, false) + '</w:p>'
      tcs.push('<w:tc><w:tcPr><w:tcW w:w="' + colW + '" w:type="dxa"/></w:tcPr>' + para + '</w:tc>')
    }
    trs.push('<w:tr>' + tcs.join('') + '</w:tr>')
  }
  return '<w:tbl><w:tblPr><w:tblW w:w="' + (totalWidth || 9000) + '" w:type="dxa"/>' + RPT_TBL_BORDERS +
    '</w:tblPr><w:tblGrid>' + grid.join('') + '</w:tblGrid>' + trs.join('') + '</w:tbl>'
}

// styles.xml 里所有 w:pStyle 引用到的样式都必须在这里有定义，
// 否则 Word 会按「样式不存在」处理（内容还在，但版式静默丢失）。
const RPT_STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults><w:rPrDefault><w:rPr>' +
  '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="21"/><w:szCs w:val="21"/>' +
  '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="320" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Report Code"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/></w:pPr>' +
  '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Report Quote"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:ind w:left="420"/></w:pPr><w:rPr><w:i/><w:color w:val="4B5563"/></w:rPr></w:style>' +
  '</w:styles>'

const RPT_CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '</Types>'

const RPT_ROOT_RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>'

const RPT_DOC_RELS_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'

// 文档级关系：正文里的每个外链都要在这里登记一条 TargetMode="External" 的关系，
// 否则 <w:hyperlink r:id> 指向不存在的 rId，Word 会丢掉链接（或被判为损坏）。
function rptDocRelsXml(links) {
  let out = RPT_DOC_RELS_HEAD
  for (const l of links) {
    out += '<Relationship Id="' + l.id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' +
      rptXmlEscape(l.target) + '" TargetMode="External"/>'
  }
  return out + '</Relationships>'
}

const RPT_SECT_PR =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>' +
  '</w:sectPr>'

// markdown → 真·Word .docx 字节流。返回 Uint8Array（未压缩 ZIP，纯 JS 写）。
export function rptBuildDocx(options) {
  const opts = options || {}
  const title = String(opts.title == null ? '' : opts.title)
  const meta = opts.meta && typeof opts.meta === 'object' ? opts.meta : null
  const blocks = rptParseMarkdown(opts.markdown == null ? '' : opts.markdown)
  const links = []
  const parts = []

  if (title !== '') parts.push(rptDocxPara('Title', [{ text: title }], links))

  if (meta) {
    const keys = Object.keys(meta)
    if (keys.length > 0) {
      const rows = keys.map(function (k) { return [k, String(meta[k])] })
      parts.push(rptDocxTable(rows, links, true, 9000))
    }
  }

  let listIndex = 0
  let prevType = ''
  let lastWasTable = false
  for (const b of blocks) {
    if (b.type !== prevType) listIndex = 0
    prevType = b.type
    if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3' || b.type === 'h4') {
      parts.push(rptDocxPara('Heading' + b.type.slice(1), b.runs, links))
    } else if (b.type === 'p') {
      parts.push(rptDocxPara('Normal', b.runs, links))
    } else if (b.type === 'quote') {
      parts.push(rptDocxPara('Quote', b.runs, links))
    } else if (b.type === 'li') {
      listIndex++
      // 真项目符号要 numbering.xml + 额外的 content-type/关系，为一份交付用报告不值得；
      // 直接把符号写进文本，Word 里看起来一样。
      parts.push(rptDocxPara('Normal', [{ text: '• ' }].concat(b.runs), links))
    } else if (b.type === 'oli') {
      listIndex++
      parts.push(rptDocxPara('Normal', [{ text: listIndex + '. ' }].concat(b.runs), links))
    } else if (b.type === 'code') {
      parts.push(rptDocxCode(b.lines || [], links))
    } else if (b.type === 'table') {
      parts.push(rptDocxTable(b.cellRuns || b.rows || [], links, true, 9000))
    }
    lastWasTable = b.type === 'table'
  }

  // OOXML 规定正文最后一个块不能是表格（表格后必须跟段落，否则 Word 判损坏）
  if (lastWasTable) parts.push('<w:p/>')

  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<w:body>' + parts.join('') + RPT_SECT_PR + '</w:body></w:document>'

  return rptZipBuild([
    { name: '[Content_Types].xml', data: rptUtf8Encode(RPT_CONTENT_TYPES_XML) },
    { name: '_rels/.rels', data: rptUtf8Encode(RPT_ROOT_RELS_XML) },
    { name: 'word/_rels/document.xml.rels', data: rptUtf8Encode(rptDocRelsXml(links)) },
    { name: 'word/document.xml', data: rptUtf8Encode(documentXml) },
    { name: 'word/styles.xml', data: rptUtf8Encode(RPT_STYLES_XML) },
  ])
}

// ── ZIP（stored，无压缩） ───────────────────────────────────────────────────

// 表驱动 CRC-32（IEEE 反射多项式 0xEDB88320）。表只建一次，报告里常有几十个条目。
let rptCrcTable = null
function rptCrc32(bytes) {
  if (rptCrcTable === null) {
    const t = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
      t.push(c >>> 0)
    }
    rptCrcTable = t
  }
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = rptCrcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// ZIP 里所有多字节整数都是小端
function rptPutU16(arr, at, value) {
  arr[at] = value & 0xff
  arr[at + 1] = (value >>> 8) & 0xff
}

function rptPutU32(arr, at, value) {
  arr[at] = value & 0xff
  arr[at + 1] = (value >>> 8) & 0xff
  arr[at + 2] = (value >>> 16) & 0xff
  arr[at + 3] = (value >>> 24) & 0xff
}

// flag bit 11 = 文件名为 UTF-8。本模块的文件名全是 ASCII，设上无副作用，
// 但万一以后加了中文部件名，这里不用再改。
const RPT_ZIP_FLAG = 0x0800

function rptZipLocalHeader(nameBytes, crc, size) {
  const h = new Uint8Array(30 + nameBytes.length)
  rptPutU32(h, 0, 0x04034b50)
  rptPutU16(h, 4, 20) // version needed
  rptPutU16(h, 6, RPT_ZIP_FLAG)
  rptPutU16(h, 8, 0) // method 0 = stored
  rptPutU16(h, 10, RPT_DOS_TIME)
  rptPutU16(h, 12, RPT_DOS_DATE)
  rptPutU32(h, 14, crc)
  rptPutU32(h, 18, size) // compressed size == uncompressed size（stored）
  rptPutU32(h, 22, size)
  rptPutU16(h, 26, nameBytes.length)
  rptPutU16(h, 28, 0) // extra field length
  h.set(nameBytes, 30)
  return h
}

function rptZipCentralHeader(nameBytes, crc, size, offset) {
  const h = new Uint8Array(46 + nameBytes.length)
  rptPutU32(h, 0, 0x02014b50)
  rptPutU16(h, 4, 20) // version made by（MS-DOS / 2.0）
  rptPutU16(h, 6, 20) // version needed
  rptPutU16(h, 8, RPT_ZIP_FLAG)
  rptPutU16(h, 10, 0)
  rptPutU16(h, 12, RPT_DOS_TIME)
  rptPutU16(h, 14, RPT_DOS_DATE)
  rptPutU32(h, 16, crc)
  rptPutU32(h, 20, size)
  rptPutU32(h, 24, size)
  rptPutU16(h, 28, nameBytes.length)
  rptPutU16(h, 30, 0) // extra
  rptPutU16(h, 32, 0) // comment
  rptPutU16(h, 34, 0) // disk number start
  rptPutU16(h, 36, 0) // internal attrs
  rptPutU32(h, 38, 0) // external attrs
  rptPutU32(h, 42, offset) // 本条目 local header 的偏移
  h.set(nameBytes, 46)
  return h
}

function rptZipEocd(count, cdSize, cdOffset) {
  const h = new Uint8Array(22)
  rptPutU32(h, 0, 0x06054b50)
  rptPutU16(h, 4, 0) // 本磁盘号
  rptPutU16(h, 6, 0) // 中央目录起始磁盘号
  rptPutU16(h, 8, count) // 本磁盘条目数
  rptPutU16(h, 10, count) // 总条目数
  rptPutU32(h, 12, cdSize)
  rptPutU32(h, 16, cdOffset)
  rptPutU16(h, 20, 0) // 注释长度
  return h
}

// entries: [{ name, data: Uint8Array }] → 完整 ZIP 字节流。
// 故意用 stored：报告产物只有几十 KB，压缩省不下多少，却要多一条 inflate 实现与
// 一大类「解压出来不对」的失败面。真需要压缩时应交给调用方而不是这里。
function rptZipBuild(entries) {
  const local = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const nameBytes = rptUtf8Encode(e.name)
    const data = e.data
    const crc = rptCrc32(data)
    const head = rptZipLocalHeader(nameBytes, crc, data.length)
    local.push(head, data)
    central.push(rptZipCentralHeader(nameBytes, crc, data.length, offset))
    offset += head.length + data.length
  }
  let cdSize = 0
  for (const c of central) cdSize += c.length
  const chunks = local.concat(central, [rptZipEocd(entries.length, cdSize, offset)])
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let pos = 0
  for (const c of chunks) { out.set(c, pos); pos += c.length }
  return out
}
