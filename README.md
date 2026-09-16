# DSH 红队插件集

在 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) 里做红队测试时用得上的插件集合。
每个插件都是一个**独立可安装的 DSH 插件包**，可以只装你要的那几个。

一次测试跑下来，它们是这样接起来的：

```
        记什么                    测到哪                     交付什么
   ┌──────────────┐        ┌──────────────┐        ┌──────────────┐
   │  红队记忆     │  ───→  │  攻击矩阵     │  ───→  │  红队报告     │
   │ 知识 / 技巧   │        │ 对话→框架命中 │        │ 证据→AI 撰写  │
   │「写入记忆」捕获│        │ 已确认 / 疑似 │        │ 编辑·导出 Word│
   └──────────────┘        └──────────────┘        └──────────────┘
                                                          │
                                              导入记忆库 ←──┘
```

- **红队记忆**：把 AI 安全知识与进攻技巧变成模型**可检索**的知识库；工作区对话里说一句
  「写入记忆」就自动收录。**本地库是权威数据，Milvus 只是它的派生索引** ——
  没有向量模型也能记录与检索，网络故障不会让内容写不进去。
- **攻击矩阵**：扫工作区对话，映射到 ATLAS / ATT&CK / OWASP LLM / NVIDIA AI Kill Chain，
  自动研判「已确认 / 疑似」，并标出已覆盖与缺口。
- **红队报告**：把上面两样加上工作区对话汇成一份证据材料，交给**当前会话正在用的那个模型**
  自动撰写；可手工改、可预览，导出 Markdown / HTML / **Word(.docx)**，或者反手导入记忆库
  （下次测试就能检索到这次的经验）。

| 插件 | 包名 | 仓库版本 | 用途 | 状态 |
|---|---|---|---|---|
| [资产图谱](packages/asset-graph/) | `dsh-redteam-asset-graph` | `7.9.7` | 目标资产自动收集、关联、可视化，模型参与研判 | ✅ 已发布 |
| [攻击矩阵](packages/attack-matrix/) | `dsh-redteam-attack-matrix` | `1.1.1` | 扫工作区对话映射到 ATLAS / ATT&CK / OWASP LLM / NVIDIA AI Kill Chain，标出已覆盖与缺口 | ✅ 已发布 |
| [记忆](packages/memory/) | `dsh-redteam-memory` | `0.3.0` | 给模型一个可检索的 AI 安全知识库（本地库为准 + Milvus 索引 + 对话捕获「写入记忆」） | 🔧 源码可用（未发包） |
| [报告](packages/report/) | `dsh-redteam-report` | `0.1.0` | 基于工作区对话 + 攻击矩阵命中 + 记忆，AI 自动撰写报告，可编辑预览、导出 Word、导入记忆 | 🔧 源码可用（未发包） |

> 「仓库版本」是 `packages/*/package.json` 里的版本，可能领先 registry 上已发布的那个
> （攻击矩阵仓库是 `1.1.1`、npm 上的 `latest` 是 `1.1.0`）。记忆与报告目前**只在源码里可用**，
> 没有发包 —— 按下面「源码直跑（开发形态）」一节的方式挂载即可。

---

## 安装

四个插件相互独立，按需安装。以资产图谱为例：

```bash
dsh plugin --profile web add dsh-redteam-asset-graph
# 重启 dsh web —— web profile 的 hmr 是 disabled，组合改动不会热生效
```

每个包都自带 `dsh.bundle.patch`，装完由 `reconcilePlugins` 自动并入
`dsh.profile.bundles`，**不需要手工编辑任何配置文件**。

装完记得按各插件自己的 README 完成必要配置（例如资产图谱需要 Jina API Key）。

## 仓库结构

```
.
├── package.json                 共享脚本入口（private，不发布）
├── docs/
│   └── DEVELOPMENT.md           仓库级开发约定与实测踩过的坑
└── packages/
    ├── asset-graph/             资产图谱（已发布 7.9.7）
    │   ├── src/                 权威源码（动态插件形态）
    │   ├── lib/                 由 src/ 生成的常驻插件包
    │   ├── tools/build-lib.mjs  生成器
    │   ├── cordis.patch.yml     bundle patch
    │   ├── README.md            使用者文档
    │   └── DEVELOPMENT.md       该插件的开发笔记
    ├── attack-matrix/           攻击矩阵（npm 1.1.0，仓库 1.1.1）—— 结构与上同
    ├── memory/                  红队记忆（本地库 + Milvus 索引 + 对话捕获）
    └── report/                  红队报告（AI 撰写 + 导出 Word + 导入记忆，含自实现 docx 写出）
```

**`src/` 是权威源码，`lib/` 由它生成**。两者主体逻辑逐字相同，差异只在垫片——
核对时 diff 两者，差异应当只出现在头尾。

## 常用命令

```bash
npm run build            # 生成所有插件的 lib/
npm run check            # 校验 lib/ 与 src/ 是否漂移（CI 用；prepack 也会跑）
npm test                 # 跑各插件的测试
```

### 让主机侧测试真的跑起来

主机侧的测试要解析 `@deepseek-ai/dsh-tools`。**解析不到时它会打印一句「跳过」然后
`exit 0`** —— `npm test` 照样全绿，但一条断言都没执行。（这个坑真实存在：CI 上一个
从未运行的测试，和周密通过的测试长得一模一样。）软链一下 DSH 部署里的依赖即可：

```bash
DSH_NM="$(readlink -f "$(command -v dsh)" | sed 's#/node_modules/.*#/node_modules/@deepseek-ai#')"
for p in asset-graph attack-matrix memory report; do
  mkdir -p "packages/$p/node_modules/@deepseek-ai"
  ln -sfn "$DSH_NM/dsh-tools" "packages/$p/node_modules/@deepseek-ai/dsh-tools"
done
npm test
# 现在能看到真实项数（共 676 项）：
#   资产图谱 15 · 攻击矩阵 host 97 / client 85 · 记忆 host 133 / client 63
#   报告 docx 122 / host 102 / client 59
```

`node_modules/` 在 `.gitignore` 里，软链不会进仓库。

## 源码直跑（开发形态，不发包）

不想发包、或者正在改插件时，用**开发形态装载器**：以动态 Cordis 插件的形式挂载，host 半边
在 apply 时读取仓库里的 `src/host.js`（报告还会把 `src/docx.js` 内联进去），client 半边
通过 `__src` 取回 `src/client.js` 并用 `with` 注入 `host / styles / React`。
**改完 `src/` 只要重跑同一个包，不用重新打包、也不用重新审批**（第一次运行需要你点一下允许）。

本仓库开发时就是这么跑的（`memdev-1` / `rptdev-3` 这类装载器由对话里的 AI 现场定义），
记忆与报告插件都只在源码里可用，因此这也是目前唯一的挂载方式。

> 装载器**不要**把诊断文件写进仓库路径：插件沙箱能读任何路径、**只能写它自己的工作区**
> （见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) §5.1），写仓库路径会被静默拒绝，
> 看起来就像「插件没生效」。诊断用工具回给模型。

## 发布

每个包各自发布。同一个插件在两个 registry 上**包名不同**（作用域规则不兼容，
原因与细节见[资产图谱的 README](packages/asset-graph/README.md)「发布位置」一节）：

```bash
cd packages/<包名>
npm pack --pack-destination ../../build   # 产出 build/<包名>-<版本>.tgz
npm publish                              # npm（未作用域名）
npm run publish:gh                       # GitHub Packages（脚本按仓库属主生成作用域副本）
```

`prepack` 会在 `lib/` 与 `src/` 漂移时拒绝打包/发布。发 npm 前顺手扫一次密钥
（这些包进的是**公开** registry，而包里带着 `src/`、`tools/` 与 README）：

```bash
tar -xzOf build/<包名>-<版本>.tgz \
  | grep -aoE "jina_[A-Za-z0-9_-]{10,}|npm_[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}" ; echo "(无输出 = 干净)"
```

## 开发

改插件前先读 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)：里面记着 DSH 插件开发的
几条硬约束与实测踩过的坑（哪些 API 在静态形态下不存在、组合 patch 的语义、沙箱与依赖解析等），
每一条都是真金白银换来的。

每个包另有自己的 `DEVELOPMENT.md`（若存在），记该插件特有的设计决定。

## 许可

[MIT](LICENSE) © 2026 fasthei
