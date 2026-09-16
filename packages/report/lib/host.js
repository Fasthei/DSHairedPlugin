// 常驻（静态）Host 半边。
//
// 主体逻辑与 src/host.js 完全一致（未改一行），差异只在于动态半边的三个符号
// （harness.defineTool / harness.registerTool / harness.handle）在静态包里不存在，
// 因此这里提供一个薄垫片 harness：
//
//   defineTool / registerTool -> @deepseek-ai/dsh-tools 的 defineTool + ctx.tools.register
//   handle                    -> 收进 handlers 表，供宿主 HTTP 路由转发（见 rpcRoute）
//
// 这样做的理由：机械改写 1600 行主体逻辑的风险远高于加一层适配，
// 而且适配层把「动态 ↔ 静态」的差异集中在一个地方，便于日后核对。
import { defineTool } from '@deepseek-ai/dsh-tools'

function applyHost(ctx) {
  const handlers = Object.create(null)
  const harness = {
    defineTool,
    registerTool(c, tool) { return c.tools.register(tool) },
    handle(method, handler) { handlers[method] = handler; return () => { delete handlers[method] } },
  }

// 红队报告 · Host 半边主体（骨架，待实现）
//
// 本文件是 applyHost 的【函数体】——函数头、harness 垫片、收尾与导出都由
// lib/parts/host.head.js 与 host.tail.js 提供，所以这里不要写 import、function 头或 return 块。
// lib/host.js 由 `npm run build:lib` 生成，不要手改 lib/。
//
// 静态形态与动态半边的差异（详见 ../../docs/DEVELOPMENT.md）：
//   - 工具用 ctx.tools.register(defineTool({...}))，不是 harness.defineTool/registerTool
//   - 客户端 RPC 走宿主路由（基址 /dsh-redteam-report），客户端用 fetch 调
  const tools = []

  // TODO: 在此注册本插件的模型工具。示例（去掉注释即可用）：
  //
  // const t = defineTool({
  //   name: 'report_example',
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

  console.log('[rtasset] redteam-report host half ready; tools =', tools.length)

  // 插件自己的 JSON-RPC 端点。
  // 客户端 bundle 用 fetch 调它（静态模块可用 fetch；动态半边才被屏蔽）。
  // 全部挂在 /dsh-redteam-report 命名空间下，避免与其它插件的路由相撞。
  const RPC_PATH = '/dsh-redteam-report/rpc'

  // 把 20 个动态 RPC 句柄经宿主 HTTP 路由暴露给客户端半边。
  // 客户端是普通模块，可以直接 fetch（动态半边才有 fetch 屏蔽）。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: RPC_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
      let body = ''
      try { for await (const chunk of req) body += chunk } catch (e) {}
      let payload = null
      try { payload = JSON.parse(body || '{}') } catch (e) {}
      const method = payload && typeof payload.method === 'string' ? payload.method : ''
      const fn = handlers[method]
      res.setHeader('content-type', 'application/json; charset=utf-8')
      if (!fn) { res.statusCode = 404; res.end(JSON.stringify({ error: 'unknown method: ' + method })); return }
      try {
        const result = await fn(payload.args === undefined ? null : payload.args)
        res.statusCode = 200
        res.end(JSON.stringify({ ok: true, result: result === undefined ? null : result }))
      } catch (e) {
        res.statusCode = 500
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
      }
    },
  }), 'rtasset: host rpc route')
}

export const name = 'redteam-report'
// 三个工具注册进宿主 tools 注册表；这里声明本半边硬依赖的服务。
export const inject = ['fs', 'shell', 'timer', 'webServer']
export { applyHost as apply }
