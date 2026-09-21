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
  没有向量模型也能记录与检索，网络故障不会让内容写不进去。面板只管用（知识库 / 检索 / 日志），
  数据库与向量模型在 DSH 设置的「红队设置」页里；导入只认 pdf / word(.docx) / md / txt。
- **攻击矩阵**：扫工作区对话，映射到 ATLAS / ATT&CK / OWASP LLM / NVIDIA AI Kill Chain，
  自动研判「已确认 / 疑似」，并标出已覆盖与缺口。
- **红队报告**：把上面两样加上工作区对话汇成一份证据材料，交给**当前会话正在用的那个模型**
  自动撰写；可手工改、可预览，导出 Markdown / HTML / **Word(.docx)**，或者反手导入记忆库
  （下次测试就能检索到这次的经验）。

| 插件 | 包名 | 仓库版本 | 用途 | 状态 |
|---|---|---|---|---|
| [资产图谱](packages/asset-graph/) | `dsh-redteam-asset-graph` | `7.9.7` | 目标资产自动收集、关联、可视化，模型参与研判 | ✅ 已发布 |
| [攻击矩阵](packages/attack-matrix/) | `dsh-redteam-attack-matrix` | `1.2.1` | 扫工作区对话映射到 ATLAS / ATT&CK / OWASP LLM / NVIDIA AI Kill Chain，标出已覆盖与缺口 | ✅ 已发布 |
| [记忆](packages/memory/) | `dsh-redteam-memory` | `0.4.2` | 给模型一个可检索的 AI 安全知识库（本地库为准 + Milvus 索引 + 对话捕获「写入记忆」；配置在「设置 → 红队设置」，导入只认 pdf / word / md / txt） | ✅ 已发布 |
| [报告](packages/report/) | `dsh-redteam-report` | `0.2.3` | 报告随工作区隔离，切换时自动采集文件与会话并 AI 撰写；可编辑预览、导出 Word、导入记忆 | ✅ 已发布 |

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

记忆与报告要一起装，并且**记忆在前**（报告依赖它提供的统一设置页）：

```bash
dsh plugin --profile web add dsh-redteam-memory@0.4.2
dsh plugin --profile web add dsh-redteam-report@0.2.3
# 重启 dsh web
```

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
    ├── attack-matrix/           攻击矩阵（1.2.1）—— 结构与上同
    ├── memory/                  红队记忆（本地库 + Milvus 索引 + 对话捕获；提供统一红队设置页）
    └── report/                  红队报告（按工作区隔离 + 自动生成 + 导出 Word + 导入记忆，含自实现 docx 写出）
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
# 现在能看到真实项数：
#   资产图谱 15 · 攻击矩阵 host 101 / client 90 · 记忆 host 176 / client 123
#   报告 docx 122 / host 112（legacy） / client 78（legacy）
#   报告新增：工作区证据 168 · 工作区调度 44 · 正式产物门禁 67
```

`node_modules/` 在 `.gitignore` 里，软链不会进仓库。

## 源码直跑（开发形态，不发包）

四个包都已发布，日常**用 `dsh plugin add` 装正式包**即可（见上）。正在改插件时才用
**开发形态装载器**：以动态 Cordis 插件的形式挂载，host 半边在 apply 时读取仓库里的
`src/host.js`，client 半边通过 `__src` 取回 `src/client.js` 后注入 `React / host / styles`。
**改完 `src/` 只要重跑同一个包，不用重新打包、也不用重新审批**（第一次运行需要你点一下允许）。

报告从 `0.2.1` 起，正式包的 Host 半边把旧引擎源码交给**每工作区独立的运行器**
（`src/workspace-runtime.js`），所以装载器读取的仍是 `src/` 下的权威源码。

> 会话内的临时装载器与正式包**不要同时挂**：两者会注册同名界面，重启后临时插件自然消失，
> 由 profile 的正式包接管。

> 装载器**不要**把诊断文件写进仓库路径：插件沙箱能读任何路径、**只能写它自己的工作区**
> （见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) §5.1），写仓库路径会被静默拒绝，
> 看起来就像「插件没生效」。诊断用工具回给模型。
>
> **重启 `dsh web` 会清空所有动态插件**（它们只在 Node 进程里）。重启后重新跑一次装载器就恢复，
> 插件的数据文件（记忆库 / 报告库 / 攻击矩阵）在磁盘上，不受影响。正式包则不受重启影响。

## 发布

每个包各自发布。同一个插件在两个 registry 上**包名不同**（作用域规则不兼容，
原因与细节见[资产图谱的 README](packages/asset-graph/README.md)「发布位置」一节）：

```bash
cd packages/<包名>
npm pack --pack-destination ../../build   # 产出 build/<包名>-<版本>.tgz
npm publish                              # npm（未作用域名）
npm run publish:gh                       # 生成本地 GitHub Packages 副本（只生成，不发布）
```

**GitHub Packages 走流水线，不手动发**：`.github/workflows/publish-github-packages.yml`
在推 `gh-packages-*` 标签（或在 Actions 页面手动 Run workflow）时，对四个包各起一个 job ——
先用各包的 `prepare-gh-packages.mjs` 生成作用域改名副本（副本内会按 `@fasthei/…` 重新生成
`lib/`，让 client bundle id 与 RPC 路由跟包名一致），再以仓库自带的 `GITHUB_TOKEN`
（`packages: write`）发布。同一个版本在 GitHub Packages 上不可覆盖，流水线对已存在的版本会跳过，
因此可以重复运行。

两个 registry 上的包名不同（GitHub Packages 要求作用域等于仓库属主），安装时按需选一个：

`prepack` 会在 `lib/` 与 `src/` 漂移时拒绝打包/发布。发 npm 前顺手扫一次密钥
（这些包进的是**公开** registry，而包里带着 `src/`、`tools/` 与 README）：

```bash
tar -xzOf build/<包名>-<版本>.tgz \
  | grep -aoE "jina_[A-Za-z0-9_-]{10,}|npm_[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}" ; echo "(无输出 = 干净)"
```

## 变更记录

### 攻击矩阵 `1.2.1` · 记忆 `0.4.2` · 报告 `0.2.3`（2026-09-21）

- **黑夜模式下面板里出现纯白块**：面板与设置页的根元素没有设 `color-scheme`，于是里面的
  **原生控件**（记忆页的 4 个 checkbox、各页的 `select` 弹出层、数字输入的微调箭头、滚动条）
  按浏览器的浅色默认渲染 —— 在黑主题里就是一块块纯白。四个插件里只有资产图谱做了这件事
  （`ctx.get('theme')` → `getTheme().active.colorScheme`），现在三个客户端都跟上；攻击矩阵的
  下拉弹出层另补了主题色（部分浏览器不跟随 `color-scheme`）。
  回归线：三个客户端测试各自新增「默认跟随 dark / 切浅色跟随 light」两条断言。

### 攻击矩阵 `1.2.0` · 报告 `0.2.2`（2026-09-21）

修两个实测问题：

- **报告生成不出来**：报告由**推理模型**撰写，而 `maxTokens` 默认 8000 是**推理与正文共用的预算**——
  推理把预算吃满时正文一个字都写不出来，报错却只说「模型没有返回任何正文（finish = max-tokens）」，
  从面板上完全看不出该怎么办（实测 `usage.outputTokens` 恰好等于 8000）。现在默认提到 32000；
  旧库按存储版本自动迁移，且**只迁移恰好停在旧默认 8000 的值**，用户自己设过的值不动；
  这种情况的报错会点明「推理占满了 N token 的预算（其中推理 M）」，并给出下一步该调到多少；
  正文被截断时另记一条 warn 与 `meta.truncated`。
- **自动研判串台与自反馈**：研判请求正文里带着「命中词：…」清单，模型判定时必然复述这些词，
  下一轮扫描又把**模型自己的回复**当成新命中——同一批关键词被反复放大，队列永远排不空。
  现在按「会话 + 投递时刻」设闸：收到过研判请求的会话，那一刻之后的模型回复不再进矩阵。
  派发同时收严到**本工作区的成员会话**（删掉了「只有一个根会话就用它」与跨工作区复用 agent
  两个兜底，认不出收件人就整批不派发），并且**所属会话已不在工作区的孤儿命中不再自动派发**
  （仍留在面板上可人工判定）。

两条都有回归测试：攻击矩阵主机侧新增自反馈闸门用例（含「未参与研判的会话照常入矩阵」对照组），
报告新增「推理吃满预算」报错路径与旧库迁移用例。

## 开发

改插件前先读 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)：里面记着 DSH 插件开发的
几条硬约束与实测踩过的坑（哪些 API 在静态形态下不存在、组合 patch 的语义、沙箱与依赖解析等），
每一条都是真金白银换来的。

每个包另有自己的 `DEVELOPMENT.md`（若存在），记该插件特有的设计决定。

## 许可

[MIT](LICENSE) © 2026 fasthei
