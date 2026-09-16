
  // 把 20 个动态 RPC 句柄经宿主 HTTP 路由暴露给客户端半边。
  // 客户端是普通模块，可以直接 fetch（动态半边才有 fetch 屏蔽）。
  ctx.effect(() => ctx.webServer.register({
    method: 'POST',
    path: '/rtasset/rpc',
    handler: async (req, res) => {
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

export const name = 'redteam-asset-graph'
// 三个工具注册进宿主 tools 注册表；这里声明本半边硬依赖的服务。
export const inject = ['fs', 'shell', 'timer', 'webServer']
export { applyHost as apply }
