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
//
// ── defineTool 的入参形态差异（实测踩坑，务必保留转换）────────────────────────
// 动态半边的 harness.defineTool 由 dsh-cordis-host-runner 的 guard 提供，它按
// 「JSON Schema」接受 parameters（{ type:'object', properties, required }）。
// 静态包的 defineTool 来自 @deepseek-ai/dsh-tools，它要的是 ParameterSchemaSpec：
// 一个**扁平的属性表**，必填写成每个属性上的 required: true，且根对象没有 type 字段。
// 直接把 JSON Schema 喂给静态 defineTool 会抛
//   JsonSchemaError: unsupported JSON schema: parameters.type must be a value schema object
// —— 三个工具会在 apply 时全部注册失败。
// 所以这里做一次转换，src/ 保持动态形态不变。
import { defineTool } from '@deepseek-ai/dsh-tools'

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

function applyHost(ctx) {
  const handlers = Object.create(null)
  const harness = {
    defineTool(definition) { return defineTool(toStaticToolDefinition(definition)) },
    registerTool(c, tool) { return c.tools.register(tool) },
    handle(method, handler) { handlers[method] = handler; return () => { delete handlers[method] } },
  }

// 攻击矩阵 · Host 半边主体
//
// 本文件是 applyHost 的【函数体】——函数头、harness 垫片、收尾与导出都由
// lib/parts/host.head.js 与 host.tail.js 提供，所以这里不要写 import、function 头或 return 块。
// lib/host.js 由 `npm run build:lib` 生成，不要手改 lib/。
//
// ── 这个插件干什么 ────────────────────────────────────────────────────────────
// 扫【当前工作区】里所有会话的对话内容（用户消息、模型回复、工具调用与结果），
// 判断每次操作是否命中某个 AI 攻击框架的技术点：命中先记为「疑似」，由人确认后
// 计入「已覆盖」。数据按工作区落盘，切工作区就切数据集。
//
// 数据来源（都是宿主 Service，见 cordis Inspect）：
//   ctx.get('workspaceRegistry') -> list() / get(id) 拿工作区；w.sessionIds 已按 canonical cwd 过滤
//   ctx.get('sessions')          -> get(id) 拿会话；session.snapshotEvents() 拿事件
//
// 注意 sessions 是内存态（官方描述：持久化不在这个 store 里），所以只能扫进程内
// 活着的会话。矩阵自己的数据是落盘的，重启不丢已有记录，只是不能回溯扫描已经
// 不在内存里的会话。
//
// 静态形态与动态半边的差异（详见 ../../docs/DEVELOPMENT.md）：
//   - 工具用 defineTool({...}) 构造后 ctx.tools.register(t)，不要用 harness.defineTool
//   - 客户端 RPC 用 harness.handle('method', fn)，客户端侧 host.call 调

  // ══════════════════════════════════════════════════════════════════════════
  // 框架数据
  //
  // detect_keywords 是自动匹配用的特征词。命中只代表「疑似」，要人确认才算覆盖。
  // 这些词刻意选得具体：宁可漏报也不要刷屏——矩阵的价值在于缺口准，不在于命中多。
  // ══════════════════════════════════════════════════════════════════════════
// 攻击矩阵 · 框架数据
//
// 这是矩阵的判断依据：每个框架的 tactic（阶段）与技术点，以及每个技术点的
// detect_keywords —— 自动匹配用的特征词。
//
// ── 关于 detect_keywords 的纪律 ────────────────────────────────────────────────
// 命中这些词只代表「疑似」，要人点确认才算覆盖。所以这些词宁可窄、不可宽：
// 一个会命中每次工具调用的词（比如裸的 "tool call"）会把矩阵变成噪音墙，
// 而矩阵的价值恰恰在于「缺口准」。加词前先问：正常开发对话会不会命中它？
//
// 各框架数据的来源与版本写在每个框架的 source 里，改数据时一并更新。
//
// 本文件由 tools/build-lib.mjs 内联进 lib/host.js（占位符见 tools/build-lib.mjs 的 FRAMEWORK_MARKER），
// 所以产物是自包含的，运行期不需要额外读文件。

  const FRAMEWORKS = [
  // ══════════════════════════════════════════════════════════════════════════
  // MITRE ATLAS —— AI 系统本身的对抗战术。
  //
  // 来源：官方机读数据 mitre-atlas/atlas-data 的 dist/v6/ATLAS-2026.09.yaml
  // （version_note 里有完整出处与抓取方式）。技术点 ID 与名称逐个核对过，
  // 没有自拟项；子技术点名字用「父技术: 子技术」形式。
  //
  // 注意 ATLAS 在 v6 里重编号了 tactic（现为 AML.TA0000–AML.TA0015），
  // 网上大量旧文章还在用 TA00xx 的旧编号，不要照抄。
  //
  // 只收 45 项：刻意剔掉了在对话里不可能留下痕迹的技术点。
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: "atlas",
    name: "MITRE ATLAS",
    short: "ATLAS",
    source: "MITRE ATLAS v2026.09 (ATLAS data collection modified-date 2026-09-15, release commit 3259f38 dated 2026-09-10; that release contains 1 matrix, 16 tactics, 120 techniques, 88 sub-techniques, 40 mitigations and 73 case studies). Source: official machine-readable dataset mitre-atlas/atlas-data, dist/v6/ATLAS-2026.09.yaml - https://github.com/mitre-atlas/atlas-data/blob/main/dist/v6/ATLAS-2026.09.yaml (the file that dist/v6/ATLAS-latest.yaml points to). Fetched from this sandbox via the GitHub contents API because raw.githubusercontent.com was unreachable; atlas.mitre.org is a JavaScript single-page app that returned only its shell (no data payload), so the official GitHub data file was used as the authoritative source. Sub-technique names use the framework's Parent Technique: Sub-technique form.",
    tactics: [
      {
        "id": "AML.TA0002",
        "name": "Reconnaissance",
        "description": "The adversary gathers information about the AI system that can be used to plan future operations."
      },
      {
        "id": "AML.TA0003",
        "name": "Resource Development",
        "description": "The adversary establishes resources, capabilities, and infrastructure to support AI-targeted operations."
      },
      {
        "id": "AML.TA0004",
        "name": "Initial Access",
        "description": "The adversary gains an initial foothold into the AI system or the environment it is connected to."
      },
      {
        "id": "AML.TA0005",
        "name": "Execution",
        "description": "The adversary runs malicious instructions or code through AI artifacts, prompts, or agent tools."
      },
      {
        "id": "AML.TA0006",
        "name": "Persistence",
        "description": "The adversary maintains a foothold by manipulating AI models, data, prompts, memory, or agent configuration."
      },
      {
        "id": "AML.TA0007",
        "name": "Defense Evasion",
        "description": "The adversary avoids detection by AI guardrails, input filters, and AI-enabled security software."
      },
      {
        "id": "AML.TA0008",
        "name": "Discovery",
        "description": "The adversary explores the AI environment to learn about models, prompts, data, tools, and agent capabilities."
      },
      {
        "id": "AML.TA0009",
        "name": "Collection",
        "description": "The adversary gathers AI artifacts and sensitive data reachable through AI services and their tools."
      },
      {
        "id": "AML.TA0010",
        "name": "Exfiltration",
        "description": "The adversary steals AI artifacts, model internals, prompts, or data through AI channels."
      },
      {
        "id": "AML.TA0011",
        "name": "Impact",
        "description": "The adversary manipulates, degrades, or destroys AI systems, data, and confidence in their outputs."
      },
      {
        "id": "AML.TA0012",
        "name": "Privilege Escalation",
        "description": "The adversary gains higher-level permissions through AI systems, agents, or their host environments."
      },
      {
        "id": "AML.TA0013",
        "name": "Credential Access",
        "description": "The adversary steals credentials stored in, or reachable through, AI systems and agent tooling."
      },
      {
        "id": "AML.TA0014",
        "name": "Command and Control",
        "description": "The adversary communicates with compromised AI systems in order to control them."
      },
      {
        "id": "AML.TA0015",
        "name": "Lateral Movement",
        "description": "The adversary moves through the environment by abusing AI systems, agents, and their connected tools."
      },
      {
        "id": "AML.TA0000",
        "name": "AI Model Access",
        "description": "The adversary obtains some level of access to an AI model, from inference API access to full model weights."
      },
      {
        "id": "AML.TA0001",
        "name": "AI Attack Adaptation",
        "description": "The adversary adapts knowledge and capabilities into attack-ready payloads tailored to the target AI system."
      }
    ],
    techniques: [
      {
        "id": "AML.T0001",
        "name": "Search Open AI Vulnerability Analysis",
        "tactic_ids": [
          "AML.TA0002"
        ],
        "description": "Searching public research, papers, and vulnerability write-ups for known attacks against the target AI model or system.",
        "detect_keywords": [
          "vulnerability",
          "cve",
          "advisory",
          "arxiv",
          "论文",
          "已知漏洞",
          "漏洞分析",
          "公开研究"
        ],
        "detect_hints": "The transcript shows the tester researching published attacks, CVEs, or papers about the target model family before attacking it."
      },
      {
        "id": "AML.T0006",
        "name": "Active Scanning",
        "tactic_ids": [
          "AML.TA0002"
        ],
        "description": "Directly probing publicly reachable AI systems and endpoints to identify live, misconfigured, or vulnerable targets.",
        "detect_keywords": [
          "nmap",
          "port scan",
          "shodan",
          "censys",
          "端口扫描",
          "资产测绘"
        ],
        "detect_hints": "The tester runs network or port scanning, or queries internet-wide scan databases, to find reachable AI endpoints."
      },
      {
        "id": "AML.T0006.002",
        "name": "Active Scanning: Scan for Exposed AI Infrastructure",
        "tactic_ids": [
          "AML.TA0002"
        ],
        "description": "Scanning hosts and well-known ports to locate self-hosted AI runtimes, model-serving endpoints, and agent infrastructure.",
        "detect_keywords": [
          "ollama",
          "vllm",
          "推理服务端口",
          "暴露的推理服务",
          "text-generation-inference",
          "model server",
          "triton"
        ],
        "detect_hints": "The transcript shows probing of default AI service ports or API paths such as /v1/models, Ollama 11434, or vLLM endpoints."
      },
      {
        "id": "AML.T0014",
        "name": "Discover AI Model Family",
        "tactic_ids": [
          "AML.TA0008"
        ],
        "description": "Fingerprinting which model or model family a system uses, in order to tailor later attacks.",
        "detect_keywords": [
          "model fingerprint",
          "identify the model",
          "which model are you",
          "model family",
          "模型指纹",
          "识别模型",
          "你是什么模型"
        ],
        "detect_hints": "The tester probes responses or metadata to determine the underlying model or vendor."
      },
      {
        "id": "AML.T0015",
        "name": "Evade AI Model",
        "tactic_ids": [
          "AML.TA0004",
          "AML.TA0007",
          "AML.TA0011"
        ],
        "description": "Crafting inputs or deepfakes that cause an AI model to misclassify or fail, evading AI-based detection or authentication.",
        "detect_keywords": [
          "evade",
          "misclassif",
          "false negative",
          "fool the detector",
          "bypass the classifier",
          "绕过检测",
          "规避模型",
          "逃逸"
        ],
        "detect_hints": "The tester measures whether modified inputs slip past a classifier, filter, or biometric check, typically reporting a drop in detection rate."
      },
      {
        "id": "AML.T0016.000",
        "name": "Obtain Capabilities: Adversarial AI Attack Implementations",
        "tactic_ids": [
          "AML.TA0003"
        ],
        "description": "Obtaining or reusing open-source implementations of AI attacks such as adversarial-example or LLM testing frameworks.",
        "detect_keywords": [
          "garak",
          "pyrit",
          "adversarial robustness toolbox",
          "foolbox",
          "cleverhans",
          "promptfoo",
          "开源攻击实现",
          "攻击工具库"
        ],
        "detect_hints": "The transcript shows the tester installing or invoking a known adversarial-AI or LLM red-team library instead of hand-crafting the attack."
      },
      {
        "id": "AML.T0020",
        "name": "Training Data Poisoning",
        "tactic_ids": [
          "AML.TA0006"
        ],
        "description": "Manipulating training or fine-tuning data to bias, degrade, or backdoor the resulting model.",
        "detect_keywords": [
          "training data poisoning",
          "fine-tuning data",
          "poisoned dataset",
          "data poisoning",
          "label flipping",
          "训练数据投毒",
          "数据投毒",
          "微调数据污染"
        ],
        "detect_hints": "The tester injects or proposes poisoned samples into a training or fine-tuning corpus and measures the resulting behavior shift."
      },
      {
        "id": "AML.T0024.000",
        "name": "Exfiltration via AI Inference API: Infer Training Data Membership",
        "tactic_ids": [
          "AML.TA0010"
        ],
        "description": "Inferring whether specific samples were present in a model's training data, leaking privacy-sensitive membership information.",
        "detect_keywords": [
          "membership inference",
          "shadow model",
          "confidence score",
          "training set membership",
          "成员推断",
          "影子模型",
          "置信度分析"
        ],
        "detect_hints": "The tester measures confidence or loss differences to decide whether a specific record was part of the training data."
      },
      {
        "id": "AML.T0024.001",
        "name": "Exfiltration via AI Inference API: Invert AI Model",
        "tactic_ids": [
          "AML.TA0010"
        ],
        "description": "Reconstructing training data by strategically querying the confidence scores exposed by an inference API.",
        "detect_keywords": [
          "model inversion",
          "reconstruct training data",
          "confidence scores",
          "gradient leakage",
          "模型反演",
          "重建训练数据",
          "梯度泄露"
        ],
        "detect_hints": "The tester queries the API repeatedly in order to reconstruct features or samples from the training data."
      },
      {
        "id": "AML.T0024.002",
        "name": "Exfiltration via AI Inference API: Extract AI Model",
        "tactic_ids": [
          "AML.TA0010"
        ],
        "description": "Querying a model to build a dataset and train a functional clone that mimics the victim's model.",
        "detect_keywords": [
          "model extraction",
          "model stealing",
          "clone the model",
          "surrogate model",
          "模型窃取",
          "模型抽取",
          "蒸馏克隆",
          "代理模型"
        ],
        "detect_hints": "The tester harvests input and output pairs at scale with the stated goal of training a copy of the model."
      },
      {
        "id": "AML.T0029",
        "name": "Denial of AI Service",
        "tactic_ids": [
          "AML.TA0011"
        ],
        "description": "Flooding or overloading an AI service with requests or expensive inputs in order to degrade or shut it down.",
        "detect_keywords": [
          "denial of service",
          "dos",
          "overload",
          "resource exhaustion",
          "death by query",
          "拒绝服务",
          "算力耗尽",
          "服务不可用"
        ],
        "detect_hints": "The tester sends high volumes or computationally expensive prompts to exhaust the service."
      },
      {
        "id": "AML.T0034",
        "name": "Cost Harvesting",
        "tactic_ids": [
          "AML.TA0011"
        ],
        "description": "Driving up the victim's AI service costs through high-volume or high-complexity queries and agent activity.",
        "detect_keywords": [
          "token usage",
          "expensive queries",
          "budget exhaustion",
          "denial of wallet",
          "成本消耗",
          "代币消耗",
          "费用攻击",
          "钱包拒绝服务"
        ],
        "detect_hints": "The tester's goal is financial: maximizing tokens, tool calls, or agent iterations to inflate the victim's bill."
      },
      {
        "id": "AML.T0043.000",
        "name": "Craft Adversarial Data: White-Box Optimization",
        "tactic_ids": [
          "AML.TA0001"
        ],
        "description": "Optimizing adversarial inputs directly against a fully known target model for maximum effect.",
        "detect_keywords": [
          "white-box",
          "fgsm",
          "pgd",
          "gradient",
          "perturbation",
          "白盒攻击",
          "梯度攻击",
          "对抗扰动"
        ],
        "detect_hints": "The tester has model weights or gradients and optimizes a perturbation directly against them."
      },
      {
        "id": "AML.T0043.001",
        "name": "Craft Adversarial Data: Black-Box Optimization",
        "tactic_ids": [
          "AML.TA0001"
        ],
        "description": "Optimizing adversarial inputs through repeated queries to a model that is only reachable via an API.",
        "detect_keywords": [
          "black-box",
          "query-based",
          "hopskipjump",
          "boundary attack",
          "query budget",
          "黑盒攻击",
          "查询式攻击",
          "查询次数"
        ],
        "detect_hints": "The tester iteratively queries the API, tracking a query budget, to evolve an adversarial input."
      },
      {
        "id": "AML.T0043.004",
        "name": "Craft Adversarial Data: Insert Backdoor Trigger",
        "tactic_ids": [
          "AML.TA0001"
        ],
        "description": "Adding a specific trigger pattern to inputs that activates a backdoor previously implanted in a model.",
        "detect_keywords": [
          "backdoor",
          "trigger pattern",
          "trojan",
          "implanted trigger",
          "后门",
          "触发器",
          "木马模型",
          "投毒触发"
        ],
        "detect_hints": "The tester checks whether a rare trigger token or pattern flips the model to attacker-controlled output."
      },
      {
        "id": "AML.T0051",
        "name": "LLM Prompt Injection",
        "tactic_ids": [
          "AML.TA0005"
        ],
        "description": "Crafting malicious prompts that make an LLM disregard its original instructions and follow the adversary's instructions instead.",
        "detect_keywords": [
          "prompt injection",
          "ignore previous instructions",
          "ignore all previous",
          "override instructions",
          "system prompt override",
          "提示词注入",
          "忽略之前的指令",
          "越权指令"
        ],
        "detect_hints": "The transcript contains instructions telling the model to disregard prior instructions or to adopt an attacker-supplied role."
      },
      {
        "id": "AML.T0051.000",
        "name": "LLM Prompt Injection: Direct",
        "tactic_ids": [
          "AML.TA0005"
        ],
        "description": "Injecting malicious prompts directly as a user of the LLM in order to hijack or misuse the model.",
        "detect_keywords": [
          "direct prompt injection",
          "as the user",
          "user turn",
          "chat input",
          "直接注入",
          "直接提示词注入",
          "用户输入注入"
        ],
        "detect_hints": "The tester types the injection payload directly into the chat as the user's own message."
      },
      {
        "id": "AML.T0051.001",
        "name": "LLM Prompt Injection: Indirect",
        "tactic_ids": [
          "AML.TA0005"
        ],
        "description": "Injecting prompts indirectly through documents, emails, websites, or other data the LLM or agent ingests.",
        "detect_keywords": [
          "indirect prompt injection",
          "poisoned document",
          "malicious webpage",
          "retrieved content",
          "injected pdf",
          "间接提示词注入",
          "文档注入",
          "网页注入"
        ],
        "detect_hints": "The payload arrives inside retrieved or fetched content rather than from the user, and the model then acts on it."
      },
      {
        "id": "AML.T0051.002",
        "name": "LLM Prompt Injection: Triggered",
        "tactic_ids": [
          "AML.TA0005"
        ],
        "description": "Triggering a previously planted prompt injection through a specific user action or event in the environment.",
        "detect_keywords": [
          "triggered injection",
          "trigger phrase",
          "on next request",
          "when the user asks",
          "activation trigger",
          "触发式注入",
          "触发词",
          "条件触发"
        ],
        "detect_hints": "Injected instructions lie dormant until a defined keyword, event, or later conversation turn activates them."
      },
      {
        "id": "AML.T0053",
        "name": "AI Agent Tool Invocation",
        "tactic_ids": [
          "AML.TA0005",
          "AML.TA0012",
          "AML.TA0015"
        ],
        "description": "Using access to an AI agent to invoke its connected tools, extending the adversary's reach and privileges.",
        "detect_keywords": [
          "tool call",
          "function call",
          "invoke tool",
          "agent tool",
          "mcp server",
          "工具调用",
          "函数调用",
          "调用插件"
        ],
        "detect_hints": "The transcript shows the agent being steered into calling a tool such as email, shell, database, or file access."
      },
      {
        "id": "AML.T0054",
        "name": "LLM Jailbreak",
        "tactic_ids": [
          "AML.TA0007",
          "AML.TA0012"
        ],
        "description": "Inducing an LLM to ignore or override its safety alignment and guardrails in order to produce withheld outputs.",
        "detect_keywords": [
          "jailbreak",
          "roleplay as",
          "no restrictions",
          "bypass safety",
          "越狱",
          "角色扮演绕过",
          "解除限制",
          "绕过安全策略"
        ],
        "detect_hints": "The tester uses personas, fictional framing, or refusal-suppression prompts to obtain content the model would normally refuse."
      },
      {
        "id": "AML.T0056",
        "name": "Extract LLM System Prompt",
        "tactic_ids": [
          "AML.TA0010"
        ],
        "description": "Extracting an LLM system prompt through prompt injection or from configuration files.",
        "detect_keywords": [
          "leak the system prompt",
          "extract prompt",
          "prompt leaking",
          "show me your instructions",
          "print your system message",
          "泄露系统提示词",
          "提取提示词",
          "打印系统消息"
        ],
        "detect_hints": "The tester works to obtain the exact system prompt text, often as a headline finding."
      },
      {
        "id": "AML.T0057",
        "name": "LLM Data Leakage",
        "tactic_ids": [
          "AML.TA0010"
        ],
        "description": "Crafting prompts that induce an LLM to reveal private user data, proprietary training data, or other users' information.",
        "detect_keywords": [
          "data leakage",
          "leak sensitive",
          "pii",
          "other users",
          "training data leak",
          "数据泄露",
          "敏感信息",
          "个人信息泄露"
        ],
        "detect_hints": "The model returns secrets, personal data, or another tenant's content in response to the tester's prompts."
      },
      {
        "id": "AML.T0062",
        "name": "Discover LLM Hallucinations",
        "tactic_ids": [
          "AML.TA0008"
        ],
        "description": "Prompting the model to surface hallucinated packages, URLs, or entities that can later be registered or published.",
        "detect_keywords": [
          "hallucinat",
          "made up package",
          "nonexistent package",
          "fake url",
          "slopsquatting",
          "幻觉",
          "虚假包名",
          "不存在的链接"
        ],
        "detect_hints": "The tester collects fabricated package names, domains, or references the model invents, as future attack targets."
      },
      {
        "id": "AML.T0064",
        "name": "Gather RAG-Indexed Targets",
        "tactic_ids": [
          "AML.TA0002"
        ],
        "description": "Identifying the external data sources indexed by a retrieval-augmented generation system in order to target them.",
        "detect_keywords": [
          "knowledge base",
          "pinecone",
          "weaviate",
          "向量库",
          "知识库"
        ],
        "detect_hints": "The tester enumerates or reasons about the documents, vector store, or knowledge base that the RAG pipeline retrieves from."
      },
      {
        "id": "AML.T0068",
        "name": "LLM Prompt Obfuscation",
        "tactic_ids": [
          "AML.TA0007"
        ],
        "description": "Hiding or encoding prompts so that humans, guardrails, or detection mechanisms fail to notice them.",
        "detect_keywords": [
          "base64",
          "encoded payload",
          "homoglyph",
          "invisible text",
          "zero-width",
          "编码绕过",
          "隐藏文本",
          "混淆提示词"
        ],
        "detect_hints": "The payload is encoded, split, or rendered invisibly so filters and human reviewers miss it while the model still parses it."
      },
      {
        "id": "AML.T0069.002",
        "name": "Discover LLM System Information: System Prompt",
        "tactic_ids": [
          "AML.TA0008"
        ],
        "description": "Learning the system instructions given to an LLM in order to understand its capabilities and circumvent its guardrails.",
        "detect_keywords": [
          "system prompt",
          "system instruction",
          "initial instructions",
          "reveal your prompt",
          "repeat the text above",
          "系统提示词",
          "系统指令",
          "初始设定"
        ],
        "detect_hints": "The tester asks the model to disclose, repeat, or paraphrase the instructions it was configured with."
      },
      {
        "id": "AML.T0070",
        "name": "RAG Poisoning",
        "tactic_ids": [
          "AML.TA0006"
        ],
        "description": "Injecting malicious content into a retrieval index so it surfaces in future RAG search results and alters model behavior.",
        "detect_keywords": [
          "rag poisoning",
          "poison the index",
          "vector store injection",
          "retrieval poisoning",
          "malicious document",
          "索引污染",
          "知识库投毒",
          "检索库投毒"
        ],
        "detect_hints": "The tester plants crafted documents in the retrieval corpus and confirms the assistant later cites or obeys them."
      },
      {
        "id": "AML.T0077",
        "name": "LLM Response Rendering",
        "tactic_ids": [
          "AML.TA0010"
        ],
        "description": "Inducing the LLM to emit markdown or HTML that makes the victim's client fetch an attacker-controlled URL, exfiltrating data.",
        "detect_keywords": [
          "markdown image",
          "![](",
          "html injection",
          "exfil via image",
          "webhook",
          "图片外带",
          "markdown外链",
          "渲染外带"
        ],
        "detect_hints": "The transcript shows private data encoded into an image URL, link, or HTML fragment that the client will render."
      },
      {
        "id": "AML.T0080",
        "name": "AI Agent Context Poisoning",
        "tactic_ids": [
          "AML.TA0006"
        ],
        "description": "Manipulating an AI agent's LLM context, memory, or thread so that its behavior changes persistently.",
        "detect_keywords": [
          "context poisoning",
          "add to memory",
          "remember this",
          "persist in context",
          "conversation memory",
          "上下文投毒",
          "写入记忆",
          "持久记忆"
        ],
        "detect_hints": "The tester gets the agent to store an instruction in memory, or relies on earlier turns to keep influencing later ones."
      },
      {
        "id": "AML.T0083",
        "name": "Credentials from AI Agent Configuration",
        "tactic_ids": [
          "AML.TA0013"
        ],
        "description": "Reading API keys, tokens, and connection strings stored in an AI agent's configuration.",
        "detect_keywords": [
          "api key",
          ".env",
          "connection string",
          "agent config",
          "密钥",
          "访问令牌",
          "配置文件凭据",
          "连接字符串"
        ],
        "detect_hints": "The tester finds credentials in agent configuration files, environment variables, or tool settings."
      },
      {
        "id": "AML.T0084",
        "name": "Discover AI Agent Configuration",
        "tactic_ids": [
          "AML.TA0008"
        ],
        "description": "Discovering an AI agent's configuration, including the tools and services it can reach.",
        "detect_keywords": [
          "agent config",
          "what tools do you have",
          "list your tools",
          "agent.yaml",
          "config file",
          "智能体配置",
          "有哪些工具",
          "配置文件"
        ],
        "detect_hints": "The tester asks the agent what tools it has access to, or reads its configuration file or dashboard."
      },
      {
        "id": "AML.T0085",
        "name": "Data from AI Services",
        "tactic_ids": [
          "AML.TA0009"
        ],
        "description": "Collecting proprietary or sensitive data through an organization's AI services, RAG stores, and agent tools.",
        "detect_keywords": [
          "rag database",
          "internal documents",
          "confluence",
          "sharepoint",
          "knowledge store",
          "内部文档",
          "检索数据",
          "知识库数据"
        ],
        "detect_hints": "The tester pulls internal documents or records through the assistant that a normal user could not reach directly."
      },
      {
        "id": "AML.T0086",
        "name": "Exfiltration via AI Agent Tool Invocation",
        "tactic_ids": [
          "AML.TA0010"
        ],
        "description": "Using an agent's write-capable tools to send sensitive data to an attacker-controlled destination.",
        "detect_keywords": [
          "exfiltrate via tool",
          "send email to",
          "create document",
          "upload to",
          "post to webhook",
          "工具外带",
          "通过工具外发",
          "写入外部"
        ],
        "detect_hints": "The tester encodes stolen data into the parameters of a legitimate write tool such as email, docs, or CRM."
      },
      {
        "id": "AML.T0092",
        "name": "Manipulate User LLM Chat History",
        "tactic_ids": [
          "AML.TA0007"
        ],
        "description": "Editing or deleting a user's LLM chat history to conceal the adversary's changes or probing.",
        "detect_keywords": [
          "chat history",
          "delete conversation",
          "clear history",
          "edit message",
          "conversation log",
          "聊天记录",
          "删除会话",
          "历史记录篡改"
        ],
        "detect_hints": "The tester modifies, deletes, or rewrites prior chat turns to cover tracks or hide an injected instruction."
      },
      {
        "id": "AML.T0093",
        "name": "Prompt Infiltration via Public-Facing Application",
        "tactic_ids": [
          "AML.TA0004",
          "AML.TA0006"
        ],
        "description": "Placing malicious prompts into a public-facing application so the victim's system ingests them later through RAG, agents, or user interaction.",
        "detect_keywords": [
          "public-facing",
          "user review",
          "forum post",
          "issue comment",
          "poisoned document upload",
          "投毒文档",
          "公开页面注入",
          "网页留言"
        ],
        "detect_hints": "The tester writes prompt payloads into a public web surface such as a review, comment, profile, or support ticket, expecting the AI to read them later."
      },
      {
        "id": "AML.T0094",
        "name": "Delay Execution of LLM Instructions",
        "tactic_ids": [
          "AML.TA0007"
        ],
        "description": "Planting instructions that execute only on a future event or turn in order to slip past per-turn controls.",
        "detect_keywords": [
          "if the user asks",
          "next time",
          "on the next turn",
          "wait until",
          "deferred instruction",
          "延迟执行",
          "下次对话",
          "条件指令"
        ],
        "detect_hints": "The injected instruction explicitly waits for a later trigger or conversation turn before taking effect."
      },
      {
        "id": "AML.T0098",
        "name": "AI Agent Tool Credential Harvesting",
        "tactic_ids": [
          "AML.TA0013"
        ],
        "description": "Using agent tools to harvest credentials from document stores, code repositories, and productivity systems.",
        "detect_keywords": [
          "credential harvesting",
          "search for password",
          "sharepoint",
          "github token",
          "notes app",
          "凭据收集",
          "搜集密码",
          "代码仓库令牌"
        ],
        "detect_hints": "The tester uses the agent's connected tools to search mail, drives, repositories, or notes for secrets."
      },
      {
        "id": "AML.T0101",
        "name": "Data Destruction via AI Agent Tool Invocation",
        "tactic_ids": [
          "AML.TA0011"
        ],
        "description": "Invoking an agent's mutative tools in order to delete or destroy data and files.",
        "detect_keywords": [
          "delete files",
          "rm -rf",
          "destroy data",
          "wipe",
          "drop table",
          "删除文件",
          "数据销毁",
          "清空数据"
        ],
        "detect_hints": "The tester drives the agent into destructive file, database, or record operations."
      },
      {
        "id": "AML.T0105",
        "name": "Escape to Host",
        "tactic_ids": [
          "AML.TA0012"
        ],
        "description": "Breaking out of a container or sandbox around an AI system in order to reach the underlying host.",
        "detect_keywords": [
          "escape to host",
          "container escape",
          "sandbox escape",
          "docker socket",
          "mount the host",
          "容器逃逸",
          "沙箱逃逸",
          "逃逸到宿主机"
        ],
        "detect_hints": "The tester tries to break out of the sandbox or container that hosts the model or agent execution environment."
      },
      {
        "id": "AML.T0110",
        "name": "AI Agent Tool Poisoning",
        "tactic_ids": [
          "AML.TA0006"
        ],
        "description": "Poisoning an agent tool's definition, implementation, or runtime responses so the agent behaves differently from what the tool represents.",
        "detect_keywords": [
          "tool poisoning",
          "malicious mcp",
          "tool description injection",
          "poisoned tool",
          "mcp server tampering",
          "工具投毒",
          "工具描述注入",
          "恶意mcp"
        ],
        "detect_hints": "The transcript describes a modified tool description, package, or MCP server that misleads the agent while appearing benign."
      },
      {
        "id": "AML.T0129",
        "name": "Triggers in Multimodal Inputs",
        "tactic_ids": [
          "AML.TA0007"
        ],
        "description": "Embedding instructions or triggers in a non-text modality so that controls that only inspect text miss them.",
        "detect_keywords": [
          "multimodal",
          "image prompt injection",
          "audio injection",
          "steganograph",
          "多模态注入",
          "图片注入",
          "语音注入",
          "隐写"
        ],
        "detect_hints": "The payload rides inside an image, audio clip, or document rendering while the text channel looks clean."
      },
      {
        "id": "AML.T0130",
        "name": "AI Agent Response Biasing",
        "tactic_ids": [
          "AML.TA0011"
        ],
        "description": "Injecting instructions that bias an assistant toward adversary-chosen sources or recommendations in its answers.",
        "detect_keywords": [
          "trusted source",
          "cite this",
          "promote",
          "prefer this site",
          "bias the response",
          "优先推荐",
          "信任来源",
          "偏置输出"
        ],
        "detect_hints": "The payload instructs the assistant to favor, promote, or always cite a chosen source in its responses."
      },
      {
        "id": "AML.T0131",
        "name": "Crafted AI Assistant Links",
        "tactic_ids": [
          "AML.TA0004"
        ],
        "description": "Crafting URLs that pre-populate or auto-submit an attacker-chosen prompt when an AI assistant link is opened.",
        "detect_keywords": [
          "?prompt=",
          "assistant link",
          "deeplink",
          "url parameter",
          "助手链接",
          "预填提示词",
          "深链接"
        ],
        "detect_hints": "The transcript contains assistant URLs carrying a prompt or query parameter that feeds the tester's payload straight into the chat."
      },
      {
        "id": "AML.T0132",
        "name": "Misconfigured or Publicly Exposed AI Services",
        "tactic_ids": [
          "AML.TA0004"
        ],
        "description": "Exploiting AI services with missing authentication or overly permissive access controls to reach agents and LLM runtimes.",
        "detect_keywords": [
          "no auth",
          "unauthenticated",
          "default credentials",
          "publicly accessible",
          "未授权",
          "默认口令",
          "暴露的服务",
          "无鉴权"
        ],
        "detect_hints": "The tester reaches an LLM or agent endpoint without credentials, or notes absent or default authentication as the way in."
      }
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // MITRE ATT&CK Enterprise —— 企业 IT 面。
  //
  // 和 ATLAS 是两套东西：ATLAS 打 AI 系统本身，ATT&CK 打企业 IT 面。
  // 红队实操里两者会同时命中（先扫资产、拿凭据，再去打模型），
  // 所以并列成两个页面，而不是合并成一个。
  //
  // 数据取自 MITRE 官方 TAXII 2.1 接口的企业版 collection
  // （attack-taxii.mitre.org/api/v21）。technique 的 id / name / description /
  // kill_chain_phases 全部来自官方 STIX 对象，未改写；tactic 名称用该版本的最新
  // 叫法（这版把 Defense Evasion 改名成 Stealth，并新增 Defense Impairment）。
  //
  // 只收 46 个：从 858 个技术点里挑出「AI/LLM 红队对话里真可能留下痕迹」的，
  // 其余（硬件、工控、macOS 细节等）刻意不收，免得矩阵被填成一份 ATT&CK 目录。
  // 覆盖 15 个阶段中的 14 个（Command and Control 暂无入选技术点）。
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: "attack-enterprise",
    name: "MITRE ATT&CK Enterprise",
    short: "ATT&CK",
    source: "MITRE ATT&CK Enterprise（企业版），https://attack.mitre.org/ —— 数据取自官方 TAXII 2.1 接口；只收与 AI/LLM 红队对话相关的 46 个技术点，不是全量。",
    tactics: [
      {
        "id": "TA0043",
        "name": "Reconnaissance",
        "description": "The adversary is trying to gather information they can use to plan future operations. Reconnaissance consists of techniques that involve adversaries actively or passively gathering information that can be used to support targeting. Such information may include details of the victim organization, infrastructure, or staff/personnel. This information can be leveraged by the adversary to aid in other phases of the adversary lifecycle, such as using gathered information to plan and execute Initial Access, to scope and prioritize post-compromise objectives, or to drive and lead further Reconnaissance efforts."
      },
      {
        "id": "TA0042",
        "name": "Resource Development",
        "description": "The adversary is trying to establish resources they can use to support operations. Resource Development consists of techniques that involve adversaries creating, purchasing, or compromising/stealing resources that can be used to support targeting. Such resources include infrastructure, accounts, or capabilities. These resources can be leveraged by the adversary to aid in other phases of the adversary lifecycle, such as using purchased domains to support Command and Control, email accounts for phishing as a part of Initial Access, or stealing code signing certificates to help with Defense Evasion."
      },
      {
        "id": "TA0001",
        "name": "Initial Access",
        "description": "The adversary is trying to get into your network. Initial Access consists of techniques that use various entry vectors to gain their initial foothold within a network. Techniques used to gain a foothold include targeted spearphishing and exploiting weaknesses on public-facing web servers. Footholds gained through initial access may allow for continued access, like valid accounts and use of external remote services, or may be limited-use due to changing passwords."
      },
      {
        "id": "TA0002",
        "name": "Execution",
        "description": "The adversary is trying to run malicious code. Execution consists of techniques that result in adversary-controlled code running on a local or remote system. Techniques that run malicious code are often paired with techniques from all other tactics to achieve broader goals, like exploring a network or stealing data. For example, an adversary might use a remote access tool to run a PowerShell script that does Remote System Discovery."
      },
      {
        "id": "TA0003",
        "name": "Persistence",
        "description": "The adversary is trying to maintain their foothold. Persistence consists of techniques that adversaries use to keep access to systems across restarts, changed credentials, and other interruptions that could cut off their access. Techniques used for persistence include any access, action, or configuration changes that let them maintain their foothold on systems, such as replacing or hijacking legitimate code or adding startup code."
      },
      {
        "id": "TA0004",
        "name": "Privilege Escalation",
        "description": "The adversary is trying to gain higher-level permissions. Privilege Escalation consists of techniques that adversaries use to gain higher-level permissions on a system or network. Adversaries can often enter and explore a network with unprivileged access but require elevated permissions to follow through on their objectives. Common approaches are to take advantage of system weaknesses, misconfigurations, and vulnerabilities. Examples of elevated access include: * SYSTEM/root level * local administrator * user account with admin-like access * user accounts with access to specific system or perform specific function These techniques often overlap with Persistence techniques, as OS features that let an adversary persist can execute in an elevated context."
      },
      {
        "id": "TA0005",
        "name": "Stealth",
        "description": "The adversary is trying to hide and conceal their actions, appearing as normal behavior. Stealth consists of techniques that reduce the likelihood of detection by blending in with legitimate activity or minimizing observable signals. These techniques are characterized by concealment behaviors, such as avoiding, obfuscating, or mimicking normal operations, without modifying security controls or compromising collection and monitoring feeds. The goal is to remain indistinguishable from benign activity while leaving defensive systems intact."
      },
      {
        "id": "TA0112",
        "name": "Defense Impairment",
        "description": "The adversary is trying to break security mechanisms, pipelines, and tooling so defenders can’t see or trust what’s happening. Defense Impairment consists of techniques that degrade, disable, or undermine the effectiveness and trustworthiness of security controls and monitoring mechanisms. These techniques are characterized by direct interference with defensive systems. The goal is to reduce defenders’ ability to detect, interpret, or respond to adversary activity."
      },
      {
        "id": "TA0006",
        "name": "Credential Access",
        "description": "The adversary is trying to steal account names and passwords. Credential Access consists of techniques for stealing credentials like account names and passwords. Techniques used to get credentials include keylogging or credential dumping. Using legitimate credentials can give adversaries access to systems, make them harder to detect, and provide the opportunity to create more accounts to help achieve their goals."
      },
      {
        "id": "TA0007",
        "name": "Discovery",
        "description": "The adversary is trying to figure out your environment. Discovery consists of techniques an adversary may use to gain knowledge about the system and internal network. These techniques help adversaries observe the environment and orient themselves before deciding how to act. They also allow adversaries to explore what they can control and what’s around their entry point in order to discover how it could benefit their current objective. Native operating system tools are often used toward this post-compromise information-gathering objective."
      },
      {
        "id": "TA0008",
        "name": "Lateral Movement",
        "description": "The adversary is trying to move through your environment. Lateral Movement consists of techniques that adversaries use to enter and control remote systems on a network. Following through on their primary objective often requires exploring the network to find their target, then pivoting through multiple systems and accounts to gain access to it. Adversaries might install their own remote access tools to accomplish Lateral Movement or use legitimate credentials with native network and operating system tools, which may be stealthier."
      },
      {
        "id": "TA0009",
        "name": "Collection",
        "description": "The adversary is trying to gather data of interest to their goal. Collection consists of techniques adversaries may use to gather information and the sources information is collected from that are relevant to following through on the adversary's objectives. Frequently, the next goal after collecting data is to either steal (exfiltrate) the data or to use the data to gain more information about the target environment. Common target sources include various drive types, browsers, audio, video, and email. Common collection methods include capturing screenshots and keyboard input."
      },
      {
        "id": "TA0011",
        "name": "Command and Control",
        "description": "The adversary is trying to communicate with compromised systems to control them. Command and Control consists of techniques that adversaries may use to communicate with systems under their control within a victim network. Adversaries commonly attempt to mimic normal, expected traffic to avoid detection. There are many ways an adversary can establish command and control with various levels of stealth depending on the victim’s network structure and defenses."
      },
      {
        "id": "TA0010",
        "name": "Exfiltration",
        "description": "The adversary is trying to steal data. Exfiltration consists of techniques that adversaries may use to steal data from your network. Once they’ve collected data, adversaries often package it to avoid detection while removing it. This can include compression and encryption. Techniques for getting data out of a target network typically include transferring it over their command and control channel or an alternate channel and may also include putting size limits on the transmission."
      },
      {
        "id": "TA0040",
        "name": "Impact",
        "description": "The adversary is trying to manipulate, interrupt, or destroy your systems and data. Impact consists of techniques that adversaries use to disrupt availability or compromise integrity by manipulating business and operational processes. Techniques used for impact can include destroying or tampering with data. In some cases, business processes can look fine, but may have been altered to benefit the adversaries’ goals. These techniques might be used by adversaries to follow through on their end goal or to provide cover for a confidentiality breach."
      }
    ],
    techniques: [
      {
        "id": "T1595",
        "name": "Active Scanning",
        "tactic_ids": [
          "TA0043"
        ],
        "description": "Adversaries may execute active reconnaissance scans to gather information that can be used during targeting. Active scans are those where the adversary probes victim infrastructure via network traffic, as opposed to other forms of reconnaissance that do not involve direct interaction. Adversaries may perform different forms of active scanning depending on what information they seek to gather. These scans can also be performed in various ways, including using native features of network protocols such as ICMP.(Citation: Botnet Scan)(Citation: OWASP Fingerprinting) Information from these scans may reveal opportunities for other forms of reconnaissance (ex: [Search Open Websites/Domains](https://attack.mitre.org/techniques/T1593) or [Search Open Technical Databases](https://attack.mitre.org/techniques/T1596)), establishing operational resources (ex: [Develop Capabilities](https://attack.mitre.org/techniques/T1587) or [Obtain Capabilities](https://attack.mitre.org/techniques/T1588)), and/or initial access (ex: [External Remote Services](https://attack.mitre.org/techniques/T1133) or [Exploit Public-Facing Application](https://attack.mitre.org/techniques/T1190)).",
        "detect_keywords": [
          "active scanning",
          "port scan",
          "nmap",
          "masscan",
          "shodan",
          "censys",
          "端口扫描",
          "资产测绘"
        ],
        "detect_hints": "对话里在做端口/服务扫描，或查 Shodan、Censys 这类互联网测绘库找目标。"
      },
      {
        "id": "T1596",
        "name": "Search Open Technical Databases",
        "tactic_ids": [
          "TA0043"
        ],
        "description": "Adversaries may search freely available technical databases for information about victims that can be used during targeting. Information about victims may be available in online databases and repositories, such as registrations of domains/certificates as well as public collections of network data/artifacts gathered from traffic and/or scans.(Citation: WHOIS)(Citation: DNS Dumpster)(Citation: Circl Passive DNS)(Citation: Medium SSL Cert)(Citation: SSLShopper Lookup)(Citation: DigitalShadows CDN)(Citation: Shodan) Adversaries may search in different open databases depending on what information they seek to gather. Information from these sources may reveal opportunities for other forms of reconnaissance (ex: [Phishing for Information](https://attack.mitre.org/techniques/T1598) or [Search Open Websites/Domains](https://attack.mitre.org/techniques/T1593)), establishing operational resources (ex: [Acquire Infrastructure](https://attack.mitre.org/techniques/T1583) or [Compromise Infrastructure](https://attack.mitre.org/techniques/T1584)), and/or initial access (ex: [External Remote Services](https://attack.mitre.org/techniques/T1133) or [Trusted Relationship](https://attack.mitre.org/techniques/T1199)).",
        "detect_keywords": [
          "osint",
          "whois",
          "dns records",
          "certificate transparency",
          "leak site",
          "公开情报",
          "证书透明度",
          "信息收集"
        ],
        "detect_hints": "对话在查公开技术数据库、DNS/证书记录或泄露数据来补全目标信息。"
      },
      {
        "id": "T1598",
        "name": "Phishing for Information",
        "tactic_ids": [
          "TA0043"
        ],
        "description": "Adversaries may send phishing messages to elicit sensitive information that can be used during targeting. Phishing for information is an attempt to trick targets into divulging information, frequently credentials or other actionable information. Phishing for information is different from [Phishing](https://attack.mitre.org/techniques/T1566) in that the objective is gathering data from the victim rather than executing malicious code. All forms of phishing are electronically delivered social engineering. Phishing can be targeted, known as spearphishing. In spearphishing, a specific individual, company, or industry will be targeted by the adversary. More generally, adversaries can conduct non-targeted phishing, such as in mass credential harvesting campaigns. Adversaries may also try to obtain information directly through the exchange of emails, instant messages, or other electronic conversation means.(Citation: ThreatPost Social Media Phishing)(Citation: TrendMictro Phishing)(Citation: PCMag FakeLogin)(Citation: Sophos Attachment)(Citation: GitHub Phishery) Victims may also receive phishing messages that direct them to call a phone number where the adversary attempts to collect confidential information.(Citation: Avertium callback phishing) Phishing for information frequently involves social engineering techniques, such as posing as a source with a reason to collect information (ex: [Establish Accounts](https://attack.mitre.org/techniques/T1585) or [Compromise Accounts](https://attack.mitre.org/techniques/T1586)) and/or sending multiple, seemingly urgent messages. Another way to accomplish this is by [Email Spoofing](https://attack.mitre.org/techniques/T1684/002)(Citation: Proofpoint-spoof) the identity of the sender, which can be used to fool both the human recipient as well as automated security tools.(Citation: cyberproof-double-bounce) Phishing for information may also involve evasive techniques, such as removing or manipulating emails or metadata/headers from compromised accounts being abused to send messages (e.g., [Email Hiding Rules](https://attack.mitre.org/techniques/T1564/008)).(Citation: Microsoft OAuth Spam 2022)(Citation: Palo Alto Unit 42 VBA Infostealer 2014)",
        "detect_keywords": [
          "phishing for information",
          "pretexting",
          "social engineering call",
          "假装是",
          "钓鱼问询",
          "社工套话"
        ],
        "detect_hints": "对话在讨论用伪装身份或话术向目标人员套取信息。"
      },
      {
        "id": "T1583",
        "name": "Acquire Infrastructure",
        "tactic_ids": [
          "TA0042"
        ],
        "description": "Adversaries may buy, lease, rent, or obtain infrastructure that can be used during targeting. A wide variety of infrastructure exists for hosting and orchestrating adversary operations. Infrastructure solutions include physical or cloud servers, domains, and third-party web services.(Citation: TrendmicroHideoutsLease) Some infrastructure providers offer free trial periods, enabling infrastructure acquisition at limited to no cost.(Citation: Free Trial PurpleUrchin) Additionally, botnets are available for rent or purchase. Use of these infrastructure solutions allows adversaries to stage, launch, and execute operations. Solutions may help adversary operations blend in with traffic that is seen as normal, such as contacting third-party web services or acquiring infrastructure to support [Proxy](https://attack.mitre.org/techniques/T1090), including from residential proxy services.(Citation: amnesty_nso_pegasus)(Citation: FBI Proxies Credential Stuffing)(Citation: Mandiant APT29 Microsoft 365 2022) Depending on the implementation, adversaries may use infrastructure that makes it difficult to physically tie back to them as well as utilize infrastructure that can be rapidly provisioned, modified, and shut down.",
        "detect_keywords": [
          "register a domain",
          "buy a vps",
          "acquire infrastructure",
          "phishing domain",
          "购买域名",
          "租用服务器",
          "搭建基础设施"
        ],
        "detect_hints": "对话在采购域名、VPS 等攻击基础设施用于后续投递。"
      },
      {
        "id": "T1587",
        "name": "Develop Capabilities",
        "tactic_ids": [
          "TA0042"
        ],
        "description": "Adversaries may build capabilities that can be used during targeting. Rather than purchasing, freely downloading, or stealing capabilities, adversaries may develop their own capabilities in-house. This is the process of identifying development requirements and building solutions such as malware, exploits, and self-signed certificates. Adversaries may develop capabilities to support their operations throughout numerous phases of the adversary lifecycle.(Citation: Mandiant APT1)(Citation: Kaspersky Sofacy)(Citation: Bitdefender StrongPity June 2020)(Citation: Talos Promethium June 2020) As with legitimate development efforts, different skill sets may be required for developing capabilities. The skills needed may be located in-house, or may need to be contracted out. Use of a contractor may be considered an extension of that adversary's development capabilities, provided the adversary plays a role in shaping requirements and maintains a degree of exclusivity to the capability.",
        "detect_keywords": [
          "develop malware",
          "build an exploit",
          "custom implant",
          "写一个木马",
          "自研利用工具",
          "开发载荷"
        ],
        "detect_hints": "对话在自行开发恶意软件、利用工具或定制载荷。"
      },
      {
        "id": "T1588",
        "name": "Obtain Capabilities",
        "tactic_ids": [
          "TA0042"
        ],
        "description": "Adversaries may buy and/or steal capabilities that can be used during targeting. Rather than developing their own capabilities in-house, adversaries may purchase, freely download, or steal them. Activities may include the acquisition of malware, software (including licenses), exploits, certificates, and information relating to vulnerabilities. Adversaries may obtain capabilities to support their operations throughout numerous phases of the adversary lifecycle. In addition to downloading free malware, software, and exploits from the internet, adversaries may purchase these capabilities from third-party entities. Third-party entities can include technology companies that specialize in malware and exploits, criminal marketplaces, or from individuals.(Citation: NationsBuying)(Citation: PegasusCitizenLab) In addition to purchasing capabilities, adversaries may steal capabilities from third-party entities (including other adversaries). This can include stealing software licenses, malware, SSL/TLS and code-signing certificates, or raiding closed databases of vulnerabilities or exploits.(Citation: DiginotarCompromise)",
        "detect_keywords": [
          "cobalt strike",
          "metasploit",
          "sliver",
          "mimikatz",
          "exploit kit",
          "攻击框架",
          "现成工具",
          "购买漏洞"
        ],
        "detect_hints": "对话在获取或使用现成的攻击框架、漏洞利用或恶意软件。"
      },
      {
        "id": "T1078",
        "name": "Valid Accounts",
        "tactic_ids": [
          "TA0005",
          "TA0003",
          "TA0004",
          "TA0001"
        ],
        "description": "Adversaries may obtain and abuse credentials of existing accounts as a means of gaining Initial Access, Persistence, Privilege Escalation, or Defense Evasion. Compromised credentials may be used to bypass access controls placed on various resources on systems within the network and may even be used for persistent access to remote systems and externally available services, such as VPNs, Outlook Web Access, network devices, and remote desktop.(Citation: volexity_0day_sophos_FW) Compromised credentials may also grant an adversary increased privilege to specific systems or access to restricted areas of the network. Adversaries may choose not to use malware or tools in conjunction with the legitimate access those credentials provide to make it harder to detect their presence. In some cases, adversaries may abuse inactive accounts: for example, those belonging to individuals who are no longer part of an organization. Using these accounts may allow the adversary to evade detection, as the original account user will not be present to identify any anomalous activity taking place on their account.(Citation: CISA MFA PrintNightmare) The overlap of permissions for local, domain, and cloud accounts across a network of systems is of concern because the adversary may be able to pivot across accounts and systems to reach a high level of access (i.e., domain or enterprise administrator) to bypass access controls set within the enterprise.(Citation: TechNet Credential Theft)",
        "detect_keywords": [
          "valid accounts",
          "default credentials",
          "stolen credentials",
          "service account",
          "默认口令",
          "弱口令登录",
          "合法账号"
        ],
        "detect_hints": "对话用窃取或默认的账号口令直接登录，而不是打漏洞。"
      },
      {
        "id": "T1566",
        "name": "Phishing",
        "tactic_ids": [
          "TA0001"
        ],
        "description": "Adversaries may send phishing messages to gain access to victim systems. All forms of phishing are electronically delivered social engineering. Phishing can be targeted, known as spearphishing. In spearphishing, a specific individual, company, or industry will be targeted by the adversary. More generally, adversaries can conduct non-targeted phishing, such as in mass malware spam campaigns. Adversaries may send victims emails containing malicious attachments or links, typically to execute malicious code on victim systems. Phishing may also be conducted via third-party services, like social media platforms. Phishing may also involve social engineering techniques, such as posing as a trusted source, as well as evasive techniques such as removing or manipulating emails or metadata/headers from compromised accounts being abused to send messages (e.g., [Email Hiding Rules](https://attack.mitre.org/techniques/T1564/008)).(Citation: Microsoft OAuth Spam 2022)(Citation: Palo Alto Unit 42 VBA Infostealer 2014) Another way to accomplish this is by [Email Spoofing](https://attack.mitre.org/techniques/T1684/002)(Citation: Proofpoint-spoof) the identity of the sender, which can be used to fool both the human recipient as well as automated security tools,(Citation: cyberproof-double-bounce) or by including the intended target as a party to an existing email thread that includes malicious files or links (i.e., \"thread hijacking\").(Citation: phishing-krebs) Victims may also receive phishing messages that instruct them to call a phone number where they are directed to visit a malicious URL, download malware,(Citation: sygnia Luna Month)(Citation: CISA Remote Monitoring and Management Software) or install adversary-accessible remote management tools onto their computer (i.e., [User Execution](https://attack.mitre.org/techniques/T1204)).(Citation: Unit42 Luna Moth)",
        "detect_keywords": [
          "phishing email",
          "spearphishing",
          "malicious attachment",
          "macro document",
          "钓鱼邮件",
          "恶意附件",
          "鱼叉邮件"
        ],
        "detect_hints": "对话在构造钓鱼邮件或恶意附件投递给目标。"
      },
      {
        "id": "T1190",
        "name": "Exploit Public-Facing Application",
        "tactic_ids": [
          "TA0001"
        ],
        "description": "Adversaries may attempt to exploit a weakness in an Internet-facing host or system to initially access a network. The weakness in the system can be a software bug, a temporary glitch, or a misconfiguration. Exploited applications are often websites/web servers, but can also include databases (like SQL), standard services (like SMB or SSH), network device administration and management protocols (like SNMP and Smart Install), and any other system with Internet-accessible open sockets.(Citation: NVD CVE-2016-6662)(Citation: CIS Multiple SMB Vulnerabilities)(Citation: US-CERT TA18-106A Network Infrastructure Devices 2018)(Citation: Cisco Blog Legacy Device Attacks)(Citation: NVD CVE-2014-7169) On ESXi infrastructure, adversaries may exploit exposed OpenSLP services; they may alternatively exploit exposed VMware vCenter servers.(Citation: Recorded Future ESXiArgs Ransomware 2023)(Citation: Ars Technica VMWare Code Execution Vulnerability 2021) Depending on the flaw being exploited, this may also involve [Exploitation for Stealth](https://attack.mitre.org/techniques/T1211) or [Exploitation for Client Execution](https://attack.mitre.org/techniques/T1203). If an application is hosted on cloud-based infrastructure and/or is containerized, then exploiting it may lead to compromise of the underlying instance or container. This can allow an adversary a path to access the cloud or container APIs (e.g., via the [Cloud Instance Metadata API](https://attack.mitre.org/techniques/T1552/005)), exploit container host access via [Escape to Host](https://attack.mitre.org/techniques/T1611), or take advantage of weak identity and access management policies. Adversaries may also exploit edge network infrastructure and related appliances, specifically targeting devices that do not support robust host-based defenses.(Citation: Mandiant Fortinet Zero Day)(Citation: Wired Russia Cyberwar) For websites and databases, the OWASP top 10 and CWE top 25 highlight the most common web-based vulnerabilities.(Citation: OWASP Top 10)(Citation: CWE top 25)",
        "detect_keywords": [
          "exploit public-facing",
          "rce",
          "remote code execution",
          "sql injection",
          "sqlmap",
          "file upload vulnerability",
          "命令执行漏洞",
          "任意文件上传"
        ],
        "detect_hints": "对话在打一个对外的应用漏洞（RCE、SQLi、文件上传等）拿初始访问。"
      },
      {
        "id": "T1133",
        "name": "External Remote Services",
        "tactic_ids": [
          "TA0003",
          "TA0001"
        ],
        "description": "Adversaries may leverage external-facing remote services to initially access and/or persist within a network. Remote services such as VPNs, Citrix, and other access mechanisms allow users to connect to internal enterprise network resources from external locations. There are often remote service gateways that manage connections and credential authentication for these services. Services such as [Windows Remote Management](https://attack.mitre.org/techniques/T1021/006) and [VNC](https://attack.mitre.org/techniques/T1021/005) can also be used externally.(Citation: MacOS VNC software for Remote Desktop) Access to [Valid Accounts](https://attack.mitre.org/techniques/T1078) to use the service is often a requirement, which could be obtained through credential pharming or by obtaining the credentials from users after compromising the enterprise network.(Citation: Volexity Virtual Private Keylogging) Access to remote services may be used as a redundant or persistent access mechanism during an operation. Access may also be gained through an exposed service that doesn’t require authentication. In containerized environments, this may include an exposed Docker API, Kubernetes API server, kubelet, or web application such as the Kubernetes dashboard.(Citation: Trend Micro Exposed Docker Server)(Citation: Unit 42 Hildegard Malware) Adversaries may also establish persistence on network by configuring a Tor hidden service on a compromised system. Adversaries may utilize the tool `ShadowLink` to facilitate the installation and configuration of the Tor hidden service. Tor hidden service is then accessible via the Tor network because `ShadowLink` sets up a .onion address on the compromised system. `ShadowLink` may be used to forward any inbound connections to RDP, allowing the adversaries to have remote access.(Citation: The BadPilot campaign) Adversaries may get `ShadowLink` to persist on a system by masquerading it as an MS Defender application.(Citation: Russian threat actors dig in, prepare to seize on war fatigue)",
        "detect_keywords": [
          "vpn login",
          "rdp exposed",
          "citrix",
          "external remote service",
          "vpn 登录",
          "暴露的远程桌面",
          "外网堡垒机"
        ],
        "detect_hints": "对话在尝试从外网接入 VPN、RDP 等远程服务。"
      },
      {
        "id": "T1059",
        "name": "Command and Scripting Interpreter",
        "tactic_ids": [
          "TA0002"
        ],
        "description": "Adversaries may abuse command and script interpreters to execute commands, scripts, or binaries. These interfaces and languages provide ways of interacting with computer systems and are a common feature across many different platforms. Most systems come with some built-in command-line interface and scripting capabilities, for example, macOS and Linux distributions include some flavor of [Unix Shell](https://attack.mitre.org/techniques/T1059/004) while Windows installations include the [Windows Command Shell](https://attack.mitre.org/techniques/T1059/003) and [PowerShell](https://attack.mitre.org/techniques/T1059/001). There are also cross-platform interpreters such as [Python](https://attack.mitre.org/techniques/T1059/006), as well as those commonly associated with client applications such as [JavaScript](https://attack.mitre.org/techniques/T1059/007) and [Visual Basic](https://attack.mitre.org/techniques/T1059/005). Adversaries may abuse these technologies in various ways as a means of executing arbitrary commands. Commands and scripts can be embedded in [Initial Access](https://attack.mitre.org/tactics/TA0001) payloads delivered to victims as lure documents or as secondary payloads downloaded from an existing C2. Adversaries may also execute commands through interactive terminals/shells, as well as utilize various [Remote Services](https://attack.mitre.org/techniques/T1021) in order to achieve remote Execution.(Citation: Powershell Remote Commands)(Citation: Cisco IOS Software Integrity Assurance - Command History)(Citation: Remote Shell Execution in Python)",
        "detect_keywords": [
          "reverse shell",
          "bash -i",
          "powershell -enc",
          "curl | sh",
          "python -c",
          "反弹 shell",
          "命令行执行"
        ],
        "detect_hints": "对话在通过命令行解释器执行命令或落地反弹 shell。"
      },
      {
        "id": "T1203",
        "name": "Exploitation for Client Execution",
        "tactic_ids": [
          "TA0002"
        ],
        "description": "Adversaries may exploit software vulnerabilities in client applications to execute code. Vulnerabilities can exist in software due to unsecure coding practices that can lead to unanticipated behavior. Adversaries can take advantage of certain vulnerabilities through targeted exploitation for the purpose of arbitrary code execution. Oftentimes the most valuable exploits to an offensive toolkit are those that can be used to obtain code execution on a remote system because they can be used to gain access to that system. Users will expect to see files related to the applications they commonly used to do work, so they are a useful target for exploit research and development because of their high utility. Several types exist: ### Browser-based Exploitation Web browsers are a common target through [Drive-by Compromise](https://attack.mitre.org/techniques/T1189) and [Spearphishing Link](https://attack.mitre.org/techniques/T1566/002). Endpoint systems may be compromised through normal web browsing or from certain users being targeted by links in spearphishing emails to adversary controlled sites used to exploit the web browser. These often do not require an action by the user for the exploit to be executed. ### Office Applications Common office and productivity applications such as Microsoft Office are also targeted through [Phishing](https://attack.mitre.org/techniques/T1566). Malicious files will be transmitted directly as attachments or through links to download them. These require the user to open the document or file for the exploit to run. ### Common Third-party Applications Other applications that are commonly seen or are part of the software deployed in a target network may also be used for exploitation. Applications such as Adobe Reader and Flash, which are common in enterprise environments, have been routinely targeted by adversaries attempting to gain access to systems. Depending on the software and nature of the vulnerability, some may be exploited in the browser or require the user to open a file. For instance, some Flash exploits have been delivered as objects within Microsoft Office documents.",
        "detect_keywords": [
          "exploit client",
          "browser exploit",
          "office exploit",
          "malicious document",
          "浏览器漏洞",
          "office 漏洞",
          "客户端利用"
        ],
        "detect_hints": "对话在利用客户端软件（浏览器、Office）的漏洞执行代码。"
      },
      {
        "id": "T1106",
        "name": "Native API",
        "tactic_ids": [
          "TA0002"
        ],
        "description": "Adversaries may interact with the native OS application programming interface (API) to execute behaviors. Native APIs provide a controlled means of calling low-level OS services within the kernel, such as those involving hardware/devices, memory, and processes.(Citation: NT API Windows)(Citation: Linux Kernel API) These native APIs are leveraged by the OS during system boot (when other system components are not yet initialized) as well as carrying out tasks and requests during routine operations. Adversaries may abuse these OS API functions as a means of executing behaviors. Similar to [Command and Scripting Interpreter](https://attack.mitre.org/techniques/T1059), the native API and its hierarchy of interfaces provide mechanisms to interact with and utilize various components of a victimized system. Native API functions (such as <code>NtCreateProcess</code>) may be directed invoked via system calls / syscalls, but these features are also often exposed to user-mode applications via interfaces and libraries.(Citation: OutFlank System Calls)(Citation: CyberBit System Calls)(Citation: MDSec System Calls) For example, functions such as the Windows API <code>CreateProcess()</code> or GNU <code>fork()</code> will allow programs and scripts to start other processes.(Citation: Microsoft CreateProcess)(Citation: GNU Fork) This may allow API callers to execute a binary, run a CLI command, load modules, etc. as thousands of similar API functions exist for various system operations.(Citation: Microsoft Win32)(Citation: LIBC)(Citation: GLIBC) Higher level software frameworks, such as Microsoft .NET and macOS Cocoa, are also available to interact with native APIs. These frameworks typically provide language wrappers/abstractions to API functionalities and are designed for ease-of-use/portability of code.(Citation: Microsoft NET)(Citation: Apple Core Services)(Citation: MACOS Cocoa)(Citation: macOS Foundation) Adversaries may use assembly to directly or in-directly invoke syscalls in an attempt to subvert defensive sensors and detection signatures such as user mode API-hooks.(Citation: Redops Syscalls) Adversaries may also attempt to tamper with sensors and defensive tools associated with API monitoring, such as unhooking monitored functions via [Disable or Modify Tools](https://attack.mitre.org/techniques/T1685).",
        "detect_keywords": [
          "native api",
          "win32 api",
          "syscall",
          "调用系统 api",
          "系统调用"
        ],
        "detect_hints": "对话在直接调用操作系统原生 API 执行动作以规避检测。"
      },
      {
        "id": "T1136",
        "name": "Create Account",
        "tactic_ids": [
          "TA0003"
        ],
        "description": "Adversaries may create an account to maintain access to victim systems.(Citation: Symantec WastedLocker June 2020) With a sufficient level of access, creating such accounts may be used to establish secondary credentialed access that do not require persistent remote access tools to be deployed on the system. Accounts may be created on the local system or within a domain or cloud tenant. In cloud environments, adversaries may create accounts that only have access to specific services, which can reduce the chance of detection.",
        "detect_keywords": [
          "create account",
          "add user",
          "new admin user",
          "useradd",
          "net user /add",
          "创建账号",
          "新建管理员"
        ],
        "detect_hints": "对话在目标系统上创建账号以便长期保留访问。"
      },
      {
        "id": "T1505",
        "name": "Server Software Component",
        "tactic_ids": [
          "TA0003"
        ],
        "description": "Adversaries may abuse legitimate extensible development features of servers to establish persistent access to systems. Enterprise server applications may include features that allow developers to write and install software or scripts to extend the functionality of the main application. Adversaries may install malicious components to extend and abuse server applications.(Citation: volexity_0day_sophos_FW)",
        "detect_keywords": [
          "web shell",
          "webshell",
          "install a service",
          "backdoor service",
          "上传 webshell",
          "安装服务后门"
        ],
        "detect_hints": "对话在装 webshell 或恶意服务组件来维持访问。"
      },
      {
        "id": "T1098",
        "name": "Account Manipulation",
        "tactic_ids": [
          "TA0003",
          "TA0004"
        ],
        "description": "Adversaries may manipulate accounts to maintain and/or elevate access to victim systems. Account manipulation may consist of any action that preserves or modifies adversary access to a compromised account, such as modifying credentials or permission groups.(Citation: FireEye SMOKEDHAM June 2021) These actions could also include account activity designed to subvert security policies, such as performing iterative password updates to bypass password duration policies and preserve the life of compromised credentials. In order to create or manipulate accounts, the adversary must already have sufficient permissions on systems or the domain. However, account manipulation may also lead to privilege escalation where modifications grant access to additional roles, permissions, or higher-privileged [Valid Accounts](https://attack.mitre.org/techniques/T1078).",
        "detect_keywords": [
          "add to admin group",
          "grant permission",
          "ssh authorized_keys",
          "modify account",
          "加进管理员组",
          "授权后门账号",
          "写入公钥"
        ],
        "detect_hints": "对话在篡改账号权限或写入 SSH 公钥来提权/保活。"
      },
      {
        "id": "T1548",
        "name": "Abuse Elevation Control Mechanism",
        "tactic_ids": [
          "TA0004"
        ],
        "description": "Adversaries may circumvent mechanisms designed to control privilege elevation to gain higher-level permissions. Most modern systems contain native elevation control mechanisms that are intended to limit privileges that a user can perform on a machine. Authorization has to be granted to specific users in order to perform tasks that can be considered of higher risk.(Citation: TechNet How UAC Works)(Citation: sudo man page 2018) An adversary can perform several methods to take advantage of built-in control mechanisms in order to escalate privileges on a system.(Citation: OSX Keydnap malware)(Citation: Fortinet Fareit)",
        "detect_keywords": [
          "sudo",
          "setuid",
          "uac bypass",
          "runas",
          "提权",
          "绕过 uac"
        ],
        "detect_hints": "对话在使用 sudo、setuid、UAC 绕过等机制提权。"
      },
      {
        "id": "T1068",
        "name": "Exploitation for Privilege Escalation",
        "tactic_ids": [
          "TA0004"
        ],
        "description": "Adversaries may exploit software vulnerabilities in an attempt to elevate privileges. Exploitation of a software vulnerability occurs when an adversary takes advantage of a programming error in a program, service, or within the operating system software or kernel itself to execute adversary-controlled code. Security constructs such as permission levels will often hinder access to information and use of certain techniques, so adversaries will likely need to perform privilege escalation to include use of software exploitation to circumvent those restrictions. When initially gaining access to a system, an adversary may be operating within a lower privileged process which will prevent them from accessing certain resources on the system. Vulnerabilities may exist, usually in operating system components and software commonly running at higher permissions, that can be exploited to gain higher levels of access on the system. This could enable someone to move from unprivileged or user level permissions to SYSTEM or root permissions depending on the component that is vulnerable. This could also enable an adversary to move from a virtualized environment, such as within a virtual machine or container, onto the underlying host. This may be a necessary step for an adversary compromising an endpoint system that has been properly configured and limits other privilege escalation methods. Adversaries may bring a signed vulnerable driver onto a compromised machine so that they can exploit the vulnerability to execute code in kernel mode. This process is sometimes referred to as Bring Your Own Vulnerable Driver (BYOVD).(Citation: ESET InvisiMole June 2020)(Citation: Unit42 AcidBox June 2020) Adversaries may include the vulnerable driver with files delivered during Initial Access or download it to a compromised system via [Ingress Tool Transfer](https://attack.mitre.org/techniques/T1105) or [Lateral Tool Transfer](https://attack.mitre.org/techniques/T1570).",
        "detect_keywords": [
          "privilege escalation exploit",
          "kernel exploit",
          "local root",
          "suid exploit",
          "本地提权",
          "内核漏洞"
        ],
        "detect_hints": "对话在利用本地漏洞或配置缺陷提权到 root/SYSTEM。"
      },
      {
        "id": "T1055",
        "name": "Process Injection",
        "tactic_ids": [
          "TA0005",
          "TA0004"
        ],
        "description": "Adversaries may inject code into processes in order to evade process-based defenses as well as possibly elevate privileges. Process injection is a method of executing arbitrary code in the address space of a separate live process. Running code in the context of another process may allow access to the process's memory, system/network resources, and possibly elevated privileges. Execution via process injection may also evade detection from security products since the execution is masked under a legitimate process. There are many different ways to inject code into a process, many of which abuse legitimate functionalities. These implementations exist for every major OS but are typically platform specific. More sophisticated samples may perform multiple process injections to segment modules and further evade detection, utilizing named pipes or other inter-process communication (IPC) mechanisms as a communication channel.",
        "detect_keywords": [
          "process injection",
          "shellcode injection",
          "dll injection",
          "进程注入",
          "内存注入",
          "shellcode"
        ],
        "detect_hints": "对话在把代码注入其他进程以隐蔽执行。"
      },
      {
        "id": "T1070",
        "name": "Indicator Removal",
        "tactic_ids": [
          "TA0005"
        ],
        "description": "Adversaries may selectively delete or modify artifacts generated to reduce indications of their presence and blend in with legitimate activity. Rather than broadly removing evidence, adversaries may target specific artifacts that appear anomalous or are likely to draw scrutiny, while leaving sufficient data intact to maintain the appearance of normal system behavior. Artifacts such as command histories, log entries, or file metadata may be altered in ways that align with expected user or system activity. Location, format, and type of artifact (such as command or login history) are often platform-specific, allowing adversaries to tailor modifications that minimize suspicion. These actions may not prevent detection entirely but can delay recognition of malicious activity or reduce the fidelity of alerts by making events appear benign or consistent with routine operations. Additionally, selectively removed or modified artifacts may still be recoverable through deeper forensic analysis, though their absence or alteration can complicate timeline reconstruction and attribution.",
        "detect_keywords": [
          "clear logs",
          "delete history",
          "rm -rf /var/log",
          "wevtutil cl",
          "清除日志",
          "擦除痕迹",
          "删除历史"
        ],
        "detect_hints": "对话在清理日志、历史或痕迹以规避溯源。"
      },
      {
        "id": "T1027",
        "name": "Obfuscated Files or Information",
        "tactic_ids": [
          "TA0005"
        ],
        "description": "Adversaries may attempt to make an executable or file difficult to discover or analyze by encrypting, encoding, or otherwise obfuscating its contents on the system or in transit. This is common behavior that can be used across different platforms and the network to evade defenses. Payloads may be compressed, archived, or encrypted in order to avoid detection. These payloads may be used during Initial Access or later to mitigate detection. Sometimes a user's action may be required to open and [Deobfuscate/Decode Files or Information](https://attack.mitre.org/techniques/T1140) for [User Execution](https://attack.mitre.org/techniques/T1204). The user may also be required to input a password to open a password protected compressed/encrypted file that was provided by the adversary.(Citation: Volexity PowerDuke November 2016) Adversaries may also use compressed or archived scripts, such as JavaScript. Portions of files can also be encoded to hide the plain-text strings that would otherwise help defenders with discovery.(Citation: Linux/Cdorked.A We Live Security Analysis) Payloads may also be split into separate, seemingly benign files that only reveal malicious functionality when reassembled.(Citation: Carbon Black Obfuscation Sept 2016) Adversaries may also abuse [Command Obfuscation](https://attack.mitre.org/techniques/T1027/010) to obscure commands executed from payloads or directly via [Command and Scripting Interpreter](https://attack.mitre.org/techniques/T1059). Environment variables, aliases, characters, and other platform/language specific semantics can be used to evade signature based detections and application control mechanisms.(Citation: FireEye Obfuscation June 2017)(Citation: FireEye Revoke-Obfuscation July 2017)(Citation: PaloAlto EncodedCommand March 2017)",
        "detect_keywords": [
          "obfuscat",
          "packer",
          "encrypt payload",
          "base64 -d",
          "混淆",
          "加壳",
          "编码载荷"
        ],
        "detect_hints": "对话在对载荷做混淆、加壳或编码以躲过检测。"
      },
      {
        "id": "T1553",
        "name": "Subvert Trust Controls",
        "tactic_ids": [
          "TA0112"
        ],
        "description": "Adversaries may undermine security controls that will either warn users of untrusted activity or prevent execution of untrusted programs. Operating systems and security products may contain mechanisms to identify programs or websites as possessing some level of trust. Examples of such features would include a program being allowed to run because it is signed by a valid code signing certificate, a program prompting the user with a warning because it has an attribute set from being downloaded from the Internet, or getting an indication that you are about to connect to an untrusted site. Adversaries may attempt to subvert these trust mechanisms. The method adversaries use will depend on the specific mechanism they seek to subvert. Adversaries may conduct [File and Directory Permissions Modification](https://attack.mitre.org/techniques/T1222) or [Modify Registry](https://attack.mitre.org/techniques/T1112) in support of subverting these controls.(Citation: SpectorOps Subverting Trust Sept 2017) Adversaries may also create or steal code signing certificates to acquire trust on target systems.(Citation: Securelist Digital Certificates)(Citation: Symantec Digital Certificates)",
        "detect_keywords": [
          "disable signature",
          "self-signed certificate",
          "code signing bypass",
          "禁用签名校验",
          "自签证书",
          "绕过签名"
        ],
        "detect_hints": "对话在破坏签名或信任校验机制以放行未签名内容。"
      },
      {
        "id": "T1003",
        "name": "OS Credential Dumping",
        "tactic_ids": [
          "TA0006"
        ],
        "description": "Adversaries may attempt to dump credentials to obtain account login and credential material, normally in the form of a hash or a clear text password. Credentials can be obtained from OS caches, memory, or structures.(Citation: Brining MimiKatz to Unix) Credentials can then be used to perform [Lateral Movement](https://attack.mitre.org/tactics/TA0008) and access restricted information. Several of the tools mentioned in associated sub-techniques may be used by both adversaries and professional security testers. Additional custom tools likely exist as well.",
        "detect_keywords": [
          "mimikatz",
          "lsass dump",
          "sam file",
          "ntds.dit",
          "sekurlsa",
          "转储 lsass",
          "抓取哈希",
          "导出凭据"
        ],
        "detect_hints": "对话在转储 LSASS/SAM/NTDS 以提取账号口令或哈希。"
      },
      {
        "id": "T1110",
        "name": "Brute Force",
        "tactic_ids": [
          "TA0006"
        ],
        "description": "Adversaries may use brute force techniques to gain access to accounts when passwords are unknown or when password hashes are obtained.(Citation: TrendMicro Pawn Storm Dec 2020) Without knowledge of the password for an account or set of accounts, an adversary may systematically guess the password using a repetitive or iterative mechanism.(Citation: Dragos Crashoverride 2018) Brute forcing passwords can take place via interaction with a service that will check the validity of those credentials or offline against previously acquired credential data, such as password hashes. Brute forcing credentials may take place at various points during a breach. For example, adversaries may attempt to brute force access to [Valid Accounts](https://attack.mitre.org/techniques/T1078) within a victim environment leveraging knowledge gathered from other post-compromise behaviors such as [OS Credential Dumping](https://attack.mitre.org/techniques/T1003), [Account Discovery](https://attack.mitre.org/techniques/T1087), or [Password Policy Discovery](https://attack.mitre.org/techniques/T1201). Adversaries may also combine brute forcing activity with behaviors such as [External Remote Services](https://attack.mitre.org/techniques/T1133) as part of Initial Access. If an adversary guesses the correct password but fails to login to a compromised account due to location-based conditional access policies, they may change their infrastructure until they match the victim’s location and therefore bypass those policies.(Citation: ReliaQuest Health Care Social Engineering Campaign 2024)",
        "detect_keywords": [
          "brute force",
          "password spray",
          "hydra",
          "credential stuffing",
          "爆破",
          "撞库",
          "口令喷洒"
        ],
        "detect_hints": "对话在对账号做暴力破解、撞库或口令喷洒。"
      },
      {
        "id": "T1555",
        "name": "Credentials from Password Stores",
        "tactic_ids": [
          "TA0006"
        ],
        "description": "Adversaries may search for common password storage locations to obtain user credentials.(Citation: F-Secure The Dukes) Passwords are stored in several places on a system, depending on the operating system or application holding the credentials. There are also specific applications and services that store passwords to make them easier for users to manage and maintain, such as password managers and cloud secrets vaults. Once credentials are obtained, they can be used to perform lateral movement and access restricted information.",
        "detect_keywords": [
          "browser password",
          "keychain",
          "credential manager",
          "password store",
          "浏览器保存的密码",
          "钥匙串",
          "凭据管理器"
        ],
        "detect_hints": "对话在读取浏览器、钥匙串等密码存储里的凭据。"
      },
      {
        "id": "T1552",
        "name": "Unsecured Credentials",
        "tactic_ids": [
          "TA0006"
        ],
        "description": "Adversaries may search compromised systems to find and obtain insecurely stored credentials. These credentials can be stored and/or misplaced in many locations on a system, including plaintext files (e.g. [Shell History](https://attack.mitre.org/techniques/T1552/003)), operating system or application-specific repositories (e.g. [Credentials in Registry](https://attack.mitre.org/techniques/T1552/002)), or other specialized files/artifacts (e.g. [Private Keys](https://attack.mitre.org/techniques/T1552/004)).(Citation: Brining MimiKatz to Unix)",
        "detect_keywords": [
          ".env file",
          "hardcoded password",
          "config file credentials",
          "aws credentials",
          ".env 文件",
          "硬编码口令",
          "配置文件里的密钥"
        ],
        "detect_hints": "对话在翻配置文件、环境变量或代码里的明文凭据。"
      },
      {
        "id": "T1087",
        "name": "Account Discovery",
        "tactic_ids": [
          "TA0007"
        ],
        "description": "Adversaries may attempt to get a listing of valid accounts, usernames, or email addresses on a system or within a compromised environment. This information can help adversaries determine which accounts exist, which can aid in follow-on behavior such as brute-forcing, spear-phishing attacks, or account takeovers (e.g., [Valid Accounts](https://attack.mitre.org/techniques/T1078)). Adversaries may use several methods to enumerate accounts, including abuse of existing tools, built-in commands, and potential misconfigurations that leak account names and roles or permissions in the targeted environment. For examples, cloud environments typically provide easily accessible interfaces to obtain user lists.(Citation: AWS List Users)(Citation: Google Cloud - IAM Servie Accounts List API) On hosts, adversaries can use default [PowerShell](https://attack.mitre.org/techniques/T1059/001) and other command line functionality to identify accounts. Information about email addresses and accounts may also be extracted by searching an infected system’s files.",
        "detect_keywords": [
          "user enumeration",
          "list users",
          "whoami",
          "net user",
          "枚举账号",
          "列出用户"
        ],
        "detect_hints": "对话在枚举系统或域里的账号列表。"
      },
      {
        "id": "T1082",
        "name": "System Information Discovery",
        "tactic_ids": [
          "TA0007"
        ],
        "description": "An adversary may attempt to get detailed information about the operating system and hardware, including version, patches, hotfixes, service packs, and architecture. Adversaries may use this information to shape follow-on behaviors, including whether or not the adversary fully infects the target and/or attempts specific actions. This behavior is distinct from [Local Storage Discovery](https://attack.mitre.org/techniques/T1680) which is an adversary's discovery of local drive, disks and/or volumes. Tools such as [Systeminfo](https://attack.mitre.org/software/S0096) can be used to gather detailed system information. If running with privileged access, a breakdown of system data can be gathered through the <code>systemsetup</code> configuration tool on macOS. Adversaries may leverage a [Network Device CLI](https://attack.mitre.org/techniques/T1059/008) on network devices to gather detailed system information (e.g. <code>show version</code>).(Citation: US-CERT-TA18-106A) On ESXi servers, threat actors may gather system information from various esxcli utilities, such as `system hostname get` and `system version get`.(Citation: Crowdstrike Hypervisor Jackpotting Pt 2 2021)(Citation: Varonis) Infrastructure as a Service (IaaS) cloud providers such as AWS, GCP, and Azure allow access to instance and virtual machine information via APIs. Successful authenticated API calls can return data such as the operating system platform and status of a particular instance or the model view of a virtual machine.(Citation: Amazon Describe Instance)(Citation: Google Instances Resource)(Citation: Microsoft Virutal Machine API) [System Information Discovery](https://attack.mitre.org/techniques/T1082) combined with information gathered from other forms of discovery and reconnaissance can drive payload development and concealment.(Citation: OSX.FairyTale)(Citation: 20 macOS Common Tools and Techniques)",
        "detect_keywords": [
          "systeminfo",
          "uname -a",
          "os version",
          "hostname",
          "系统信息",
          "内核版本",
          "主机名"
        ],
        "detect_hints": "对话在收集目标系统版本、主机名等基础信息。"
      },
      {
        "id": "T1046",
        "name": "Network Service Discovery",
        "tactic_ids": [
          "TA0007"
        ],
        "description": "Adversaries may attempt to get a listing of services running on remote hosts and local network infrastructure devices, including those that may be vulnerable to remote software exploitation. Common methods to acquire this information include port, vulnerability, and/or wordlist scans using tools that are brought onto a system.(Citation: CISA AR21-126A FIVEHANDS May 2021) Within cloud environments, adversaries may attempt to discover services running on other cloud hosts. Additionally, if the cloud environment is connected to a on-premises environment, adversaries may be able to identify services running on non-cloud systems as well. Within macOS environments, adversaries may use the native Bonjour application to discover services running on other macOS hosts within a network. The Bonjour mDNSResponder daemon automatically registers and advertises a host’s registered services on the network. For example, adversaries can use a mDNS query (such as <code>dns-sd -B _ssh._tcp .</code>) to find other systems broadcasting the ssh service.(Citation: apple doco bonjour description)(Citation: macOS APT Activity Bradley)",
        "detect_keywords": [
          "port scan",
          "service discovery",
          "nmap -sV",
          "open ports",
          "服务探测",
          "开放端口",
          "服务识别"
        ],
        "detect_hints": "对话在扫描开放端口与服务以摸清可攻击面。"
      },
      {
        "id": "T1018",
        "name": "Remote System Discovery",
        "tactic_ids": [
          "TA0007"
        ],
        "description": "Adversaries may attempt to get a listing of other systems by IP address, hostname, or other logical identifier on a network that may be used for Lateral Movement from the current system. Functionality could exist within remote access tools to enable this, but utilities available on the operating system could also be used such as [Ping](https://attack.mitre.org/software/S0097), <code>net view</code> using [Net](https://attack.mitre.org/software/S0039), or, on ESXi servers, `esxcli network diag ping`. Adversaries may also analyze data from local host files (ex: <code>C:\\Windows\\System32\\Drivers\\etc\\hosts</code> or <code>/etc/hosts</code>) or other passive means (such as local [Arp](https://attack.mitre.org/software/S0099) cache entries) in order to discover the presence of remote systems in an environment. Adversaries may also target discovery of network infrastructure as well as leverage [Network Device CLI](https://attack.mitre.org/techniques/T1059/008) commands on network devices to gather detailed information about systems within a network (e.g. <code>show cdp neighbors</code>, <code>show arp</code>).(Citation: US-CERT-TA18-106A)(Citation: CISA AR21-126A FIVEHANDS May 2021)",
        "detect_keywords": [
          "network scan",
          "arp scan",
          "ping sweep",
          "net view",
          "存活主机",
          "内网扫描",
          "网段探测"
        ],
        "detect_hints": "对话在探测内网存活主机以规划横向移动。"
      },
      {
        "id": "T1069",
        "name": "Permission Groups Discovery",
        "tactic_ids": [
          "TA0007"
        ],
        "description": "Adversaries may attempt to discover group and permission settings. This information can help adversaries determine which user accounts and groups are available, the membership of users in particular groups, and which users and groups have elevated permissions. Adversaries may attempt to discover group permission settings in many different ways. This data may provide the adversary with information about the compromised environment that can be used in follow-on activity and targeting.(Citation: CrowdStrike BloodHound April 2018)",
        "detect_keywords": [
          "group enumeration",
          "domain admins",
          "list groups",
          "枚举用户组",
          "域管理员组"
        ],
        "detect_hints": "对话在枚举权限组来定位高价值账号。"
      },
      {
        "id": "T1518",
        "name": "Software Discovery",
        "tactic_ids": [
          "TA0007"
        ],
        "description": "Adversaries may attempt to get a listing of software and software versions that are installed on a system or in a cloud environment. Adversaries may use the information from [Software Discovery](https://attack.mitre.org/techniques/T1518) during automated discovery to shape follow-on behaviors, including whether or not the adversary fully infects the target and/or attempts specific actions. Such software may be deployed widely across the environment for configuration management or security reasons, such as [Software Deployment Tools](https://attack.mitre.org/techniques/T1072), and may allow adversaries broad access to infect devices or move laterally. Adversaries may attempt to enumerate software for a variety of reasons, such as figuring out what security measures are present or if the compromised system has a version of software that is vulnerable to [Exploitation for Privilege Escalation](https://attack.mitre.org/techniques/T1068).",
        "detect_keywords": [
          "installed software",
          "software inventory",
          "version detection",
          "已安装软件",
          "软件版本",
          "组件清单"
        ],
        "detect_hints": "对话在盘点目标上装的软件与版本，便于匹配已知漏洞。"
      },
      {
        "id": "T1560",
        "name": "Archive Collected Data",
        "tactic_ids": [
          "TA0009"
        ],
        "description": "An adversary may compress and/or encrypt data that is collected prior to exfiltration. Compressing the data can help to obfuscate the collected data and minimize the amount of data sent over the network.(Citation: DOJ GRU Indictment Jul 2018) Encryption can be used to hide information that is being exfiltrated from detection or make exfiltration less conspicuous upon inspection by a defender. Both compression and encryption are done prior to exfiltration, and can be performed using a utility, 3rd party library, or custom method.",
        "detect_keywords": [
          "zip the data",
          "tar czf",
          "archive and exfil",
          "压缩打包",
          "打包外带"
        ],
        "detect_hints": "对话在把收集到的数据压缩打包以便外带。"
      },
      {
        "id": "T1530",
        "name": "Data from Cloud Storage",
        "tactic_ids": [
          "TA0009"
        ],
        "description": "Adversaries may access data from cloud storage. Many IaaS providers offer solutions for online data object storage such as Amazon S3, Azure Storage, and Google Cloud Storage. Similarly, SaaS enterprise platforms such as Office 365 and Google Workspace provide cloud-based document storage to users through services such as OneDrive and Google Drive, while SaaS application providers such as Slack, Confluence, Salesforce, and Dropbox may provide cloud storage solutions as a peripheral or primary use case of their platform. In some cases, as with IaaS-based cloud storage, there exists no overarching application (such as SQL or Elasticsearch) with which to interact with the stored objects: instead, data from these solutions is retrieved directly though the [Cloud API](https://attack.mitre.org/techniques/T1059/009). In SaaS applications, adversaries may be able to collect this data directly from APIs or backend cloud storage objects, rather than through their front-end application or interface (i.e., [Data from Information Repositories](https://attack.mitre.org/techniques/T1213)). Adversaries may collect sensitive data from these cloud storage solutions. Providers typically offer security guides to help end users configure systems, though misconfigurations are a common problem.(Citation: Amazon S3 Security, 2019)(Citation: Microsoft Azure Storage Security, 2019)(Citation: Google Cloud Storage Best Practices, 2019) There have been numerous incidents where cloud storage has been improperly secured, typically by unintentionally allowing public access to unauthenticated users, overly-broad access by all users, or even access for any anonymous person outside the control of the Identity Access Management system without even needing basic user permissions. This open access may expose various types of sensitive data, such as credit cards, personally identifiable information, or medical records.(Citation: Trend Micro S3 Exposed PII, 2017)(Citation: Wired Magecart S3 Buckets, 2019)(Citation: HIPAA Journal S3 Breach, 2017)(Citation: Rclone-mega-extortion_05_2021) Adversaries may also obtain then abuse leaked credentials from source repositories, logs, or other means as a way to gain access to cloud storage objects.",
        "detect_keywords": [
          "s3 bucket",
          "oss bucket",
          "cloud storage",
          "blob storage",
          "对象存储",
          "云存储桶",
          "存储桶权限"
        ],
        "detect_hints": "对话在访问或枚举云对象存储里的数据。"
      },
      {
        "id": "T1114",
        "name": "Email Collection",
        "tactic_ids": [
          "TA0009"
        ],
        "description": "Adversaries may target user email to collect sensitive information. Emails may contain sensitive data, including trade secrets or personal information, that can prove valuable to adversaries. Emails may also contain details of ongoing incident response operations, which may allow adversaries to adjust their techniques in order to maintain persistence or evade defenses.(Citation: TrustedSec OOB Communications)(Citation: CISA AA20-352A 2021) Adversaries can collect or forward email from mail servers or clients.",
        "detect_keywords": [
          "mailbox",
          "export email",
          "imap",
          "exchange",
          "邮箱导出",
          "读取邮件",
          "邮件归档"
        ],
        "detect_hints": "对话在收集目标邮箱里的邮件内容。"
      },
      {
        "id": "T1071",
        "name": "Application Layer Protocol",
        "tactic_ids": [
          "TA0011"
        ],
        "description": "Adversaries may communicate using OSI application layer protocols to avoid detection/network filtering by blending in with existing traffic. Commands to the remote system, and often the results of those commands, will be embedded within the protocol traffic between the client and server. Adversaries may utilize many different protocols, including those used for web browsing, transferring files, electronic mail, DNS, or publishing/subscribing. For connections that occur internally within an enclave (such as those between a proxy or pivot node and other nodes), commonly used protocols are SMB, SSH, or RDP.(Citation: Mandiant APT29 Eye Spy Email Nov 22)",
        "detect_keywords": [
          "http beacon",
          "dns tunnel",
          "c2 over http",
          "beacon interval",
          "心跳回连",
          "dns 隧道",
          "http 回连"
        ],
        "detect_hints": "对话在搭建基于 HTTP/DNS 等应用层协议的 C2 通道。"
      },
      {
        "id": "T1102",
        "name": "Web Service",
        "tactic_ids": [
          "TA0011"
        ],
        "description": "Adversaries may use an existing, legitimate external Web service as a means for relaying data to/from a compromised system. Popular websites, cloud services, and social media acting as a mechanism for C2 may give a significant amount of cover due to the likelihood that hosts within a network are already communicating with them prior to a compromise. Using common services, such as those offered by Google, Microsoft, or Twitter, makes it easier for adversaries to hide in expected noise.(Citation: Broadcom BirdyClient Microsoft Graph API 2024) Web service providers commonly use SSL/TLS encryption, giving adversaries an added level of protection. Use of Web services may also protect back-end C2 infrastructure from discovery through malware binary analysis while also enabling operational resiliency (since this infrastructure may be dynamically changed).",
        "detect_keywords": [
          "pastebin",
          "github gist",
          "telegram bot",
          "discord webhook",
          "web service c2",
          "用网盘做 c2",
          "公开服务回连"
        ],
        "detect_hints": "对话借用合法 Web 服务（网盘、代码托管、IM）作为 C2。"
      },
      {
        "id": "T1090",
        "name": "Proxy",
        "tactic_ids": [
          "TA0011"
        ],
        "description": "Adversaries may use a connection proxy to direct network traffic between systems or act as an intermediary for network communications to a command and control server to avoid direct connections to their infrastructure. Many tools exist that enable traffic redirection through proxies or port redirection, including [HTRAN](https://attack.mitre.org/software/S0040), ZXProxy, and ZXPortMap. (Citation: Trend Micro APT Attack Tools) Adversaries use these types of proxies to manage command and control communications, reduce the number of simultaneous outbound network connections, provide resiliency in the face of connection loss, or to ride over existing trusted communications paths between victims to avoid suspicion. Adversaries may chain together multiple proxies to further disguise the source of malicious traffic. Adversaries can also take advantage of routing schemes in Content Delivery Networks (CDNs) to proxy command and control traffic.",
        "detect_keywords": [
          "socks proxy",
          "ssh tunnel",
          "port forward",
          "chisel",
          "frp",
          "代理隧道",
          "端口转发",
          "内网穿透"
        ],
        "detect_hints": "对话在架代理或隧道隐藏来源、穿透内网。"
      },
      {
        "id": "T1041",
        "name": "Exfiltration Over C2 Channel",
        "tactic_ids": [
          "TA0010"
        ],
        "description": "Adversaries may steal data by exfiltrating it over an existing command and control channel. Stolen data is encoded into the normal communications channel using the same protocol as command and control communications.",
        "detect_keywords": [
          "exfil over c2",
          "send data back",
          "上传到 c2",
          "经 c2 外带"
        ],
        "detect_hints": "对话把数据经已有的 C2 通道传回。"
      },
      {
        "id": "T1567",
        "name": "Exfiltration Over Web Service",
        "tactic_ids": [
          "TA0010"
        ],
        "description": "Adversaries may use an existing, legitimate external Web service to exfiltrate data rather than their primary command and control channel. Popular Web services acting as an exfiltration mechanism may give a significant amount of cover due to the likelihood that hosts within a network are already communicating with them prior to compromise. Firewall rules may also already exist to permit traffic to these services. Web service providers also commonly use SSL/TLS encryption, giving adversaries an added level of protection.",
        "detect_keywords": [
          "upload to web service",
          "exfil via api",
          "paste the data",
          "上传网盘",
          "经接口外带",
          "上传到公开服务"
        ],
        "detect_hints": "对话把数据上传到 Web 服务或 API 外带。"
      },
      {
        "id": "T1048",
        "name": "Exfiltration Over Alternative Protocol",
        "tactic_ids": [
          "TA0010"
        ],
        "description": "Adversaries may steal data by exfiltrating it over a different protocol than that of the existing command and control channel. The data may also be sent to an alternate network location from the main command and control server. Alternate protocols include FTP, SMTP, HTTP/S, DNS, SMB, or any other network protocol not being used as the main command and control channel. Adversaries may also opt to encrypt and/or obfuscate these alternate channels. [Exfiltration Over Alternative Protocol](https://attack.mitre.org/techniques/T1048) can be done using various common operating system utilities such as [Net](https://attack.mitre.org/software/S0039)/SMB or FTP.(Citation: Palo Alto OilRig Oct 2016) On macOS and Linux <code>curl</code> may be used to invoke protocols such as HTTP/S or FTP/S to exfiltrate data from a system.(Citation: 20 macOS Common Tools and Techniques) Many IaaS and SaaS platforms (such as Microsoft Exchange, Microsoft SharePoint, GitHub, and AWS S3) support the direct download of files, emails, source code, and other sensitive information via the web console or [Cloud API](https://attack.mitre.org/techniques/T1059/009).",
        "detect_keywords": [
          "dns exfil",
          "icmp tunnel",
          "ftp exfil",
          "dns 外带",
          "icmp 隧道",
          "非标准协议外发"
        ],
        "detect_hints": "对话用 DNS、ICMP 等非标准协议外带数据。"
      },
      {
        "id": "T1485",
        "name": "Data Destruction",
        "tactic_ids": [
          "TA0040"
        ],
        "description": "Adversaries may destroy data and files on specific systems or in large numbers on a network to interrupt availability to systems, services, and network resources. Data destruction is likely to render stored data irrecoverable by forensic techniques through overwriting files or data on local and remote drives.(Citation: Symantec Shamoon 2012)(Citation: FireEye Shamoon Nov 2016)(Citation: Palo Alto Shamoon Nov 2016)(Citation: Kaspersky StoneDrill 2017)(Citation: Unit 42 Shamoon3 2018)(Citation: Talos Olympic Destroyer 2018) Common operating system file deletion commands such as <code>del</code> and <code>rm</code> often only remove pointers to files without wiping the contents of the files themselves, making the files recoverable by proper forensic methodology. This behavior is distinct from [Disk Content Wipe](https://attack.mitre.org/techniques/T1561/001) and [Disk Structure Wipe](https://attack.mitre.org/techniques/T1561/002) because individual files are destroyed rather than sections of a storage disk or the disk's logical structure. Adversaries may attempt to overwrite files and directories with randomly generated data to make it irrecoverable.(Citation: Kaspersky StoneDrill 2017)(Citation: Unit 42 Shamoon3 2018) In some cases politically oriented image files have been used to overwrite data.(Citation: FireEye Shamoon Nov 2016)(Citation: Palo Alto Shamoon Nov 2016)(Citation: Kaspersky StoneDrill 2017) To maximize impact on the target organization in operations where network-wide availability interruption is the goal, malware designed for destroying data may have worm-like features to propagate across a network by leveraging additional techniques like [Valid Accounts](https://attack.mitre.org/techniques/T1078), [OS Credential Dumping](https://attack.mitre.org/techniques/T1003), and [SMB/Windows Admin Shares](https://attack.mitre.org/techniques/T1021/002).(Citation: Symantec Shamoon 2012)(Citation: FireEye Shamoon Nov 2016)(Citation: Palo Alto Shamoon Nov 2016)(Citation: Kaspersky StoneDrill 2017)(Citation: Talos Olympic Destroyer 2018). In cloud environments, adversaries may leverage access to delete cloud storage objects, machine images, database instances, and other infrastructure crucial to operations to damage an organization or their customers.(Citation: Data Destruction - Threat Post)(Citation: DOJ - Cisco Insider) Similarly, they may delete virtual machines from on-prem virtualized environments.",
        "detect_keywords": [
          "destroy data",
          "rm -rf",
          "wipe",
          "shred",
          "drop database",
          "删除数据",
          "数据销毁",
          "清库"
        ],
        "detect_hints": "对话在删除或销毁目标数据与文件。"
      },
      {
        "id": "T1486",
        "name": "Data Encrypted for Impact",
        "tactic_ids": [
          "TA0040"
        ],
        "description": "Adversaries may encrypt data on target systems or on large numbers of systems in a network to interrupt availability to system and network resources. They can attempt to render stored data inaccessible by encrypting files or data on local and remote drives and withholding access to a decryption key. This may be done in order to extract monetary compensation from a victim in exchange for decryption or a decryption key (ransomware) or to render data permanently inaccessible in cases where the key is not saved or transmitted.(Citation: US-CERT Ransomware 2016)(Citation: FireEye WannaCry 2017)(Citation: US-CERT NotPetya 2017)(Citation: US-CERT SamSam 2018) In the case of ransomware, it is typical that common user files like Office documents, PDFs, images, videos, audio, text, and source code files will be encrypted (and often renamed and/or tagged with specific file markers). Adversaries may need to first employ other behaviors, such as [File and Directory Permissions Modification](https://attack.mitre.org/techniques/T1222) or [System Shutdown/Reboot](https://attack.mitre.org/techniques/T1529), in order to unlock and/or gain access to manipulate these files.(Citation: CarbonBlack Conti July 2020) In some cases, adversaries may encrypt critical system files, disk partitions, and the MBR.(Citation: US-CERT NotPetya 2017) Adversaries may also encrypt virtual machines hosted on ESXi or other hypervisors.(Citation: Crowdstrike Hypervisor Jackpotting Pt 2 2021) To maximize impact on the target organization, malware designed for encrypting data may have worm-like features to propagate across a network by leveraging other attack techniques like [Valid Accounts](https://attack.mitre.org/techniques/T1078), [OS Credential Dumping](https://attack.mitre.org/techniques/T1003), and [SMB/Windows Admin Shares](https://attack.mitre.org/techniques/T1021/002).(Citation: FireEye WannaCry 2017)(Citation: US-CERT NotPetya 2017) Encryption malware may also leverage [Internal Defacement](https://attack.mitre.org/techniques/T1491/001), such as changing victim wallpapers or ESXi server login messages, or otherwise intimidate victims by sending ransom notes or other messages to connected printers (known as \"print bombing\").(Citation: NHS Digital Egregor Nov 2020)(Citation: Varonis) In cloud environments, storage objects within compromised accounts may also be encrypted.(Citation: Rhino S3 Ransomware Part 1) For example, in AWS environments, adversaries may leverage services such as AWS’s Server-Side Encryption with Customer Provided Keys (SSE-C) to encrypt data.(Citation: Halcyon AWS Ransomware 2025)",
        "detect_keywords": [
          "ransomware",
          "encrypt files",
          "ransom note",
          "勒索",
          "加密文件",
          "勒索信"
        ],
        "detect_hints": "对话涉及加密目标文件并索要赎金。"
      },
      {
        "id": "T1490",
        "name": "Inhibit System Recovery",
        "tactic_ids": [
          "TA0040"
        ],
        "description": "Adversaries may delete or remove built-in data and turn off services designed to aid in the recovery of a corrupted system to prevent recovery.(Citation: Talos Olympic Destroyer 2018)(Citation: FireEye WannaCry 2017) This may deny access to available backups and recovery options. Operating systems may contain features that can help fix corrupted systems, such as a backup catalog, volume shadow copies, and automatic repair features. Adversaries may disable or delete system recovery features to augment the effects of [Data Destruction](https://attack.mitre.org/techniques/T1485) and [Data Encrypted for Impact](https://attack.mitre.org/techniques/T1486).(Citation: Talos Olympic Destroyer 2018)(Citation: FireEye WannaCry 2017) Furthermore, adversaries may disable recovery notifications, then corrupt backups.(Citation: disable_notif_synology_ransom) A number of native Windows utilities have been used by adversaries to disable or delete system recovery features: * <code>vssadmin.exe</code> can be used to delete all volume shadow copies on a system - <code>vssadmin.exe delete shadows /all /quiet</code> * [Windows Management Instrumentation](https://attack.mitre.org/techniques/T1047) can be used to delete volume shadow copies - <code>wmic shadowcopy delete</code> * <code>wbadmin.exe</code> can be used to delete the Windows Backup Catalog - <code>wbadmin.exe delete catalog -quiet</code> * <code>bcdedit.exe</code> can be used to disable automatic Windows recovery features by modifying boot configuration data - <code>bcdedit.exe /set {default} bootstatuspolicy ignoreallfailures & bcdedit /set {default} recoveryenabled no</code> * <code>REAgentC.exe</code> can be used to disable Windows Recovery Environment (WinRE) repair/recovery options of an infected system * <code>diskshadow.exe</code> can be used to delete all volume shadow copies on a system - <code>diskshadow delete shadows all</code> (Citation: Diskshadow) (Citation: Crytox Ransomware) On network devices, adversaries may leverage [Disk Wipe](https://attack.mitre.org/techniques/T1561) to delete backup firmware images and reformat the file system, then [System Shutdown/Reboot](https://attack.mitre.org/techniques/T1529) to reload the device. Together this activity may leave network devices completely inoperable and inhibit recovery operations. On ESXi servers, adversaries may delete or encrypt snapshots of virtual machines to support [Data Encrypted for Impact](https://attack.mitre.org/techniques/T1486), preventing them from being leveraged as backups (e.g., via ` vim-cmd vmsvc/snapshot.removeall`).(Citation: Cybereason) Adversaries may also delete “online” backups that are connected to their network – whether via network storage media or through folders that sync to cloud services.(Citation: ZDNet Ransomware Backups 2020) In cloud environments, adversaries may disable versioning and backup policies and delete snapshots, database backups, machine images, and prior versions of objects designed to be used in disaster recovery scenarios.(Citation: Dark Reading Code Spaces Cyber Attack)(Citation: Rhino Security Labs AWS S3 Ransomware)",
        "detect_keywords": [
          "delete shadow copy",
          "disable recovery",
          "vssadmin delete",
          "bcdedit",
          "删除卷影",
          "关闭恢复",
          "破坏备份"
        ],
        "detect_hints": "对话在删除卷影副本、关闭恢复以阻碍还原。"
      },
      {
        "id": "T1489",
        "name": "Service Stop",
        "tactic_ids": [
          "TA0040"
        ],
        "description": "Adversaries may stop or disable services on a system to render those services unavailable to legitimate users. Stopping critical services or processes can inhibit or stop response to an incident or aid in the adversary's overall objectives to cause damage to the environment.(Citation: Talos Olympic Destroyer 2018)(Citation: Novetta Blockbuster) Adversaries may accomplish this by disabling individual services of high importance to an organization, such as <code>MSExchangeIS</code>, which will make Exchange content inaccessible.(Citation: Novetta Blockbuster) In some cases, adversaries may stop or disable many or all services to render systems unusable.(Citation: Talos Olympic Destroyer 2018) Services or processes may not allow for modification of their data stores while running. Adversaries may stop services or processes in order to conduct [Data Destruction](https://attack.mitre.org/techniques/T1485) or [Data Encrypted for Impact](https://attack.mitre.org/techniques/T1486) on the data stores of services like Exchange and SQL Server, or on virtual machines hosted on ESXi infrastructure.(Citation: SecureWorks WannaCry Analysis)(Citation: Crowdstrike Hypervisor Jackpotting Pt 2 2021) Threat actors may also disable or stop service in cloud environments. For example, by leveraging the `DisableAPIServiceAccess` API in AWS, a threat actor may prevent the service from creating service-linked roles on new accounts in the AWS Organization.(Citation: Datadog Security Labs Cloud Persistence 2025)(Citation: AWS DisableAWSServiceAccess)",
        "detect_keywords": [
          "stop service",
          "kill process",
          "systemctl stop",
          "net stop",
          "停服务",
          "杀进程",
          "停掉数据库"
        ],
        "detect_hints": "对话在停掉关键服务或进程造成业务中断。"
      },
      {
        "id": "T1491",
        "name": "Defacement",
        "tactic_ids": [
          "TA0040"
        ],
        "description": "Adversaries may modify visual content available internally or externally to an enterprise network, thus affecting the integrity of the original content. Reasons for [Defacement](https://attack.mitre.org/techniques/T1491) include delivering messaging, intimidation, or claiming (possibly false) credit for an intrusion. Disturbing or offensive images may be used as a part of [Defacement](https://attack.mitre.org/techniques/T1491) in order to cause user discomfort, or to pressure compliance with accompanying messages.",
        "detect_keywords": [
          "deface",
          "replace homepage",
          "website defacement",
          "篡改首页",
          "挂黑页",
          "网页篡改"
        ],
        "detect_hints": "对话在篡改对外网页内容。"
      }
    ],
  },

  {
    id: "owasp-llm",
    name: "OWASP Top 10 for LLM Applications 2025",
    short: "OWASP LLM",
    source: "OWASP Top 10 for LLM Applications 2025（条目 ID/名称取自官方仓库 2_0_vulns 目录），https://genai.owasp.org/llm-top-10/",
    tactics: [],
    techniques: [
      {
        "id": "LLM01",
        "name": "Prompt Injection",
        "tactic_ids": [],
        "description": "用户或第三方内容以非预期方式改变模型行为或输出，含直接注入与经检索/抓取内容的间接注入。",
        "detect_keywords": [
          "prompt injection",
          "ignore previous instructions",
          "ignore all previous",
          "jailbreak",
          "developer mode",
          "提示词注入",
          "忽略之前的指令",
          "越狱"
        ],
        "detect_hints": "出现试图覆盖或追加系统指令的消息，或在检索文档、工具输出、网页内容里埋指令并被模型执行。"
      },
      {
        "id": "LLM02",
        "name": "Sensitive Information Disclosure",
        "tactic_ids": [],
        "description": "模型或其应用上下文泄露个人信息、凭据、财务/健康记录、商业机密或模型自身细节。",
        "detect_keywords": [
          "sensitive information",
          "pii",
          "training data leak",
          "api key",
          "credential leak",
          "敏感信息",
          "数据泄露",
          "个人信息"
        ],
        "detect_hints": "模型主动吐出真实个人数据、密钥或被记忆的训练内容，或测试者用定向提问索取本不该拿到的数据。"
      },
      {
        "id": "LLM03",
        "name": "Supply Chain",
        "tactic_ids": [],
        "description": "LLM 供应链（训练数据、模型、适配器、部署平台）被污染，导致输出偏差、后门或系统故障。",
        "detect_keywords": [
          "supply chain",
          "third-party model",
          "huggingface",
          "safetensors",
          "malicious pickle",
          "供应链",
          "模型来源",
          "第三方模型"
        ],
        "detect_hints": "讨论或测试不可信的预训练模型、数据集、插件与依赖包，含恶意模型文件、被篡改的模型仓库或过期组件。"
      },
      {
        "id": "LLM04",
        "name": "Data and Model Poisoning",
        "tactic_ids": [],
        "description": "预训练、微调或嵌入数据被操纵，向模型植入后门、偏差或退化行为。",
        "detect_keywords": [
          "data poisoning",
          "model poisoning",
          "backdoor trigger",
          "trigger phrase",
          "fine-tuning data",
          "sleeper agent",
          "数据投毒",
          "后门"
        ],
        "detect_hints": "尝试污染训练/微调数据、植入触发词让模型在特定短语下作恶，或验证已植入的后门是否生效。"
      },
      {
        "id": "LLM05",
        "name": "Improper Output Handling",
        "tactic_ids": [],
        "description": "模型输出未经充分校验或净化就交给下游，导致 XSS、SQL 注入、命令注入或 SSRF。",
        "detect_keywords": [
          "improper output handling",
          "unsanitized output",
          "markdown injection",
          "script tag",
          "输出未过滤",
          "输出处理"
        ],
        "detect_hints": "诱导模型输出会被下游直接执行或渲染的载荷（script 标签、SQL、shell 命令、URL）而下游未净化。"
      },
      {
        "id": "LLM06",
        "name": "Excessive Agency",
        "tactic_ids": [],
        "description": "基于 LLM 的系统通过扩展、工具或插件获得过多功能、权限或自主性，可被提示驱动做出破坏性动作。",
        "detect_keywords": [
          "excessive agency",
          "over-privileged tool",
          "plugin permission",
          "autonomous execution",
          "过度代理",
          "越权操作",
          "自主执行"
        ],
        "detect_hints": "模型调用带真实副作用的工具/函数/代理动作，尤其在被注入或构造的输入下触发破坏性、特权或未确认的操作。"
      },
      {
        "id": "LLM07",
        "name": "System Prompt Leakage",
        "tactic_ids": [],
        "description": "引导模型的系统提示词被暴露，泄露其中的敏感内容、防护规则或凭据。",
        "detect_keywords": [
          "system prompt",
          "repeat your instructions",
          "reveal your prompt",
          "initial instructions",
          "system message leak",
          "系统提示词",
          "提示词泄露",
          "复述你的指令"
        ],
        "detect_hints": "请求打印、复述、翻译、编码或总结模型的隐藏指令，或模型把自己的系统提示词回显给用户。"
      },
      {
        "id": "LLM08",
        "name": "Vector and Embedding Weaknesses",
        "tactic_ids": [],
        "description": "向量与嵌入在生成、存储、检索环节的弱点，使 RAG 系统可被注入内容、泄露数据或跨租户检索。",
        "detect_keywords": [
          "vector database",
          "embedding inversion",
          "similarity search",
          "knowledge base poisoning",
          "cross-tenant retrieval",
          "向量数据库",
          "嵌入反转",
          "检索增强"
        ],
        "detect_hints": "操纵 RAG 知识库、嵌入索引或相似度检索，例如植入投毒文档、反转嵌入或取到其他租户的内容。"
      },
      {
        "id": "LLM09",
        "name": "Misinformation",
        "tactic_ids": [],
        "description": "模型产出看似可信的虚假或误导信息，含幻觉、无依据断言与编造引用。",
        "detect_keywords": [
          "hallucination",
          "misinformation",
          "fabricated citation",
          "made-up reference",
          "false claim",
          "幻觉",
          "虚假信息",
          "捏造"
        ],
        "detect_hints": "模型自信地断言假事实、编造来源或 API，或测试者专门探测其断言的准确性。"
      },
      {
        "id": "LLM10",
        "name": "Unbounded Consumption",
        "tactic_ids": [],
        "description": "推理未设上限，导致拒绝服务、资源耗尽、成本放大或经由海量请求的模型窃取。",
        "detect_keywords": [
          "unbounded consumption",
          "denial of service",
          "resource exhaustion",
          "cost amplification",
          "model extraction",
          "资源耗尽",
          "拒绝服务"
        ],
        "detect_hints": "超长或重复输入、递归自膨胀提示、大量并发请求，意图耗尽 token/算力/预算，或通过批量请求提取模型。"
      }
    ],
  },

  {
    id: "nvidia-kill-chain",
    name: "NVIDIA AI Kill Chain",
    short: "NVIDIA Kill Chain",
    source: "NVIDIA Technical Blog, \"Modeling Attacks on AI-Powered Apps with the AI Kill Chain Framework\" (2025-09-11), https://developer.nvidia.com/blog/modeling-attacks-on-ai-powered-apps-with-the-ai-kill-chain-framework/",
    tactics: [
      {
        "id": "recon",
        "name": "recon",
        "description": "摸清数据流向、工具与 MCP 服务、开源库、护栏位置与系统记忆，常以交互式探测错误与行为来规划精准攻击。"
      },
      {
        "id": "poison",
        "name": "poison",
        "description": "把恶意输入放进最终会被模型处理的位置，最常见的是直接或间接提示词注入。"
      },
      {
        "id": "hijack",
        "name": "hijack",
        "description": "poison 阶段植入的输入被模型摄入并夺取其输出，攻击由此转入活跃状态、开始服务攻击者目标。"
      },
      {
        "id": "persist",
        "name": "persist",
        "description": "把载荷嵌入会话历史、跨会话记忆、共享资源或代理计划，让影响在同一会话内甚至跨会话、跨用户存续。"
      },
      {
        "id": "iterate-pivot",
        "name": "iterate or pivot",
        "description": "NVIDIA 的 iterate/pivot 分支：在代理型系统里攻击者利用反馈回路横向转移、反复改写代理计划或建立 C2，把 persist 接回 poison。"
      },
      {
        "id": "impact",
        "name": "impact",
        "description": "攻击者目标兑现：被夺取的输出触发动作，影响到模型之外的系统、数据或用户。"
      }
    ],
    techniques: [
      {
        "id": "nv-recon-route-mapping",
        "name": "数据流路径测绘",
        "tactic_ids": [
          "recon"
        ],
        "description": "枚举攻击者可控数据能到达模型的每一条路径。",
        "detect_keywords": [
          "data flow",
          "ingestion path",
          "input route",
          "数据流",
          "输入路径"
        ],
        "detect_hints": "对话在追问不可信内容如何抵达模型，或梳理有哪些上传点、连接器、摄取路径喂给 LLM。"
      },
      {
        "id": "nv-recon-tool-enum",
        "name": "工具与 MCP 服务枚举",
        "tactic_ids": [
          "recon"
        ],
        "description": "枚举应用暴露的工具、MCP 服务或其他函数，寻找可利用能力。",
        "detect_keywords": [
          "mcp server",
          "tool manifest",
          "function schema",
          "available tools",
          "工具清单",
          "可用工具"
        ],
        "detect_hints": "对话在套取或列出代理可调用的工具、函数 schema、MCP 服务及其参数。"
      },
      {
        "id": "nv-recon-guardrail-probing",
        "name": "护栏位置探测",
        "tactic_ids": [
          "recon"
        ],
        "description": "判断系统护栏施加在何处、如何工作，以便绕开。",
        "detect_keywords": [
          "guardrail",
          "input filter",
          "safety filter",
          "moderation layer",
          "防护栏",
          "绕过过滤"
        ],
        "detect_hints": "对话在探测哪些输入会被拦、过滤放在哪一层，或如何规避某个具体护栏。"
      },
      {
        "id": "nv-recon-memory-probing",
        "name": "系统记忆探测",
        "tactic_ids": [
          "recon"
        ],
        "description": "摸清应用使用哪类系统记忆，以寻找可长期驻留的落脚点。",
        "detect_keywords": [
          "conversation memory",
          "vector store",
          "long-term memory",
          "长期记忆",
          "向量库"
        ],
        "detect_hints": "对话在问系统是否记得之前轮次、记忆存哪、是否跨会话保留。"
      },
      {
        "id": "nv-recon-observability-probing",
        "name": "交互式报错与行为探测",
        "tactic_ids": [
          "recon"
        ],
        "description": "反复交互观察报错与行为，把可观测性转成更精准的下一步。",
        "detect_keywords": [
          "error message",
          "stack trace",
          "parsing error",
          "debug output",
          "报错信息",
          "错误堆栈"
        ],
        "detect_hints": "对话反复投喂畸形或边界输入，以套出报错文本、堆栈或系统提示词。"
      },
      {
        "id": "nv-recon-open-source-lib-recon",
        "name": "开源库侦察",
        "tactic_ids": [
          "recon"
        ],
        "description": "识别应用使用的开源库与组件版本，比对已知漏洞。",
        "detect_keywords": [
          "library version",
          "known cve",
          "framework version",
          "dependency version",
          "开源库",
          "依赖版本"
        ],
        "detect_hints": "对话在问目标应用基于哪个框架/库、什么版本，以便匹配已知 CVE。"
      },
      {
        "id": "nv-poison-direct-prompt-injection",
        "name": "直接提示词注入",
        "tactic_ids": [
          "poison"
        ],
        "description": "攻击者以用户身份经正常交互投喂恶意输入，通常限于自身会话。",
        "detect_keywords": [
          "ignore previous instructions",
          "ignore all instructions",
          "you are now",
          "developer mode",
          "jailbreak",
          "忽略之前的指令",
          "越狱"
        ],
        "detect_hints": "用户轮次里出现试图覆盖系统指令或重新指派模型角色的内容。"
      },
      {
        "id": "nv-poison-indirect-prompt-injection",
        "name": "间接提示词注入",
        "tactic_ids": [
          "poison"
        ],
        "description": "污染应用代他人摄取的数据（如 RAG 库或共享文档），影响面随之放大。",
        "detect_keywords": [
          "indirect injection",
          "rag document",
          "retrieved document",
          "shared document",
          "间接注入",
          "检索文档"
        ],
        "detect_hints": "把指令埋进模型之后会代其他用户检索到的内容里——文档、评论或网页。"
      },
      {
        "id": "nv-poison-training-data-poisoning",
        "name": "训练数据投毒",
        "tactic_ids": [
          "poison"
        ],
        "description": "向微调或训练数据集注入被污染样本。",
        "detect_keywords": [
          "training data",
          "fine-tuning dataset",
          "data poisoning",
          "finetune corpus",
          "训练数据",
          "微调数据集"
        ],
        "detect_hints": "对话在讨论把恶意样本插进训练/微调语料，以影响模型后续行为。"
      },
      {
        "id": "nv-poison-adversarial-example",
        "name": "对抗样本攻击",
        "tactic_ids": [
          "poison"
        ],
        "description": "在像素或信号层面操纵图像、音频等输入，迫使模型误分类。",
        "detect_keywords": [
          "adversarial example",
          "adversarial perturbation",
          "pixel attack",
          "misclassification",
          "对抗样本",
          "对抗扰动"
        ],
        "detect_hints": "对图像或音频输入做像素/信号级扰动，以诱导错误分类。"
      },
      {
        "id": "nv-poison-visual-payload",
        "name": "视觉载荷",
        "tactic_ids": [
          "poison"
        ],
        "description": "物理或视觉场景中的恶意符号、贴纸或隐藏数据影响模型输出。",
        "detect_keywords": [
          "visual payload",
          "sticker attack",
          "malicious qr",
          "hidden text in image",
          "视觉载荷",
          "贴纸攻击"
        ],
        "detect_hints": "把指令藏进图像、贴纸或二维码，期待带摄像头的模型读出并执行。"
      },
      {
        "id": "nv-poison-ascii-smuggling",
        "name": "ASCII 走私（隐藏 Unicode 注入）",
        "tactic_ids": [
          "poison"
        ],
        "description": "用未被净化的 Unicode 标签字符隐藏注入指令，使其在摄取时不可见地存活。",
        "detect_keywords": [
          "ascii smuggling",
          "unicode tag",
          "invisible characters",
          "zero-width",
          "不可见字符",
          "隐藏指令"
        ],
        "detect_hints": "把指令藏在 Unicode 标签字符、零宽字符等不可见字符里以穿过过滤器。"
      },
      {
        "id": "nv-poison-guardrail-evasion-wrap",
        "name": "载荷包装与改写以通过摄取",
        "tactic_ids": [
          "poison"
        ],
        "description": "用 base64、编码或角色扮演框等方式重塑载荷，使摄取过滤识别不出。",
        "detect_keywords": [
          "base64 payload",
          "encoded payload",
          "obfuscate payload",
          "roleplay framing",
          "hypothetical scenario",
          "编码绕过",
          "角色扮演"
        ],
        "detect_hints": "把载荷编码、切碎或换框以绕过摄取侧净化，同时保留其效果。"
      },
      {
        "id": "nv-hijack-attacker-controlled-tool-use",
        "name": "攻击者控制的工具调用",
        "tactic_ids": [
          "hijack"
        ],
        "description": "迫使模型用攻击者指定的参数调用特定工具。",
        "detect_keywords": [
          "call the tool",
          "invoke function",
          "set parameter",
          "execute command",
          "调用工具",
          "函数调用"
        ],
        "detect_hints": "对话在把模型引向用攻击者挑选（而非用户指定）的取值去调用工具或函数。"
      },
      {
        "id": "nv-hijack-data-exfiltration",
        "name": "经模型输出外带数据",
        "tactic_ids": [
          "hijack"
        ],
        "description": "把模型上下文里的敏感数据编码进 URL、CSS 或文件写出等输出。",
        "detect_keywords": [
          "exfiltrate",
          "markdown image",
          "css url",
          "encode context",
          "leak system prompt",
          "外带数据",
          "泄露系统提示词"
        ],
        "detect_hints": "让模型把上下文数据嵌进 URL、图片链接、CSS 或文件路径从而离开系统。"
      },
      {
        "id": "nv-hijack-misinformation",
        "name": "虚假信息生成",
        "tactic_ids": [
          "hijack"
        ],
        "description": "炮制刻意虚假或误导的模型回复。",
        "detect_keywords": [
          "misinformation",
          "disinformation",
          "false claim",
          "fabricate",
          "虚假信息",
          "造谣"
        ],
        "detect_hints": "意图让模型输出貌似可信的假内容以误导读者。"
      },
      {
        "id": "nv-hijack-context-specific-payload",
        "name": "上下文特定载荷",
        "tactic_ids": [
          "hijack"
        ],
        "description": "仅在特定用户上下文中触发恶意行为，让载荷长期休眠、难以发现。",
        "detect_keywords": [
          "trigger condition",
          "only when user",
          "dormant payload",
          "conditional trigger",
          "触发条件",
          "特定用户"
        ],
        "detect_hints": "把载荷触发条件绑定到特定用户、关键词或上下文，使其在测试中保持休眠。"
      },
      {
        "id": "nv-hijack-goal-manipulation",
        "name": "代理目标与计划劫持",
        "tactic_ids": [
          "hijack"
        ],
        "description": "在代理型工作流里操纵模型的目标而非仅输出，把代理引向未授权的自主动作。",
        "detect_keywords": [
          "agent goal",
          "redefine objective",
          "task hijack",
          "subgoal",
          "目标劫持",
          "子任务"
        ],
        "detect_hints": "对话在改写代理的目标或计划，使其追求攻击者定义的目标而非用户的目标。"
      },
      {
        "id": "nv-persist-session-history",
        "name": "会话历史驻留",
        "tactic_ids": [
          "persist"
        ],
        "description": "注入的提示词在活动会话内持续有效，使劫持跨轮次存活。",
        "detect_keywords": [
          "stay in context",
          "remain in session",
          "earlier instruction",
          "保持上下文",
          "会话内持续"
        ],
        "detect_hints": "植入一条意在让整个后续对话持续生效的指令。"
      },
      {
        "id": "nv-persist-cross-session-memory",
        "name": "跨会话记忆驻留",
        "tactic_ids": [
          "persist"
        ],
        "description": "在带用户记忆的系统里植入可跨会话存活的载荷。",
        "detect_keywords": [
          "remember this",
          "save to memory",
          "persist across sessions",
          "user memory",
          "跨会话记忆",
          "记住这个"
        ],
        "detect_hints": "要求系统把某条指令写进长期记忆，以便未来会话召回。"
      },
      {
        "id": "nv-persist-shared-resource",
        "name": "共享资源投毒",
        "tactic_ids": [
          "persist"
        ],
        "description": "攻击共享数据库（如 RAG 源或知识库）以影响多个用户。",
        "detect_keywords": [
          "vector database",
          "knowledge base",
          "shared index",
          "write to rag",
          "embedding store",
          "向量数据库",
          "知识库投毒"
        ],
        "detect_hints": "把恶意内容写进向量库或知识库等共享存储，使其他用户检索到。"
      },
      {
        "id": "nv-persist-agentic-plan",
        "name": "代理计划驻留",
        "tactic_ids": [
          "persist"
        ],
        "description": "劫持代理目标，并确保其持续追求攻击者定义的目标。",
        "detect_keywords": [
          "persist goal",
          "agent plan file",
          "scheduled task",
          "task queue",
          "任务计划",
          "持久化目标"
        ],
        "detect_hints": "让代理把攻击者定义的目标写进计划、队列或任务文件，从而活得比本轮更久。"
      },
      {
        "id": "nv-iterate-lateral-pivot",
        "name": "横向转移到更多数据源",
        "tactic_ids": [
          "iterate-pivot"
        ],
        "description": "污染更多数据源以影响其他用户或工作流，放大持久化范围。",
        "detect_keywords": [
          "lateral movement",
          "additional data source",
          "scale impact",
          "横向移动",
          "扩大影响"
        ],
        "detect_hints": "从初始落脚点转向污染更多数据源或工作流，以扩大影响半径。"
      },
      {
        "id": "nv-iterate-plan-rewrite",
        "name": "迭代改写代理计划",
        "tactic_ids": [
          "iterate-pivot"
        ],
        "description": "在完全代理型系统里，于每轮循环改写代理目标，替换成攻击者定义的。",
        "detect_keywords": [
          "rewrite plan",
          "self-correct loop",
          "goal replacement",
          "重写计划",
          "迭代计划"
        ],
        "detect_hints": "让代理反复修订自己的计划或目标，朝攻击者意图的方向漂移。"
      },
      {
        "id": "nv-iterate-command-and-control",
        "name": "经嵌入载荷建立 C2",
        "tactic_ids": [
          "iterate-pivot"
        ],
        "description": "嵌入让代理每轮去取攻击者新指令的载荷。",
        "detect_keywords": [
          "command and control",
          "c2 server",
          "callback url",
          "fetch instructions",
          "beacon",
          "命令与控制",
          "回连"
        ],
        "detect_hints": "让代理从攻击者控制的端点取回新指令，或在每轮迭代时回连。"
      },
      {
        "id": "nv-impact-state-changing-action",
        "name": "改变状态的动作",
        "tactic_ids": [
          "impact"
        ],
        "description": "被劫持的输出驱动文件、数据库或系统配置的实际修改。",
        "detect_keywords": [
          "modify file",
          "delete record",
          "update config",
          "database write",
          "修改文件",
          "删除记录"
        ],
        "detect_hints": "经代理所连工具造成真实的写入、删除或配置变更。"
      },
      {
        "id": "nv-impact-financial-transaction",
        "name": "金融交易",
        "tactic_ids": [
          "impact"
        ],
        "description": "促使付款审批、转账或财务记录被篡改。",
        "detect_keywords": [
          "wire transfer",
          "approve transaction",
          "bank account",
          "invoice",
          "转账",
          "支付审批"
        ],
        "detect_hints": "经所连 API 触发或尝试支付、转账或财务记录变更。"
      },
      {
        "id": "nv-impact-data-exfiltration",
        "name": "影响阶段的数据外泄",
        "tactic_ids": [
          "impact"
        ],
        "description": "编码进输出的敏感数据真的离开系统，例如经 URL、CSS 技巧或 API 调用。",
        "detect_keywords": [
          "data exfiltration",
          "attacker server",
          "outbound request",
          "dns exfil",
          "数据外泄",
          "外发请求"
        ],
        "detect_hints": "出现带敏感数据、指向攻击者控制目标的外发请求或载荷投递。"
      },
      {
        "id": "nv-impact-external-communication",
        "name": "对外通信",
        "tactic_ids": [
          "impact"
        ],
        "description": "冒充可信用户对外发送邮件、消息或命令。",
        "detect_keywords": [
          "send email",
          "impersonate user",
          "slack message",
          "send command",
          "发送邮件",
          "冒充用户"
        ],
        "detect_hints": "让代理冒充可信用户发出邮件、聊天消息或命令。"
      }
    ],
  },
]


  // ══════════════════════════════════════════════════════════════════════════
  // 存储
  //
  // 按工作区分文件：<工作区>/<STORE_NAME>。这让「切工作区 = 切数据集」是文件系统
  // 层面的事实，插件里不需要维护多份状态。
  // ══════════════════════════════════════════════════════════════════════════
  const STORE_NAME = '.redteam-attack-matrix.json'
  const STORE_VERSION = 1
  const SNIPPET_MAX = 200
  const SNIPPETS_PER_HIT = 4

  // 扫描与研判都自动跑，没有人工按钮：
  //   扫描是增量的（scans[sid].maxSeq），没有新事件时不落盘 —— 否则每 20 秒
  //   白写一次上百 KB 的矩阵文件。
  //   研判按批送给模型，JUDGE_BATCH 是单批上限：几十条疑似一次灌进去会淹没结论。
  const AUTO_SCAN_MS = 20000
  const AUTO_JUDGE_MS = 15000
  const JUDGE_BATCH = 8
  const JUDGE_SAMPLES = 2
  // 够一批才交出去，且两批之间至少隔这么久。不加这两道闸的话，在「正在开发
  // 这个插件的会话」里会变成每 90 秒唤醒一次模型 —— 扫描对象就是产生噪音的源头，
  // 队列永远排不空，判定请求会无休止地打断开发者。
  const JUDGE_MIN = 6
  const JUDGE_STALE_MS = 600000
  const JUDGE_COOLDOWN_MS = 300000
  // sentAt 是**租约**不是终态：唤醒模型可能根本没被接手（会话在忙、消息丢了）。
  // 超过这个时间还没有结论就把 sentAt 清掉重新排队，否则那几条会永远停在
  // 「模型研判中」——既不会被重送，也不会被判。
  const JUDGE_LEASE_MS = 900000
  const LOG_MAX = 120

  function isFresh(item, now) {
    return !item.sentAt || (now - item.sentAt > JUDGE_LEASE_MS)
  }

  function blankStore() {
    return {
      version: STORE_VERSION,
      workspacePath: '',
      updatedAt: 0,
      // scans[sessionId] = { maxSeq, title, at } —— 增量扫描的续点
      scans: {},
      // matrix[frameworkId][techniqueId][sessionId] = hit
      matrix: {},
      // 被标成「非目标」的会话：不再扫描、已有记录也清掉。
      // 存在的理由很具体：开发这个插件的工作区里，对话本身就在不停命中框架关键词
      // （我写一行注释含「主机名」就造出一个 T1082 桶），噪音会盖过真实目标数据。
      ignoreSessions: [],
      log: [],
      logSeq: 0,
      meta: { lastError: null, lastScanAt: 0, scannedSessions: 0 },
    }
  }

  function blankHit(sessionId, title) {
    return {
      sessionId: String(sessionId),
      sessionTitle: String(title || ''),
      firstAt: 0,
      lastAt: 0,
      occurrences: 0,
      // 只用于增量扫描续点；hit 本身不含任何运行时对象引用。
      maxSeq: -1,
      kind: '',
      snippets: [],
      matched: [],
      // 这条命中打过谁：URL / IP[:端口] / 主机名 / nmap -p 端口表。面板上直接显示。
      targets: [],
      confidence: 'suspected',
      confirmedAt: 0,
      // 自动研判：needsJudge 由扫描置位，sentAt 防重送，judgedAt 表示已定论。
      // decidedBy 记「谁定的」：model（AI 自动标）或 human（面板里手动点）。
      needsJudge: true,
      sentAt: 0,
      judgedAt: 0,
      decidedBy: '',
      reason: '',
    }
  }

  // ── 工具函数 ──────────────────────────────────────────────────────────────
  function msgOf(e) { return e && e.message ? String(e.message) : String(e) }

  function textOfContent(content) {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    let out = ''
    for (const b of content) {
      if (!b || typeof b !== 'object' || typeof b.text !== 'string') continue
      out += (out ? '\n' : '') + b.text
      if (out.length > 24000) break
    }
    return out
  }

  function clip(s, n) {
    const v = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim()
    return v.length > n ? v.slice(0, n - 1) + '…' : v
  }

  function lower(s) { return String(s === undefined || s === null ? '' : s).toLowerCase() }
  function nowMs() { return Date.now() }

  function fmtTime(ms) {
    if (!ms) return ''
    try {
      const d = new Date(ms)
      const p = function (n) { return n < 10 ? '0' + n : String(n) }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    } catch (e) { return '' }
  }

  // ── 工作区与会话 ──────────────────────────────────────────────────────────
  function workspaceRegistry() {
    const reg = ctx.get('workspaceRegistry')
    if (!reg || typeof reg.list !== 'function') return null
    return reg
  }

  function listWorkspaces() {
    const reg = workspaceRegistry()
    if (!reg) return []
    let raw = null
    try { raw = reg.list() } catch (e) { return [] }
    if (!Array.isArray(raw)) return []
    const out = []
    for (const w of raw) {
      if (!w) continue
      const ids = Array.isArray(w.sessionIds) ? w.sessionIds : []
      out.push({ id: String(w.id || ''), path: String(w.path || ''), title: String(w.title || ''), sessionCount: ids.length })
    }
    return out
  }

  // 当前会话所在的工作区；取不到就退到第一个工作区（总比什么都不显示强）。
  function currentWorkspace() {
    const reg = workspaceRegistry()
    if (!reg) return null
    try {
      const agents = ctx.get('agents')
      let agent = null
      if (agents && typeof agents.currentInitiator === 'function') agent = agents.currentInitiator()
      if (!agent && agents && typeof agents.roots === 'function') {
        const roots = agents.roots()
        if (Array.isArray(roots) && roots.length === 1) agent = roots[0]
      }
      if (agent) {
        const sid = String(agent.id)
        for (const w of listWorkspaces()) {
          let full = null
          try { full = typeof reg.get === 'function' ? reg.get(w.id) : null } catch (e) {}
          const ids = full && Array.isArray(full.sessionIds) ? full.sessionIds : []
          for (const x of ids) if (String(x) === sid) return w
        }
      }
    } catch (e) {}
    const all = listWorkspaces()
    return all.length > 0 ? all[0] : null
  }

  function sessionsOf(workspaceId) {
    const reg = workspaceRegistry()
    const sessions = ctx.get('sessions')
    if (!reg || !sessions || typeof sessions.get !== 'function') return []
    let w = null
    try { w = typeof reg.get === 'function' ? reg.get(workspaceId) : null } catch (e) { return [] }
    if (!w || !Array.isArray(w.sessionIds)) return []
    const out = []
    for (const id of w.sessionIds) {
      let s = null
      try { s = sessions.get(id) } catch (e) { continue }
      if (s) out.push(s)
    }
    return out
  }

  // ── 落盘 ──────────────────────────────────────────────────────────────────
  function storePathFor(workspacePath) {
    const base = String(workspacePath || '').replace(/\/+$/, '')
    return (base ? base + '/' : '') + STORE_NAME
  }

  async function readStore(workspacePath) {
    const store = blankStore()
    store.workspacePath = String(workspacePath || '')
    const fs = ctx.get('fs')
    if (!fs || typeof fs.resolve !== 'function') {
      store.meta.lastError = 'fs 服务不可用，本次仅内存分析'
      return store
    }
    try {
      const target = await fs.resolve(storePathFor(workspacePath))
      const info = await fs.stat(target)
      if (!info) return store
      const parsed = JSON.parse(await fs.readText(target))
      if (!parsed || typeof parsed !== 'object') return store
      if (Number(parsed.version) !== STORE_VERSION) {
        store.meta.lastError = '已有数据版本 ' + parsed.version + '，当前 ' + STORE_VERSION + '，已忽略旧数据'
        return store
      }
      if (parsed.scans && typeof parsed.scans === 'object') store.scans = parsed.scans
      if (parsed.matrix && typeof parsed.matrix === 'object') store.matrix = parsed.matrix
      if (Array.isArray(parsed.ignoreSessions)) store.ignoreSessions = parsed.ignoreSessions.map(String)
      if (Array.isArray(parsed.log)) store.log = parsed.log.slice(-LOG_MAX)
      if (typeof parsed.logSeq === 'number') store.logSeq = parsed.logSeq
      if (parsed.meta && typeof parsed.meta === 'object') {
        store.meta.lastScanAt = Number(parsed.meta.lastScanAt) || 0
        store.meta.scannedSessions = Number(parsed.meta.scannedSessions) || 0
      }
      store.updatedAt = Number(parsed.updatedAt) || 0
      return store
    } catch (e) {
      // 文件不存在不是错误：当作空矩阵继续。
      const m = msgOf(e)
      if (!/ENOENT|not found|不存在|null/i.test(m)) store.meta.lastError = '读取失败：' + m
      return store
    }
  }

  async function writeStore(store) {
    const fs = ctx.get('fs')
    if (!fs || typeof fs.resolve !== 'function') return false
    try {
      const target = await fs.resolve(storePathFor(store.workspacePath))
      const payload = {
        version: STORE_VERSION,
        workspacePath: store.workspacePath,
        updatedAt: store.updatedAt,
        scans: store.scans,
        matrix: store.matrix,
        ignoreSessions: store.ignoreSessions || [],
        log: (store.log || []).slice(-LOG_MAX),
        logSeq: store.logSeq || 0,
        meta: {
          lastScanAt: store.meta.lastScanAt,
          scannedSessions: store.meta.scannedSessions,
        },
      }
      await fs.writeText(target, JSON.stringify(payload, null, 2))
      return true
    } catch (e) {
      store.meta.lastError = '写入失败：' + msgOf(e)
      return false
    }
  }

  // ── 会话事件 -> 操作项 ────────────────────────────────────────────────────
  // 一次「攻击操作」= 一条用户消息 / 一次模型回复 / 一次工具调用或结果。
  // 这是矩阵卡片能对应到的最小可读单位，也是时间线的刻度。
  //
  // 但插件**自己的产出不能进矩阵**，否则是自反馈：判定 reason 里必然引用被命中的
  // 关键词（「`rce` 是 source 的子串」），研判请求正文里又带着「命中词：…」清单，
  // 下一轮扫描把它们当成新命中，于是同一批关键词被反复放大。
  // 实测污染面：matrix_label 出现在 25 个桶的证据里，研判正文出现在 6 个桶里。
  // 残留（已知、未处理）：判定过程中模型自己写的分析文本没有可靠标记可认，
  // 只能靠「别在开发这个插件的会话里依赖覆盖率」这条使用纪律回避。
  const SELF_TOOLS = ['matrix_label']
  const SELF_PROMPT = '【攻击矩阵 · 自动研判】'
  function isSelfTool(name) { return SELF_TOOLS.indexOf(String(name || '')) >= 0 }
  function isSelfPrompt(text) { return String(text || '').indexOf(SELF_PROMPT) >= 0 }

  function activitiesOf(session) {
    let events = []
    try { events = session.snapshotEvents() } catch (e) { return [] }
    if (!Array.isArray(events)) return []

    // 先收拢工具调用，好让「调用 + 结果」在结果那条上仍能看到工具名与参数。
    const calls = {}
    for (const ev of events) {
      if (!ev || !ev.data || ev.type !== 'tool/call') continue
      const cid = String(ev.data.callId || '')
      if (cid) calls[cid] = { name: String(ev.data.name || ''), args: String(ev.data.arguments || '') }
    }

    const out = []
    for (const ev of events) {
      if (!ev || !ev.data) continue
      const seq = Number(ev.seq)
      const at = Number(ev.time) || 0
      const d = ev.data
      if (ev.type === 'user/message') {
        const text = textOfContent(d.content)
        if (text.trim() && !isSelfPrompt(text)) out.push({ kind: 'user', seq: seq, at: at, text: text, label: '用户消息' })
      } else if (ev.type === 'assistant/message') {
        const text = textOfContent(d.message && d.message.content)
        if (text.trim()) out.push({ kind: 'assistant', seq: seq, at: at, text: text, label: '模型回复' })
      } else if (ev.type === 'tool/call') {
        if (isSelfTool(d.name)) continue
        out.push({ kind: 'tool', seq: seq, at: at, text: String(d.name || '') + ' ' + String(d.arguments || ''), label: '工具调用 ' + String(d.name || '') })
      } else if (ev.type === 'tool/result') {
        const cid = String((d.message && d.message.source && d.message.source.callId) || '')
        const c = calls[cid]
        if (c && isSelfTool(c.name)) continue
        out.push({
          kind: 'tool',
          seq: seq,
          at: at,
          text: (c ? c.name + ' ' + c.args + ' ' : '') + textOfContent(d.message && d.message.content),
          label: '工具结果' + (c && c.name ? ' ' + c.name : ''),
          error: !!d.error,
        })
      }
    }
    return out
  }

  function sessionTitleOf(session) {
    try {
      const st = ctx.get('sessionTitle')
      if (st && typeof st.get === 'function') {
        const snap = st.get(session)
        if (snap && snap.title) return clip(snap.title, 60)
      }
    } catch (e) {}
    const id = String(session.id || '')
    return id.length > 14 ? id.slice(0, 14) : id
  }

  // ── 目标提取 ──────────────────────────────────────────────────────────────
  // 时间线和攻击操作日志要能一眼看出「打的是谁」：光有技术点 ID 没用，
  // 红队回溯时要的是具体目标。所以从操作文本里抽出 URL / IP[:端口] / 主机名 / nmap 的 -p 端口表。
  // 只做保守提取：宁可少列，不要把随机数字当端口刷屏。
  const RE_URL = /\bhttps?:\/\/[^\s"'`,;)<>\\]+/gi
  const RE_IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g
  const RE_HOST = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|cn|net|org|io|cc|dev|app|xyz|top|info|biz|me|tv|cloud|site|online|tech|store|shop|link|live|fun|pro|work|space|website|host|press|wiki|edu|gov|mil|int|ai|sh|de|jp|uk|fr|ru|us|ca|au|nl|se|it|es|br|in|kr|tw|hk|sg|local|internal|lan)\b/gi
  // nmap 风格的端口表：`-p 8002,8003,8004,11434` / `-p 1-1024`
  const RE_PORTLIST = /(?:^|\s)-p\s+([0-9][0-9,\-]{0,80})/i
  const TARGETS_MAX = 12

  function targetsIn(text) {
    const s = String(text === undefined || text === null ? '' : text)
    if (!s) return []
    const out = []
    function add(v) {
      const t = String(v || '').trim()
      if (!t || t.length > 80) return
      if (out.indexOf(t) >= 0) return
      if (out.length < TARGETS_MAX) out.push(t)
    }
    let m
    RE_URL.lastIndex = 0
    while ((m = RE_URL.exec(s))) add(m[0])
    RE_IPV4.lastIndex = 0
    while ((m = RE_IPV4.exec(s))) add(m[0])
    RE_HOST.lastIndex = 0
    while ((m = RE_HOST.exec(s))) add(m[0].toLowerCase())
    const pl = RE_PORTLIST.exec(s)
    if (pl && pl[1]) add('端口 ' + pl[1])
    return out
  }

  function mergeTargets(hit, list) {
    if (!Array.isArray(list) || list.length === 0) return
    if (!Array.isArray(hit.targets)) hit.targets = []
    for (const t of list) {
      if (hit.targets.indexOf(t) >= 0) continue
      if (hit.targets.length >= TARGETS_MAX) return
      hit.targets.push(t)
    }
  }

  // 读的时候兜底：加 targets 字段之前扫出来的桶没有它，就从留存的证据片段里现取。
  // 这样不必为了看目标而重扫 —— 重扫会把已有的判定结论一起丢掉。
  function hitTargets(h) {
    if (Array.isArray(h.targets) && h.targets.length) return h.targets
    let s = ''
    for (const x of (h.snippets || [])) s += ' ' + (x.text || '')
    return targetsIn(s)
  }

  // ── 匹配 ──────────────────────────────────────────────────────────────────
  // 关键词表是扁平的，直接对 haystack 做匹配：一次操作 × 全部关键词。
  // 关键词总量在几百这个量级，实时扫描足够快，不值得上倒排索引。
  //
  // 但**必须带词边界**。裸 indexOf 实测造出过两个巨型假阳性：
  //   `rce` 命中 source / resource（单桶 395 次），`dos` 命中 todos（单桶 147 次）。
  // 含 CJK 的关键词不能用词边界（中文没有词边界），仍走子串匹配。
  const KW_ASCII = /^[\x20-\x7e]+$/
  const kwRegexCache = {}

  function kwHit(hay, kw) {
    let re = kwRegexCache[kw]
    if (re === undefined) {
      if (!KW_ASCII.test(kw)) re = null
      else {
        const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        re = new RegExp('(^|[^a-z0-9])' + esc + '($|[^a-z0-9])', 'i')
      }
      kwRegexCache[kw] = re
    }
    if (re === null) return hay.indexOf(kw) >= 0
    return re.test(hay)
  }

  function matchFrameworks(text) {
    const hay = lower(text)
    if (!hay) return []
    const found = []
    for (const fw of FRAMEWORKS) {
      for (const tech of fw.techniques) {
        let score = 0
        const hit = []
        for (const kw of tech.detect_keywords) {
          if (kw && kwHit(hay, kw)) { score++; hit.push(kw) }
        }
        if (score > 0) found.push({ frameworkId: fw.id, techniqueId: tech.id, keywords: hit, score: score })
      }
    }
    return found
  }

  // 同一条操作命中同一技术点的多个关键词时只留最好的那条：命中词越多越可信。
  function bestPerTechnique(matches) {
    const best = {}
    for (const m of matches) {
      const k = m.frameworkId + '\u0000' + m.techniqueId
      if (!best[k] || m.score > best[k].score) best[k] = m
    }
    const out = []
    for (const k of Object.keys(best)) out.push(best[k])
    return out
  }

  function entryBucket(store, frameworkId, techniqueId) {
    if (!store.matrix[frameworkId]) store.matrix[frameworkId] = {}
    if (!store.matrix[frameworkId][techniqueId]) store.matrix[frameworkId][techniqueId] = {}
    return store.matrix[frameworkId][techniqueId]
  }

  // ── 扫描 ──────────────────────────────────────────────────────────────────
  async function scanWorkspace(workspaceId, options) {
    const opts = options || {}
    const list = listWorkspaces()
    let w = null
    if (workspaceId) { for (const x of list) if (x.id === workspaceId) { w = x; break } }
    if (!w) w = currentWorkspace()
    if (!w) return { ok: false, error: '拿不到工作区（workspaceRegistry 不可用？）' }

    const store = await readStore(w.path)
    if (opts.reset === true) { store.matrix = {}; store.scans = {} }

    const sessions = sessionsOf(w.id)
    let touched = 0
    let scannedSessions = 0
    let newMatches = 0

    for (const session of sessions) {
      const sid = String(session.id || '')
      if (!sid) continue
      // 非目标会话：连水位都不碰，直接跳过。
      if ((store.ignoreSessions || []).indexOf(sid) >= 0) continue
      const title = sessionTitleOf(session)
      const acts = activitiesOf(session)
      if (acts.length === 0) continue
      scannedSessions++

      const prev = store.scans[sid]
      const fromSeq = prev && typeof prev.maxSeq === 'number' ? prev.maxSeq : -1
      let maxSeq = fromSeq

      for (const act of acts) {
        if (!(act.seq > fromSeq)) continue
        if (act.seq > maxSeq) maxSeq = act.seq
        const matches = bestPerTechnique(matchFrameworks(act.text))
        if (matches.length === 0) continue
        newMatches++
        for (const m of matches) {
          const bucket = entryBucket(store, m.frameworkId, m.techniqueId)
          let hit = bucket[sid]
          if (!hit) { hit = blankHit(sid, title); bucket[sid] = hit }
          hit.sessionTitle = title
          hit.occurrences += 1
          // 扫描只负责「排进待判定队列」：第一次命中、或已定论之后又出现新操作，
          // 都重新排队等模型判定（decidedBy 为空 = 还没人下过结论）。
          if (hit.confidence !== 'confirmed' && !hit.judgedAt) { hit.needsJudge = true; hit.sentAt = 0 }
          if (!hit.firstAt || act.at < hit.firstAt) hit.firstAt = act.at
          if (act.at > hit.lastAt) hit.lastAt = act.at
          if (act.kind === 'tool') hit.kind = 'tool'
          else if (!hit.kind) hit.kind = act.kind
          for (const kw of m.keywords) if (hit.matched.indexOf(kw) < 0 && hit.matched.length < 12) hit.matched.push(kw)
          mergeTargets(hit, targetsIn(act.text))
          // 证据片段保留策略：最早的 2 条 + **滚动保留最新的 2 条**。
          // 原来只留最早的 4 条 —— 于是判定者永远看不到后半段发生了什么。
          // 实测踩过：一次未授权的模型创建/删除发生在很靠后的位置，判定时根本看不到，
          // 那次战果就没被记上。前面两条留着是为了保住「这条桶从什么开始」。
          const snip = { at: act.at, seq: act.seq, kind: act.kind, label: act.label, text: clip(act.text, SNIPPET_MAX) }
          if (hit.snippets.length < SNIPPETS_PER_HIT) {
            hit.snippets.push(snip)
          } else {
            hit.snippets[SNIPPETS_PER_HIT - 2] = hit.snippets[SNIPPETS_PER_HIT - 1]
            hit.snippets[SNIPPETS_PER_HIT - 1] = snip
          }
        }
      }

      if (maxSeq > fromSeq || !prev) {
        store.scans[sid] = { maxSeq: maxSeq, title: title, at: nowMs() }
        if (maxSeq > fromSeq) touched++
      }
    }

    store.meta.scannedSessions = scannedSessions
    // 没有新事件就不落盘。矩阵文件是百 KB 级，20 秒白写一次纯属浪费 I/O；
    // lastScanAt 的含义因此是「最近一次扫到新内容的时刻」，面板上按这个措辞显示。
    const changed = touched > 0 || opts.reset === true || newMatches > 0
    let saved = true
    if (changed) {
      store.updatedAt = nowMs()
      store.meta.lastScanAt = store.updatedAt
      saved = await writeStore(store)
      if (!saved && !store.meta.lastError) store.meta.lastError = '写入失败（未知原因）'
    }

    return {
      ok: true, saved: saved, changed: changed, store: store, workspace: w,
      stats: { sessions: sessions.length, scannedSessions: scannedSessions, newMatches: newMatches, touchedSessions: touched },
    }
  }

  // ── 自动扫描与自动研判 ────────────────────────────────────────────────────
  // 面板上没有「扫描」按钮：host 按节拍自己扫，自己把疑似交给模型定论。
  // 结论只能有两个来源 —— 模型（matrix_label，AI 自动标）或人在面板上手动点
  // （confirm / ignore）。扫描永远只负责「排进队列」，不自己下结论。
  let scanBusy = false
  let judgeBusy = false
  let lastHandoffAt = 0
  let rememberedAgent = null
  const autoScanState = { at: 0, changedAt: 0, sessions: 0, matches: 0 }

  // 所有「读整份 store -> 改 -> 整份写回」的路径都必须串行。
  // 不串行会丢更新：注册日志那次就是这样被同时进行的扫描覆盖掉的 ——
  // 两个异步链各自读了同一份旧数据，后写的把先写的改动整段抹掉。
  let storeChain = Promise.resolve()
  function withStore(fn) {
    const run = storeChain.then(function () { return fn() }, function () { return fn() })
    storeChain = run.then(function () {}, function () {})
    return run
  }

  function logTo(store, level, text) {
    store.logSeq = (store.logSeq || 0) + 1
    store.log.push({ seq: store.logSeq, at: nowMs(), level: level, text: String(text).slice(0, 1200) })
    if (store.log.length > LOG_MAX) store.log = store.log.slice(store.log.length - LOG_MAX)
  }

  // 待判定 = 还没有人下过结论的疑似命中。
  // 旧数据没有 judgedAt/decidedBy 这两个字段，判据里按「未判定」处理 ——
  // 于是升级后第一轮扫描就会把这批历史疑似全部排进队列，不需要迁移脚本。
  function pendingItems(store) {
    const out = []
    for (const fw of FRAMEWORKS) {
      const bucket = store.matrix[fw.id] || {}
      for (const tech of fw.techniques) {
        const hits = bucket[tech.id] || {}
        for (const sid of Object.keys(hits)) {
          const h = hits[sid]
          if (!h || h.confidence === 'confirmed' || h.judgedAt) continue
          out.push({
            frameworkId: fw.id, techniqueId: tech.id, techniqueName: tech.name,
            sessionId: sid, sessionTitle: h.sessionTitle,
            firstAt: h.firstAt || 0, lastAt: h.lastAt || 0, occurrences: h.occurrences || 0,
            matched: (h.matched || []).slice(0, 6),
            samples: (h.snippets || []).slice(-JUDGE_SAMPLES).map(function (s) { return clip(s.text, 300) }),
            sentAt: h.sentAt || 0,
          })
        }
      }
    }
    // 命中多的、近的先判：信息量大的先定论。
    out.sort(function (a, b) { return (b.occurrences - a.occurrences) || (b.lastAt - a.lastAt) })
    return out
  }

  function judgeRules() {
    const L = []
    L.push('你的任务：给下面每条「疑似命中」下结论，逐条调用 matrix_label 登记。')
    L.push('')
    L.push('三种结论：')
    L.push('1. confirmed —— **已经实现、已经验证**：对话里有做成的证据，例如利用成功、拿到回显/shell/文件内容、PoC 跑通、注入或越权确实生效、拿到了本不该拿到的数据。')
    L.push('2. suspected —— 只是提及、计划、讨论，或者尝试过但没有成功的证据。')
    L.push('3. rejected —— 误报：命中的其实是正常开发或与目标无关的内容。')
    L.push('')
    L.push('判定纪律（这几条决定了覆盖率可不可信）：')
    L.push('- 只有「做成了」才算 confirmed。命令写出来了、工具被调用了，但结果没证明成功 —— 那是 suspected。')
    L.push('- 关键看工具结果：报错、权限拒绝、404、连接超时、空结果都是**没做成**。')
    L.push('- 拿不准就 suspected。覆盖率虚高比缺项更有害。')
    L.push('- reason 要写你实际看到的内容，不要写「关键词匹配到了」这种同义反复。')
    L.push('')
    L.push('每条都要调一次 matrix_label，不要只在回复里写结论。')
    return L.join('\n')
  }

  function buildJudgePrompt(workspace, items) {
    const L = []
    L.push('【攻击矩阵 · 自动研判】工作区：' + (workspace.path || workspace.title || workspace.id))
    L.push('')
    L.push(judgeRules())
    L.push('')
    L.push('待判定 ' + items.length + ' 条：')
    for (const it of items) {
      L.push('')
      L.push('- ' + it.frameworkId + ' / ' + it.techniqueId + ' ' + it.techniqueName)
      L.push('  会话：' + (it.sessionTitle || '') + '（sessionId=' + it.sessionId + '）')
      L.push('  命中 ' + it.occurrences + ' 次，' + fmtTime(it.firstAt) + ' → ' + fmtTime(it.lastAt))
      L.push('  命中词：' + (it.matched || []).join('、'))
      for (const s of it.samples) L.push('  证据：' + s)
    }
    return L.join('\n')
  }

  function findAgent() {
    const agents = ctx.get('agents')
    if (!agents) return null
    try {
      if (typeof agents.currentInitiator === 'function') {
        const a = agents.currentInitiator()
        if (a) { rememberedAgent = a; return a }
      }
      // 定时器回调里没有驱动链，currentInitiator() 必然是空的。这时候按
      // 「哪个根会话属于当前工作区」来认 —— 那才是该收到研判请求的会话。
      // 早先这里只认 roots().length === 1，多个工作区时会直接放弃，
      // 结果就是扫描一直在跑、判定请求一条都发不出去。
      const roots = typeof agents.roots === 'function' ? agents.roots() : []
      if (Array.isArray(roots) && roots.length) {
        const w = currentWorkspace()
        const reg = workspaceRegistry()
        let ids = []
        try {
          const full = w && reg && typeof reg.get === 'function' ? reg.get(w.id) : null
          ids = full && Array.isArray(full.sessionIds) ? full.sessionIds.map(String) : []
        } catch (e) {}
        for (const a of roots) if (a && ids.indexOf(String(a.id)) >= 0) { rememberedAgent = a; return a }
        if (roots.length === 1) { rememberedAgent = roots[0]; return roots[0] }
      }
    } catch (e) {}
    return rememberedAgent
  }

  async function handoffToModel(store, workspace, items) {
    const agent = findAgent()
    if (!agent || typeof agent.followup !== 'function') {
      logTo(store, 'warn', '找不到可唤醒的会话 Agent，' + items.length + ' 条疑似留在队列里等下次研判')
      return false
    }
    const text = buildJudgePrompt(workspace, items)
    const base = {
      id: 'rtmatrix-' + nowMs().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      role: 'user',
      content: [{ type: 'text', text: text }],
    }
    try {
      agent.followup(Object.assign({}, base, { source: { kind: 'plugin', plugin: 'redteam-attack-matrix' } }))
    } catch (e1) {
      try {
        agent.followup(Object.assign({}, base, { id: base.id + 'b', source: { kind: 'user' } }))
      } catch (e2) {
        logTo(store, 'err', '唤醒模型失败：' + msgOf(e2) + ' —— 疑似仍留在队列里')
        return false
      }
    }
    return true
  }

  async function autoScanOnce() {
    if (scanBusy) return
    const w = currentWorkspace()
    if (!w) return
    scanBusy = true
    autoScanState.at = nowMs()
    try {
      await withStore(async function () {
        const r = await scanWorkspace(w.id, {})
        if (!r.ok || !r.stats) return
        autoScanState.sessions = r.stats.scannedSessions || 0
        autoScanState.matches = r.stats.newMatches || 0
        if (!r.changed) return
        autoScanState.changedAt = nowMs()
        const store = r.store
        logTo(store, 'ok', '自动扫描：' + autoScanState.sessions + ' 个会话，命中 ' + autoScanState.matches + ' 处操作')
        store.updatedAt = nowMs()
        await writeStore(store)
      })
    } catch (e) {
      console.error('[rtmatrix] 自动扫描失败: ' + msgOf(e))
    } finally {
      scanBusy = false
    }
  }

  async function autoJudgeOnce() {
    if (judgeBusy || scanBusy) return
    if (lastHandoffAt && nowMs() - lastHandoffAt < JUDGE_COOLDOWN_MS) return
    const w = currentWorkspace()
    if (!w) return
    judgeBusy = true
    try {
      await withStore(async function () {
        const store = await readStore(w.path)
        const all = pendingItems(store)
        const now0 = nowMs()
        const fresh = all.filter(function (x) { return isFresh(x, now0) })
        if (fresh.length === 0) return
        // 闸门：要么攒够 JUDGE_MIN 条，要么有已经等了很久的（避免少量命中永远排不上）。
        const oldest = fresh[0] || null
        const stale = oldest && oldest.firstAt && (nowMs() - oldest.firstAt > JUDGE_STALE_MS)
        if (fresh.length < JUDGE_MIN && !stale) return
        const batch = fresh.slice(0, JUDGE_BATCH)
        for (const it of batch) {
          const h = ((store.matrix[it.frameworkId] || {})[it.techniqueId] || {})[it.sessionId]
          if (h) h.sentAt = nowMs()
        }
        logTo(store, 'phase', '自动研判：交给模型 ' + batch.length + ' 条疑似（队列共 ' + all.length + ' 条）')
        store.updatedAt = nowMs()
        await writeStore(store)
        // 先把「已送出」落盘再唤醒模型：反过来的话，模型可能在被标记之前就开始判定。
        const ok = await handoffToModel(store, w, batch)
        lastHandoffAt = nowMs()
        if (!ok) {
          // 没送出去就别把它们标成已送出，否则会永远卡在队列里。
          for (const it of batch) {
            const h = ((store.matrix[it.frameworkId] || {})[it.techniqueId] || {})[it.sessionId]
            if (h && h.confidence !== 'confirmed') h.sentAt = 0
          }
          await writeStore(store)
        }
      })
    } catch (e) {
      console.error('[rtmatrix] 自动研判失败: ' + msgOf(e))
    } finally {
      judgeBusy = false
    }
  }

  // 模型下的结论落到矩阵上。rejected 走的是和手动「排除」同一条路：删除该命中。
  async function applyDecision(args) {
    const a = args && typeof args === 'object' ? args : {}
    const frameworkId = String(a.frameworkId || '')
    const techniqueId = String(a.techniqueId || '')
    const sessionId = String(a.sessionId || '')
    const raw = String(a.decision || '')
    const decision = raw === 'confirmed' ? 'confirmed' : (raw === 'rejected' ? 'rejected' : 'suspected')
    const reason = clip(a.reason || '', 400)
    if (!reason) return { ok: false, error: 'reason 不能为空 —— 判定依据是审计链的一部分' }
    const w = currentWorkspace()
    if (!w) return { ok: false, error: '拿不到工作区' }
    return await withStore(async function () {
      const store = await readStore(w.path)
      const hits = (store.matrix[frameworkId] || {})[techniqueId]
      if (!hits) return { ok: false, error: '没有这个技术点的记录：' + frameworkId + '/' + techniqueId }
      const h = hits[sessionId]
      if (!h) return { ok: false, error: '没有这个会话的命中记录：' + sessionId }
      const who = (h.sessionTitle || sessionId)
      if (decision === 'rejected') {
        delete hits[sessionId]
        logTo(store, 'warn', '排除 ' + frameworkId + '/' + techniqueId + '（' + who + '）：' + reason)
      } else {
        h.confidence = decision
        h.decidedBy = 'model'
        h.reason = reason
        h.judgedAt = nowMs()
        h.needsJudge = false
        h.sentAt = 0
        if (decision === 'confirmed') h.confirmedAt = nowMs()
        logTo(store, decision === 'confirmed' ? 'ok' : 'info',
          (decision === 'confirmed' ? '确认 ' : '存疑 ') + frameworkId + '/' + techniqueId + '（' + who + '）：' + reason)
      }
      store.updatedAt = nowMs()
      await writeStore(store)
      return { ok: true, decision: decision, pending: pendingItems(store).length }
    })
  }

  const labelTool = harness.defineTool({
    name: 'matrix_label',
    description: '为攻击矩阵的一条技术点命中下结论（攻击矩阵面板的自动研判用）。confirmed=已经实现或已验证；suspected=证据不足，保持疑似；rejected=误报，删除该命中。每条命中单独调用一次。',
    parameters: {
      type: 'object',
      properties: {
        frameworkId: { type: 'string', description: '框架 id，例如 atlas / attack-enterprise / owasp-llm / nvidia-kill-chain' },
        techniqueId: { type: 'string', description: '技术点 id，例如 T1190 / LLM01' },
        sessionId: { type: 'string', description: '会话 id，研判消息里给出的 sessionId' },
        decision: { type: 'string', enum: ['confirmed', 'suspected', 'rejected'], description: 'confirmed=做成了；suspected=只是提及或尝试未果；rejected=误报' },
        reason: { type: 'string', description: '判定依据：你实际看到的内容。会写进矩阵日志并显示在卡片上。' },
      },
      required: ['frameworkId', 'techniqueId', 'sessionId', 'decision', 'reason'],
    },
    output: {
      schema: { type: 'json' },
      render: function (args, value) {
        if (!value || value.ok !== true) return [{ type: 'text', text: '判定失败：' + ((value && value.error) || '未知错误') }]
        return [{ type: 'text', text: '已判定 ' + args.frameworkId + '/' + args.techniqueId + ' → ' + value.decision + '（还剩 ' + value.pending + ' 条待判定）' }]
      },
    },
    execute: async function (args) { return await applyDecision(args) },
  })
  // 注册失败必须是可见的：自动研判整条链路都指望这个工具，静默失败会变成
  // 「扫描在跑但永远没人下结论」——asset-graph 就栽在工具注册无声失败上。
  try {
    harness.registerTool(ctx, labelTool)
    Promise.resolve().then(function () {
      return withStore(async function () {
        const w = currentWorkspace()
        if (!w) return
        const store = await readStore(w.path)
        logTo(store, 'info', '已注册模型工具 matrix_label（自动研判用）')
        store.updatedAt = nowMs()
        await writeStore(store)
      })
    }).catch(function () {})
  } catch (e) {
    console.error('[rtmatrix] matrix_label 注册失败: ' + msgOf(e))
    Promise.resolve().then(function () {
      return withStore(async function () {
        const w = currentWorkspace()
        if (!w) return
        const store = await readStore(w.path)
        logTo(store, 'err', 'matrix_label 注册失败：' + msgOf(e))
        await writeStore(store)
      })
    }).catch(function () {})
  }

  // ── 读模型 ────────────────────────────────────────────────────────────────
  // 只发面板真的需要的叶子字段，不发整个 store。
  function summarizeStore(store, workspaceId) {
    const frameworks = []
    const timeline = []
    for (const fw of FRAMEWORKS) {
      const bucket = store.matrix[fw.id] || {}
      let suspected = 0
      let confirmed = 0
      let operations = 0
      const entries = []
      for (const tech of fw.techniques) {
        const hits = bucket[tech.id] || {}
        const ids = Object.keys(hits)
        let n = 0
        let confSessions = 0
        let confirmedOps = 0
        let firstAt = 0
        let lastAt = 0
        let pendingSessions = 0
        for (const sid of ids) {
          const h = hits[sid]
          n += h.occurrences || 0
          if (h.confidence === 'confirmed') { confSessions++; confirmedOps += h.occurrences || 0 }
          else if (!h.judgedAt) pendingSessions++
          if (h.lastAt > lastAt) lastAt = h.lastAt
          if (h.firstAt && (!firstAt || h.firstAt < firstAt)) firstAt = h.firstAt
          if (h.lastAt > 0) {
            // at=lastAt 只用来排序；展示用的是 firstAt → lastAt 这个区间。
            // 之前只发 lastAt，于是「横跨 27 小时、388 次命中」在时间线上被压成一个时刻。
            timeline.push({
              frameworkId: fw.id, techniqueId: tech.id, techniqueName: tech.name,
              at: h.lastAt, firstAt: h.firstAt || h.lastAt, lastAt: h.lastAt,
              sessionId: sid, sessionTitle: h.sessionTitle,
              pieces: h.occurrences || 0, confidence: h.confidence,
              decidedBy: h.decidedBy || '', reason: h.reason || '',
              targets: hitTargets(h), matched: (h.matched || []).slice(0, 8),
            })
          }
        }
        if (n > 0) suspected++
        if (confSessions > 0) confirmed++
        operations += n
        entries.push({
          id: tech.id, name: tech.name, tactics: tech.tactic_ids || [],
          confirmed: confSessions > 0, sessions: ids.length, occurrences: n,
          confirmedOps: confirmedOps, firstAt: firstAt, lastAt: lastAt,
          pending: pendingSessions,
        })
      }
      frameworks.push({
        id: fw.id, name: fw.name, short: fw.short || fw.name, source: fw.source || '',
        tactics: fw.tactics || [], total: fw.techniques.length,
        suspected: suspected, confirmed: confirmed, operations: operations, entries: entries,
      })
    }
    timeline.sort(function (a, b) { return b.at - a.at })
    const pendingAll = pendingItems(store)
    let pendingFresh = 0
    const nowP = nowMs()
    for (const x of pendingAll) if (isFresh(x, nowP)) pendingFresh++
    return {
      workspaceId: workspaceId || '',
      workspacePath: store.workspacePath || '',
      updatedAt: store.updatedAt || 0,
      lastScanAt: store.meta.lastScanAt || 0,
      lastError: store.meta.lastError || null,
      sessions: store.meta.scannedSessions || 0,
      frameworks: frameworks,
      timeline: timeline.slice(0, 200),
      timelineTotal: timeline.length,
      // 待判定：total 是还没人下结论的疑似条数，fresh 是还没送给模型的条数。
      pending: { total: pendingAll.length, fresh: pendingFresh },
      // 自动扫描的心跳（内存态，不入库）：面板用它显示「还在自动跑」。
      autoScan: {
        at: autoScanState.at, changedAt: autoScanState.changedAt,
        sessions: autoScanState.sessions, matches: autoScanState.matches,
        intervalMs: AUTO_SCAN_MS,
      },
      judging: { lastHandoffAt: lastHandoffAt, cooldownMs: JUDGE_COOLDOWN_MS, batch: JUDGE_BATCH },
      // 被标成非目标的会话（面板上显示数量，并提供一键恢复）。
      ignored: (store.ignoreSessions || []).slice(),
      log: (store.log || []).slice(-40),
    }
  }

  function techniqueDetail(store, frameworkId, techniqueId) {
    const fw = FRAMEWORKS.filter(function (x) { return x.id === frameworkId })[0]
    if (!fw) return { ok: false, error: '未知框架：' + frameworkId }
    const tech = fw.techniques.filter(function (x) { return x.id === techniqueId })[0]
    if (!tech) return { ok: false, error: '未知技术点：' + techniqueId }
    const hits = (store.matrix[frameworkId] || {})[techniqueId] || {}
    const operations = []
    for (const sid of Object.keys(hits)) {
      const h = hits[sid]
      operations.push({
        sessionId: sid, sessionTitle: h.sessionTitle, confidence: h.confidence,
        occurrences: h.occurrences, firstAt: h.firstAt, lastAt: h.lastAt,
        matched: h.matched, snippets: h.snippets, targets: hitTargets(h),
        decidedBy: h.decidedBy || '', reason: h.reason || '', judgedAt: h.judgedAt || 0,
      })
    }
    operations.sort(function (a, b) { return b.lastAt - a.lastAt })
    return {
      ok: true,
      framework: { id: fw.id, name: fw.name },
      technique: {
        id: tech.id, name: tech.name, description: tech.description,
        tactic_ids: tech.tactic_ids || [], detect_hints: tech.detect_hints || '',
        detect_keywords: tech.detect_keywords,
      },
      tactics: fw.tactics || [],
      operations: operations,
    }
  }

  async function loadCurrent(workspaceId) {
    const list = listWorkspaces()
    let w = null
    if (workspaceId) { for (const x of list) if (x.id === workspaceId) { w = x; break } }
    if (!w) w = currentWorkspace()
    if (!w) return { ok: false, error: '拿不到工作区', workspaces: list }
    const store = await readStore(w.path)
    return { ok: true, workspace: w, store: store, workspaces: list }
  }

  // ── RPC 句柄（客户端 host.call 调）──────────────────────────────────────────
  harness.handle('snapshot', async function (args) {
    const wsId = args && args.workspaceId ? String(args.workspaceId) : ''
    const r = await loadCurrent(wsId)
    if (!r.ok) return { ok: false, error: r.error, workspaces: r.workspaces || [] }
    return { ok: true, workspaces: r.workspaces, current: r.workspace, view: summarizeStore(r.store, r.workspace.id) }
  })

  harness.handle('scan', async function (args) {
    const wsId = args && args.workspaceId ? String(args.workspaceId) : ''
    return await withStore(async function () {
      const r = await scanWorkspace(wsId, { reset: !!(args && args.reset) })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, stats: r.stats, current: r.workspace, view: summarizeStore(r.store, r.workspace.id) }
    })
  })

  harness.handle('technique', async function (args) {
    const wsId = args && args.workspaceId ? String(args.workspaceId) : ''
    const r = await loadCurrent(wsId)
    if (!r.ok) return { ok: false, error: r.error }
    const d = techniqueDetail(r.store, String((args && args.frameworkId) || ''), String((args && args.techniqueId) || ''))
    d.workspaceId = r.workspace.id
    return d
  })

  harness.handle('confirm', async function (args) {
    const wsId = args && args.workspaceId ? String(args.workspaceId) : ''
    const frameworkId = String((args && args.frameworkId) || '')
    const techniqueId = String((args && args.techniqueId) || '')
    const sessionId = args && args.sessionId ? String(args.sessionId) : ''
    return await withStore(async function () {
      const r = await loadCurrent(wsId)
      if (!r.ok) return { ok: false, error: r.error }
      const bucket = (r.store.matrix[frameworkId] || {})[techniqueId]
      if (!bucket) return { ok: false, error: '该技术点还没有记录，先扫描一次' }
      const ids = sessionId && bucket[sessionId] ? [sessionId] : Object.keys(bucket)
      let n = 0
      for (const sid of ids) {
        const h = bucket[sid]
        if (!h) continue
        h.confidence = 'confirmed'
        h.confirmedAt = nowMs()
        // 人工确认也要留痕：面板上能分辨「AI 自动标」和「人点的」。
        h.decidedBy = 'human'
        h.judgedAt = nowMs()
        h.needsJudge = false
        h.sentAt = 0
        if (!h.reason) h.reason = '面板手动确认'
        n++
      }
      if (n > 0) logTo(r.store, 'ok', '人工确认 ' + frameworkId + '/' + techniqueId + '（' + n + ' 个会话）')
      r.store.updatedAt = nowMs()
      await writeStore(r.store)
      return { ok: true, changed: n, view: summarizeStore(r.store, r.workspace.id) }
    })
  })

  harness.handle('ignore', async function (args) {
    const wsId = args && args.workspaceId ? String(args.workspaceId) : ''
    const frameworkId = String((args && args.frameworkId) || '')
    const techniqueId = String((args && args.techniqueId) || '')
    const sessionId = args && args.sessionId ? String(args.sessionId) : ''
    return await withStore(async function () {
      const r = await loadCurrent(wsId)
      if (!r.ok) return { ok: false, error: r.error }
      if (!(r.store.matrix[frameworkId] || {})[techniqueId]) return { ok: false, error: '该技术点还没有记录' }
      if (sessionId) delete r.store.matrix[frameworkId][techniqueId][sessionId]
      else r.store.matrix[frameworkId][techniqueId] = {}
      logTo(r.store, 'warn', '人工排除 ' + frameworkId + '/' + techniqueId + (sessionId ? '（' + sessionId + '）' : '（全部会话）'))
      r.store.updatedAt = nowMs()
      await writeStore(r.store)
      return { ok: true, view: summarizeStore(r.store, r.workspace.id) }
    })
  })

  // 「清除」与「重扫」是一对互补动作，区别只在水位：
  //   清除 = 清空命中记录与判定结论，**保留** scans 续点 → 历史事件不再入表，从此刻起重来；
  //   重扫 = 连 scans 一起清 → 同一批历史事件被原样重建（所以它清不掉噪音）。
  // 因此清除是可逆的：想要回历史就重扫一次。
  harness.handle('clear', async function (args) {
    const wsId = args && args.workspaceId ? String(args.workspaceId) : ''
    return await withStore(async function () {
      const r = await loadCurrent(wsId)
      if (!r.ok) return { ok: false, error: r.error }
      let buckets = 0
      for (const fw of Object.keys(r.store.matrix)) {
        const techs = r.store.matrix[fw] || {}
        for (const tid of Object.keys(techs)) buckets += Object.keys(techs[tid] || {}).length
      }
      r.store.matrix = {}
      // 日志也清掉（它记的是被清的这批数据），但立刻留一条清除记录本身。
      r.store.log = []
      r.store.logSeq = 0
      logTo(r.store, 'warn', '人工清除本工作区矩阵数据：' + buckets + ' 条命中记录出表（扫描续点保留 —— 历史事件不会重新入表，想要回历史请点「重扫」）')
      r.store.updatedAt = nowMs()
      await writeStore(r.store)
      return { ok: true, cleared: buckets, view: summarizeStore(r.store, r.workspace.id) }
    })
  })

  // ── 导出：时间线 CSV ──────────────────────────────────────────────────────
  // 面板只显示最近 200 个分组，导出取**全部**桶 —— 它是拿去写报告/进表格的交付物。
  function stampFull(ms) {
    if (!ms) return ''
    const d = new Date(ms)
    const p = function (n) { return n < 10 ? '0' + n : String(n) }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  }

  function csvCell(v) {
    const s = v === undefined || v === null ? '' : String(v)
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }

  function buildTimelineCsv(store) {
    const header = ['firstAt', 'lastAt', 'durationSec', 'frameworkId', 'techniqueId', 'techniqueName',
      'sessionId', 'sessionTitle', 'occurrences', 'confidence', 'decidedBy', 'reason',
      'targets', 'matchedKeywords', 'firstAtLocal', 'lastAtLocal', 'exportedAt']
    const rows = []
    for (const fw of FRAMEWORKS) {
      const bucket = store.matrix[fw.id] || {}
      for (const tech of fw.techniques) {
        const hits = bucket[tech.id] || {}
        for (const sid of Object.keys(hits)) {
          const h = hits[sid]
          if (!h || !h.lastAt) continue
          rows.push({
            first: h.firstAt || h.lastAt, last: h.lastAt,
            fw: fw.id, tid: tech.id, tname: tech.name,
            sid: sid, stitle: h.sessionTitle || '',
            n: h.occurrences || 0, conf: h.confidence || '',
            by: h.decidedBy || '', reason: h.reason || '',
            targets: hitTargets(h).join(' | '),
            matched: (h.matched || []).join(' | '),
          })
        }
      }
    }
    rows.sort(function (a, b) { return b.last - a.last })
    const L = [header.join(',')]
    for (const r of rows) {
      L.push([r.first, r.last, Math.round((r.last - r.first) / 1000), r.fw, r.tid, r.tname,
        r.sid, r.stitle, r.n, r.conf, r.by, r.reason, r.targets, r.matched,
        stampFull(r.first), stampFull(r.last), stampFull(nowMs())].map(csvCell).join(','))
    }
    // 前置 BOM：不带它 Excel 会把中文读成乱码。
    return { text: '\ufeff' + L.join('\r\n') + '\r\n', rows: rows.length }
  }

  harness.handle('exportCsv', async function (args) {
    const wsId = args && args.workspaceId ? String(args.workspaceId) : ''
    const r = await loadCurrent(wsId)
    if (!r.ok) return { ok: false, error: r.error, workspaces: r.workspaces || [] }
    const built = buildTimelineCsv(r.store)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const safe = String(r.workspace.id || 'workspace').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 32)
    return { ok: true, filename: 'attack-matrix-' + safe + '-' + stamp + '.csv', content: built.text, rows: built.rows }
  })

  // 把某个会话标成「非目标」：不再扫描它，并清掉它已有的记录 —— 忽略一个会话的
  // 意思就是「这些不是目标活动」，留着一堆桶只会污染覆盖率。可逆：
  // 恢复之后重扫一次，历史命中就回来了。
  harness.handle('ignoreSession', async function (args) {
    const wsId = args && args.workspaceId ? String(args.workspaceId) : ''
    const sid = String((args && args.sessionId) || '')
    const off = !!(args && args.off === true)
    const all = !!(args && args.all === true)
    if (!all && !sid) return { ok: false, error: '缺少 sessionId' }
    return await withStore(async function () {
      const r = await loadCurrent(wsId)
      if (!r.ok) return { ok: false, error: r.error }
      if (!Array.isArray(r.store.ignoreSessions)) r.store.ignoreSessions = []
      let removed = 0
      let note = ''
      if (all) {
        const n = r.store.ignoreSessions.length
        r.store.ignoreSessions = []
        note = '恢复全部（' + n + ' 个会话）—— 之后的扫描会重新收录'
      } else if (off) {
        const i = r.store.ignoreSessions.indexOf(sid)
        if (i >= 0) r.store.ignoreSessions.splice(i, 1)
        note = '恢复会话「' + sid + '」—— 之后的扫描会重新收录，历史命中需「重扫」才回来'
      } else {
        if (r.store.ignoreSessions.indexOf(sid) < 0) r.store.ignoreSessions.push(sid)
        for (const fw of Object.keys(r.store.matrix)) {
          const techs = r.store.matrix[fw] || {}
          for (const tid of Object.keys(techs)) {
            if (techs[tid] && techs[tid][sid]) { delete techs[tid][sid]; removed++ }
          }
        }
        if (r.store.scans && r.store.scans[sid]) delete r.store.scans[sid]
        note = '忽略会话「' + sid + '」：移出 ' + removed + ' 条命中记录，之后不再扫描它'
      }
      logTo(r.store, 'warn', '人工' + note)
      r.store.updatedAt = nowMs()
      await writeStore(r.store)
      return { ok: true, removed: removed, ignored: r.store.ignoreSessions.slice(), view: summarizeStore(r.store, r.workspace.id) }
    })
  })

  harness.handle('frameworks', async function () {
    return {
      ok: true,
      frameworks: FRAMEWORKS.map(function (fw) {
        return {
          id: fw.id, name: fw.name, short: fw.short || fw.name, source: fw.source || '',
          tactics: fw.tactics || [],
          techniques: fw.techniques.map(function (t) { return { id: t.id, name: t.name, tactic_ids: t.tactic_ids || [] } }),
        }
      }),
    }
  })

  // 自动扫描 + 自动研判的心跳。timer 的返回值就是 disposer，交给 ctx.effect 管生命周期，
  // 这样 stop / 卸载时不会留下野定时器。
  ctx.effect(function () {
    const t = ctx.get('timer')
    if (!t || typeof t.interval !== 'function') {
      console.error('[rtmatrix] timer 服务不可用：自动扫描与自动研判都不会运行')
      return
    }
    const a = t.interval(function () { autoScanOnce().catch(function () {}) }, AUTO_SCAN_MS)
    const b = t.interval(function () { autoJudgeOnce().catch(function () {}) }, AUTO_JUDGE_MS)
    return function () { a(); b() }
  }, 'redteam-attack-matrix: auto scan + judge')

  // 装载后先扫一次，不然要等一个节拍才看到东西。
  Promise.resolve().then(function () { return autoScanOnce() }).catch(function () {})

  const techniqueCount = FRAMEWORKS.reduce(function (n, f) { return n + f.techniques.length }, 0)
  console.log('[rtmatrix] attack-matrix host half ready; frameworks =', FRAMEWORKS.length, 'techniques =', techniqueCount)

  // 插件自己的 JSON-RPC 端点。
  // 客户端 bundle 用 fetch 调它（静态模块可用 fetch；动态半边才被屏蔽）。
  // 全部挂在 /dsh-redteam-attack-matrix 命名空间下，避免与其它插件的路由相撞。
  const RPC_PATH = '/dsh-redteam-attack-matrix/rpc'

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

export const name = 'redteam-attack-matrix'
// 三个工具注册进宿主 tools 注册表；这里声明本半边硬依赖的服务。
export const inject = ['fs', 'shell', 'timer', 'webServer']
export { applyHost as apply }
