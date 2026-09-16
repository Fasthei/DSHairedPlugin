// 红队记忆 · Host 半边主体（骨架，待实现）
//
// 本文件是 applyHost 的【函数体】——函数头、harness 垫片、收尾与导出都由
// lib/parts/host.head.js 与 host.tail.js 提供，所以这里不要写 import、function 头或 return 块。
// lib/host.js 由 `npm run build:lib` 生成，不要手改 lib/。
//
// 静态形态与动态半边的差异（详见 ../../docs/DEVELOPMENT.md）：
//   - 工具用 ctx.tools.register(defineTool({...}))，不是 harness.defineTool/registerTool
//   - 客户端 RPC 走宿主路由（基址 /dsh-redteam-memory），客户端用 fetch 调
  const tools = []

  // TODO: 在此注册本插件的模型工具。示例（去掉注释即可用）：
  //
  // const t = defineTool({
  //   name: 'memory_example',
  //   description: '一句话说明这个工具做什么、什么时候该用',
  //   parameters: {
  //     type: 'object',
  //     properties: { value: { type: 'string', description: '参数说明' } },
  //     required: ['value'],
  //   },
  //   output: {
  //     schema: { type: 'json' },
  //     render: function (args, value) {
  //       return [{ type: 'text', text: '结果：' + JSON.stringify(value) }]
  //     },
  //   },
  //   execute: async function (args) {
  //     return { ok: true, echo: String(args.value) }
  //   },
  // })
  // tools.push(t)

  for (const t of tools) ctx.tools.register(t)

  // TODO: 面板用的 JSON-RPC 路由已由 host.tail.js 注册（handlers 表在本函数作用域内），
  //       在这里用 harness.handle('method', fn) 补句柄即可，客户端用 host.call 调。

  console.log('[rtasset] redteam-memory host half ready; tools =', tools.length)
