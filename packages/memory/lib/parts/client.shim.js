function applyClient(ctx) {
  // ── 静态形态垫片（动态半边的闭包符号在静态包里不存在）──
  //
  // 1) host.call：转到宿主 HTTP 路由（见 lib/host.js 的 __ROUTE_BASE__/rpc）。
  //    选 HTTP 而非 ctx.remote：Remote 需 typert 代码生成（zod schema + 生成绑定），
  //    而本插件有 20 个无类型 JSON 句柄，为此引入整套生成链不划算；
  //    且 fetch 只被【动态】半边屏蔽，静态模块可直接用。
  // 2) styles.insert：动态 runner 把它作为闭包参数注入，静态 bundle 里没有，
  //    故自行插入 <style> 元素（浏览器全局可用），并登记到 fiber 便于卸载清理。
  // 路径必须由生成器按包名填充（__ROUTE_BASE__）。这里曾经写死成
  // `/dsh-redteam-asset-graph/rpc` —— 那是从资产图谱早期版本复制骨架时带过来的缺陷：
  // 本插件的面板会去打资产图谱的路由，请求全 404，两者同时安装还会读到对方的数据
  // （资产图谱 README 记的那次事故是同一个根因）。测试里钉住了实际请求的 url。
  const RPC_PATH = '__ROUTE_BASE__/rpc'
  const host = {
    call(method, args) {
      return fetch(RPC_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: method, args: args === undefined ? null : args }),
      }).then(function (res) {
        return res.json().catch(function () { return null }).then(function (payload) {
          if (!res.ok || !payload || payload.ok !== true) {
            const detail = (payload && payload.error) || ('HTTP ' + res.status)
            throw new Error('__PLUGIN_NAME__ rpc ' + method + ' 失败：' + detail)
          }
          return payload.result
        })
      })
    },
  }

  const STYLE_ID = '__PLUGIN_NAME__-styles'
  const styles = {
    insert(css) {
      if (typeof document === 'undefined') return function () {}
      let el = document.getElementById(STYLE_ID)
      if (!el) { el = document.createElement('style'); el.id = STYLE_ID; document.head.appendChild(el) }
      el.textContent += String(css) + '\n'
      const dispose = function () { if (el && el.parentNode) el.parentNode.removeChild(el) }
      try { ctx.effect(function () { return dispose }, '__PLUGIN_NAME__: styles') } catch (e) { return dispose }
      return dispose
    },
  }

