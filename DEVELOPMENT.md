# 开发笔记 · DSHairedPlugin

面向改这个插件的人。使用者请看 [README.md](README.md)。

这里的每一条都是**实测踩出来的**，不是推测；踩坑的代价很高（有些只能在真机上复现），
所以留档，避免重复。

## 目录

- [引导式加载](#引导式加载本机改代码用)
- [常驻插件包](#常驻插件包lib-是怎么来的)

---

## 引导式加载（本机改代码用）

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

## 常驻插件包（`lib/` 是怎么来的）

动态插件是进程内的，DSH 重启就没了。`lib/` 是把它做成**常驻插件包**后的产物：
挂在宿主组合里，随进程启动加载，**重启不丢**。

```
src/host.js   ──垫片──▶  lib/host.js   宿主半边：三个工具 + JSON-RPC 路由
src/client.js ──垫片──▶  lib/client.js 客户端半边：面板（__ModuleLoader__ CJS 工厂）
```

`src/` 与 `lib/` 不是两份实现：两半边都由 `npm run build:lib` 从 `src/` **生成**，
主体逻辑逐字相同，差异只在垫片（见 `lib/README.md`）。

垫片解决的是「动态 API 在静态包里不存在」：

| 动态半边 | 静态实现 |
|---|---|
| `harness.defineTool` / `harness.registerTool` | `defineTool` + `ctx.tools.register` |
| `harness.handle` / `host.call` | 宿主注册 `POST /dsh-redteam-asset-graph/rpc`，客户端用 `fetch` 调 |
| `styles.insert`（动态 runner 的闭包参数） | 客户端自行插入 `<style>` 元素 |

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
# 走 npm 包时应看到 name: dsh-redteam-asset-graph
# 走仓库路径时应看到 name: file:///…/DSHairedPlugin
```

`--dump-config` 用的是与启动同一套 patch 语义（`applyEntryPatches`），所以 dump 对了、
启动时就对了。

---

---

## 相关文件

| 文件 | 说明 |
|---|---|
| `src/host.js` `src/client.js` | 权威源码（动态插件形态） |
| `lib/` | 由 `src/` 生成的常驻插件包，见 `lib/README.md` |
| `tools/build-lib.mjs` | 生成器，`npm run build:lib` / `--check` |
| `test/render-smoke.mjs` | 客户端渲染冒烟测试 |
| `cordis.patch.yml` | bundle patch，`dsh plugin add` 靠它自动挂载 |
