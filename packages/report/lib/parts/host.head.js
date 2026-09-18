// 常驻（静态）Host 半边。
//
// 正式入口调用 workspace-install：旧 src/host.js 作为源码数据交给工作区运行器，
// 每个工作区独立实例化，避免共享全局报告库。这里提供工具与 HTTP 的薄垫片：
//
//   defineTool / registerTool -> @deepseek-ai/dsh-tools 的 defineTool + ctx.tools.register
//   handle                    -> 收进 handlers 表，供宿主 HTTP 路由转发（见 rpcRoute）
//
// 这样做的理由：机械改写上千行主体逻辑的风险远高于加一层适配，
// 而且适配层把「动态 ↔ 静态」的差异集中在一个地方，便于日后核对。
//
// ── defineTool 的入参形态差异（实测踩坑，务必保留转换）────────────────────────
// 动态半边的 harness.defineTool 由 dsh-cordis-host-runner 的 guard 提供，它按
// 「JSON Schema」接受 parameters（{ type:'object', properties, required }）。
// 静态包的 defineTool 来自 @deepseek-ai/dsh-tools，它要的是 ParameterSchemaSpec：
// 一个**扁平的属性表**，必填写成每个属性上的 required: true，且根对象没有 type 字段。
// 直接把 JSON Schema 喂给静态 defineTool 会抛
//   JsonSchemaError: unsupported JSON schema: parameters.type must be a value schema object
// —— 工具会在 apply 时全部注册失败。
// 所以这里做一次转换，src/ 保持动态形态不变。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { rptInstallWorkspaceReports } from '../src/workspace-install.js'

// JSON Schema 属性节点 -> ParameterSchemaSpec 属性节点。只带上工具真的用到的键，
// 不搬运 pattern / format 之类静态编译器不接受的约束。
function toPropertySpec(node) {
  if (!node || typeof node !== 'object') return { type: 'string' }
  const annotations = {}
  if (typeof node.description === 'string') annotations.description = node.description
  if (node.default !== undefined) annotations.default = node.default
  if (Array.isArray(node.examples)) annotations.examples = node.examples
  const t = node.type
  if (t === 'array') {
    const spec = { type: 'array', items: toPropertySpec(node.items), ...annotations }
    if (typeof node.minItems === 'number') spec.minItems = node.minItems
    if (typeof node.maxItems === 'number') spec.maxItems = node.maxItems
    return spec
  }
  if (t === 'object') {
    return { type: 'object', additionalProperties: node.additionalProperties === false ? false : true, properties: toPropertyMap(node.properties), ...annotations }
  }
  const spec = { type: t || 'string', ...annotations }
  if (Array.isArray(node.enum)) spec.enum = node.enum.slice()
  if (node.const !== undefined) spec.const = node.const
  return spec
}

function toPropertyMap(props) {
  const out = {}
  if (props && typeof props === 'object') for (const key of Object.keys(props)) out[key] = toPropertySpec(props[key])
  return out
}

// 接受动态形态的 parameters；已是扁平属性表时原样返回（幂等，便于两种写法共存）。
function toParameterSpec(parameters, required) {
  if (!parameters || typeof parameters !== 'object') return { type: 'object', properties: {}, additionalProperties: false }
  let props = parameters.properties
  if (props === undefined && parameters.type !== 'object') props = parameters
  const map = toPropertyMap(props)
  const req = Array.isArray(required) ? required : (Array.isArray(parameters.required) ? parameters.required : [])
  for (const name of req) if (map[name] && typeof map[name] === 'object') map[name].required = true
  return map
}

// 工具定义里除了 parameters 之外都与静态 defineTool 兼容，只替换这一个字段。
function toStaticToolDefinition(definition) {
  const rest = {}
  for (const key of Object.keys(definition)) if (key !== 'parameters') rest[key] = definition[key]
  rest.parameters = toParameterSpec(definition.parameters, definition.required)
  return rest
}

async function applyHost(ctx) {
  const handlers = Object.create(null)
  const harness = {
    defineTool(definition) { return defineTool(toStaticToolDefinition(definition)) },
    registerTool(c, tool) { return c.tools.register(tool) },
    handle(method, handler) { handlers[method] = handler; return () => { delete handlers[method] } },
  }

