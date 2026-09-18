// 为 GitHub Packages 生成发布副本。
//
// 为什么需要这个脚本：GitHub Packages 要求包名是作用域形式，且作用域必须等于仓库属主
// （这里 owner = Fasthei，故只能叫 @fasthei/…）。而 npmjs 不允许发布不属于自己的 scope，
// 因此同一个包在这两个 registry 上必须是**两个名字**：
//
//   npmjs            -> dsh-redteam-asset-graph            （未作用域，公开、可被搜索）
//   GitHub Packages  -> @fasthei/dsh-redteam-asset-graph   （作用域名，需属主）
//
// 与其手抄两份 package.json（必然漂移），不如由本脚本从唯一的 package.json 生成副本，
// 只替换 name 与 publishConfig：其余字段（dsh.bundle/client/dynamic、exports、files…）
// 逐字继承，保证两个 registry 上的包行为一致。
//
// 用法:
//   node tools/prepare-gh-packages.mjs            # 生成到 build/gh-packages/
//   然后在 build/gh-packages/ 下执行 npm publish

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.join(import.meta.dirname, '..')
const OUT = path.join(root, 'build', 'gh-packages')

const OWNER = 'fasthei'
const GH_SCOPE = '@' + OWNER

const base = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const baseName = base.name
const scopedName = `${GH_SCOPE}/${baseName}`

const manifest = {
  ...base,
  name: scopedName,
  publishConfig: {
    registry: 'https://npm.pkg.github.com',
    // 作用域包在 GitHub Packages 上默认是 private；显式声明 public 才能被他人安装。
    access: 'public',
  },
}

// 递归复制发布所需内容（只复制 files 白名单 + 清单），与 npm pack 的口径一致。
function copyListed(rel) {
  const src = path.join(root, rel)
  const dst = path.join(OUT, rel)
  if (!fs.existsSync(src)) {
    console.warn(`prepare-gh-packages: 跳过缺失项 ${rel}`)
    return
  }
  const st = fs.statSync(src)
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true })
    for (const entry of fs.readdirSync(src)) copyListed(path.join(rel, entry))
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
  }
}

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
for (const rel of base.files ?? []) copyListed(rel)
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

// 用副本自己的 package.json 重新生成本地 lib/。
//
// 为什么必须重生成：lib/client.js 的 bundle id 就是包名（client-modules 靠它
// require），lib/host.js 的 RPC 路由也带上包名。直接沿用未作用域的 lib/，
// 会让 GitHub Packages 上的包在浏览器里以错误 id 注册、并把请求打到错的路由。
// 本包的 build-lib.mjs 还会 import ../src/workspace-client.js，副本里 src/ 一并复制，
// 因此在 OUT 内执行即可；这一步同时让 prepack 的 build-lib --check 闸对改名副本成立。
const build = spawnSync(process.execPath, [path.join(OUT, 'tools', 'build-lib.mjs')], {
  cwd: OUT,
  encoding: 'utf8',
})
if (build.status !== 0) {
  console.error('prepare-gh-packages: 在副本里重生成 lib/ 失败')
  console.error(build.stdout || '')
  console.error(build.stderr || '')
  process.exit(1)
}
const verify = spawnSync(process.execPath, [path.join(OUT, 'tools', 'build-lib.mjs'), '--check'], {
  cwd: OUT,
  encoding: 'utf8',
})
if (verify.status !== 0) {
  console.error('prepare-gh-packages: 副本 lib/ 与 src/ 不同步（prepack 会拦住这次发布）')
  console.error(verify.stdout || '')
  console.error(verify.stderr || '')
  process.exit(1)
}

console.log(`prepare-gh-packages: ${baseName}@${base.version} -> ${scopedName}`)
console.log(`prepare-gh-packages: registry = https://npm.pkg.github.com`)
console.log(`prepare-gh-packages: 输出目录 = ${path.relative(root, OUT)}`)
console.log(`prepare-gh-packages: 副本内已按 ${scopedName} 重新生成 lib/ 并通过 --check`)
