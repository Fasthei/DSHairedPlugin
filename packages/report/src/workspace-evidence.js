// Workspace evidence collection. Plain ESM; strip line-leading `export ` to inline
// into a dynamic Host. No imports, networking, commands, or business-file writes.
// The caller supplies the actual Harness fs service and an absolute workspace root.
// Fingerprints are deterministic change detectors, NOT cryptographic signatures.

export function rptRedactEvidence(text) {
  let value = String(text == null ? '' : text)
  value = value.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi, '[REDACTED PRIVATE KEY]')
  value = value.replace(/\b(Bearer|Basic)([ \t]+)[A-Za-z0-9._~+\/=-]+/gi, '$1$2[REDACTED]')
  value = value.replace(/\b(?:sk[-_][A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|npm_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
  value = value.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[REDACTED]@')
  // YAML literal/folded secrets: discard the indented body as well as its marker.
  const key = '[A-Za-z0-9_-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization)[A-Za-z0-9_-]*'
  value = value.replace(new RegExp('^([ \\t]*["\\\']?' + key + '["\\\']?[ \\t]*:[ \\t]*)[|>][-+]?[ \\t]*\\r?\\n(?:[ \\t]+[^\\r\\n]*(?:\\r?\\n|$))+', 'gim'), '$1[REDACTED]\n')
  // JSON, YAML, .env, source assignments, headers, and URL query parameters.
  // Keeping the key is useful evidence; never retain the matched value.
  value = value.replace(new RegExp('((?:["\\\']?\\b' + key + '["\\\']?)[ \\t]*(?::|=)[ \\t]*)(\\[REDACTED(?: PRIVATE KEY)?\\]|"(?:\\\\.|[^"\\\\])*"|\\\'(?:\\\\.|[^\\\'\\\\])*\\\'|[^\\r\\n,;#}\\]&]+)', 'gi'), (match, prefix, secret) => prefix + (secret[0] === '"' ? '"[REDACTED]"' : secret[0] === "'" ? "'[REDACTED]'" : '[REDACTED]'))
  return value
}

export function rptEvidenceFingerprint(text) {
  const value = String(text == null ? '' : text)
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0
    b = ((b << 13) | (b >>> 19)) >>> 0
  }
  return 'wev1-' + a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

// opts (all limits are clamped; quotas can be zero except maxBytes):
// maxEntries=2000, maxDirectories=200 (includes root), maxDepth=8 (root=0),
// maxFiles=60 (bounds read attempts, including failures), maxFileChars=6000,
// maxTotalChars=100000, maxBytes=65536.
// generatedReportDirectories / generatedReportPaths: additional ROOT-RELATIVE
// paths to exclude. Defaults also exclude conventional generated-report folders.
// Inventory contains directory and file entries, including skipped entries, but
// never expands an excluded directory. Quotas bound both inventory and excerpts.
// listDir itself returns one whole directory in the Harness API; a large provider
// response cannot be paginated here. Only bounded names from it are retained.
export async function rptCollectWorkspaceFiles(fs, workspacePath, opts = {}) {
  if (typeof workspacePath !== 'string' || !/^(?:\/|[A-Za-z]:[\\/])/.test(workspacePath) || /\0/.test(workspacePath)) {
    throw new TypeError('workspacePath must be an absolute path without NUL')
  }
  for (const method of ['resolve', 'contains', 'processPath', 'stat', 'lstat', 'listDir']) {
    if (!fs || typeof fs[method] !== 'function') throw new TypeError('Required fs boundary capability missing: ' + method)
  }
  const options = opts && typeof opts === 'object' ? opts : {}
  function limit(name, fallback, maximum, minimum = 0) {
    const n = options[name]
    return typeof n === 'number' && Number.isFinite(n) ? Math.max(minimum, Math.min(maximum, Math.floor(n))) : fallback
  }
  const limits = {
    entries: limit('maxEntries', 2000, 20000),
    directories: limit('maxDirectories', 200, 2000),
    depth: limit('maxDepth', 8, 32),
    files: limit('maxFiles', 60, 500),
    fileChars: limit('maxFileChars', 6000, 100000),
    totalChars: limit('maxTotalChars', 100000, 2000000),
    bytes: limit('maxBytes', 65536, 1048576, 1),
  }
  const files = []
  const inventory = []
  const skipped = []
  const notes = []
  const noteSet = new Set()
  const stats = {
    entriesEnumerated: 0, entriesOmitted: 0, directoriesVisited: 0,
    directoriesNotTraversed: 0, filesSeen: 0, filesCollected: 0,
    entriesSkipped: 0, readAttempts: 0, bytesRead: 0, charsCollected: 0, truncatedFiles: 0,
    errors: 0, inventoryComplete: true,
    limitHits: { entries: 0, directories: 0, depth: 0, files: 0, characters: 0 },
  }
  const dependencyDirs = new Set(['node_modules', 'vendor', 'bower_components', 'venv', 'env', '__pycache__', 'dist', 'build', 'target', 'out', 'coverage', 'cache', 'caches', 'tmp', 'temp'])
  const reportDirs = new Set(['reports', 'generated-reports', 'generated_reports', 'redteam-reports', 'redteam_reports', 'report-output', 'report-outputs', 'report-exports', 'report_exports'])
  const textExtensions = new Set(['md', 'markdown', 'txt', 'log', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'graphql', 'gql', 'proto', 'vue', 'svelte', 'r', 'kt', 'kts', 'swift', 'php', 'pl', 'ex', 'exs', 'erl', 'hrl', 'hs', 'lua'])
  const textNames = new Set(['readme', 'license', 'licence', 'copying', 'notice', 'makefile', 'dockerfile', 'containerfile', 'gemfile', 'rakefile'])
  function relativeExclusions(input) {
    const result = new Set()
    if (!Array.isArray(input)) return result
    for (const item of input.slice(0, 200)) {
      if (typeof item !== 'string' || item.startsWith('/') || item.includes('\\') || item.includes('\0')) continue
      const path = item.replace(/\/+$/, '')
      if (path && path.split('/').every(part => part && part !== '.' && part !== '..')) result.add(path)
    }
    return result
  }
  const extraReportDirs = relativeExclusions(options.generatedReportDirectories)
  const extraReportPaths = relativeExclusions(options.generatedReportPaths)
  function note(message) {
    if (!noteSet.has(message) && notes.length < 64) { noteSet.add(message); notes.push(message) }
  }
  function quota(name) {
    stats.limitHits[name]++
    note('Quota reached: ' + name + '; inventory or excerpts are incomplete.')
  }
  function skip(record, reason, isDirectory = false) {
    record.status = 'skipped'
    record.reason = reason
    skipped.push({ path: record.path, reason })
    stats.entriesSkipped++
    if (isDirectory) {
      stats.directoriesNotTraversed++
      stats.inventoryComplete = false
      note('Excluded directories are listed but their contents are not enumerated.')
    }
  }
  function fail(record, reason, isDirectory = false) {
    skip(record, reason, isDirectory)
    record.status = 'error'
    stats.errors++
    stats.inventoryComplete = false
    note('Some filesystem operations failed; no error payloads or outside-root paths are included.')
  }
  function credentialName(name) {
    return /^(?:\.env(?:\.|$)|\.npmrc$|\.pypirc$|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$))/.test(name)
      || /(?:^|[._-])(?:secrets?|credentials?|passwords?|tokens?|api[-_]?keys?)(?:[._-]|$)/.test(name)
      || /\.(?:pem|key|p12|pfx|jks|keystore|gpg)$/.test(name)
  }
  function allowedText(name) {
    if (textNames.has(name)) return true
    const dot = name.lastIndexOf('.')
    return dot >= 0 && textExtensions.has(name.slice(dot + 1))
  }
  function bytesOf(info) { return info && typeof info.size === 'number' && Number.isFinite(info.size) && info.size >= 0 ? Math.floor(info.size) : 0 }
  function finish() {
    stats.entriesEnumerated = inventory.length
    stats.filesCollected = files.length
    // These are all newly constructed records, not FsTargets or service objects.
    const fingerprint = rptEvidenceFingerprint(JSON.stringify({ files, inventory, skipped, stats, notes }))
    return { files, inventory, skipped, stats, fingerprint, notes }
  }
  note('Text is allowlisted and heuristically redacted; review evidence before sending it to a model. Unlabelled secrets may remain.')
  let root
  let rootPath
  try {
    const rootInfo = await fs.lstat(workspacePath)
    if (!rootInfo || rootInfo.type !== 'directory') {
      note(rootInfo && rootInfo.type === 'symlink' ? 'Workspace root is a symbolic link; collection refused.' : 'Workspace root is missing or not a directory; collection refused.')
      stats.inventoryComplete = false
      stats.errors++
      return finish()
    }
    root = await fs.resolve(workspacePath)
    if (!fs.contains(root, root)) throw new Error('Invalid root boundary')
    rootPath = fs.processPath(root)
    if (typeof rootPath !== 'string' || !rootPath) throw new Error('Missing canonical root path')
    const info = await fs.stat(root)
    if (!info || info.type !== 'directory') throw new Error('Invalid root type')
  } catch (error) {
    note('Workspace root could not be safely resolved; collection refused.')
    stats.errors++
    stats.inventoryComplete = false
    return finish()
  }
  const visitedDirectories = new Set()
  let enumerationStopped = false
  async function walk(target, absolutePath, relativePath, depth, directoryRecord) {
    if (enumerationStopped) return
    if (stats.directoriesVisited >= limits.directories) {
      quota('directories')
      if (directoryRecord) skip(directoryRecord, 'directory-quota', true)
      else { stats.directoriesNotTraversed++; stats.inventoryComplete = false }
      return
    }
    if (visitedDirectories.has(absolutePath)) {
      if (directoryRecord) skip(directoryRecord, 'directory-alias', true)
      return
    }
    visitedDirectories.add(absolutePath)
    stats.directoriesVisited++
    let entries
    try {
      if (!fs.contains(root, target)) throw new Error('Outside root')
      entries = await fs.listDir(target)
      if (!Array.isArray(entries)) throw new Error('Invalid directory listing')
    } catch (error) {
      if (directoryRecord) fail(directoryRecord, 'list-failed', true)
      else { stats.errors++; stats.inventoryComplete = false; note('Workspace directory listing failed.') }
      return
    }
    // Keep the lexicographically smallest bounded names even if the provider is
    // unsorted. This retains deterministic output without copying live entries.
    const remaining = limits.entries - inventory.length
    const names = []
    const seenNames = new Set()
    for (const entry of entries) {
      const name = entry && typeof entry.name === 'string' ? entry.name : ''
      if (!name || seenNames.has(name)) continue
      // The bounded sorted prefix needs no unbounded Set of all returned names.
      if (names.length >= remaining && name >= names[names.length - 1]) continue
      let i = 0
      while (i < names.length && names[i] < name) i++
      names.splice(i, 0, name)
      seenNames.add(name)
      if (names.length > remaining) seenNames.delete(names.pop())
    }
    if (entries.length > names.length && remaining <= entries.length) {
      stats.entriesOmitted += entries.length - names.length
      stats.inventoryComplete = false
      quota('entries')
    }
    for (let i = 0; i < names.length; i++) {
      if (inventory.length >= limits.entries) {
        stats.entriesOmitted += names.length - i
        stats.inventoryComplete = false
        quota('entries')
        enumerationStopped = true
        return
      }
      const name = names[i]
      const safeName = name !== '.' && name !== '..' && !/[\\/\0]/.test(name)
      const path = safeName ? (relativePath ? relativePath + '/' + name : name) : (relativePath ? relativePath + '/' : '') + '[invalid-entry]'
      const record = { path, bytes: 0, status: 'pending', reason: '' }
      inventory.push(record)
      if (!safeName) { skip(record, 'invalid-entry-name'); stats.inventoryComplete = false; continue }
      const lower = name.toLowerCase()
      // Exclusions happen before resolution or content reads, so credentials are
      // never opened merely to decide whether to omit them.
      if (lower.startsWith('.redteam-report') || extraReportPaths.has(path) || credentialName(lower)) {
        skip(record, lower.startsWith('.redteam-report') || extraReportPaths.has(path) ? 'generated-report' : 'credential-file')
        stats.inventoryComplete = false
        note('Credential/generated-report paths excluded before metadata checks use bytes=0 for unknown size and are never traversed.')
        continue
      }
      const candidatePath = absolutePath.replace(/[\\/]+$/, '') + '/' + name
      let info
      let child
      let canonicalPath
      try {
        info = await fs.lstat(candidatePath)
        if (!info) { fail(record, 'entry-disappeared'); continue }
        record.bytes = bytesOf(info)
        if (info.type === 'symlink') { skip(record, 'symbolic-link'); stats.inventoryComplete = false; note('Symbolic links are not followed; their target contents are not enumerated.'); continue }
        child = await fs.resolve(candidatePath)
        if (!fs.contains(root, child)) { skip(record, 'outside-workspace', info.type === 'directory'); stats.inventoryComplete = false; continue }
        canonicalPath = fs.processPath(child)
        if (typeof canonicalPath !== 'string' || !canonicalPath) throw new Error('Invalid process path')
        const resolvedInfo = await fs.stat(child)
        if (!resolvedInfo || resolvedInfo.type !== info.type) { fail(record, 'entry-type-changed', info.type === 'directory'); continue }
        info = resolvedInfo
        record.bytes = bytesOf(info)
      } catch (error) { fail(record, 'metadata-failed'); continue }
      const isDirectory = info.type === 'directory'
      if (lower.startsWith('.')) { skip(record, 'hidden-entry', isDirectory); continue }
      if (isDirectory) {
        if (dependencyDirs.has(lower)) { skip(record, 'dependency-build-cache', true); continue }
        if (reportDirs.has(lower) || extraReportDirs.has(path)) { skip(record, 'generated-report-directory', true); continue }
        if (depth + 1 > limits.depth) { quota('depth'); skip(record, 'depth-quota', true); continue }
        record.status = 'directory'
        await walk(child, canonicalPath, path, depth + 1, record)
        continue
      }
      if (info.type !== 'file') { skip(record, 'non-regular-file'); continue }
      stats.filesSeen++
      if (!allowedText(lower)) { skip(record, 'not-text-allowlist'); continue }
      if (stats.readAttempts >= limits.files) { quota('files'); skip(record, 'file-quota'); continue }
      if (stats.charsCollected >= limits.totalChars || limits.fileChars === 0) { quota('characters'); skip(record, 'character-quota'); continue }
      if (typeof TextDecoder !== 'function') { fail(record, 'text-decoder-unavailable'); continue }
      let data
      let byteTruncated = false
      stats.readAttempts++
      try {
        // Recheck before reading: no path supplied by listDir is trusted.
        if (!fs.contains(root, child)) { skip(record, 'outside-workspace'); stats.inventoryComplete = false; continue }
        if (typeof fs.readByteRange === 'function') {
          data = await fs.readByteRange(child, { offset: 0, length: limits.bytes })
        } else if (record.bytes <= limits.bytes && typeof fs.readBytes === 'function') {
          data = await fs.readBytes(child, undefined, limits.bytes)
        } else {
          fail(record, 'bounded-read-unavailable')
          continue
        }
        if (!data || typeof data.length !== 'number' || typeof data.subarray !== 'function') throw new Error('Invalid byte response')
        stats.bytesRead += data.length
        byteTruncated = record.bytes > data.length || data.length >= limits.bytes
        if (data.length > limits.bytes) { data = data.subarray(0, limits.bytes); byteTruncated = true }
      } catch (error) { fail(record, 'read-failed'); continue }
      let text
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true })
        // Streaming decode accepts an incomplete final codepoint ONLY for a
        // bounded prefix. Invalid UTF-8 (including 0xff at the end) still fails.
        text = decoder.decode(data, { stream: byteTruncated })
      } catch (error) { skip(record, 'non-utf8-text'); continue }
      const controls = text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g)
      if (text.includes('\0') || (controls && controls.length > Math.max(1, text.length / 100))) { skip(record, 'binary-content'); continue }
      text = rptRedactEvidence(text)
      const room = Math.min(limits.fileChars, limits.totalChars - stats.charsCollected)
      const charTruncated = text.length > room
      if (charTruncated) {
        text = text.slice(0, room)
        // Avoid a dangling high surrogate at the character cutoff.
        if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1)
      }
      const truncated = byteTruncated || charTruncated
      if (truncated) { stats.truncatedFiles++; note('Some files contain only bounded, redacted excerpts; truncated=true does not represent the complete file.') }
      if (charTruncated) quota('characters')
      record.status = truncated ? 'excerpt' : 'collected'
      record.reason = byteTruncated ? 'byte-limit-or-short-read' : (charTruncated ? 'character-limit' : '')
      files.push({ path, bytes: record.bytes, text, truncated })
      stats.charsCollected += text.length
    }
  }
  await walk(root, rootPath, '', 0, null)
  return finish()
}
