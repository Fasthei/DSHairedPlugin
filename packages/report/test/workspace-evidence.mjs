import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import vm from 'node:vm'
import { rptCollectWorkspaceFiles, rptRedactEvidence, rptEvidenceFingerprint } from '../src/workspace-evidence.js'

let assertions = 0
let groups = 0
const ok = (value, message) => { assertions++; assert.ok(value, message) }
const equal = (actual, expected, message) => { assertions++; assert.equal(actual, expected, message) }
const same = (actual, expected, message) => { assertions++; assert.deepEqual(actual, expected, message) }
async function rejects(fn, pattern) { assertions++; await assert.rejects(fn, pattern) }
async function test(name, fn) { await fn(); groups++; console.log('ok ' + groups + ' - ' + name) }
const encode = text => new TextEncoder().encode(text)
const file = text => ({ type: 'file', text })
const directory = { type: 'directory' }

function memoryFs(input, options = {}) {
  const nodes = new Map()
  for (const [path, node] of Object.entries(input)) nodes.set(posix.normalize(path), node)
  for (const path of [...nodes.keys()]) {
    let parent = posix.dirname(path)
    while (!nodes.has(parent)) {
      nodes.set(parent, { type: 'directory' })
      if (parent === '/') break
      parent = posix.dirname(parent)
    }
  }
  const calls = { resolve: [], lstat: [], stat: [], list: [], range: [], bytes: [], text: [] }
  function poison(value) {
    Object.defineProperty(value, 'toJSON', { value() { throw new Error('LIVE FS OBJECT SERIALIZED') }, enumerable: false })
    return Object.freeze(value)
  }
  function normalize(path, opts) { return posix.normalize(path.startsWith('/') ? path : (opts && opts.cwd || '/work') + '/' + path) }
  function target(path) { return poison({ targetKey: path, displayPath: path }) }
  function bytes(node) { return node.bytes || encode(node.text || '') }
  function info(node) {
    if (!node) return undefined
    const result = { type: node.type, version: 'version-do-not-export', mtimeMs: options.time || 1 }
    if (node.type === 'file') result.size = node.size === undefined ? bytes(node).length : node.size
    return poison(result)
  }
  const service = {
    async resolve(path, opts) {
      const name = normalize(path, opts)
      calls.resolve.push(name)
      const node = nodes.get(name)
      return target(node && (node.canonicalTo || node.linkTo) || name)
    },
    contains(parent, child) {
      return child.targetKey === parent.targetKey || child.targetKey.startsWith(parent.targetKey.replace(/\/$/, '') + '/')
    },
    processPath(value) { return value.targetKey },
    async lstat(path, opts) {
      const name = normalize(path, opts)
      calls.lstat.push(name)
      const node = nodes.get(name)
      if (node && node.lstatError) throw new Error('SECRET filesystem error /outside/confidential')
      return info(node)
    },
    async stat(value) {
      calls.stat.push(value.targetKey)
      return info(nodes.get(value.targetKey))
    },
    async listDir(value) {
      const path = value.targetKey
      calls.list.push(path)
      const node = nodes.get(path)
      if (node && node.listError) throw new Error('SECRET list error')
      let names = node && node.children ? node.children.slice() : [...nodes.keys()].filter(x => x !== path && posix.dirname(x) === path).map(x => posix.basename(x))
      if (options.reverse) names.reverse()
      return names.map(name => poison({ name, type: 'other', target: target('/outside/UNTRUSTED-LIST-TARGET') }))
    },
    async readByteRange(value, range) {
      calls.range.push({ path: value.targetKey, offset: range.offset, length: range.length })
      const node = nodes.get(value.targetKey)
      if (node.readError) throw new Error('SECRET read error')
      return bytes(node).slice(range.offset, range.offset + range.length)
    },
    async readBytes(value, signal, maxBytes) {
      calls.bytes.push({ path: value.targetKey, maxBytes })
      const data = bytes(nodes.get(value.targetKey))
      if (data.length > maxBytes) throw new Error('FS_TOO_LARGE')
      return data.slice()
    },
    async readText(value) {
      calls.text.push(value.targetKey)
      throw new Error('Unbounded readText must not be used')
    },
  }
  return { fs: poison(service), calls, nodes }
}
const reason = (result, path) => result.inventory.find(entry => entry.path === path)?.reason
const allReadPaths = mock => mock.calls.range.concat(mock.calls.bytes).map(call => call.path)

await test('pure redaction covers headers, labelled values, private keys, URLs and remains idempotent', () => {
  const secrets = ['BEARER_SECRET_123', 'BASIC_SECRET_123', 'KEY WITH SPACE', 'json-password', 'token-value', 'yaml-first', 'yaml-second', 'CLIENTSECRET', 'url-password', 'query-secret', 'PEM_LINE_1', 'PEM_LINE_2', 'ghp_1234567890abcdef', 'sk-1234567890abcdef']
  const text = [
    'Authorization: Bearer ' + secrets[0],
    'Authorization: Basic ' + secrets[1],
    'API_KEY="' + secrets[2] + '"',
    '{"password":"' + secrets[3] + '","token":"' + secrets[4] + '"}',
    'client_secret: |\n  ' + secrets[5] + '\n  ' + secrets[6] + '\npublic: visible',
    "clientSecret = '" + secrets[7] + "'",
    'https://username:' + secrets[8] + '@example.test/?api_key=' + secrets[9] + '&public=yes',
    '-----BEGIN PRIVATE KEY-----\n' + secrets[10] + '\n' + secrets[11] + '\n-----END PRIVATE KEY-----',
    secrets[12], secrets[13], 'ordinary public evidence',
  ].join('\n')
  const redacted = rptRedactEvidence(text)
  for (const secret of secrets) ok(!redacted.includes(secret), 'secret removed: ' + secret)
  ok(redacted.includes('ordinary public evidence'))
  ok(redacted.includes('public: visible'))
  ok(redacted.includes('public=yes'))
  equal(rptRedactEvidence(redacted), redacted)
  equal(JSON.parse(rptRedactEvidence('{"apiKey":"abc","password":"def"}')).apiKey, '[REDACTED]')
  ok(!rptRedactEvidence('-----BEGIN RSA PRIVATE KEY-----\npartial-pem').includes('partial-pem'))
  equal(rptRedactEvidence(null), '')
  equal(rptRedactEvidence('password: an unquoted secret phrase\npublic: yes'), 'password: [REDACTED]\npublic: yes')
  equal(rptRedactEvidence('X-API-Key: header-value'), 'X-API-Key: [REDACTED]')
  equal(rptRedactEvidence('access_token=query-secret&public=yes'), 'access_token=[REDACTED]&public=yes')
  const fakeNpm = 'npm_' + 'X'.repeat(36)
  equal(rptRedactEvidence('发包' + fakeNpm), '发包[REDACTED]')
  equal(rptRedactEvidence('token is ' + fakeNpm), 'token is [REDACTED]')
})

await test('fingerprint is deterministic, unicode safe and changes with input', () => {
  equal(rptEvidenceFingerprint('中文😀'), rptEvidenceFingerprint('中文😀'))
  ok(rptEvidenceFingerprint('a') !== rptEvidenceFingerprint('b'))
  ok(/^wev1-[0-9a-f]{16}$/.test(rptEvidenceFingerprint('sample')))
})

await test('allowlisted evidence is owned JSON and listing targets are ignored', async () => {
  const mock = memoryFs({ '/work/a.md': file('hello'), '/work/src/main.js': file('const answer = 42'), '/work/data.json': file('{"apiKey":"TOPSECRET","result":"ok"}') })
  const result = await rptCollectWorkspaceFiles(mock.fs, '/work')
  same(result.files.map(x => x.path), ['a.md', 'data.json', 'src/main.js'])
  equal(result.files[0].bytes, 5)
  equal(result.files[0].truncated, false)
  equal(result.stats.filesCollected, 3)
  equal(result.stats.directoriesVisited, 2)
  equal(result.stats.errors, 0)
  equal(result.stats.inventoryComplete, true)
  ok(!JSON.stringify(result).includes('TOPSECRET'))
  ok(!JSON.stringify(result).includes('targetKey'))
  ok(!JSON.stringify(result).includes('version-do-not-export'))
  same(mock.calls.text, [])
  ok(allReadPaths(mock).every(path => path.startsWith('/work/')))
  same(Object.keys(result).sort(), ['files', 'fingerprint', 'inventory', 'notes', 'skipped', 'stats'])
})

await test('cross-root canonical targets and malicious entry names are refused before reads', async () => {
  const mock = memoryFs({
    '/work': { type: 'directory', children: ['safe.txt', 'escape.txt', '../outside.txt', '/absolute.txt', 'bad\\name.txt', '..'] },
    '/work/safe.txt': file('safe'),
    '/work/escape.txt': { ...file('alias'), canonicalTo: '/outside/secret.txt' },
    '/outside/secret.txt': file('DO NOT READ'),
  })
  const result = await rptCollectWorkspaceFiles(mock.fs, '/work')
  same(result.files.map(x => x.path), ['safe.txt'])
  equal(reason(result, 'escape.txt'), 'outside-workspace')
  equal(result.inventory.filter(x => x.reason === 'invalid-entry-name').length, 4)
  same(allReadPaths(mock), ['/work/safe.txt'])
  ok(!JSON.stringify(result).includes('DO NOT READ'))
  ok(!JSON.stringify(result).includes('/outside/'))
  equal(result.stats.inventoryComplete, false)
})

await test('symbolic links and symbolic workspace roots are not followed', async () => {
  const mock = memoryFs({ '/work/link.txt': { type: 'symlink', linkTo: '/outside/a.txt' }, '/work/linkdir': { type: 'symlink', linkTo: '/outside' }, '/outside/a.txt': file('outside') })
  const result = await rptCollectWorkspaceFiles(mock.fs, '/work')
  equal(result.files.length, 0)
  equal(reason(result, 'link.txt'), 'symbolic-link')
  equal(reason(result, 'linkdir'), 'symbolic-link')
  same(mock.calls.resolve, ['/work'])
  same(allReadPaths(mock), [])
  const rootLink = memoryFs({ '/work': { type: 'symlink', linkTo: '/outside' }, '/outside/a.txt': file('outside') })
  const refused = await rptCollectWorkspaceFiles(rootLink.fs, '/work')
  equal(refused.files.length, 0)
  ok(refused.notes.some(x => x.includes('symbolic link')))
  same(rootLink.calls.resolve, [])
})

await test('hidden entries, dependencies, build caches and credentials are excluded', async () => {
  const mock = memoryFs({
    '/work/visible.txt': file('evidence'), '/work/.hidden.txt': file('hidden'), '/work/.git/config': file('git-secret'),
    '/work/.env': file('password=secret'), '/work/.npmrc': file('npm-secret'), '/work/credentials.json': file('credential-secret'),
    '/work/secrets.yaml': file('secret: important'), '/work/id_ed25519': file('private-key'), '/work/server.pem': file('private-key'),
    '/work/node_modules/lib/index.js': file('dependency'), '/work/dist/bundle.js': file('build'), '/work/__pycache__/foo.txt': file('cache'),
  })
  const result = await rptCollectWorkspaceFiles(mock.fs, '/work')
  same(result.files.map(x => x.path), ['visible.txt'])
  for (const path of ['.env', '.npmrc', 'credentials.json', 'secrets.yaml', 'id_ed25519', 'server.pem']) equal(reason(result, path), 'credential-file')
  equal(reason(result, '.hidden.txt'), 'hidden-entry')
  equal(reason(result, '.git'), 'hidden-entry')
  for (const path of ['node_modules', 'dist', '__pycache__']) equal(reason(result, path), 'dependency-build-cache')
  same(mock.calls.list, ['/work'])
  same(allReadPaths(mock), ['/work/visible.txt'])
  ok(result.notes.some(x => x.includes('Excluded directories')))
})

await test('generated reports and caller-specified output locations cannot feed back', async () => {
  const mock = memoryFs({ '/work/.redteam-report.json': file('old report'), '/work/reports/old.md': file('old report'), '/work/generated-reports/old.txt': file('old report'), '/work/artifacts/finished/report.md': file('old report'), '/work/output.md': file('old report'), '/work/evidence.md': file('new evidence') })
  const result = await rptCollectWorkspaceFiles(mock.fs, '/work', { generatedReportDirectories: ['artifacts/finished', '../bad', '/outside'], generatedReportPaths: ['output.md'] })
  same(result.files.map(x => x.path), ['evidence.md'])
  equal(reason(result, '.redteam-report.json'), 'generated-report')
  equal(reason(result, 'reports'), 'generated-report-directory')
  equal(reason(result, 'artifacts/finished'), 'generated-report-directory')
  equal(reason(result, 'output.md'), 'generated-report')
  ok(!mock.calls.list.includes('/work/reports'))
  ok(!mock.calls.list.includes('/work/artifacts/finished'))
})

await test('large files use bounded byte ranges and report incomplete excerpts', async () => {
  const mock = memoryFs({ '/work/large.log': file('x'.repeat(200000)) })
  const result = await rptCollectWorkspaceFiles(mock.fs, '/work', { maxBytes: 31 })
  same(mock.calls.range, [{ path: '/work/large.log', offset: 0, length: 31 }])
  same(mock.calls.bytes, [])
  same(mock.calls.text, [])
  equal(result.files[0].text.length, 31)
  equal(result.files[0].bytes, 200000)
  equal(result.files[0].truncated, true)
  equal(result.inventory[0].status, 'excerpt')
  equal(result.stats.bytesRead, 31)
  ok(result.notes.some(x => x.includes('bounded, redacted excerpts')))
})

await test('UTF-8 prefixes can end mid-codepoint, but invalid bytes and binary content are skipped', async () => {
  const mock = memoryFs({ '/work/a.txt': file('x'.repeat(15) + '中suffix'), '/work/b.txt': { type: 'file', bytes: new Uint8Array([65, 255]), size: 200 }, '/work/c.txt': { type: 'file', bytes: new Uint8Array([65, 0, 66]) }, '/work/image.png': file('fake png') })
  const result = await rptCollectWorkspaceFiles(mock.fs, '/work', { maxBytes: 16 })
  same(result.files.map(x => x.path), ['a.txt'])
  equal(result.files[0].text, 'x'.repeat(15))
  equal(result.files[0].truncated, true)
  equal(reason(result, 'b.txt'), 'non-utf8-text')
  equal(reason(result, 'c.txt'), 'binary-content')
  equal(reason(result, 'image.png'), 'not-text-allowlist')
  ok(!allReadPaths(mock).includes('/work/image.png'))
})

await test('depth is measured from workspace root and bounded', async () => {
  const mock = memoryFs({ '/work/root.txt': file('root'), '/work/a/one.txt': file('one'), '/work/a/b/two.txt': file('two') })
  const result = await rptCollectWorkspaceFiles(mock.fs, '/work', { maxDepth: 1 })
  same(result.files.map(x => x.path), ['a/one.txt', 'root.txt'])
  equal(reason(result, 'a/b'), 'depth-quota')
  equal(result.stats.limitHits.depth, 1)
  ok(!mock.calls.list.includes('/work/a/b'))
  const zero = await rptCollectWorkspaceFiles(mock.fs, '/work', { maxDepth: 0 })
  same(zero.files.map(x => x.path), ['root.txt'])
  equal(zero.stats.inventoryComplete, false)
})

await test('directory quota includes root, and does not prevent root file collection', async () => {
  const mock = memoryFs({ '/work/a/one.txt': file('one'), '/work/b/two.txt': file('two'), '/work/root.txt': file('root') })
  const result = await rptCollectWorkspaceFiles(mock.fs, '/work', { maxDirectories: 1 })
  equal(result.stats.directoriesVisited, 1)
  same(result.files.map(x => x.path), ['root.txt'])
  equal(reason(result, 'a'), 'directory-quota')
  equal(reason(result, 'b'), 'directory-quota')
  equal(result.stats.directoriesNotTraversed, 2)
  equal(result.stats.limitHits.directories, 2)
  const zero = await rptCollectWorkspaceFiles(mock.fs, '/work', { maxDirectories: 0 })
  equal(zero.inventory.length, 0)
  equal(zero.stats.inventoryComplete, false)
})

await test('inventory entry quota retains stable bounded prefixes and accounts for omissions', async () => {
  const data = Object.fromEntries(Array.from({ length: 20 }, (_, i) => ['/work/f' + String(i).padStart(2, '0') + '.txt', file('evidence')]))
  const first = await rptCollectWorkspaceFiles(memoryFs(data).fs, '/work', { maxEntries: 3 })
  const second = await rptCollectWorkspaceFiles(memoryFs(data, { reverse: true }).fs, '/work', { maxEntries: 3 })
  equal(first.inventory.length, 3)
  equal(first.stats.entriesEnumerated, 3)
  equal(first.stats.entriesOmitted, 17)
  same(first.files.map(x => x.path), ['f00.txt', 'f01.txt', 'f02.txt'])
  equal(first.fingerprint, second.fingerprint)
  ok(first.stats.limitHits.entries > 0)
  ok(first.notes.some(x => x.includes('entries')))
  const zero = await rptCollectWorkspaceFiles(memoryFs(data).fs, '/work', { maxEntries: 0 })
  equal(zero.inventory.length, 0)
  equal(zero.stats.entriesOmitted, 20)
})

await test('inventory quota also holds across recursive traversal', async () => {
  const mock = memoryFs({ '/work/a/aa.txt': file('a'), '/work/a/ab.txt': file('b'), '/work/b.txt': file('c'), '/work/c.txt': file('d') })
  const result = await rptCollectWorkspaceFiles(mock.fs, '/work', { maxEntries: 3 })
  equal(result.inventory.length, 3)
  same(result.inventory.map(x => x.path), ['a', 'a/aa.txt', 'a/ab.txt'])
  equal(result.stats.entriesOmitted, 2)
  equal(result.stats.inventoryComplete, false)
})

await test('file quota bounds read attempts, including unreadable or invalid files', async () => {
  const mock = memoryFs({ '/work/a.txt': { type: 'file', bytes: new Uint8Array([255]) }, '/work/b.txt': { ...file('error'), readError: true }, '/work/c.txt': file('evidence') })
  const result = await rptCollectWorkspaceFiles(mock.fs, '/work', { maxFiles: 2 })
  equal(result.stats.readAttempts, 2)
  equal(mock.calls.range.length, 2)
  equal(result.files.length, 0)
  equal(reason(result, 'c.txt'), 'file-quota')
  equal(result.inventory.length, 3)
  equal(result.stats.errors, 1)
  const zero = await rptCollectWorkspaceFiles(memoryFs({ '/work/a.txt': file('a') }).fs, '/work', { maxFiles: 0 })
  equal(zero.stats.readAttempts, 0)
  equal(zero.files.length, 0)
})

await test('per-file and total character quotas bound excerpts, not inventory', async () => {
  const mock = memoryFs({ '/work/a.txt': file('a'.repeat(20)), '/work/b.txt': file('b'.repeat(20)), '/work/c.txt': file('c'.repeat(20)) })
  const result = await rptCollectWorkspaceFiles(mock.fs, '/work', { maxFileChars: 8, maxTotalChars: 10 })
  same(result.files.map(x => x.text), ['a'.repeat(8), 'bb'])
  equal(result.stats.charsCollected, 10)
  equal(result.inventory.length, 3)
  equal(reason(result, 'c.txt'), 'character-quota')
  equal(result.stats.truncatedFiles, 2)
  ok(result.stats.limitHits.characters > 0)
  const emoji = await rptCollectWorkspaceFiles(memoryFs({ '/work/a.txt': file('a😀b') }).fs, '/work', { maxFileChars: 2 })
  equal(emoji.files[0].text, 'a')
  const zero = await rptCollectWorkspaceFiles(memoryFs({ '/work/a.txt': file('a') }).fs, '/work', { maxTotalChars: 0 })
  equal(zero.stats.readAttempts, 0)
})

await test('only bounded readBytes is a fallback; large files cannot fall back to readText', async () => {
  const mock = memoryFs({ '/work/a.txt': file('abc'), '/work/large.txt': file('x'.repeat(100)) })
  const fs = { ...mock.fs, readByteRange: undefined }
  const result = await rptCollectWorkspaceFiles(fs, '/work', { maxBytes: 10 })
  same(result.files.map(x => x.path), ['a.txt'])
  same(mock.calls.bytes, [{ path: '/work/a.txt', maxBytes: 10 }])
  same(mock.calls.text, [])
  equal(reason(result, 'large.txt'), 'bounded-read-unavailable')
})

await test('filesystem failures are explicit without exposing raw errors or external paths', async () => {
  const mock = memoryFs({ '/work/a.txt': { ...file('a'), lstatError: true }, '/work/b': { type: 'directory', listError: true }, '/work/c.txt': { ...file('c'), readError: true }, '/work/d.txt': file('okay') })
  const result = await rptCollectWorkspaceFiles(mock.fs, '/work')
  equal(result.stats.errors, 3)
  equal(reason(result, 'a.txt'), 'metadata-failed')
  equal(reason(result, 'b'), 'list-failed')
  equal(reason(result, 'c.txt'), 'read-failed')
  same(result.files.map(x => x.path), ['d.txt'])
  ok(!JSON.stringify(result).includes('SECRET'))
  ok(!JSON.stringify(result).includes('/outside/'))
  equal(result.stats.inventoryComplete, false)
})

await test('invalid or missing roots and missing safety capabilities fail closed', async () => {
  const mock = memoryFs({ '/work/a.txt': file('a') })
  await rejects(() => rptCollectWorkspaceFiles(mock.fs, '../outside'), /absolute/)
  await rejects(() => rptCollectWorkspaceFiles(mock.fs, '/work\0bad'), /NUL/)
  await rejects(() => rptCollectWorkspaceFiles({ ...mock.fs, lstat: undefined }, '/work'), /lstat/)
  const missing = await rptCollectWorkspaceFiles(mock.fs, '/missing')
  equal(missing.files.length, 0)
  equal(missing.stats.errors, 1)
  const notDirectory = await rptCollectWorkspaceFiles(mock.fs, '/work/a.txt')
  equal(notDirectory.files.length, 0)
  same(allReadPaths(mock), [])
})

await test('fingerprint ignores metadata time and provider listing order, but tracks public evidence changes', async () => {
  const input = { '/work/b.txt': file('B'), '/work/a.txt': file('A') }
  const one = await rptCollectWorkspaceFiles(memoryFs(input, { time: 1 }).fs, '/work')
  const two = await rptCollectWorkspaceFiles(memoryFs(input, { time: 999, reverse: true }).fs, '/work')
  equal(one.fingerprint, two.fingerprint)
  const changed = await rptCollectWorkspaceFiles(memoryFs({ ...input, '/work/a.txt': file('different evidence') }).fs, '/work')
  ok(one.fingerprint !== changed.fingerprint)
  ok(!JSON.stringify(one).includes('mtimeMs'))
  ok(!Object.hasOwn(one, 'collectedAt'))
})

await test('module can be stripped and evaluated in a Host-like VM without Node globals', async () => {
  const source = readFileSync(new URL('../src/workspace-evidence.js', import.meta.url), 'utf8')
  ok(!/^\s*import\s/m.test(source))
  ok(!/\brequire\s*\(/.test(source))
  ok(!/\b(?:process|Buffer)\s*\./.test(source))
  const stripped = source.replace(/^export\s+(?=(?:async\s+)?function\b)/gm, '')
  const module = vm.runInNewContext('(function(){' + stripped + '; return {rptCollectWorkspaceFiles,rptRedactEvidence,rptEvidenceFingerprint};})()', { TextDecoder })
  const result = await module.rptCollectWorkspaceFiles(memoryFs({ '/work/a.md': file('safe') }).fs, '/work')
  equal(result.files[0].text, 'safe')
  equal(module.rptEvidenceFingerprint('same'), rptEvidenceFingerprint('same'))
  equal(module.rptRedactEvidence('password=abc'), 'password=[REDACTED]')
  ok(JSON.stringify(result).includes('fingerprint'))
})

console.log('\nPASS: ' + groups + ' groups, ' + assertions + ' assertions; no network, commands, or business writes.')
