# 红队资产图谱 · DSH 动态 Cordis 插件

在 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) 里做红队测试时，把目标资产**自动收集、关联、可视化**，并让模型参与研判。

- **面板**：左侧一级菜单「资产图谱」—— 网状图 / 列表 / 垃圾箱三视图
- **删除**：列表每行可单独删除；删除一律进垃圾箱（可恢复），并写入图谱日志的审计链
- **模型工具**：`asset_record`（登记）、`asset_query`（查询）、`asset_remove`（剔除误报）
- **检索**：Jina MCP 直连，按需勾选工具（`include_tools` 限定，减少上下文占用）
- **关联分析**：两阶段 —— 阶段 1 用 Jina 检索**只产出候选**，阶段 2 交模型研判决定入库哪些

---

## ⚠️ 形态说明（先读这一段）

这是 **动态 Cordis 插件源码**，**不是 npm 包**，也不能 `npm install`。

它由两个半边组成，运行时通过 DSH 的 `cordis_define` 加载进一个会话：

| 文件 | 半边 | 作用 |
|---|---|---|
| `src/host.js` | Host（Node 进程） | 数据存储、项目跟随工作区、Jina MCP 客户端、三个模型工具、RPC 句柄 |
| `src/client.js` | Client（浏览器） | 面板 UI、网状图布局与交互、状态显示 |

**代价：它是进程内的。** DSH 一重启，面板、侧边栏按钮、三个模型工具和全部 Package 一起消失，只有数据文件留在磁盘上，需要重新加载一次。

> 想要「重启不丢、装了就能用」的形态，需要把它移植成**常驻插件包 + agent preset**（改 `cordis.yml` 挂载）。本仓库目前不包含那部分。

---

## 加载方法

在 DSH 会话里让 Agent：

1. 读取 `src/host.js` 与 `src/client.js`
2. 用 `cordis_define` 新建插件，把两者分别作为 `code.host` 与 `code.client`（**两个半边必须同时提供**，缺任一半会静默丢失对应能力：缺 client 则面板消失，缺 host 则所有 RPC 与工具消失）
3. `cordis_run` 激活

### 加载时注意内存

两个半边合计约 **146 KB**，加载会把这份源码喂进会话记录并被长期持有。实测一个解压后 40 MB 的会话记录，在 host 内存里膨胀到约 680 MB 起步；DSH 默认堆上限约 2 GB。**反复重发整包是显著的内存压力来源**，建议：

```bash
NODE_OPTIONS=--max-old-space-size=4096 dsh web
```

并在改代码时尽量减少重发次数（见下方「研判规则外置」）。

### 引导式加载（推荐，也是本仓库当前的运行形态）

把 155 KB 整包当字符串发给 `cordis_define` 有一个硬伤：那份字符串要由 Agent **手工转义后逐字写进工具参数**。实测这样转写 155 KB 会出错，且报错只给第一个语法错误（本仓库真实发生过两次 `SyntaxError: Unexpected token ')'`，两次都指向同一行，排查代价很高）。

改用「引导式」：提交给 `cordis_define` 的只是**几千字节引导码**，真正的源码留在磁盘上，运行期再读回来编译。

```
code.host    引导码  ──fs 读──▶  src/host.js    ──new Function──▶ 执行
code.client  引导码  ──host.call('payload')──▶  src/client.js  ──new Function──▶ 执行
```

好处：

- **改代码不用重发整包**。改完 `src/host.js` / `src/client.js`，只需重跑一次 Package（`cordis_run`）。
- 会话记录里不再长期驻留 146 KB 源码，内存压力显著下降。
- 磁盘上的 `src/*.js` 就是权威源码，不存在「仓库版本与运行版本不一致」。

代价：Host 半边依赖一个绝对路径常量（引导码里的 `ROOT`）。换目录或移走仓库后要在引导码里同步改。

#### 实测踩出来的四个约束（都不是推测）

1. **宿主「函数体」里没有 `ctx`**。只有 `apply(ctx)` 的参数里有。在 `apply` 之外引用 `ctx` 会直接 `ReferenceError: ctx is not defined`——Host 和 Client 半边都一样。
2. **客户端半边必须自己声明 `inject: ['slots','timer']`**。客户端门禁用 `Object.keys(ctx.fiber.inject)` 判断 `ctx.slots` 是否可读，而它取的是**你返回的那个 plugin 对象**的声明。引导码若不声明，内层 `applyClient` 拿到的 `ctx.slots` 是「未声明的假上下文」，Slot 注册会失败——而且**失败被 `applyClient` 自己的 `try/catch` 吞掉，外层照样报 `state: running`**，表现为「插件运行成功但侧边栏没有面板」。这个坑最难查。
3. **`payload` 句柄要在 `await` 读文件之前注册**。否则客户端可能先到一步拿到 not-found，直接把客户端半边做死。句柄内部再去等读取完成即可（写成 `async`）。
4. **沙箱只认工作区内的绝对路径**。相对路径会落到会话沙箱之外，读不到也写不进；`/tmp` 同样不可用。

另外两条：源码含中文，`btoa` / `TextDecoder` 之类不能直接吃，引导码里只用字符串拼接就不受影响；`data:` URL 模块虽然可以 `import`，但**裸说明符（`'react'`、`'@deepseek-ai/cordis'`）在其中无法解析**，所以别指望靠它导入 React——React 必须由参数注入。

> **注意**：引导码本身是在会话里定义的，不随仓库分发；它读的 `src/*.js` 才是仓库里的源码。因此修改引导码（例如换 `ROOT`）必须重新 `cordis_define`，而修改 `src/*.js` 只需重跑 Package。

---

## 常驻插件包（重启不丢）

动态插件是进程内的，DSH 重启就没了。`lib/` 是把它做成**常驻插件包**后的产物：挂在宿主组合里，
随进程启动加载，DSH 重启不丢、装了就能用。

```
src/host.js   ──机械改造（垫片）──▶  lib/host.js    宿主半边：三个工具
src/client.js ──待改造──────────────▶  lib/client.js  客户端半边：面板（尚未完成）
```

`src/` 与 `lib/` 并不是两份实现：`lib/host.js` 由 `npm run build:lib` 从 `src/host.js`
**生成**，其中 1600 行主体逻辑逐字相同，只有文件头尾与一层 `harness` 垫片不同
（详见 `lib/README.md`）。核对时 diff 两者，差异应当只出现在头尾。

### 安装（三步）

```bash
# 1) 让本仓库能解析 @deepseek-ai/* —— 它不在 profile 的解析链上
mkdir -p node_modules
ln -sfn ~/.dsh/profiles/node_modules/@deepseek-ai node_modules/@deepseek-ai

# 2) 把插件行加进活动 profile 的宿主组合
#    文件：~/.dsh/profiles/web/cordis.patch.yml
#    （见下方「组合行的正确写法」）

# 3) 重启 dsh web —— 宿主组合的 HMR 在 web profile 里是关闭的，热改不会生效
```

### 组合行的正确写法

```yaml
- insert:
    - id: redteam-asset-graph
      name: /home/parallels/Pictures/DSHairedPlugin   # 绝对路径
```

三个**实测踩过**的坑：

1. **patch 条目的语义是 `PatchOptions`，不是「直接放一行」。** 带 `id` 的条目是「改某行配置」，
   裸行会被 `patch: id is required` 跳过并告警；**只有 `insert` 且不带 `id` 才是往根列表追加新行**。
2. **`name` 用绝对路径。** 相对路径的解析基址是 `DSH_HOME`（`~/.dsh`），不是 profile 目录——
   写 `../../Pictures/...` 会被解析成 `~/.dsh/Pictures/...`（实测 dump 出来的就是这个错路径）。
3. **`web profile` 里 `hmr` 是 `disabled: true`**，所以 `patchReload: live` 实际不生效，
   改完组合**必须重启** `dsh web`。

### 验证组合是否正确

```bash
dsh --profile web --dump-config | tail -4
# 应看到：
#   - id: redteam-asset-graph
#     name: file:///home/parallels/Pictures/DSHairedPlugin
```

`--dump-config` 用的是与启动同一套 patch 语义（`applyEntryPatches`），所以 dump 对了、
启动时就对了。

### 用 npm 分发（给别人装）

上面的「手工加一行」只适合本机开发。要让**别人**也能用，走官方的 bundle 机制：
本包已声明 `dsh.bundle.patch`，装了就会被自动挂载，无需手工编辑任何配置。

```bash
# 用户侧：一条命令
dsh plugin --profile web add dsh-redteam-asset-graph
# 然后重启 dsh web（web profile 的 hmr 是 disabled，组合改动不会热生效）
```

这背后的机制（`dsh` 官方行为）：

1. `dsh plugin` 是 **pnpm 的转发器**，在 profile 目录里执行 `pnpm add <包>`，
   于是包装进了 profile 的 `node_modules`；
2. 随后 `reconcilePlugins` 检查依赖是否**声明了 `dsh.bundle.patch`**，
   是则把包名并入 `dsh.profile.bundles`；
3. 启动时按层叠加：各 bundle 的 patch → profile 的 `cordis.patch.yml`
   → `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖层。

所以**同一个包能省掉手工那一步**。`cordis.patch.yml` 的内容就是一行 `insert`：

```yaml
- insert:
    - id: redteam-asset-graph
      name: 'dsh-redteam-asset-graph'
```

> 发布到 npm 需要你自己的 npm 账号（`npm login` 后 `npm publish`）。
> 包名 `dsh-redteam-asset-graph` 在 registry 上未被占用。
> 想先本地验证可以 `npm pack` 出 tarball，再用
> `dsh plugin --profile web add ./dsh-redteam-asset-graph-7.9.5.tgz` 装。

### 两种挂载方式怎么选

| | 仓库路径挂载 | npm 包挂载 |
|---|---|---|
| 配置 | 手工往 `cordis.patch.yml` 加 `insert` | 无（包自带 patch） |
| 适合 | 本机改代码 | 分发给别人 |
| 改源码后 | 重启即生效 | 需重新发布/重装 |

**别同时用**：两种都指向本插件，会注册重复的行与重复的工具。

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

这是本仓库刻意留的逃生口：**调规则只改这个文件，不用重新加载 146 KB 的整包。**

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

- **进程内**，DSH 重启即消失（见顶部形态说明）
- 强依赖 Jina API Key，没填等于不能用
- 研判阶段的 `web_fetch` 在部分环境不可用（代理会把域名解析到保留地址段），内置规则已注明改用检索类工具
- 资产值现在只能录入 IP 与域名
- 数据文件不做并发保护，同时开多个 DSH 实例指向同一份存储会互相覆盖

---

## 测试

```bash
npm test        # 或 node test/render-smoke.mjs
```

`test/render-smoke.mjs` 是 **Client 半边的渲染冒烟测试**。存在的理由很具体：Client 半边只过 `node --check` 是不够的 —— 语法完全合法的代码仍可能在运行期崩溃。真实案例：`assocInfo` 是函数声明（会提升），却在它依赖的 `const EV_PLACEHOLDER` 初始化之前被调用，抛 `Cannot access 'EV_PLACEHOLDER' before initialization`（TDZ）。这类错误只在「选中一个带边的资产」时才触发，恰好绕过所有静态检查。

测试用桩件实现 `React.useState/useMemo/useRef/createElement` 等，把 `selected` 指向一个真实带边的资产，然后调用 `Panel()` 走完整渲染路径。数据源优先用 `~/.redteam-assets.json`，不存在时退回内置小样本。

## 版本

**运行中 `7.9.5`（引导式加载，dynamic plugin `asset-4` 的 `pkg-18`，run-19）**。

这版包含 `main` 上的候选池结算（研判结束后，把本轮送出、且未被 `asset_record` 采纳的候选出池；模型这一轮若没有任何推理/输出，则把候选退回待研判，重推上限 3 次以防空转），以及删除 `purgeJunkOnce()` 死代码。

**因为改用了引导式加载，`src/host.js` / `src/client.js` 的当前内容就是运行中的代码** —— 不再存在「仓库版本与运行版本不一致」的问题。版本历史见 git log。

仍未完成的是 README 顶部提到的**常驻插件包 + agent preset** 移植：当前形态仍是进程内的，DSH 重启后需要重新加载一次（但重新加载不再需要重发 155 KB 整包）。

## 许可

[MIT](LICENSE) © 2026 fasthei
