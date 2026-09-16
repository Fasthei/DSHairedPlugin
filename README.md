# DSH 红队插件集

在 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) 里做红队测试时用得上的插件集合。
每个插件都是一个**独立可安装的 DSH 插件包**，可以只装你要的那几个。

| 插件 | 包名 | 仓库版本 | 用途 | 状态 |
|---|---|---|---|---|
| [资产图谱](packages/asset-graph/) | `dsh-redteam-asset-graph` | `7.9.7` | 目标资产自动收集、关联、可视化，模型参与研判 | ✅ 已发布 |
| [攻击矩阵](packages/attack-matrix/) | `dsh-redteam-attack-matrix` | `1.1.0` | 扫工作区对话映射到 ATLAS / ATT&CK / OWASP LLM / NVIDIA AI Kill Chain，标出已覆盖与缺口 | ✅ 已发布 |
| [记忆](packages/memory/) | `dsh-redteam-memory` | `0.1.0` | 跨会话保留目标上下文，避免重复侦察 | 🚧 开发中 |
| [报告](packages/report/) | `dsh-redteam-report` | `0.1.0` | 把图谱与研判结论汇成可交付报告 | 🚧 开发中 |

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
    ├── attack-matrix/           攻击矩阵（已发布 1.1.0）—— 结构与上同
    ├── memory/                  跨会话记忆（骨架）
    └── report/                  交付报告（骨架）
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
for p in asset-graph attack-matrix; do
  mkdir -p "packages/$p/node_modules/@deepseek-ai"
  ln -sfn "$DSH_NM/dsh-tools" "packages/$p/node_modules/@deepseek-ai/dsh-tools"
done
npm test        # 现在能看到真实项数：资产图谱 15 + 攻击矩阵 host 84 / client 85
```

`node_modules/` 在 `.gitignore` 里，软链不会进仓库。

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
