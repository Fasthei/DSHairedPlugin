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

