
  // 插件自己的 JSON-RPC 端点。
  // 客户端 bundle 用 fetch 调它（静态模块可用 fetch；动态半边才被屏蔽）。
  // 全部挂在 __ROUTE_BASE__ 命名空间下，避免与其它插件的路由相撞。
  const RPC_PATH = '__ROUTE_BASE__/rpc'

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

export const name = '__PLUGIN_NAME__'
// 三个工具注册进宿主 tools 注册表；这里声明本半边硬依赖的服务。
export const inject = ['fs', 'shell', 'timer', 'tools', 'workspaceRegistry', 'webServer']
export { applyHost as apply }
