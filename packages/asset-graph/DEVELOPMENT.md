# 资产图谱 · 开发笔记

面向改**这个插件**的人。使用者请看 [README.md](README.md)；
仓库级通用约定（两种形态、静态形态缺失的 API、patch 语义、沙箱与路径）
见 [../../docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md)。

下面只记**本插件特有**的设计与踩过的坑。

---

## `lib/` 是怎么来的：垫片，而不是改写

`src/` 是权威源码（动态插件形态），`lib/` 由 `npm run build:lib` 生成。
两半边的主体逻辑**逐字不动**，差异全部收敛在垫片里：

```
src/host.js   ──垫片──▶  lib/host.js   宿主半边：三个工具 + JSON-RPC 路由
src/client.js ──垫片──▶  lib/client.js 客户端半边：面板（__ModuleLoader__ CJS 工厂）
```

| 动态半边有 | 本插件的静态实现 |
|---|---|
| `harness.defineTool` / `registerTool` | `defineTool` + `ctx.tools.register` |
| `harness.handle` / `host.call` | 宿主注册 `POST /dsh-redteam-asset-graph/rpc`，客户端 `fetch` 调 |
| `styles.insert`（动态 runner 的闭包参数） | 客户端自行插入 `<style>` 元素 |

**为什么选垫片而不是机械改写 1600 行主体逻辑**：改写引入的回归极难排查，而垫片把
「动态 ↔ 静态」的全部差异收敛到一处。核对时只需 diff `src/` 与 `lib/`，差异应当
**只出现在文件头尾**；主体一旦出现差异，说明有人手改了生成物。

## 客户端 RPC 为什么走 HTTP 而不是 `ctx.remote`

静态客户端的对外通道本该是 `ctx.remote.<ns>`，但那要求宿主侧写 typert Remote 服务
（zod schema + 生成绑定）。本插件有 **20 个无类型 JSON 句柄**，为此引入整套生成链不划算。

所以选了自己开路由：

```
客户端 fetch POST /dsh-redteam-asset-graph/rpc
  body: { method: 'snapshot' | 'enrich' | …, args: … }
宿主把 20 个 harness.handle 收进 handlers 表，按 method 分发
```

路由整体挂在插件命名空间下，避免与其它插件的路由相撞。

## 实测踩过的坑

### 客户端半边必须自己声明 `inject`

客户端门禁用 `Object.keys(ctx.fiber.inject)` 判断 `ctx.slots` 是否可读，而它取的是
**你返回的那个 plugin 对象**的声明。引导码若不声明 `inject: ['slots','timer']`，
内层 `applyClient` 拿到的 `ctx.slots` 是「未声明的假上下文」，Slot 注册会失败
——而且**失败被 `applyClient` 自己的 `try/catch` 吞掉，外层照样报 `state: running`**，
表现为「插件运行成功但侧边栏没有面板」。这个坑最难查。

### `webServer.register` 的 `kind` 是必填

按官方 `WebRoute` 类型定义，`kind`（`'exact' | 'prefix'`）**必填**，且**没有 `method` 字段**
——方法校验要写在 handler 里。漏了 `kind` 在真实宿主上会直接注册失败，
而这种错只有读类型定义才看得出来。

### `payload` 句柄要先于 `await` 注册（引导式加载）

引导式加载时，客户端会来取源码。若 `harness.handle('payload')` 注册在 `await` 读文件
**之后**，客户端可能先到一步拿到 not-found，直接把客户端半边做死。句柄内部再去等读取
完成即可（写成 `async`）。

### 生成物的括号平衡 *不等于* 结构正确

`node --check` 只保证语法合法。曾经把主体整段包进了垫片函数里，于是那 1100 行成了
**死代码**，而括号完全平衡、语法检查通过。定位方法是**抛错探针**：
在关键位置插入 `throw`，看它到底执行到哪一行。

### 同一资产对会出现两条边（已知缺陷，未修）

`addEdgeRaw` 的去重键是 `(from, to, relation)`，而 `analyzePool` 对 URL→域名固定生成
`belongs_to`。所以用 `hosts_on` 显式建边时会与自动边**并存**，同一对资产出现两条边、
网状图上重叠画线。实测 5 对受影响。

## 验证清单

改完这个插件，跑这几步：

```bash
npm run check          # lib/ 与 src/ 是否漂移
npm test               # 客户端渲染冒烟测试
node --check lib/host.js
# 客户端是 CJS 工厂形态，node --check 默认按 ESM 解析会误报；用：
cp lib/client.js /tmp/c.js && echo '{"type":"commonjs"}' > /tmp/package.json && node --check /tmp/c.js
```

装到 profile 后还需真机验四件事：三个工具注册、面板出现、**面板 RPC 通路可用**
（`fetch` → `/dsh-redteam-asset-graph/rpc`，唯一只能真机验的环节）、重启不丢。

## 相关文件

| 文件 | 说明 |
|---|---|
| `src/host.js` `src/client.js` | 权威源码 |
| `lib/` | 由 `src/` 生成的常驻插件包，见 `lib/README.md` |
| `tools/build-lib.mjs` | 生成器（`npm run build:lib` / `--check`） |
| `tools/prepare-gh-packages.mjs` | 生成 GitHub Packages 发布副本 |
| `test/render-smoke.mjs` | 客户端渲染冒烟测试 |
| `cordis.patch.yml` | bundle patch，`dsh plugin add` 靠它自动挂载 |
