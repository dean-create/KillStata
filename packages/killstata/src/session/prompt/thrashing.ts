import type { MessageV2 } from "../message-v2"

/**
 * workflow / question thrashing 检测：最近几轮 assistant 消息连续调用同一类
 * 工具（workflow 只读 action，或 question）且状态没变——典型表现为模型在
 * ARTIFACT_MISSING 或 question label 超长这类无解错误前盲试工具（2026-08-08
 * did.xlsx 真实测试：助手 5+ 步 workflow 盲试；同日另一次会话 question 连续失败 8 次）。
 *
 * 独立成模块：dispatch 依赖整棵 prompt 树，直接 import 会触发循环引用；检测函数
 * 是纯函数，抽出来单测更干净。
 */

const WORKFLOW_THRASHING_ACTIONS = new Set([
  "status",
  "stage",
  "artifacts",
  "doctor",
  "rerun_plan",
  "tasks",
  "timeline",
  "tools",
  "skills",
  "diagnostics",
  "agent",
  "verify",
])

/** question 也纳入 thrashing 检测：label/header 超长被拒时模型会反复重试同一批问题。 */
const THRASHING_TOOL_NAMES = new Set(["pipeline", "question"])

const READ_ONLY_DATA_ACTIONS = new Set(["profile", "frequency", "validate", "correlation", "healthcheck"])

/**
 * 用户明确要求：若当前工具不能安全构造研究设计变量，就说明缺口并停止。
 * 这不是普通的“请先检查数据”，不能让模型用更多只读查询把停点拖成无限探索。
 */
export function userRequestedResearchDesignStop(text: string | undefined) {
  if (!text) return false
  const explicitUnsupportedStop = /(?:如果|若)[^。\n]{0,180}(?:不能|无法|不支持)[^。\n]{0,180}(?:停止|停下)/i.test(text)
  return (
    (explicitUnsupportedStop || /(?:如果|若)[^。\n]{0,100}(?:不能|无法|不支持)[^。\n]{0,100}(?:构造|生成|计算)[^。\n]{0,80}(?:停止|停下)/i.test(text)) &&
    /(?:不要|请勿)[^。\n]{0,80}(?:猜|反复|试错|Bash|静默)/i.test(text)
  )
}

function dataQuerySignature(part: MessageV2.ToolPart) {
  if (part.tool !== "data_import") return undefined
  const input = part.state.input as Record<string, unknown> | undefined
  const normalize = (value: unknown) => (Array.isArray(value) ? [...value].sort() : value)
  return JSON.stringify({
    action: input?.action,
    datasetId: input?.datasetId,
    stageId: input?.stageId,
    variables: normalize(input?.variables),
    groupBy: normalize(input?.groupBy),
    entityVar: input?.entityVar,
    timeVar: input?.timeVar,
  })
}

function internalReadSignature(part: MessageV2.ToolPart) {
  if (part.tool !== "read") return undefined
  const input = part.state.input as Record<string, unknown> | undefined
  const reference = input?.filePath ?? input?.reference
  if (typeof reference !== "string") return undefined
  // 只把外部化工具结果/受控内部产物纳入空转检测；用户主动读取普通项目文件
  // 不能因为连续查看多个文件就被强行截断。
  if (!/^(?:tool-output:|tool-output\/)|(?:^|[\\/])\.killstata[\\/]|killstata-artifacts/i.test(reference)) return undefined
  return reference
}

function isDataMutation(part: MessageV2.ToolPart) {
  if (part.state.status === "running") return false
  if (part.tool === "data_preprocess") return true
  if (part.tool !== "data_import") return false
  const action = (part.state.input as Record<string, unknown> | undefined)?.action
  return action === "import" || action === "export" || action === "rollback"
}

export function detectWorkflowThrashing(
  msgs: MessageV2.WithParts[],
  options?: { userText?: string },
): {
  thrashing: boolean
  consecutiveCalls: number
  lastAction?: string
  toolName?: string
  researchDesign?: boolean
} {
  const WINDOW = 5
  let consecutive = 0
  let lastAction: string | undefined
  let lastTool: string | undefined
  const dataQuerySignatures = new Set<string>()
  const internalReadSignatures = new Set<string>()
  let oldestScannedMessageIndex = msgs.length
  for (let i = msgs.length - 1; i >= 0 && consecutive < WINDOW; i--) {
    oldestScannedMessageIndex = i
    const msg = msgs[i]
    if (msg.info.role !== "assistant") continue
    // 同一条消息可能携带多个并行 tool part（AI SDK 批量调用）：逐个统计，
    // 遇非 thrashing 工具或非只读 action 才中断，不能处理一个 part 就退出
    //（2026-08-09 drive did-direct：模型开场 6 个并行 workflow 只读到 1 个，漏检）。
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      if (part.state.status === "running") continue
      const isReadOnlyDataQuery =
        part.tool === "data_import" &&
        READ_ONLY_DATA_ACTIONS.has(String((part.state.input as { action?: unknown })?.action ?? ""))
      const readSignature = internalReadSignature(part)
      if (!THRASHING_TOOL_NAMES.has(part.tool) && !isReadOnlyDataQuery && !readSignature) break
      // workflow 只统计只读类 action；question 任何失败都计
      if (part.tool === "pipeline") {
        const action = (part.state.input as { action?: unknown })?.action
        if (typeof action !== "string" || !WORKFLOW_THRASHING_ACTIONS.has(action)) break
        lastAction = action
      } else if (part.state.status !== "error") {
        if (!isReadOnlyDataQuery && !readSignature) break
      }
      const signature = isReadOnlyDataQuery ? dataQuerySignature(part) : undefined
      if (signature) dataQuerySignatures.add(signature)
      if (readSignature) internalReadSignatures.add(readSignature)
      consecutive += 1
      lastTool = part.tool
    }
  }
  // 数据变换完成后，模型可能不断更换 variables/groupBy 继续做同一阶段的只读探查。
  // 这些调用各自合法，但连续达到窗口且没有进入估计/用户确认时，继续执行通常没有新信息。
  // 只在窗口前确实发生过数据变换时触发，保留普通质量体检中五种不同只读动作的自由度。
  let mutationBeforeWindow = false
  for (let i = oldestScannedMessageIndex - 1; i >= 0 && !mutationBeforeWindow; i--) {
    const msg = msgs[i]
    if (msg.info.role !== "assistant") continue
    mutationBeforeWindow = msg.parts.some((part) => part.type === "tool" && isDataMutation(part))
  }
  const dataQueriesAfterMutation =
    lastTool === "data_import" && consecutive >= WINDOW && mutationBeforeWindow && dataQuerySignatures.size >= WINDOW
  const repeatedInternalRead =
    lastTool === "read" && consecutive >= WINDOW && internalReadSignatures.size < consecutive
  const researchStopRequested = userRequestedResearchDesignStop(options?.userText)
  let explorationCalls = 0
  // 只统计当前用户消息之后的只读探查。这里故意不要求“同一查询重复”：
  // 用户已经明确说“不支持就停止”时，换变量、换分组继续查仍属于空转。
  researchScan: for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    if (msg.info.role === "user") break
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type !== "tool" || part.state.status === "running") continue
      // 成功的数据变换已经改变了研究阶段；只统计该阶段之后的新探查，
      // 避免把变换前的正常画像与变换后的查询累计成误报。
      if (part.tool === "data_preprocess" && part.state.status === "completed") break researchScan
      const isReadOnlyExploration =
        part.tool === "data_import" ||
        part.tool === "read" ||
        part.tool === "econometrics_recommend"
      if (isReadOnlyExploration) explorationCalls += 1
    }
  }
  const researchDesign =
    researchStopRequested &&
    explorationCalls >= 4
  return {
    // 不同的合法画像动作可以组成正常工作流；至少出现一次相同查询重复，才认定
    // data_import 在无状态变化下空转。pipeline/question 仍沿用原有阈值语义。
    thrashing:
      consecutive >= WINDOW &&
      (lastTool !== "data_import" || dataQuerySignatures.size < consecutive || dataQueriesAfterMutation) ||
      repeatedInternalRead || researchDesign,
    consecutiveCalls: consecutive,
    lastAction,
    toolName: lastTool,
    researchDesign,
  }
}
