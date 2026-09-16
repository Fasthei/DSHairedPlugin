# 红队资产图谱 · DSH 插件包

在 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) 里做红队测试时，把目标资产**自动收集、关联、可视化**，并让模型参与研判。

- **面板**：左侧一级菜单「资产图谱」—— 网状图 / 列表 / 垃圾箱三视图
- **删除**：列表每行可单独删除；删除一律进垃圾箱（可恢复），并写入图谱日志的审计链
- **模型工具**：`asset_record`（登记）、`asset_query`（查询）、`asset_remove`（剔除误报）
- **检索**：Jina MCP 直连，按需勾选工具（`include_tools` 限定，减少上下文占用）
- **关联分析**：两阶段 —— 阶段 1 用 Jina 检索**只产出候选**，阶段 2 交模型研判决定入库哪些

---

## 安装（推荐：插件包）

```bash
dsh plugin --profile web add dsh-redteam-asset-graph
# 然后重启 dsh web —— web profile 的 hmr 是 disabled，组合改动不会热生效
```

本包声明了 `dsh.bundle.patch`，所以**装完即自动挂载**，不需要手工编辑任何配置：

1. `dsh plugin` 是 **pnpm 的转发器**，在 profile 目录里执行 `pnpm add <包>`；
2. 随后 `reconcilePlugins` 发现该包声明了 `dsh.bundle.patch`，就把包名并入
   `dsh.profile.bundles`；
3. 启动时按层叠加：各 bundle 的 patch → profile 的 `cordis.patch.yml`
   → `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖层。

验证组合是否生效：

```bash
dsh --profile web --dump-config | tail -4
# 应看到：
#   - id: redteam-asset-graph
#     name: dsh-redteam-asset-graph
```

`--dump-config` 用的是与启动同一套 patch 语义（`applyEntryPatches`），dump 对了启动时就对了。

**装完还要做一件事**：填 Jina API Key。面板 → **设置 → Jina（必填）**。没填时「关联分析」
按钮禁用——本插件的检索与关联分析依赖 Jina。填完可以点「测试连接」确认。

### 其他安装方式

```bash
# 指定版本
dsh plugin --profile web add dsh-redteam-asset-graph@7.9.5

# 从仓库直接装（开发用；仍是同一套 bundle 机制）
dsh plugin --profile web add github:Fasthei/DSHairedPlugin

# 本地 tarball
npm pack && dsh plugin --profile web add ./dsh-redteam-asset-graph-7.9.5.tgz

# 卸载（bundles 会自动回收该行）
dsh plugin --profile web remove dsh-redteam-asset-graph
```

### 发布位置（两个 registry）

同一个插件在两个 registry 上发布，**包名不同**——这不是笔误，是两边的命名规则决定的：

| registry | 包名 | 谁能直接装 |
|---|---|---|
| **npm**（主推） | `dsh-redteam-asset-graph` | 所有人，一条命令即可 |
| **GitHub Packages** | `@fasthei/dsh-redteam-asset-graph` | 仅已授权者（见下） |

**为什么必须两个名字**：GitHub Packages 要求包名是作用域形式，且作用域必须等于仓库属主
（`Fasthei` → `@fasthei/…`）；而 npm 侧的作用域只能用自己的 npm 用户名，且不允许发布他人的
作用域。所以无法用同一个名字覆盖两边。

**GitHub Packages 的额外代价**（所以只作备用源）：该包是私有的，匿名读取返回 401，
每个使用者都要先在自己 `~/.npmrc` 里声明 registry 与凭据：

```
@fasthei:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<自己的 GitHub token，需 read:packages>
```

然后：

```bash
dsh plugin --profile web add @fasthei/dsh-redteam-asset-graph
```

> **发布（维护者）**
>
> ```bash
> # npm（公开）
> npm publish
>
> # GitHub Packages（作用域副本由脚本生成，避免手抄两份清单）
> npm run publish:gh          # 生成 build/gh-packages/，name 改为 @fasthei/…
> cd build/gh-packages && npm publish
> ```
>
> 两边都受 `prepack` 保护：`lib/` 与 `src/` 漂移时**拒绝发布**，避免发出不一致的包。

---

## 三种形态

同一个插件的三种跑法，能力相同、生命周期不同：

| 形态 | 入口 | 生命周期 | 适合 |
|---|---|---|---|
| **插件包**（推荐） | `lib/host.js` + `lib/client.js` | 随进程启动，**重启不丢** | 日常使用、分发 |
| 引导式加载 | 会话内引导码 → 读 `src/*.js` | 进程内，重启要重跑一次 Package | 本机快速改代码 |
| 动态插件 | `cordis_define` 提交 `src/*.js` 全文 | 进程内，重启即消失 | 临时试用（不推荐，见下） |

`src/` 是**权威源码**；`lib/` 由 `npm run build:lib` 从它**生成**，主体逻辑逐字相同，
差异只在文件头尾与一层垫片（详见 `lib/README.md`）。核对时 diff 两者，差异应只出现在头尾。

### 插件包的安装（源码方式，适合本机开发）

如果你是从仓库目录直接用（不走 npm），需要三步：

```bash
# 1) 让本仓库能解析 @deepseek-ai/* —— 它不在 profile 的解析链上
mkdir -p node_modules
ln -sfn ~/.dsh/profiles/node_modules/@deepseek-ai node_modules/@deepseek-ai

# 2) 把插件行加进活动 profile 的宿主组合
#    文件：~/.dsh/profiles/web/cordis.patch.yml（写法见下）

# 3) 重启 dsh web
```

组合行必须写成 `insert` 形态：

```yaml
- insert:
    - id: redteam-asset-graph
      name: /绝对路径/到/本仓库        # 必须绝对路径，理由见 DEVELOPMENT.md
```

> ⚠️ **别与 npm 包同时用**：两种都指向本插件，会注册重复的行与重复的工具。

---

## 开发

改这个插件（引导式加载、常驻插件包的垫片与编排细节、实测踩过的坑）见 **[DEVELOPMENT.md](DEVELOPMENT.md)**。

---

## 配置

全部在面板 **设置** 抽屉里：

| 项 | 说明 |
|---|---|
| **Jina API Key** | **必填**。本插件的检索与关联分析依赖 Jina，未填写时「关联分析」按钮禁用 |
| **工具（按需勾选）** | 勾选后端点自动带上 `include_tools`，只暴露所选工具 |
| **跟随工作区** | 开启后项目自动跟随当前会话的工作区目录；项目 = 工作区目录，自动创建与清理 |
| **自动研判** | 阶段 1 结束后是否自动唤醒模型做阶段 2 研判 |
| **自动捕获** | **只从外部情报工具**（web_search / Jina 检索类）攒**候选**，跳过 bash 与本地读文件；不直接入库。攒到 6 条、或安静 45 秒后自动唤醒模型研判，由模型决定登记哪些 |
| **存储路径** | 默认 `~/.redteam-assets.json`，相对路径基于用户主目录 |

### 研判规则外置（调规则不用重发）

研判提示词里那套「哪些候选该收、哪些该排除」的规则，可以在 `~/.redteam-asset-graph.rules.md` 覆盖。该文件存在即生效，删除或留空则回退到内置默认。每次研判开始时日志会打一行 `研判规则来源：…` 告诉你走了哪一份。

这是本仓库刻意留的逃生口：**调规则只改这个文件，不用改代码、也不用重新发布包。**

---

## 关联分析怎么工作

```
阶段 1/2  Jina 检索        对项目内每个可检索资产发一次最小查询
                          → 只产出候选列表，**不写图谱**
阶段 2/2  模型研判        候选清单随研判规则交给模型
                          → 相关的 asset_record，不确定的登记并标「待验证」
                          → 确认无关的**不调用任何工具**，理由留在推理里
                          → 图谱里已有的误报才用 asset_remove 清理
```

### 工具捕获候选（全自动，无按钮）

`自动捕获` 开关打开时，插件从工具输出里提资产，但**只进候选池，不写图谱**。

**捕获范围是一份正向白名单**（`web_search` / `web_fetch` / `search_*` / `web_*` / `read_url` / `parallel_read_url` 等外部检索工具），`bash`、`read`、`grep`、`glob` 等本地工具一律跳过。这不是保守，是实测出来的：本地工具的输出里同样会出现域名与哈希，而且它们不是目标情报 —— git commit SHA 会被当成 hash 资产（40 位十六进制正好命中），源码里的 `relay.ok` 会被当成域名（`ok` 是两位字母），连我自己诊断命令打印的截断串都会被当成 URL：

```
工具输出 → 提取 → 待研判候选池（去重、上限 300、带来源与命中次数）
                       ↓  攒到 6 条，或最后一条之后安静 45 秒
              自动唤醒模型（复用同一条研判规则与提示词）
                       ↓
       相关的 asset_record 入库；无关的不登记，理由留在推理里
                       ↓
   已被登记的候选自动从池里移出；被排除的留在池里但标记已送，不再重复打扰
```

顶栏的「待研判候选 N」是**只读指示**，没有按钮 —— 整个过程自己跑。触发时机由 **host 自己的 `timer` 服务**每 5 秒驱动一次（客户端每 2 秒的 `snapshot` 轮询作为补充）。这一点曾经踩过坑：最初只挂在客户端轮询上，结果**面板一关，没有轮询，没有心跳，自动研判永远不触发** —— 候选池涨到 21 条、`自动研判候选` 一次都没出现在日志里。

面板「关联分析」下方常驻一行状态：`未运行 / 运行中（检索中·研判中，带已用时间）/ 已完成（带耗时与结束时刻）/ 已停止 / 分析失败`。运行期间该按钮变「停止」，此时重复点击会被拒绝。

图谱中的关系边只来自两类来源：

1. **本地结构化规则** —— `belongs_to`（URL→域名）、`hosts_on`（URL→IP）、`exposes_port`、`subdomain_of`、`in_range`（IP 落网段）、`mailbox_at`（邮箱→域）
2. **显式指定** —— 模型或人工在 `asset_record` 里传 `relay + relation`

**不会**从备注文本做子串匹配建边，也**不会**因为两个资产共享某个标签就两两建边。这两类规则都被刻意移除了：它们是平方级噪声源，实测一个语义标签曾在 8 个资产间炸出 35 条边、占全图 78%。

### 关联的「依据」从哪来

详情卡片里每条关联都带一行灰色的「依据」，按优先级取：

1. **边的 `evidence` 字段** —— 模型调用 `asset_record` 时传了 `evidence`（这条关系你看到了什么），用它
2. 否则取**对方资产 note 的首行** —— 也就是模型写「收录依据 / 决定性证据」的地方
3. 都没有则不显示该行

自动关系的 `evidence` 是触发匹配的那个值（主机名 / 域名 / 网段），所以也能直接读。注意 `evidence` 曾一度被填成字面量 `"model"` —— 那是 bug，已修：宁可空着，也不显示假依据。

---

## 隐私与安全

- 运行数据存在 `~/.redteam-assets.json`，**其中包含你的 Jina API Key 和真实目标资产**，已在 `.gitignore` 中排除。**永远不要提交它。**
- 本仓库的源码里**不含任何密钥或测试数据**，只有占位符 `jina_xxxxxxxxxxxxxxxx`。
- 本工具用于**已获授权的**安全测试。请自行确认你对测试目标拥有授权。

---

## 已知限制

- 强依赖 Jina API Key，没填等于不能用
- 研判阶段的 `web_fetch` 在部分环境不可用（代理会把域名解析到保留地址段），内置规则已注明改用检索类工具
- 资产值现在只能录入 IP 与域名
- 数据文件不做并发保护，同时开多个 DSH 实例指向同一份存储会互相覆盖
- 面板的 RPC 走插件自己的 HTTP 路由（`/dsh-redteam-asset-graph/rpc`），要求宿主提供 `webServer` 服务

---

## 测试

```bash
npm test        # 或 node test/render-smoke.mjs
```

`test/render-smoke.mjs` 是 **Client 半边的渲染冒烟测试**。存在的理由很具体：Client 半边只过 `node --check` 是不够的 —— 语法完全合法的代码仍可能在运行期崩溃。真实案例：`assocInfo` 是函数声明（会提升），却在它依赖的 `const EV_PLACEHOLDER` 初始化之前被调用，抛 `Cannot access 'EV_PLACEHOLDER' before initialization`（TDZ）。这类错误只在「选中一个带边的资产」时才触发，恰好绕过所有静态检查。

测试用桩件实现 `React.useState/useMemo/useRef/createElement` 等，把 `selected` 指向一个真实带边的资产，然后调用 `Panel()` 走完整渲染路径。数据源优先用 `~/.redteam-assets.json`，不存在时退回内置小样本。

## 版本

**`7.9.5`**（已发布到 npm：`dsh-redteam-asset-graph@7.9.5`）。

本版包含候选池结算（研判结束后，把本轮送出、且未被 `asset_record` 采纳的候选出池；模型这一轮若没有任何推理/输出，则把候选退回待研判，重推上限 3 次以防空转）、面板的「待验证」确认按钮与详情卡放大/展开，以及 `lib/` 常驻插件包与 npm 分发要件（`dsh.bundle.patch`）。

`src/` 是权威源码，`lib/` 由它生成，因此**不存在「仓库版本与运行版本不一致」**。版本历史见 git log。

## 许可

[MIT](LICENSE) © 2026 fasthei
