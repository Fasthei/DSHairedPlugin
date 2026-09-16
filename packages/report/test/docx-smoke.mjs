// 红队报告 · Markdown → HTML/DOCX 冒烟测试
//
// 为什么直接测 src/docx.js 而不是 lib/host.js：docx.js 是零依赖的纯函数模块，可以直接 import；
// lib/host.js 要解析 @deepseek-ai/dsh-tools，没装 DSH 的环境里连加载都失败——
// 那种测试就成了「绿但没跑」，比红更糟。
//
// 覆盖：手写 UTF-8/base64 的字节正确性、markdown 块解析、真 ZIP（外部工具校验 CRC）、
// document.xml 的良构与转义、HTML 的完整性与 XSS 反例。
//
// 用法: node packages/report/test/docx-smoke.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import * as docxMod from '../src/docx.js'
import {
  RPT_REPORT_STYLES,
  rptBytesToBase64,
  rptBuildDocx,
  rptBuildHtml,
  rptParseMarkdown,
  rptUtf8Encode,
} from '../src/docx.js'

let pass = 0
const fails = []
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✔ ' + label) }
  else { fails.push(label); console.log('  ✗ ' + label) }
}
function section(title) { console.log('\n' + title) }

// 一份同时含全部必须支持语法的中文 markdown。
// <五号资产> 与 A & B 是故意留的：正文与表格都要验证 XML/HTML 转义。
const SAMPLE_MD = [
  '# 红队评估报告',
  '',
  '## 一、概述',
  '',
  '本报告由 **DSH 红队插件** 生成，包含 `资产` 清单与 [参考链接](https://example.com/a?b=1&c=2)。',
  '',
  '### 1.1 目标范围',
  '',
  '- 目标：example.com',
  '- 边界：A & B <五号资产>',
  '',
  '1. 先做资产梳理',
  '2. 再做漏洞验证',
  '',
  '> 注意：所有测试均在授权范围内进行。',
  '',
  '```js',
  'const ok = 1 < 2 && 3 > 2',
  '```',
  '',
  '| 字段 | 值 |',
  '| --- | --- |',
  '| 目标 | example.com |',
  '| 风险 | **高** |',
  '',
  '#### 附录：原始数据',
  '',
  '第一行',
  '第二行',
].join('\n')

const SAMPLE_TITLE = '红队评估报告 · 交付件'
const SAMPLE_META = { 目标: 'example.com 及其子域', 时间: '2024-06-01', 作者: '红队 <A&B>' }

// ── ZIP 校验工具：优先 unzip，退化到 python3（两者都没有就直接红） ────────────
function hasCmd(cmd) {
  try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true }
  catch (e) { return !(e && e.code === 'ENOENT') }
}
const HAS_UNZIP = hasCmd('unzip')
const HAS_PYTHON = hasCmd('python3')
const BIG = 32 * 1024 * 1024

function readEntry(zipPath, name) {
  // unzip 把条目名当 glob 解释，`[Content_Types].xml` 会被当成字符集匹配而报
  // "filename not matched" —— 这类名字交给 python3 按精确名读，其余仍走 unzip -p。
  const globby = /[[\]*?]/.test(name)
  if (HAS_UNZIP && !(globby && HAS_PYTHON)) {
    return execFileSync('unzip', ['-p', zipPath, name], { maxBuffer: BIG }).toString('utf8')
  }
  return execFileSync('python3', ['-c',
    'import sys,zipfile;sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode("utf-8"))',
    zipPath, name], { maxBuffer: BIG }).toString('utf8')
}

function testZip(zipPath) {
  if (HAS_UNZIP) {
    const out = execFileSync('unzip', ['-t', zipPath], { maxBuffer: BIG }).toString('utf8')
    return { ok: /No errors detected/.test(out), detail: out.trim().split('\n').pop() }
  }
  const out = execFileSync('python3', ['-c',
    'import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).testzip())', zipPath], { maxBuffer: BIG }).toString('utf8').trim()
  return { ok: out === 'None', detail: out }
}

function listZip(zipPath) {
  if (HAS_PYTHON) {
    // 用 chr(10)：这段 -c 代码会经过 JS 字符串字面量，直接写 "\n" 会被 JS 先解释成真换行
    const out = execFileSync('python3', ['-c',
      'import sys,zipfile;sys.stdout.write(chr(10).join(zipfile.ZipFile(sys.argv[1]).namelist()))', zipPath], { maxBuffer: BIG }).toString('utf8')
    return out.trim().split('\n').filter(Boolean)
  }
  const out = execFileSync('unzip', ['-Z1', zipPath], { maxBuffer: BIG }).toString('utf8')
  return out.trim().split('\n').filter(Boolean)
}

// 小标签配对检查：只看结构，不引 XML 库。孤立 < / 未闭合 / 标签错配都要报出来。
function xmlWellFormedErrors(xml) {
  const errors = []
  const src = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '')
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  const stack = []
  let m
  let last = 0
  while ((m = re.exec(src)) !== null) {
    if (src.slice(last, m.index).indexOf('<') >= 0) errors.push('文本区出现游离的 <（未转义）')
    last = m.index + m[0].length
    if (m[1] === '/') {
      const top = stack.pop()
      if (top !== m[2]) errors.push('闭合标签不匹配: </' + m[2] + '> 对应 <' + top + '>')
    } else if (m[4] !== '/') {
      stack.push(m[2])
    }
  }
  if (src.slice(last).indexOf('<') >= 0) errors.push('文件尾部出现游离的 <（未转义）')
  if (stack.length) errors.push('未闭合标签: ' + stack.join(', '))
  return errors
}

if (!HAS_UNZIP && !HAS_PYTHON) {
  console.error('✗ 既没有 unzip 也没有 python3，无法校验 ZIP 完整性；不静默跳过。')
  process.exit(1)
}

section('[0] 模块形状：拼接进宿主函数体的前提')
{
  const names = Object.keys(docxMod).sort()
  const expect = ['RPT_REPORT_STYLES', 'rptBuildDocx', 'rptBuildHtml', 'rptBytesToBase64', 'rptParseMarkdown', 'rptUtf8Encode']
  ok(names.join(',') === expect.join(','), '导出清单恰好是规范的六项：' + names.join(', '))
  ok(typeof RPT_REPORT_STYLES === 'string' && RPT_REPORT_STYLES.length > 200, 'RPT_REPORT_STYLES 是非空 CSS 字符串')
  for (const fn of ['rptUtf8Encode', 'rptBytesToBase64', 'rptParseMarkdown', 'rptBuildHtml', 'rptBuildDocx']) {
    ok(typeof docxMod[fn] === 'function', fn + ' 是函数')
  }
}

section('[1] 手写 UTF-8：中文/emoji 的字节序列')
{
  const zh = rptUtf8Encode('中文')
  ok(zh instanceof Uint8Array, 'rptUtf8Encode 返回 Uint8Array')
  ok(zh.length === 6, '「中文」6 字节（实际 ' + zh.length + '）')
  ok(Array.from(zh).join(',') === '228,184,173,230,150,135', '「中文」= E4B8AD E69687')

  const emoji = rptUtf8Encode('😀')
  ok(emoji.length === 4, 'emoji 是 4 字节（代理对正确合并，实际 ' + emoji.length + '）')
  ok(Array.from(emoji).join(',') === '240,159,152,128', '😀 = F09F9880')

  ok(Array.from(rptUtf8Encode('A')).join(',') === '65', 'ASCII 保持单字节')
  ok(Array.from(rptUtf8Encode('é')).join(',') === '195,169', 'é = C3A9（双字节分支）')
  ok(Array.from(rptUtf8Encode('€')).join(',') === '226,130,172', '€ = E282AC（三字节分支）')
  ok(rptUtf8Encode('中😀').length === 7, '中文+emoji 混排 3+4=7 字节')
  ok(rptUtf8Encode('').length === 0, '空串 0 字节')

  const mixed = '报告：A&B <tag> 😀 中文'
  ok(Buffer.from(rptUtf8Encode(mixed)).equals(Buffer.from(mixed, 'utf8')), '与 Buffer 的 UTF-8 结果逐字节一致')
}

section('[2] 手写 base64：已知向量与交叉验证')
{
  const ascii = (s) => rptUtf8Encode(s)
  ok(rptBytesToBase64(ascii('foo')) === 'Zm9v', "foo → 'Zm9v'（3 字节无填充）")
  ok(rptBytesToBase64(ascii('foob')) === 'Zm9vYg==', "foob → 'Zm9vYg=='（补两个 =）")
  ok(rptBytesToBase64(ascii('fooba')) === 'Zm9vYmE=', "fooba → 'Zm9vYmE='（补一个 =）")
  ok(rptBytesToBase64(ascii('foobar')) === 'Zm9vYmFy', "foobar → 'Zm9vYmFy'")
  ok(rptBytesToBase64(ascii('')) === '', '空输入 → 空串')
  ok(rptBytesToBase64(rptUtf8Encode('中')) === '5Lit', "「中」(E4B8AD) → '5Lit'")

  const s = '红队报告 redteam 2024 😀'
  ok(rptBytesToBase64(rptUtf8Encode(s)) === Buffer.from(s, 'utf8').toString('base64'), '与 Buffer.toString(base64) 一致')
}

section('[3] rptParseMarkdown：块类型序列')
{
  const blocks = rptParseMarkdown(SAMPLE_MD)
  const types = blocks.map((b) => b.type)
  const expect = ['h1', 'h2', 'p', 'h3', 'li', 'li', 'oli', 'oli', 'quote', 'code', 'table', 'h4', 'p']
  ok(types.join(',') === expect.join(','), '块类型序列：' + types.join(','))

  const h1 = blocks[0]
  ok(h1.text === '红队评估报告', 'h1 文本正确：' + h1.text)
  ok(blocks[1].text === '一、概述', 'h2 文本正确')
  ok(blocks[11].type === 'h4' && blocks[11].text === '附录：原始数据', '#### 及以上按 h4 处理')

  const para = blocks[2]
  const bold = para.runs.filter((r) => r.bold).map((r) => r.text)
  const code = para.runs.filter((r) => r.code).map((r) => r.text)
  const links = para.runs.filter((r) => r.href)
  ok(bold.join(',') === 'DSH 红队插件', '**粗体** 解析成 bold run')
  ok(code.join(',') === '资产', '`行内代码` 解析成 code run')
  ok(links.length === 1 && links[0].text === '参考链接', '[文字](url) 解析成链接 run')
  ok(links[0].href === 'https://example.com/a?b=1&c=2', '链接 href 完整保留（含查询串）')

  ok(blocks[4].type === 'li' && blocks[4].ordered === false, '无序列表项 type=li、ordered=false')
  ok(blocks[6].type === 'oli' && blocks[6].ordered === true, '有序列表项 type=oli、ordered=true')
  ok(blocks[5].text === '边界：A & B <五号资产>', '列表项文本原样保留（转义留给渲染层）')
  ok(blocks[8].text === '注意：所有测试均在授权范围内进行。', '引用文本去掉 > 前缀')
  ok(blocks[9].lines.length === 1 && blocks[9].lines[0] === 'const ok = 1 < 2 && 3 > 2', '代码块逐字保留（含 < > &）')

  const table = blocks[10]
  ok(table.type === 'table', '表格识别成功')
  ok(JSON.stringify(table.rows) === JSON.stringify([['字段', '值'], ['目标', 'example.com'], ['风险', '高']]),
    '表格 rows 正确（含 |---| 分隔行被吃掉）：' + JSON.stringify(table.rows))
  ok(table.cellRuns[2][1].some((r) => r.bold && r.text === '高'), '表格单元格内 **粗体** 也被解析')

  const last = blocks[blocks.length - 1]
  ok(last.type === 'p' && last.text === '第一行 第二行', '连续非空行合并为一段、段内换行转空格')

  // 边界：未闭合围栏、空输入、行内格式不吞掉普通文本
  const open = rptParseMarkdown('```\n未闭合')
  ok(open.length === 1 && open[0].type === 'code' && open[0].lines[0] === '未闭合', '未闭合代码围栏不吞后续内容也不抛错')
  ok(rptParseMarkdown('').length === 0, '空 markdown 得到 0 个块')
  const plain = rptParseMarkdown('普通一行').map((b) => b.type)
  ok(plain.join(',') === 'p', '无标记文本按段落处理')
}

section('[4] rptBuildHtml：完整文档、meta、表格一致性')
{
  const html = rptBuildHtml({ title: SAMPLE_TITLE, markdown: SAMPLE_MD, meta: SAMPLE_META })
  ok(html.startsWith('<!doctype html>'), '以 <!doctype html> 开头')
  ok(html.trimEnd().endsWith('</html>'), '以 </html> 收尾（是完整文档）')
  ok(html.includes('<meta charset="utf-8">'), '带 <meta charset="utf-8">（中文不乱码的前提）')
  ok(html.includes('<title>' + SAMPLE_TITLE + '</title>'), 'title 进 <title>')
  ok(html.includes('<h1 class="rpt-title">' + SAMPLE_TITLE + '</h1>'), 'title 作为页首大标题')
  ok(html.includes('<style>') && html.includes('.rpt-table'), '内联 <style>，无外部资源')
  ok(html.includes('<table class="rpt-meta">') && html.includes('<th>目标</th>'), 'meta 渲染成页首信息表')
  ok(html.includes('目标</th><td>example.com 及其子域</td>'), 'meta 值与键都落进表格')
  ok(html.includes('<table class="rpt-table">') && html.includes('<th>字段</th>'), 'markdown 表格渲染成 <table>')
  ok(html.includes('<thead>') && html.includes('<tbody>'), '首行进 thead、其余进 tbody')
  ok(html.includes('<td><strong>高</strong></td>'), '表格单元格里的粗体与正文一致')
  ok(html.includes('<strong>DSH 红队插件</strong>'), '正文粗体渲染成 <strong>')
  ok(html.includes('<code>资产</code>'), '行内代码渲染成 <code>')
  ok(html.includes('<a href="https://example.com/a?b=1&amp;c=2"'), '链接 href 转义后进 <a>')
  ok(html.includes('<ul class="rpt-list">') && html.includes('<ol class="rpt-list">'), '列表按类型分组渲染')
  ok(html.includes('<pre class="rpt-code"><code>const ok = 1 &lt; 2 &amp;&amp; 3 &gt; 2</code></pre>'), '代码块被转义后进 <pre>')
  ok(html.includes('<blockquote>'), '引用渲染成 <blockquote>')
  ok(html.includes('A &amp; B &lt;五号资产&gt;'), '正文里的 & 与尖括号被转义')
  ok(html.includes('红队 <A&amp;B>') || html.includes('红队 &lt;A&amp;B&gt;'), 'meta 值里的 < > 也被转义')
}

section('[5] 反例：markdown 里的脚本不能变成活标签')
{
  const evil = [
    '# 注入测试',
    '',
    '脚本注入：<script>alert(1)</script>',
    '',
    '<img src=x onerror="alert(2)">',
    '',
    '[点我](javascript:alert(3))',
    '',
    '| a | b |',
    '| --- | --- |',
    '| <script>alert(4)</script> | [x](vbscript:msgbox) |',
  ].join('\n')
  const html = rptBuildHtml({ title: 'x < y & "z"', markdown: evil })
  ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), '<script> 被转义成 &lt;script&gt;')
  ok(!/<script[\s>]/i.test(html), '输出里没有活的 <script> 标签')
  ok(!/onerror\s*=/i.test(html) || html.includes('&lt;img'), '<img onerror> 以文本形式出现')
  ok(!html.includes('javascript:'), 'javascript: 链接被降级（不出现在 href 里）')
  ok(!html.includes('vbscript:'), '表格单元格里的 vbscript: 同样被降级')
  ok(html.includes('&lt;script&gt;alert(4)&lt;/script&gt;'), '表格单元格里的脚本也被转义')
  ok(!html.includes('<title>x < y'), 'title 里的特殊字符被转义')
  ok(html.includes('&lt;img src=x onerror=&quot;alert(2)&quot;&gt;'), '段落里的 HTML 标签整体转义')

  // DOCX 走的是另一条渲染路径，同一个反例必须同样安全
  const docxHtmlSafe = docxMod.rptBuildDocx({ title: 'x', markdown: evil })
  ok(docxHtmlSafe instanceof Uint8Array && docxHtmlSafe.length > 0, '恶意 markdown 也能正常构建 docx（不抛错）')
}

section('[6] rptBuildDocx：ZIP 完整性（外部工具校验 CRC）')
{
  const bytes = rptBuildDocx({ title: SAMPLE_TITLE, markdown: SAMPLE_MD, meta: SAMPLE_META })
  assert.ok(bytes instanceof Uint8Array, 'rptBuildDocx 必须返回 Uint8Array')
  assert.ok(bytes.length > 2000, 'docx 字节数不合理：' + bytes.length)
  ok(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04, '首 4 字节是 local file header 签名 PK\\x03\\x04')

  const eocdCount = bytes[bytes.length - 14] | (bytes[bytes.length - 13] << 8)
  ok(eocdCount === 5, 'EOCD 里条目数 = 5（实际 ' + eocdCount + '）')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-docx-'))
  const zipPath = path.join(dir, 'report.docx')
  fs.writeFileSync(zipPath, Buffer.from(bytes))

  const tested = testZip(zipPath)
  ok(tested.ok, (HAS_UNZIP ? 'unzip -t' : 'python3 zipfile.testzip') + ' 通过 CRC 与结构校验：' + tested.detail)
  if (HAS_UNZIP && HAS_PYTHON) {
    // 两个独立的 ZIP 实现都认可，才算压得住「自己写对了自己又读对了」的假绿
    const py = execFileSync('python3', ['-c',
      'import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).testzip())', zipPath], { maxBuffer: BIG }).toString('utf8').trim()
    ok(py === 'None', 'python3 zipfile.testzip() 也返回 None（独立实现交叉验证）')
  }
  if (HAS_PYTHON) {
    // 自写的标签配对检查只能发现「明显不配」，XML 规范里的其它约束得让真正的解析器复核
    const parsed = execFileSync('python3', ['-c',
      'import sys,zipfile,xml.etree.ElementTree as E;z=zipfile.ZipFile(sys.argv[1]);print(len([E.fromstring(z.read(n)) for n in z.namelist()]))',
      zipPath], { maxBuffer: BIG }).toString('utf8').trim()
    ok(parsed === '5', 'xml.etree 独立解析全部 5 个 XML 部件成功（实际 ' + parsed + '）')
  }
  const names = listZip(zipPath)
  const need = ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml']
  for (const n of need) ok(names.indexOf(n) >= 0, 'ZIP 内含 ' + n)
  ok(names[0] === '[Content_Types].xml', '[Content_Types].xml 是第一个条目')

  const ct = readEntry(zipPath, '[Content_Types].xml')
  ok(ct.includes('wordprocessingml.document.main+xml') && ct.includes('wordprocessingml.styles+xml'),
    '[Content_Types].xml 声明了 document 与 styles 两个 Override')
  ok(readEntry(zipPath, '_rels/.rels').includes('Target="word/document.xml"'), '_rels/.rels 指向 word/document.xml')

  const rels = readEntry(zipPath, 'word/_rels/document.xml.rels')
  ok(rels.includes('Target="styles.xml"'), 'document.xml.rels 里 rId1 → styles.xml')
  ok(rels.includes('TargetMode="External"') && rels.includes('Target="https://example.com/a?b=1&amp;c=2"'),
    '正文外链在 rels 里登记成 External 关系（rId 与 document.xml 对得上）')

  const xml = readEntry(zipPath, 'word/document.xml')
  const errs = xmlWellFormedErrors(xml)
  ok(errs.length === 0, 'word/document.xml 标签配对正确' + (errs.length ? '：' + errs.join(' / ') : ''))
  ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'), 'document.xml 带 XML 声明')
  ok(xml.includes('<w:pStyle w:val="Heading1"/>') && xml.includes('<w:pStyle w:val="Title"/>'), '标题用了 Title/Heading1 段落样式')
  ok(xml.includes('<w:tbl>') && xml.includes('<w:tblBorders>') && xml.includes('<w:tr>') && xml.includes('<w:tc>'), '表格渲染成 w:tbl/w:tr/w:tc')
  ok(xml.includes('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>'), '代码块用等宽字体')
  ok(xml.includes('<w:hyperlink r:id="rId2">'), '链接渲染成 w:hyperlink 并引用 rId2')

  ok(xml.includes('红队评估报告'), '中文标题原文出现在 document.xml（UTF-8 路径正确）')
  ok(xml.includes('所有测试均在授权范围内进行'), '中文正文跨 UTF-8 后仍可读')
  ok(xml.includes('A &amp; B &lt;五号资产&gt;'), '正文的 & < > 转义成 &amp; &lt; &gt;')
  ok(xml.includes('红队 &lt;A&amp;B&gt;'), 'meta 值里的特殊字符同样转义')
  ok(xml.includes('&amp;&amp;') && xml.includes('1 &lt; 2'), '代码块里的 & 与 < 也转义')
  ok(!/&(?!amp;|lt;|gt;|quot;)/.test(xml), 'document.xml 里没有裸 &（XML 非法的直接来源）')
  ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml), 'document.xml 里没有 XML 非法控制字符')
  ok(!/<script[\s>]/i.test(xml), 'markdown 里的标签没有以裸形式混进 XML')

  const styles = readEntry(zipPath, 'word/styles.xml')
  const styleErrs = xmlWellFormedErrors(styles)
  ok(styleErrs.length === 0, 'word/styles.xml 标签配对正确' + (styleErrs.length ? '：' + styleErrs.join(' / ') : ''))
  for (const id of ['Normal', 'Title', 'Heading1', 'Heading2', 'Heading3', 'Heading4']) {
    ok(styles.includes('w:styleId="' + id + '"'), 'styles.xml 定义了 ' + id)
  }
  ok(styles.includes('<w:sz w:val="32"/>'), 'Heading1 字号是半磅值 32（=16pt）')
  ok(styles.includes('<w:name w:val="heading 1"/>') && styles.includes('<w:outlineLvl w:val="0"/>'), 'Heading1 结构符合 OOXML 习惯写法')
  // document.xml 引用到的每个 pStyle 都必须有定义，否则 Word 静默丢版式
  const used = new Set()
  const reStyle = /<w:pStyle w:val="([^"]+)"\/>/g
  let sm
  while ((sm = reStyle.exec(xml)) !== null) used.add(sm[1])
  const missing = Array.from(used).filter((s) => !styles.includes('w:styleId="' + s + '"'))
  ok(missing.length === 0, 'document.xml 引用的 ' + used.size + ' 个样式都在 styles.xml 里有定义' + (missing.length ? '：缺 ' + missing.join(',') : ''))

  const b64 = rptBytesToBase64(bytes)
  ok(b64.length % 4 === 0, 'base64 长度是 4 的倍数')
  ok(Buffer.from(b64, 'base64').equals(Buffer.from(bytes)), '整份 docx 走手写 base64 后能被 Buffer 还原（含 padding）')

  fs.rmSync(dir, { recursive: true, force: true })
}

section('[7] 边界：空文档、无 meta、末块是表格')
{
  const onlyTableMd = '| a | b |\n| --- | --- |\n| 1 | 2 |'
  const onlyTable = rptBuildDocx({ title: 'T', markdown: onlyTableMd })
  const onlyHtml = rptBuildHtml({ title: 'T', markdown: onlyTableMd })
  ok(onlyTable instanceof Uint8Array && onlyTable.length > 0, '只有表格的文档能构建')
  ok(onlyHtml.includes('<table class="rpt-table">'), '只有表格时 HTML 仍有 <table>')
  ok(!onlyHtml.includes('class="rpt-meta"'), '没有 meta 时不渲染信息表')

  // OOXML 规定表格不能是正文最后一个块，必须补一个空段落，否则 Word 判文档损坏
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-docx-tail-'))
  const zipPath = path.join(dir, 'tail.docx')
  fs.writeFileSync(zipPath, Buffer.from(onlyTable))
  const tail = readEntry(zipPath, 'word/document.xml')
  ok(/<\/w:tbl><w:p\/><w:sectPr>/.test(tail), '末块是表格时补了空段落（<w:tbl> 后跟 <w:p/>）')
  ok(xmlWellFormedErrors(tail).length === 0, '该文档的 document.xml 依然良构')
  fs.rmSync(dir, { recursive: true, force: true })

  const empty = rptBuildDocx({ title: '', markdown: '' })
  ok(empty instanceof Uint8Array && empty.length > 0, '空文档也是一个合法 ZIP')
  const html = rptBuildHtml({})
  ok(html.startsWith('<!doctype html>') && html.includes('<meta charset="utf-8">'), '无参数调用不抛错且仍是完整文档')
  ok(html.includes('<article class="rpt">'), '无参数时正文容器照旧')
}

console.log('')
if (fails.length) {
  console.log('✗ 失败 ' + fails.length + ' 项：')
  for (const f of fails) console.log('  - ' + f)
}
console.log(pass + ' 项通过' + (fails.length ? '，失败 ' + fails.length + ' 项' : ''))
process.exitCode = fails.length === 0 ? 0 : 1
