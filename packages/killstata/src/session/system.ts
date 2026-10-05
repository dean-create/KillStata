import { Instance } from "../project/instance"
import type { MessageV2 } from "./message-v2"

import PROMPT_GENERIC from "./prompt/qwen.txt"
import PROMPT_DEEPSEEK from "./prompt/deepseek.txt"

import type { Provider } from "@/provider/provider"
import { Flag } from "@/flag/flag"
import type { Agent } from "@/agent/agent"
import { SessionInstruction } from "./instruction"
import { DataContext } from "./data-context"
import { buildContextCapsule } from "@/runtime/context-capsule-adapter"
import { renderContextCapsule } from "@/runtime/context-capsule"
import { ECONOMETRICS_CONTEXT } from "./prompt/econometrics-context"
import { ANALYST_ROLE_PROMPT } from "@/agent/prompt/roles"
import type { PromptSection } from "@/runtime/services/prompt-assembly"
import type { WorkflowInputIntent } from "@/runtime/types"
import { CONVERSATION_PROMPT } from "./prompt/core"
import { Tool } from "@/tool/tool"
import { getExecutionMode } from "@/runtime/execution-mode"

const RUNTIME_ENVIRONMENT_PREFIX = "<runtime>"

function compactPrompt(value: string) {
  return value.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
}

// 这些 prompt 是编译期常量，压缩结果不随请求变化：模块加载时算一次即可，
// 不必每个 step 都对几 KB 文本重跑正则。
const COMPACT_PROMPT_DEEPSEEK = compactPrompt(PROMPT_DEEPSEEK)
const COMPACT_PROMPT_GENERIC = compactPrompt(PROMPT_GENERIC)
const COMPACT_ECONOMETRICS_CONTEXT = compactPrompt(ECONOMETRICS_CONTEXT)

/**
 * system prompt 的分层装配。每层只负责一件事，同一条规则不跨层重复：
 *
 *   provider    完整静态行为边界    → `session/prompt/{deepseek,qwen}.txt`
 *   methodology 计量方法论与工作流  → `session/prompt/econometrics-context.ts`
 *   role        agent 职责边界      → `agent/prompt/roles.ts`
 *   runtime     环境与数据集状态    → `environment()`
 *   catalog     本轮可调用工具      → `toolCatalog()`
 *   user        用户自定义规则      → `custom()`
 *
 * 装配顺序见 `session/llm.ts` 的 stream()。想知道某条规则出自哪一层，
 * 用 `killstata debug prompt --agent <name> --provider <id>`。
 */
export namespace SystemPrompt {
  export function sections(input: {
    model: Provider.Model
    agent: Agent.Info
    runtime?: string[]
    custom?: string[]
    inventory?: string[]
    catalog?: string[]
    user?: string[]
    hooks?: string[]
    conversationOnly?: boolean
  }): PromptSection[] {
    const turn = (id: string, content: string[]): PromptSection[] =>
      content.filter(Boolean).map((item, index) => ({
        id: index === 0 ? id : `${id}.${index}`,
        stability: "turn",
        content: item,
      }))

    if (input.conversationOnly) {
      return [
        { id: "global.conversation", stability: "global", content: CONVERSATION_PROMPT },
        ...(input.custom ?? []).filter(Boolean).map((content, index) => ({
          id: index === 0 ? "session.custom" : `session.custom.${index}`,
          stability: "session" as const,
          content,
        })),
        ...turn("turn.runtime", input.runtime ?? []),
        ...turn("turn.user", input.user ?? []),
        ...turn("turn.hooks", input.hooks ?? []),
      ]
    }

    if (input.agent.prompt) {
      return [
      ...(input.inventory ?? []).filter(Boolean).map((content, index) => ({
        id: index === 0 ? "global.tool_inventory" : `global.tool_inventory.${index}`,
        stability: "global" as const,
        content,
      })),
        { id: "session.agent", stability: "session", content: input.agent.prompt },
        ...(input.custom ?? []).filter(Boolean).map((content, index) => ({
          id: index === 0 ? "session.custom" : `session.custom.${index}`,
          stability: "session" as const,
          content,
        })),
        ...turn("turn.runtime", input.runtime ?? []),
        ...turn("turn.user", input.user ?? []),
        ...turn("turn.hooks", input.hooks ?? []),
        ...turn("turn.catalog", input.catalog ?? []),
      ]
    }

    const [providerPrompt, methodology] = provider(input.model)
    return [
      { id: "global.provider", stability: "global", content: providerPrompt },
      { id: "global.methodology", stability: "global", content: methodology },
      ...(input.inventory ?? []).filter(Boolean).map((content, index) => ({
        id: index === 0 ? "global.tool_inventory" : `global.tool_inventory.${index}`,
        stability: "global" as const,
        content,
      })),
      ...agent(input.agent).map((content, index) => ({
        id: index === 0 ? "session.agent" : `session.agent.${index}`,
        stability: "session" as const,
        content,
      })),
      ...(input.custom ?? []).filter(Boolean).map((content, index) => ({
        id: index === 0 ? "session.custom" : `session.custom.${index}`,
        stability: "session" as const,
        content,
      })),
      ...turn("turn.runtime", input.runtime ?? []),
      ...turn("turn.user", input.user ?? []),
      ...turn("turn.hooks", input.hooks ?? []),
      ...turn("turn.catalog", input.catalog ?? []),
    ]
  }

  export function agent(agent: Agent.Info) {
    if (agent.name === "analyst" || agent.name === "explorer") return [ANALYST_ROLE_PROMPT]
    return []
  }

  export function conversation() {
    return [CONVERSATION_PROMPT]
  }

  export function header(_providerID: string): string[] {
    return []
  }

  /**
   * 第二层方法注册表的稳定索引。
   *
   * 稳定前缀只说明发现协议和跨语言职责，不枚举计量方法 ID 或方法级 Schema；
   * 具体方法由 Python Registry 在 tool_search 时按需返回。这样方法增删不会使
   * System Prompt 的稳定缓存前缀随之变化。
   */
  export function toolInventory(
    _entries: Array<{ modelNamespace: Tool.ModelNamespace }>,
  ) {
    const lines = [
      "# 工具发现",
      "系统采用三级工具架构：本轮工具目录列出可直接调用的系统工具；具体计量方法由 Python Registry 按需检索，不预加载到稳定工具目录。",
      "",
      "## 计量方法发现",
      "1. 数据或估计任务先调用 analysis_request 登记当前用户消息；登记完成后，再依据 data_import、数据质量检查和推荐结果确认数据事实；",
      "2. 需要具体方法时调用 tool_search，Python Registry 会返回候选、适用边界和参数 Schema；",
      "3. 使用 Python 返回的完整 Schema 调用 analysis_prepare(requestId, methodID, arguments)，由 Pydantic 校验参数并对当前数据阶段执行只读 preflight；",
      "4. inspect 只报告可行性；estimate 只有返回当前任务的 ready specId、方法与数据阶段绑定仍有效，且用户已明确选择该方法后，才能调用 econometrics_execute(specId)。准备规格不是执行授权。",
      "具体方法以按需加载的完整方法引用为准；不要猜测隐藏方法 ID 或参数。",
      "Python 引擎只负责 Registry、参数校验、数据计算和结构化结果，不读取 Session、不调用模型、不决定权限或是否向用户提问；",
      "TypeScript Harness 负责 Agent 循环、工具协议、数据血缘、权限、用户确认、上下文、结果展示和引擎进程生命周期。",
    ]
    lines.push(
      "",
      "数据导入、预处理、状态查询等系统能力按当前工作流直接暴露，不要用 tool_search 搜索它们。",
      "不要猜测方法 ID；若 Registry 没有匹配结果，说明当前能力缺口或需要补充研究设计。",
    )
    return [lines.join("\n")]
  }

  export function toolCatalog(
    tools: Array<string | { id: string; modelNamespace: Tool.ModelNamespace }>,
    deferred?: Array<{ modelNamespace: Tool.ModelNamespace; count: number }>,
    methodReferences?: Array<{
      toolID: string
      modelNamespace: Tool.ModelNamespace
      description: string
      inputSchema: unknown
    }>,
  ) {
    const deduplicated = new Map<string, Tool.ModelNamespace | undefined>()
    for (const item of tools) {
      if (typeof item === "string") deduplicated.set(item, undefined)
      else deduplicated.set(item.id, item.modelNamespace)
    }
    const exposed = [...deduplicated.keys()].sort()
    const lines = ["# 当前工具目录"]
    if (!exposed.length) {
      lines.push("本轮没有可调用工具。")
    } else {
      const grouped = new Map<string, string[]>()
      for (const id of exposed) {
        const namespace = deduplicated.get(id)
        const label = namespace ? Tool.ModelNamespaceLabel[namespace] : "其他"
        const values = grouped.get(label) ?? []
        values.push(id)
        grouped.set(label, values)
      }
      lines.push("本轮可调用工具按用途分组如下；工具 ID 保持稳定，详细边界以各工具 schema 为准：")
      for (const namespace of Tool.ModelNamespaceOrder) {
        const label = Tool.ModelNamespaceLabel[namespace]
        const ids = grouped.get(label)
        if (ids?.length) lines.push(`- ${label}：${ids.join(", ")}`)
      }
      const other = grouped.get("其他")
      if (other?.length) lines.push(`- 其他：${other.join(", ")}`)
    }
    if (deferred?.some((item) => item.count > 0)) {
      lines.push("延迟工具按用途汇总如下；此处不展开工具 ID 和 Schema：")
      for (const namespace of Tool.ModelNamespaceOrder) {
        const count = deferred
          .filter((item) => item.modelNamespace === namespace)
          .reduce((total, item) => total + Math.max(0, item.count), 0)
        if (count > 0) lines.push(`- ${Tool.ModelNamespaceLabel[namespace]}：${count} 个`)
      }
      lines.push(
        "需要延迟工具时，先调用 tool_search 描述具体任务或方法；搜索命中的完整 Schema 从下一轮模型请求开始可见。不要猜测隐藏工具 ID。",
      )
    }
    // 已加载的方法引用已经在 tool_search 结果中携带 Schema；稳定 Provider 工具前缀
    // 不随方法变化。方法字段先由 analysis_prepare 校验并生成 PreparedSpec，执行只传 specId。
    if (methodReferences?.length) {
      lines.push(
        `已加载的计量方法引用（完整 Schema 已随搜索结果提供）：${methodReferences.map((reference) => reference.toolID).join("、")}。先调用 analysis_prepare(requestId, methodID, arguments)；仅当当前 estimate 请求获得 ready specId 且用户授权该方法后，调用 econometrics_execute(specId)。`,
      )
    }
    lines.push(
      "不得调用“本轮可调用”以外的工具。需要的工具缺失或未解锁时，说明所需阶段转换；不要把阶段限制说成工具未注册。",
    )
    lines.push(
      "需要索引里的其他计量方法时，先用 tool_search 按方法 ID 加载 Schema，再用 analysis_prepare 做字段校验与数据 preflight；econometrics_execute 只接受准备成功的 specId。",
    )
    return [lines.join("\n")]
  }

  // provider 已锁定为 deepseek + custom 两家（见 provider/model-policy.ts），用户根本连不上
  // gpt / gemini / claude。原先按这些模型 id 分支的 codex/beast/gemini/anthropic prompt
  // 全是死路由，已删除。现在只有两条真实路径：
  //   - deepseek → 完整的中文静态行为 prompt，额外锁定工具参数必须为 JSON 对象
  //   - custom（Qwen / Kimi / GLM / 本地 vLLM）→ 完整的通用中文静态行为 prompt
  // 两份 Provider 文件自身都可独立审查；具体估计器路由仍只由 ECONOMETRICS_CONTEXT
  // 提供，避免把同一套计量决策树复制两份后发生漂移。
  export function provider(model: Provider.Model) {
    const isDeepSeek = model.providerID === "deepseek" || model.api.id.includes("deepseek")
    return [isDeepSeek ? COMPACT_PROMPT_DEEPSEEK : COMPACT_PROMPT_GENERIC, COMPACT_ECONOMETRICS_CONTEXT]
  }

  export async function environment(input: {
    sessionID: string
    messages?: MessageV2.WithParts[]
    inputIntent?: WorkflowInputIntent
    confirmedToolIDs?: string[]
    analysisRequestId?: string
  }) {
    // <data-context> 让模型每轮都知道"当前在哪个数据集、哪个活跃阶段、已试几组设定"，
    // 而不必靠翻对话历史去回忆（压缩之后连历史都没了）。数据全部来自已落盘的 manifest，
    // 没有已导入数据集时返回 undefined，不塞空壳。
    // sessionID 必传：**会话隔离**。dataset index 是项目级共享的，但只有本会话真正操作过
    // 的数据集才允许进入模型可见面——新窗口绝不能背上别的会话留下的数据集，见
    // DataContext.build() 的文档注释。
    const capsule = buildContextCapsule(input.sessionID)
    const dataContext = capsule ? renderContextCapsule(capsule) : DataContext.build(input.sessionID)
    const dataReadiness = DataContext.readiness(input.sessionID)
    // 执行模式声明。两种模式的工具**可见面完全一致**，差别在执行边界与提问倾向：
    // - Plan：放行 data_import 的受管检查动作 + question/todowrite/skill，其余返回
    //   PLAN_MODE_EXECUTION_BLOCKED；因为不执行分析，必须靠多轮 question 把研究设计问清楚。
    // - Auto：全部放行；此时反复提问才是干扰，能推断的一律自己定。
    const executionModeNotice =
      getExecutionMode() === "plan"
        ? [
            "执行模式=Plan（规划与受管检查）",
            "- 可以：data_import 的检查动作（import/profile/validate/correlation/frequency/healthcheck；只生成受管检查快照，不改用户原始文件）、读产物、tool_search 查看计量方法参数 Schema、用 question 向用户澄清、列出完整分析计划。",
            "- 不可以：data_preprocess、任何估计器/诊断器、econometrics_recommend、data_import 的 export/rollback，以及除上述受管检查快照外的写文件/执行命令——这些会被 PLAN_MODE_EXECUTION_BLOCKED 拒绝。",
            "- 收到 PLAN_MODE_EXECUTION_BLOCKED 时不要重试、不要换工具绕路：把要执行的方法名、完整参数、数据阶段和步骤顺序写进给用户的方案，并说明切到 Auto 后即可执行。",
            "- 提问策略（Plan 模式要主动）：用户给了数据文件后，先导入并读画像，再基于真实列名逐轮用 question 澄清研究设计——分析目标、被解释变量、核心解释变量、控制变量、面板的个体与时间列、识别策略与样本范围。每轮只问一个核心决策，用户回答后再问下一个；把已确认的选择累积进最终方案。宁可多问一轮，也不要替用户假设研究设计。",
          ].join("\n")
        : [
            "执行模式=Auto（自由执行）",
            "- 默认自己把任务做完：能从数据画像、质检结果、schema 或用户已说明的内容推断出来的，直接推断并执行，不要为确认而确认。",
            "- 只有在缺少这一项就无法继续、且任何假设都可能做出与用户意图相反的分析时，才用 question 询问一次；问完立刻继续执行。",
            "- 变量角色、面板键、方法选择存在多个同样合理且结论方向不同的选项时，属于必须询问；仅仅是参数细节或可逆的默认值，自己定并在结果里说明。",
          ].join("\n")
    const interactionNotice = input.inputIntent === "status"
      ? "本轮是只读进度查询：优先调用 pipeline 的 status 获取当前真实状态，然后用中文直接回答用户。不要重新导入、质检、读取外部化报告或调用计量工具；不要因为状态不完整而重启分析。"
      : undefined
    const analysisRequestNotice = input.analysisRequestId
      ? `当前 AnalysisRequest requestId=${input.analysisRequestId}；仅在 analysis_prepare 的 requestId 字段使用此值，不要向用户展示。`
      : undefined
    const confirmedMethodNotice = input.confirmedToolIDs?.length
      ? [
          `本轮用户已明确选择的方法：${input.confirmedToolIDs.join("、")}`,
          "优先按该方法检查前置条件并执行；不得回到此前失败的方法，也不得静默改用其他方法。",
          "如果缺少研究设计前提，必须询问用户并说明具体缺口，不得猜测构造规则。",
        ].join("\n")
      : undefined
    return [
      [
        RUNTIME_ENVIRONMENT_PREFIX,
        `主工作目录=${Instance.directory}`,
        `平台=${process.platform}`,
        `Shell=${process.env.SHELL?.split("/").pop() ?? "unknown"}`,
        `日期=${new Date().toISOString().slice(0, 10)}`,
        analysisRequestNotice,
        interactionNotice,
        confirmedMethodNotice,
        executionModeNotice,
        dataContext,
        dataReadiness,
        "</runtime>",
      ]
        .filter(Boolean)
        .join("\n"),
    ]
  }

  export async function custom() {
    return SessionInstruction.system()
  }
}
