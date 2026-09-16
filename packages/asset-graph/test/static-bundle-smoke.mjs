// Client 半边【常驻包形态】渲染冒烟测试
//
// 为什么需要它：render-smoke.mjs 只测 src/client.js（动态半边，用
// new Function('React','host','styles','ctx', src) 直接求值）。而发布出去的是
// lib/client.js —— 一个交给 client-modules 的 CJS 工厂：
//
//   window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports } })
//
// 两者形态完全不同，动态形态跑通**不能**推出静态 bundle 跑通。真实案例：
// lib/host.js 曾因为函数外壳被重复声明而导出「零工具残壳」，语法与单测都看不出来。
// 这里就补上静态形态的那一环：假 window、假 require、真 factory、真渲染。
//
// 用法: node test/static-bundle-smoke.mjs

import fs from 'node:fs'
import path from 'node:path'

const libClient = path.join(import.meta.dirname, '..', 'lib', 'client.js')

let pass = 0
const fails = []
function ok(cond, label) {
  if (cond) {
    pass++
    console.log('  ✓ ' + label)
  } else {
    fails.push(label)
    console.log('  ✗ ' + label)
  }
}

// ── 假 React：只需满足 createElement 与 hooks ────────────────────────────────
function createElement(type, props, ...children) {
  return { type, props: { ...(props || {}), children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children } }
}
const React = {
  createElement,
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
  Fragment: 'Fragment',
}

// ── 假 window.__ModuleLoader__：只注册工厂，物化发生在 require 时 ─────────────
let registration = null
globalThis.window = {
  __ModuleLoader__: {
    load: (def) => { registration = def },
  },
}

// ── 假 host / styles：静态 bundle 里这两者由垫片自建 ─────────────────────────
const snapshot = {
  projects: [{ id: 'p1', name: 'demo', path: '/tmp/demo' }],
  assets: [
    { id: 'a1', projectId: 'p1', type: 'url', value: 'https://docs.example.com/overview', sources: ['model'], tags: ['文档站'], confidence: 80, hits: 1, createdAt: 1, note: '概览页' },
    { id: 'a2', projectId: 'p1', type: 'domain', value: 'docs.example.com', sources: ['model'], tags: [], confidence: 85, hits: 1, createdAt: 2, note: '子域' },
  ],
  edges: [{ id: 'e1', from: 'a1', to: 'a2', relation: 'belongs_to', weight: 3, source: 'auto', evidence: 'docs.example.com', createdAt: 3 }],
  trash: [], log: [], settings: {}, meta: {},
}
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: snapshot }) })

// ── 加载 bundle：这一步只应「注册」，不应产生副作用 ──────────────────────────
console.log('加载 lib/client.js')
try {
  new Function('window', 'document', 'fetch', fs.readFileSync(libClient, 'utf8'))(globalThis.window, undefined, globalThis.fetch)
} catch (e) {
  console.log('  ✗ 求值失败: ' + e.constructor.name + ': ' + e.message)
  process.exit(1)
}
ok(registration !== null, 'window.__ModuleLoader__.load 被调用（bundle 已注册工厂）')
ok(registration && typeof registration.factory === 'function', '工厂是函数（懒物化模型）')
if (!registration) process.exit(1)

console.log('\n[1] 物化模块')
let mod
try {
  mod = registration.factory((name) => {
    if (name === 'react') return React
    throw new Error('未知依赖: ' + name)
  })
} catch (e) {
  ok(false, '工厂执行失败: ' + e.constructor.name + ': ' + e.message)
  process.exit(1)
}
ok(!!mod, '工厂返回 module.exports')
ok(typeof mod.apply === 'function', '导出 apply 是函数')
ok(Array.isArray(mod.inject) && mod.inject.indexOf('slots') >= 0 && mod.inject.indexOf('timer') >= 0, '导出 inject 含 slots/timer：' + JSON.stringify(mod.inject))

// ── 用假 ctx 真正跑一次 apply + 渲染 ────────────────────────────────────────
console.log('\n[2] apply 并渲染')
let Main = null
const slots = {
  inject: (name, cb) => { cb(); return () => {} },
  register: (def, Comp) => { if (def && def.name === 'main') Main = Comp; return () => {} },
}
const ctx = {
  slots,
  get: (n) => (n === 'slots' ? slots : undefined),
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  interval: () => () => {},
  timeout: () => () => {},
}
try {
  mod.apply(ctx)
} catch (e) {
  ok(false, 'apply 抛错: ' + e.constructor.name + ': ' + e.message)
}
ok(Main !== null, '注册了 main 面板')

if (Main) {
  try {
    const el = Main()
    ok(!!el && !!el.type, 'Main() 返回可渲染元素（type=' + (el && el.type) + '）')
  } catch (e) {
    ok(false, '渲染崩溃: ' + e.constructor.name + ': ' + e.message)
  }
}

console.log('\n' + (fails.length === 0 ? '✓ 静态 bundle 冒烟通过（' + pass + ' 项）' : '✗ 失败 ' + fails.length + ' 项：\n  - ' + fails.join('\n  - ')))
process.exit(fails.length === 0 ? 0 : 1)
