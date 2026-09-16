# 攻击矩阵 · DSH 插件

把**工作区里的对话**（用户消息、模型回复、工具调用与结果）扫成一张攻击矩阵：
每次操作命中哪个框架的哪个技术点，标出**已覆盖**与**缺口**，
并在下方给出对本组织发起测试的时间线。

**当前支持四套框架**，每套一个页面：

| 框架 | 面向 | 收录 | 数据来源 |
|---|---|---|---|
| MITRE ATLAS | AI 系统本身的对抗战术 | 45 技术点 / 16 阶段 | 官方机读数据 `atlas-data` v2026.09 |
| MITRE ATT&CK Enterprise | 企业 / IT 面战术技术 | 46 技术点 / 15 阶段 | MITRE 官方 TAXII 2.1（企业版 collection） |
| OWASP Top 10 for LLM Applications 2025 | LLM 应用风险 | LLM01–LLM10 | 官方仓库 `2_0_vulns` |
| NVIDIA AI Kill Chain | AI 应用攻击阶段 | 29 技术点 / 6 阶段 | NVIDIA 官方博客（2025-09-11, Rich Harang） |

ATLAS 和 ATT&CK 是两套东西：ATLAS 打 AI 系统本身，ATT&CK 打企业 IT 面。
红队实操里两者会同时命中（先扫资产、拿凭据，再去打模型），所以并列成两个页面
而不是合并。两个大框架都只收了与「AI/LLM 红队对话」相关的子集，不是全量目录 ——
矩阵的价值在于缺口准，不在于条目多。

## 它怎么工作

1. **扫对话**：读当前工作区里所有会话的事件流（`user/message`、`assistant/message`、
   `tool/call`、`tool/result`），把每次操作抽成一条可读记录。
2. **匹配**：用每个技术点的特征词表（`detect_keywords`）在操作文本里匹配。
   命中先记为**疑似** —— 自动匹配只负责提示，不负责下结论。
3. **确认**：你在卡片详情里点「确认覆盖」才计入覆盖率；点「排除」把误报踢掉。
4. **落盘**：矩阵数据写进工作区自己的 `.redteam-attack-matrix.json`，
   所以**切工作区 = 切数据集**，互不污染。
5. **时间线**：所有命中按时间倒序汇总，就是这次对本组织测试的作战时间线。

### 界面

```
┌ 顶栏：工作区下拉 · 扫描对话 · 重扫 · 统计
├ 框架标签页：ATLAS / ATT&CK / OWASP LLM / NVIDIA      每个框架一页
├ 覆盖率条：已确认 / 疑似 / 总数 · 命中操作次数
├ 技术卡片网格：灰=未覆盖   黄=疑似   绿=已确认
│   └ 点卡片 → 右侧详情：技术点说明、判定线索、特征词、
│                 攻击操作日志（按会话聚合，带证据片段）、确认 / 排除
└ 时间线：对本组织发起测试的记录，按时间倒序
```

## 安装

> ⚠️ **发布 `1.0.1` 之前，先别从 npm 装**：npm 上当前的 `latest` 是 `1.0.0`，
> 它的客户端 RPC 路径写死成了资产图谱的路由，**面板全 404**（详见「版本」一节）。
> `1.0.1` 尚未发布，下面这条命令现在装到的就是那个坏版本。

```bash
dsh plugin --profile web add dsh-redteam-attack-matrix
# 重启 dsh web
```

包自带 `dsh.bundle.patch`，装完自动挂载，不需要手工编辑配置。

## 版本

**`1.0.1`**（仓库版本）。`src/` 是权威源码，`lib/` 由它生成，因此不存在「仓库版本与运行版本不一致」。

本版只修一处缺陷：**客户端 RPC 路径**。`1.0.0` 的 `lib/client.js` 把它写死成了
`/dsh-redteam-asset-graph/rpc` —— 本插件于是去打资产图谱的路由：**面板请求全 404**，
两者同时安装时还会读到对方的数据。本版改成由生成器按包名替换的 `__ROUTE_BASE__`
占位符，并把**实际请求的 url** 钉进冒烟测试：原来只记 `method`，路径写错成别的插件
也测不出来 —— 这次事故正是从那个盲区漏出去的。

`1.0.0` 的内容（四套框架矩阵、扫描与确认链路、时间线）见 git log 与 tag
`attack-matrix-v1.0.0`。

## 已知限制

- **只能扫进程内活着的会话**。DSH 的 `sessions` 是内存态 Service
  （官方描述：持久化不在这个 store 里），所以重启后已不在内存里的历史会话扫不到。
  矩阵自己的数据是落盘的，重启不会丢已有记录，但「重扫」也读不回已经卸载的会话。
- **自动匹配会误报**。特征词表刻意选得具体（宁可漏报不刷屏），但仍然只是提示。
  覆盖率以人工确认为准。
- **框架数据是内置的**，不联网拉取。ATT&CK / ATLAS 这类大框架只收与
  AI/LLM 测试对话可能相关的子集，不是全量。每个框架的版本与来源写在
  面板标签页的 tooltip 里（`src/frameworks.js` 的 `source` 字段）。

## 开发

`src/` 是权威源码，`lib/` 由它生成：

```bash
npm run build:lib     # 生成 lib/
npm run check:lib     # 校验与 src/ 是否漂移（prepack 会跑）
npm test              # 扫描链路 + 客户端渲染
```

改之前请先读仓库的 [../../docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md)——
DSH 插件开发有几条硬约束（静态形态下哪些 API 不存在、组合 patch 的语义、
沙箱与依赖解析），那里记的每一条都是实测踩出来的。

| 文件 | 说明 |
|---|---|
| `src/host.js` | `applyHost` 的**函数体**（函数头/垫片/收尾在 `lib/parts/`，不要重复写） |
| `src/frameworks.js` | 框架数据：tactics + techniques + detect_keywords |
| `src/client.js` | 客户端半边，以 `return { name, inject, apply }` 结尾 |
| `lib/parts/` | 生成器模板：垫片与包装都在这里 |
| `tools/build-lib.mjs` | 生成器（把 `src/frameworks.js` 内联进产物） |
| `cordis.patch.yml` | bundle patch，`dsh plugin add` 靠它自动挂载 |

### 加技术点 / 改特征词

只改 `src/frameworks.js`，然后 `npm run build:lib`。生成器会校验：
框架结构完整、技术点 id 不重复、`detect_keywords` 是数组，不合格直接终止构建。

**加特征词前先问一句**：正常开发对话会不会命中它？
一个会命中每次工具调用的词（比如裸的 `tool call`）会把矩阵变成噪音墙，
而矩阵的价值恰恰在于缺口准。

### 数据源

面板用的 JSON-RPC 路由已由 `lib/parts/host.tail.js` 注册（基址 `/dsh-redteam-attack-matrix`），
`src/host.js` 里用 `harness.handle('method', fn)` 补句柄，客户端用 `host.call` 调。

宿主侧读会话靠两个 Service：

- `ctx.get('workspaceRegistry')` → `list()` / `get(id)`；`Workspace.sessionIds` 已按 canonical cwd 过滤
- `ctx.get('sessions')` → `get(id)`；`session.snapshotEvents()` 拿事件流

会话事件里用来判断的几类：`user/message`、`assistant/message`、`tool/call`、`tool/result`。
一次「攻击操作」就是其中一条事件，这也是时间线的刻度。
