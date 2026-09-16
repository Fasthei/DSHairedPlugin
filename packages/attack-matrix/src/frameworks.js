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

export const FRAMEWORKS = [
  {
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
