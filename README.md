# DSH 红队插件集

在 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) 里做红队测试时用得上的插件集合。
每个插件都是一个**独立可安装的 DSH 插件包**，可以只装你要的那几个。

| 插件 | 包名 | 用途 | 状态 |
|---|---|---|---|
| [资产图谱](packages/asset-graph/) | `dsh-redteam-asset-graph` | 目标资产自动收集、关联、可视化，模型参与研判 | ✅ 已发布 |
| [攻击矩阵](packages/attack-matrix/) | `dsh-redteam-attack-matrix` | 扫工作区对话映射到 ATLAS / ATT&CK / OWASP LLM / NVIDIA AI Kill Chain，标出已覆盖与缺口 | 🧪 已实现，待发布 |
| [记忆](packages/memory/) | 待定 | 跨会话保留目标上下文，避免重复侦察 | 🚧 骨架 |
| [报告](packages/report/) | 待定 | 把图谱与研判结论汇成可交付报告 | 🚧 骨架 |

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
    ├── asset-graph/             资产图谱（已发布）
    │   ├── src/                 权威源码（动态插件形态）
    │   ├── lib/                 由 src/ 生成的常驻插件包
    │   ├── tools/build-lib.mjs  生成器
    │   ├── cordis.patch.yml     bundle patch
    │   ├── README.md            使用者文档
    │   └── DEVELOPMENT.md       该插件的开发笔记
    ├── attack-matrix/
    ├── memory/
    └── report/
```

**`src/` 是权威源码，`lib/` 由它生成**。两者主体逻辑逐字相同，差异只在垫片——
核对时 diff 两者，差异应当只出现在头尾。

## 常用命令

```bash
npm run build            # 生成所有插件的 lib/
npm run check            # 校验 lib/ 与 src/ 是否漂移（CI 用）
npm test                 # 跑各插件的测试
```

## 开发

改插件前先读 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)：里面记着 DSH 插件开发的
几条硬约束与实测踩过的坑（哪些 API 在静态形态下不存在、组合 patch 的语义、沙箱与依赖解析等），
每一条都是真金白银换来的。

每个包另有自己的 `DEVELOPMENT.md`（若存在），记该插件特有的设计决定。

## 许可

[MIT](LICENSE) © 2026 fasthei
