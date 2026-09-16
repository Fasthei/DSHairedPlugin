// 攻击矩阵 · Client 半边（骨架，待实现）
//
// lib/client.js 由 `npm run build:lib` 从本文件生成，不要手改 lib/。
// 生成器以函数名 `applyClient` 为入口锚点，并在其中注入 host.call / styles.insert 垫片
// ——静态 bundle 里没有这两个闭包符号，原因见 ../../docs/DEVELOPMENT.md。
//
// 注意：本文件必须以 `return { name, inject, apply }` 块【结尾】，生成器据此剥离动态包装。

function applyClient(ctx) {
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
      React.createElement('div', { className: 'rtm-title' }, '攻击矩阵'),
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
  }, 'redteam-attack-matrix: styles')

  ctx.effect(function () {
    return slots.inject('sidebar.panellist', function () {
      return slots.register({ name: 'sidebar.panellist', id: 'redteam-attack-matrix', order: 60, label: '攻击矩阵' }, Glyph)
    })
  }, 'redteam-attack-matrix: panel button')

  ctx.effect(function () {
    return slots.inject('main', function () {
      return slots.register({ name: 'main', key: 'redteam-attack-matrix' }, Panel)
    })
  }, 'redteam-attack-matrix: main panel')

  console.log('[rtasset] redteam-attack-matrix client half ready')
}

return {
  name: 'redteam-attack-matrix',
  inject: ['slots', 'timer'],
  apply: applyClient
}
