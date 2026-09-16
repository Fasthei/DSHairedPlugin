// 常驻（静态）客户端半边 —— 浏览器 bundle 形态（由 tools/build-lib.mjs 生成）。
//
// client-modules 是 CJS 懒执行模型：bundle 只【注册】工厂，副作用留在闭包内，
// 首次 require 时物化。因此这里用 window.__ModuleLoader__.load({id, factory}) 注册。
//
// 包装刻意保持极薄（只做作用域与导出），全部改造集中在主体自己的 applyClient 里，
// 见 lib/parts/client.shim.js。
window.__ModuleLoader__.load({
  id: 'dsh-redteam-memory',
  factory: (require) => {
    let React = require('react');
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

// 红队记忆 · Client 半边（骨架，待实现）
//
// lib/client.js 由 `npm run build:lib` 从本文件生成，不要手改 lib/。
// 生成器以函数名 `applyClient` 为入口锚点，并在其中注入 host.call / styles.insert 垫片
// ——静态 bundle 里没有这两个闭包符号，原因见 ../../docs/DEVELOPMENT.md。
//
// 注意：本文件必须以 `return { name, inject, apply }` 块【结尾】，生成器据此剥离动态包装。

function applyClient(ctx) {
  // ── 静态形态垫片（动态半边的闭包符号在静态包里不存在）──
  //
  // 1) host.call：转到宿主 HTTP 路由（见 lib/host.js 的 /dsh-redteam-memory/rpc）。
  //    选 HTTP 而非 ctx.remote：Remote 需 typert 代码生成（zod schema + 生成绑定），
  //    而本插件有 20 个无类型 JSON 句柄，为此引入整套生成链不划算；
  //    且 fetch 只被【动态】半边屏蔽，静态模块可直接用。
  // 2) styles.insert：动态 runner 把它作为闭包参数注入，静态 bundle 里没有，
  //    故自行插入 <style> 元素（浏览器全局可用），并登记到 fiber 便于卸载清理。
  const RPC_PATH = '/dsh-redteam-asset-graph/rpc'
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
            throw new Error('redteam-memory rpc ' + method + ' 失败：' + detail)
          }
          return payload.result
        })
      })
    },
  }

  const STYLE_ID = 'redteam-memory-styles'
  const styles = {
    insert(css) {
      if (typeof document === 'undefined') return function () {}
      let el = document.getElementById(STYLE_ID)
      if (!el) { el = document.createElement('style'); el.id = STYLE_ID; document.head.appendChild(el) }
      el.textContent += String(css) + '\n'
      const dispose = function () { if (el && el.parentNode) el.parentNode.removeChild(el) }
      try { ctx.effect(function () { return dispose }, 'redteam-memory: styles') } catch (e) { return dispose }
      return dispose
    },
  }

  const slots = ctx.slots

  function Panel() {
    const [snapshot, setSnapshot] = React.useState(null)
    const [error, setError] = React.useState(null)

    React.useEffect(function () {
      host.call('snapshot').then(setSnapshot).catch(function (e) {
        setError(String((e && e.message) || e))
      })
    }, [])

    return React.createElement('div', { className: 'rtm-root' },
      React.createElement('div', { className: 'rtm-title' }, '红队记忆'),
      error ? React.createElement('div', { className: 'rtm-err' }, error) : null,
      snapshot
        ? React.createElement('pre', { className: 'rtm-pre' }, JSON.stringify(snapshot, null, 2))
        : React.createElement('div', { className: 'rtm-dim' }, '加载中…'))
  }

  // 侧边栏图标（占位图形，后续可换成本插件自己的）
  function Glyph(props) {
    const size = props && props.size ? props.size : 16
    const active = props && props.active
    const c = active ? 'var(--dsw-alias-brand-primary, #4c8dff)' : 'currentColor'
    return React.createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' },
      React.createElement('circle', { cx: 12, cy: 12, r: 3.1, stroke: c, strokeWidth: 1.6 }),
      React.createElement('path', { d: 'M12 5.5v3M12 15.5v3M6.2 14.2l3.6-2.1M14.2 11.9l3.6-2.1', stroke: c, strokeWidth: 1.5, strokeLinecap: 'round' }),
      React.createElement('circle', { cx: 12, cy: 3.4, r: 1.8, fill: c }),
      React.createElement('circle', { cx: 12, cy: 20.6, r: 1.8, fill: c }),
      React.createElement('circle', { cx: 4.4, cy: 15.4, r: 1.8, fill: c }),
      React.createElement('circle', { cx: 19.6, cy: 15.4, r: 1.8, fill: c })
    )
  }

  ctx.effect(function () {
    return styles.insert([
      '.rtm-root{padding:12px;font-size:13px;display:flex;flex-direction:column;gap:8px}',
      '.rtm-title{font-weight:600;font-size:14px}',
      '.rtm-dim{opacity:.66}',
      '.rtm-err{color:var(--dsw-alias-state-error-primary,#e05252);white-space:pre-wrap}',
      '.rtm-pre{white-space:pre-wrap;word-break:break-all;font-size:11px;max-height:60vh;overflow:auto}',
    ].join('\n'))
  }, 'redteam-memory: styles')

  ctx.effect(function () {
    return slots.inject('sidebar.panellist', function () {
      return slots.register({ name: 'sidebar.panellist', id: 'redteam-memory', order: 60, label: '红队记忆' }, Glyph)
    })
  }, 'redteam-memory: panel button')

  ctx.effect(function () {
    return slots.inject('main', function () {
      return slots.register({ name: 'main', key: 'redteam-memory' }, Panel)
    })
  }, 'redteam-memory: main panel')

  console.log('[rtasset] redteam-memory client half ready')
}
    exports.inject = ['slots', 'timer']
    exports.apply = function (ctx) { return applyClient(ctx) }
    return module.exports
  }
});
