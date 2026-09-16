# lib/：常驻插件包的两半边

`src/host.js` 与 `src/client.js` 是**会话内动态 Cordis 插件**的源码；`lib/` 是把它打包成
**常驻插件包**（可在宿主组合 / agent preset 里挂载、DSH 重启不丢）后的产物。

| 文件 | 来源 | 说明 |
|---|---|---|
| `lib/host.js` | `src/host.js` 机械改造 | 主体逻辑**一行未改**，只补了一层 `harness` 垫片与 HTTP RPC 路由 |
| `lib/client.js` | 待补 | 客户端半边尚未改造（动态版靠 `host.call`，常驻版要另做通道） |

## Host 半边的改造方式

动态半边的三个符号在静态包里不存在，所以 `lib/host.js` 提供一个薄垫片把它们接上：

| 动态 API | 静态实现 |
|---|---|
| `harness.defineTool(def)` | `@deepseek-ai/dsh-tools` 的 `defineTool` |
| `harness.registerTool(ctx, tool)` | `ctx.tools.register(tool)` |
| `harness.handle(method, fn)` | 收进 `handlers` 表，经宿主 HTTP 路由 `POST /rtasset/rpc` 暴露给客户端 |

选择「垫片」而不是机械改写 1600 行主体逻辑，理由是：改写引入的回归极难排查，而垫片把
「动态 ↔ 静态」的全部差异收敛在一处。核对时只需 diff `src/host.js` 与 `lib/host.js`，
差异应当**只出现在文件头尾与这一层垫片**。

## 依赖解析

`lib/host.js` 里 `import { defineTool } from '@deepseek-ai/dsh-tools'`，而本仓库不在
profile 的 node_modules 解析链上。仓库内的 `node_modules/@deepseek-ai` 是指向
`~/.dsh/profiles/node_modules/@deepseek-ai` 的**符号链接**，专为解析这一依赖。
`node_modules/` 已在 `.gitignore` 中，克隆后需重建该链接（见 README「常驻插件包」一节）。

## 重新生成

```bash
npm run build:lib     # 由 src/host.js 重新生成 lib/host.js
```
