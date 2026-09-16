# 仓库级开发约定

适用于 `packages/` 下的所有插件。每个插件自己的设计决定记在它自己的
`DEVELOPMENT.md` 里（如 [asset-graph](../packages/asset-graph/DEVELOPMENT.md)）。

**这里每一条都是实测踩出来的，不是推断。** 代价很高（有些只能在真机上复现），所以留档。

---

## 1. 两种形态：动态 vs 常驻

DSH 插件可以有两种活法，同一个插件通常两样都要：

| | 动态插件 | 常驻插件包 |
|---|---|---|
| 加载方式 | 会话内 `cordis_define` 提交源码 | 宿主组合里挂一行，随进程启动 |
| 生命周期 | 进程内，DSH 重启即消失 | **重启不丢** |
| 分发 | 无法分发（只存在于会话记录里） | npm 安装，`dsh plugin add` |
| API | `harness.*` | 标准 Cordis 插件 API |

**结论**：想做「装了就能用、能给别人」的插件，必须落成**常驻插件包**；动态形态只用于开发期快速迭代。

## 2. 静态形态下不存在的那些 API（最常踩）

动态半边有若干便利符号，**静态包里全都不存在**，必须各自找替代：

| 动态半边有 | 静态形态下 | 替代做法 |
|---|---|---|
| `harness.defineTool` / `harness.registerTool` | ❌ | 从 `@deepseek-ai/dsh-tools` 导入 `defineTool`，用 `ctx.tools.register(tool)` |
| `harness.handle` / 客户端 `host.call` | ❌ | 宿主用 `ctx.webServer.register` 开 HTTP 路由，客户端用 `fetch` 调 |
| `styles`（闭包参数） | ❌ | 客户端自行插入 `<style>` 元素 |
| `React`（闭包参数） | ❌ | 客户端 bundle 里 `require('react')` |
| 函数体里可用的 `ctx` | ❌ | 静态模块里 `ctx` 只在 `apply(ctx)` 参数中存在 |

> 客户端 bundle 是 CJS 懒执行模型：执行时只**注册**工厂
> （`window.__ModuleLoader__.load({id, factory})`），一切副作用留在闭包内，首次
> `require` 时物化。所以入口文件必须写成这个形态。

## 3. 组合 patch 的语义（`cordis.patch.yml`）

patch 条目是 `@deepseek-ai/cordis-plugin-include` 的 **`PatchOptions`**，不是「直接放一行」：

- **带 `id`** 的条目 = 改**某一行**的配置；裸行会被 `patch: id is required` 跳过并告警
- **`insert` 且不带 `id`** = 往根列表**追加新行** ← 新增插件用这个

组合顺序（官方 `dsh` README）：

```
空根 → dsh.profile.bundles 各 bundle 的 patch → profile 的 cordis.patch.yml
     → $DSH_HOME/cordis.patch.yml → --patch 覆盖层
```

## 4. 让用户「装了就能用」：`dsh.bundle.patch`

插件包在 `package.json` 里声明：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

`dsh plugin add <包>` 把包装进 profile 的 `node_modules` 后，`reconcilePlugins`
发现该声明就**自动**把包名并入 `dsh.profile.bundles`——用户不需要改任何配置。

## 5. 路径与沙箱

- **相对路径的解析基址是 `DSH_HOME`（`~/.dsh`），不是 profile 目录**。
  要引用仓库路径就用**绝对路径**，否则会被解析成 `~/.dsh/...` 的错路径。
- **web profile 里 `hmr` 是 `disabled: true`**，所以 `patchReload: live` 实际不生效。
  **改完宿主组合必须重启 `dsh web`**。
- 会话沙箱只认工作区内的**绝对路径**；相对路径与 `/tmp` 通常读不到也写不进。

## 6. 本仓库的两条生成约定

**`src/` 是权威源码，`lib/` 由它生成**，不要手改 `lib/`：

```bash
npm run build              # 生成所有插件的 lib/
npm run check              # 校验有没有漂移（prepack 会跑，漂移则拒绝发布）
```

生成器把「动态半边 → 静态形态」的差异**全部收敛在垫片里**，主体逻辑逐字不动。
好处是核对时 diff `src/` 与 `lib/`，差异应当**只出现在文件头尾**；一旦主体出现差异，
说明有人手改了生成物。

**同一个插件在两个 registry 上是两个名字**，这不是笔误：

| registry | 命名要求 |
|---|---|
| npm | 作用域只能用自己的 npm 用户名；未作用域名谁都可以占 |
| GitHub Packages | **作用域必须等于仓库属主**（`Fasthei` → `@fasthei/…`） |

两边规则不兼容，所以只能各用一名。见 `packages/asset-graph` 的
`tools/prepare-gh-packages.mjs`——它从唯一的 `package.json` 生成 GitHub Packages 副本，
只替换 `name` 与 `publishConfig`，避免手抄两份清单漂移。

## 7. 新增一个插件的最小步骤

1. 复制一个已有包（如 `packages/asset-graph`）作为起点——**别从空目录开始**，
   容易漏掉 realm/依赖解析之类的隐式约定
2. 改 `package.json` 的 `name` / `description` / `keywords`
3. 改 `cordis.patch.yml` 里的 `id` 与 `name`
4. `npm run build` 生成 `lib/`，`npm run check` 确认一致
5. 在 profile 里装一次验证：`dsh plugin --profile web add <包名>`，重启后看工具与面板

## 8. 跑测试：绿的不一定是跑了

**主机侧测试要解析 `@deepseek-ai/dsh-tools`。解析不到时它打印一句「跳过」然后 `exit 0`。**

于是 `npm test` 会全绿，而主机侧一条断言都没执行 —— 本轮就真实踩到过：攻击矩阵的
`scan-flow.mjs` 与资产图谱的主机侧测试都长期处于这种状态，看起来和周密通过没有区别。
所以**先确认项数**，再相信绿色：

```bash
DSH_NM="$(readlink -f "$(command -v dsh)" | sed 's#/node_modules/.*#/node_modules/@deepseek-ai#')"
for p in asset-graph attack-matrix; do
  mkdir -p "packages/$p/node_modules/@deepseek-ai"
  ln -sfn "$DSH_NM/dsh-tools" "packages/$p/node_modules/@deepseek-ai/dsh-tools"
done
npm test        # 资产图谱 15 + 攻击矩阵 host 84 / client 85
```

`node_modules/` 在 `.gitignore` 里，软链不进仓库。客户端侧的冒烟测试不需要这个依赖，
所以它一直是真跑的 —— 这也是为什么「有测试」不等于「有覆盖」。
