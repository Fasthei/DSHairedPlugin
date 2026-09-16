# 红队报告 · DSH 插件

把资产图谱与研判结论汇成可交付的报告（Markdown / 其他格式）。

> **状态：骨架（未实现）**。目录、构建、发布链路都已就绪，`src/` 里是待实现的骨架；
> 装上去能看到一个占位面板，但还没有实际能力。

## 安装

```bash
dsh plugin --profile web add dsh-redteam-report
# 重启 dsh web
```

包自带 `dsh.bundle.patch`，装完自动挂载，不需要手工编辑配置。

## 规划中的能力

- 按模板汇总资产、关系、研判结论与排除理由
- 导出为文件，便于交付与归档
- 与资产图谱联动：直接读取图谱数据

## 开发

本包的 `src/` 是权威源码，`lib/` 由它生成：

```bash
npm run build:lib     # 生成 lib/
npm run check:lib     # 校验与 src/ 是否漂移（prepack 会跑）
```

改之前请先读仓库的 [../../docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md)——
DSH 插件开发有几条硬约束（静态形态下哪些 API 不存在、组合 patch 的语义、
沙箱与依赖解析），那里记的每一条都是实测踩出来的。

骨架里已有的结构：

| 文件 | 说明 |
|---|---|
| `src/host.js` | `applyHost` 的**函数体**（函数头/垫片/收尾在 `lib/parts/`，不要重复写） |
| `src/client.js` | 客户端半边，以 `return { name, inject, apply }` 结尾 |
| `lib/parts/` | 生成器模板：垫片与包装都在这里 |
| `tools/build-lib.mjs` | 生成器 |
| `cordis.patch.yml` | bundle patch，`dsh plugin add` 靠它自动挂载 |

面板用的 JSON-RPC 路由已由 `lib/parts/host.tail.js` 注册（基址 `/dsh-redteam-report`），
在 `src/host.js` 里用 `harness.handle('method', fn)` 补句柄，客户端用 `host.call` 调。
