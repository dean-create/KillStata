import type { NamedError } from "@killstata/util/error"
import { MessageV2 } from "@/session/message-v2"
import { ProviderTransform } from "@/provider/transform"
import type { FailureType } from "./failure-reflection"
import { Token } from "@/util/token"

export namespace FailurePolicy {
  export const RETRY_INITIAL_DELAY = 2_000
  export const RETRY_BACKOFF_FACTOR = 2
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000
  export const RETRY_MAX_DELAY = 2_147_483_647
  /** 安全上限，不冒充本地统计结论；ledger 遥测样本充足后再校准。 */
  export const MAX_CONSECUTIVE_MODEL_FAILURES = 3
  /**
   * 纯网络/连接类瞬时故障（掉线、DNS 抖动、TLS 握手失败、socket 断开、408）单独放宽到 10 次。
   * 这类失败几乎总能靠等待恢复，且不会产生副作用（tool-call 在流结束前对引擎不可见），
   * 积极重连比过早熔断更贴近用户预期。限流(429)、5xx 仍走 MAX_CONSECUTIVE_MODEL_FAILURES。
   */
  export const MAX_TRANSIENT_NETWORK_RETRIES = 10
  export const MAX_CONSECUTIVE_COMPACTION_FAILURES = 3
  export const FALLBACK_AFTER_RETRIES = MAX_CONSECUTIVE_MODEL_FAILURES
  export const BACKGROUND_MAX_RETRIES = 0

  export type RequestSource = "foreground" | "background"
  export type FailureDisposition = "retry" | "repair" | "stop" | "compact" | "fallback"
  export type ModelFailureCategory =
    | "transient_network"
    | "rate_limited"
    | "provider_unavailable"
    | "invalid_request"
    | "authentication"
    | "permission_denied"
    | "quota_exhausted"
    | "context_overflow"
    | "aborted"
    | "unknown_model_failure"
  export type ToolFailureCategory =
    | "permission_denied"
    | "user_cancelled"
    | "tool_not_found"
    | "attempt_budget_exhausted"
    | "result_contract_failure"
    | "invalid_tool_input"
    | "precondition_failure"
    | "qa_blocked"
    | "estimation_failure"
    | "process_timeout"
    | "side_effect_retry_blocked"
    | "unknown_tool_failure"

  export type FailureDecision = {
    scope: "model" | "tool" | "compaction"
    category: ModelFailureCategory | ToolFailureCategory | "compaction_circuit_open"
    disposition: FailureDisposition
    reason: string
    userVisibleMessage: string
    maxConsecutiveFailures?: number
  }

  function messageOf(error: ReturnType<NamedError["toObject"]>) {
    return typeof error.data?.message === "string" ? error.data.message : ""
  }

  function hasTransientDisconnect(message: string) {
    const lower = message.toLowerCase()
    return (
      lower.includes("stream disconnected before completion") ||
      lower.includes("stream disconnected before first meaningful response") ||
      lower.includes("connection reset by server") ||
      lower.includes("econnreset") ||
      lower.includes("socket hang up") ||
      (lower.includes("error sending request for url") &&
        (lower.includes("/responses/compact") || lower.includes("/backend-api/codex/responses")))
    )
  }

  function hasTransientCertificateError(message: string) {
    const lower = message.toLowerCase()
    return (
      lower.includes("unknown certificate verification error") ||
      lower.includes("certificate verification error") ||
      lower.includes("certificate verification failed") ||
      lower.includes("unable to verify the first certificate") ||
      lower.includes("client network socket disconnected before secure tls connection was established") ||
      lower.includes("tls handshake") ||
      lower.includes("ssl handshake")
    )
  }

  /**
   * 常见的"网络不好/波动"传输层错误签名——这些错误没有 HTTP 状态码（请求根本没到服务端
   * 或响应中途断开），几乎总能靠重连恢复。命中即按 MAX_TRANSIENT_NETWORK_RETRIES 积极重试。
   * 用户主动中断(MessageAbortedError)在 classifyModel 顶部已先行拦截，不会走到这里。
   */
  function hasTransientNetworkError(message: string) {
    if (hasTransientDisconnect(message) || hasTransientCertificateError(message)) return true
    const lower = message.toLowerCase()
    return (
      lower.includes("fetch failed") ||
      lower.includes("failed to fetch") ||
      lower.includes("network error") ||
      lower.includes("networkerror when attempting to fetch") ||
      lower.includes("enotfound") ||
      lower.includes("eai_again") ||
      lower.includes("econnrefused") ||
      lower.includes("econnaborted") ||
      lower.includes("etimedout") ||
      lower.includes("epipe") ||
      lower.includes("ehostunreach") ||
      lower.includes("enetunreach") ||
      lower.includes("enetdown") ||
      lower.includes("connection refused") ||
      lower.includes("connection closed") ||
      lower.includes("connection timeout") ||
      lower.includes("connect timeout") ||
      lower.includes("request timed out") ||
      lower.includes("the network connection was lost") ||
      lower.includes("unable to connect") ||
      lower.includes("could not connect") ||
      lower.includes("name or service not known") ||
      lower.includes("temporary failure in name resolution")
    )
  }

  function capacityCategoryFromPayload(message: string): ModelFailureCategory | undefined {
    try {
      const json = JSON.parse(message)
      if (json?.type === "error" && json.error?.type === "too_many_requests") return "rate_limited"
      if (typeof json?.error?.code === "string" && json.error.code.includes("rate_limit")) return "rate_limited"
      if (typeof json?.code === "string" && (json.code.includes("exhausted") || json.code.includes("unavailable"))) {
        return "provider_unavailable"
      }
      if (json?.error?.message?.includes("no_kv_space") || json?.error?.type === "server_error") {
        return "provider_unavailable"
      }
    } catch {}
    return undefined
  }

  export function classifyModel(
    error: ReturnType<NamedError["toObject"]>,
    source: RequestSource = "foreground",
  ): FailureDecision {
    const message = messageOf(error)
    const lower = message.toLowerCase()
    const api = MessageV2.APIError.isInstance(error) ? error : undefined
    const status = api?.data.statusCode

    // 用户主动中断优先于一切分类：否则中断时若报错信息里恰好含 "socket hang up" 等字样，
    // 会被下方的瞬时网络分支误判成可重试，从而在用户已经按下停止后继续重连。
    if (error.name === "MessageAbortedError") {
      return {
        scope: "model", category: "aborted", disposition: "stop", reason: message || "Aborted",
        userVisibleMessage: "已停止本次模型请求。",
      }
    }

    if (ProviderTransform.isBalanceOrQuotaError(message) || status === 402) {
      return {
        scope: "model", category: "quota_exhausted", disposition: "stop",
        reason: message || "Provider quota exhausted",
        userVisibleMessage: "模型服务余额或配额不足，本次任务已停止；任务进度和已完成产物仍然保留。",
      }
    }
    if (status === 413) {
      return {
        scope: "model", category: "context_overflow", disposition: "compact", reason: message || "HTTP 413",
        userVisibleMessage: "模型输入超过上下文限制，正在从持久化任务状态生成压缩视图。",
      }
    }
    if (status === 408) {
      return {
        scope: "model", category: "transient_network", disposition: "retry", reason: message || "HTTP 408",
        userVisibleMessage: "网络请求超时，正在重连。",
        maxConsecutiveFailures: MAX_TRANSIENT_NETWORK_RETRIES,
      }
    }
    if (status !== undefined && status >= 400 && status < 500 && ![401, 403, 429].includes(status)) {
      return {
        scope: "model", category: "invalid_request", disposition: "stop", reason: message || `HTTP ${status}`,
        userVisibleMessage: "模型请求格式或参数不被服务接受，框架不会原样重试。",
      }
    }
    if (status === 401) {
      return {
        scope: "model", category: "authentication", disposition: "stop", reason: message || "HTTP 401",
        userVisibleMessage: "模型服务认证失败，请检查当前provider凭证后从失败阶段继续。",
      }
    }
    if (status === 403) {
      return {
        scope: "model", category: "permission_denied", disposition: "stop", reason: message || "HTTP 403",
        userVisibleMessage: "模型服务拒绝了当前请求，框架不会重复发送相同请求。",
      }
    }
    if (status === 429 || lower.includes("too many requests") || lower.includes("rate limit")) {
      return {
        scope: "model", category: "rate_limited", disposition: source === "foreground" ? "retry" : "stop",
        reason: message || "Rate limited",
        userVisibleMessage: source === "foreground"
          ? "模型服务暂时限流，正在按服务端等待时间重试。"
          : "后台模型任务遇到限流，已停止以保留前台配额。",
        maxConsecutiveFailures: MAX_CONSECUTIVE_MODEL_FAILURES,
      }
    }
    if (hasTransientNetworkError(message)) {
      // 一直没有收到正文、思考或工具事件时，重试同一请求不会给模型带来新的信息，
      // 不能沿用普通网络抖动的 10 次重连预算；三次后交还用户，避免空等数分钟。
      const maxConsecutiveFailures = lower.includes("before first meaningful response")
        ? MAX_CONSECUTIVE_MODEL_FAILURES
        : MAX_TRANSIENT_NETWORK_RETRIES
      return {
        scope: "model", category: "transient_network", disposition: "retry",
        reason: hasTransientCertificateError(message)
          ? "Provider TLS/certificate verification failed"
          : "Transient network failure",
        userVisibleMessage: "网络连接不稳定，正在重连。",
        maxConsecutiveFailures,
      }
    }

    const payloadCategory = capacityCategoryFromPayload(message)
    if (payloadCategory === "rate_limited") {
      return {
        scope: "model", category: "rate_limited", disposition: source === "foreground" ? "retry" : "stop",
        reason: "Too Many Requests",
        userVisibleMessage: source === "foreground"
          ? "模型服务暂时限流，正在有限重试。"
          : "后台模型任务遇到限流，已停止以保留前台配额。",
        maxConsecutiveFailures: MAX_CONSECUTIVE_MODEL_FAILURES,
      }
    }
    if ((status !== undefined && status >= 500) || payloadCategory === "provider_unavailable" || api?.data.isRetryable) {
      return {
        scope: "model", category: payloadCategory ?? "provider_unavailable",
        disposition: source === "foreground" ? "retry" : "stop",
        reason: message || (status ? `HTTP ${status}` : "Provider unavailable"),
        userVisibleMessage: source === "foreground"
          ? "模型服务暂时不可用，正在有限重试。"
          : "后台模型任务遇到服务拥塞，已停止。",
        maxConsecutiveFailures: MAX_CONSECUTIVE_MODEL_FAILURES,
      }
    }
    return {
      scope: "model", category: "unknown_model_failure", disposition: "stop",
      reason: message || "Unknown model failure",
      userVisibleMessage: "模型请求发生不可安全重试的错误，本次任务已停止并保留当前进度。",
    }
  }

  export function classifyTool(input: {
    toolName: string
    message: string
    failureType?: FailureType
    errorCode?: string
    control?: "permission_denied" | "user_cancelled"
    preventContinuation?: boolean
    hookSuggestedRepair?: boolean
    sideEffectLevel?: "none" | "session" | "filesystem" | "external"
    /** 只读探查工具（glob/grep/read/list/tool_search 等）：未知失败不终结整轮，把错误交回模型继续或汇报。 */
    readOnlyTool?: boolean
    /**
     * 该工具 ID 是否在准入清单里。用于区分"方法存在但本轮没加载"与"工具根本不存在"：
     * 前者是可修复状态，必须告诉模型怎么加载；后者才终结。未传时按保守的终结处理。
     */
    admittedTool?: boolean
  }): FailureDecision {
    const lower = input.message.toLowerCase()
    const terminal = (category: ToolFailureCategory, userVisibleMessage: string): FailureDecision => ({
      scope: "tool", category, disposition: "stop", reason: input.message, userVisibleMessage,
    })
    const repair = (
      category: ToolFailureCategory,
      userVisibleMessage: string,
      options: { preconditionOnly?: boolean } = {},
    ): FailureDecision => {
      // 数据质量检查/规划门禁发生在目标动作真正执行前，repair 的含义是切换到画像、清洗等
      // 前置工具，不是重放刚才的有副作用调用。未知失败或执行中断仍必须 fail-closed。
      if (
        input.sideEffectLevel &&
        input.sideEffectLevel !== "none" &&
        options.preconditionOnly !== true
      ) {
        return terminal(
          "side_effect_retry_blocked",
          `工具 ${input.toolName} 可能已经改变状态，缺少幂等执行凭证，框架不会自动重试；请核对当前阶段和产物后再决定是否继续。`,
        )
      }
      return { scope: "tool", category, disposition: "repair", reason: input.message, userVisibleMessage }
    }

    if (input.control === "permission_denied") return terminal("permission_denied", "当前权限不允许执行该工具，本次任务已停止。")
    if (input.control === "user_cancelled") return terminal("user_cancelled", "用户已停止本次工具执行。")
    if (
      input.failureType === "data_snapshot_failure" ||
      input.errorCode === "DATA_SNAPSHOT_FAILED" ||
      input.errorCode === "DATA_SNAPSHOT_UNSTABLE"
    ) {
      return terminal(
        "precondition_failure",
        "计量引擎无法保证本次执行读取的数据快照稳定；估计器没有运行。请确认文件写入已完成且本机读取权限/磁盘空间正常，再刷新诊断并重新准备规格。",
      )
    }
    if (
      lower.includes("当前活动方法窗口") ||
      (lower.includes("method") && lower.includes("active method window"))
    ) {
      // 稳定的 econometrics_execute 路由通过 specId 回查真实 methodID；方法尚未
      // 进入滑动窗口时不是参数契约错误，也不是“原样重试”问题，而是一次方法发现
      // 失败。必须把模型送回 tool_search/已注册工具目录，否则它会重复提交同一个
      // methodID，浪费 repair 预算并把可恢复任务误报成停止。
      return repair(
        "tool_not_found",
        `方法 ${input.toolName} 当前不在活动方法窗口；请先调用 tool_search 搜索并加载已注册方法，再按返回的 Schema 重新选择，不要原样重试该 methodID。`,
        { preconditionOnly: true },
      )
    }
    if (
      lower.includes("unavailable tool") || lower.includes("no such tool") ||
      lower.includes("tool is not available") || (lower.includes("tool ") && lower.includes("not available in this request"))
    ) {
      // 已准入方法未出现在本轮目录，是**阶段/窗口限制**而不是"不存在"。此前一律 terminal，
      // 给模型的只有一句否定，既不说它其实可以加载，也不给加载路径——真实会话里模型因此
      // 盲试 pipeline status/verify/diagnostics 直到熔断（2026-08-28 did.xlsx）。
      if (input.admittedTool) {
        return repair(
          "tool_not_found",
          `${input.toolName} 是已准入方法，只是尚未加载到当前方法引用窗口。先调用 tool_search 并把 query 设为 "${input.toolName}"，再按返回 Schema 调用 analysis_prepare；只有得到当前请求绑定的 ready specId 后才能调用 econometrics_execute(specId)，不要改用其他方法。`,
          { preconditionOnly: true },
        )
      }
      // 未注册工具根本没有执行，因此不存在副作用。把它作为一次“工具选择错误”
      // 交回模型，让模型查看当前目录或 tool_search 选择已注册工具；外层仍受
      // AUTOMATIC_TOOL_REPAIR_LIMIT 限制，连续选错后会清晰停点，不会无限循环。
      return repair(
        "tool_not_found",
        `工具 ${input.toolName} 未注册，本次没有执行任何操作。请根据当前已注册工具目录重新选择工具；必要时调用 tool_search，不要继续猜测同名工具。`,
        { preconditionOnly: true },
      )
    }
    if (lower.includes("tool_attempt_budget_exhausted")) {
      return terminal(
        "attempt_budget_exhausted",
        "同一数据阶段、计量方法和参数已经失败过一次，系统拒绝原样重复估计；请先根据结构化错误修正数据或研究设定，再继续。",
      )
    }
    if (input.errorCode === "TOOL_SCHEMA_NOT_SENT") {
      return repair(
        "invalid_tool_input",
        `${input.toolName} 的完整参数 Schema 未进入本轮模型上下文，本次未执行估计。先调用 tool_search 搜索并加载该精确 methodID，再按返回的完整 Schema 修正字段后重试；不要猜参数或切换方法。`,
        { preconditionOnly: true },
      )
    }
    if (lower.includes("不支持分位数分箱") || lower.includes("不支持分箱")) {
      return terminal(
        "precondition_failure",
        "当前工具没有安全的分位数分箱能力，已停止继续试错；请提供已分好组的 0/1/2 分类列，或确认新增并验收分箱方法。",
      )
    }
    if (
      lower.includes("must be of a numeric type") ||
      lower.includes("必须是数值型") ||
      lower.includes("可转换为数值的时期编码")
    ) {
      return terminal(
        "invalid_tool_input",
        "事件研究的时间变量和首次处理时期变量必须是可转换为数值的时期编码；本次未生成结果。请检查 year/time 的类型，并确认从未处理组的 cohort 已编码为 0 后再提交。",
      )
    }
    if (
      input.toolName === "composite_evaluation" &&
      (lower.includes("id 列组合在评价范围内存在重复") || lower.includes("duplicate evaluation") || lower.includes("评价单元") && lower.includes("重复"))
    ) {
      return terminal(
        "precondition_failure",
        "综合评价要求当前评价范围内每个评价单元唯一；本次未生成排名结果。请按年份或其他评价范围筛选为每个地区一行，或提供包含完整年份标识的评价单元列后再试。",
      )
    }
    if (
      input.toolName.startsWith("psm_") &&
      (
        lower.includes("psm matching failed post-match balance") ||
        lower.includes("psm matching found no treated observation") ||
        lower.includes("ipw overlap failure") ||
        lower.includes("ipw effective sample size failure") ||
        lower.includes("ipw failed weighted balance") ||
        lower.includes("propensity-score logit did not converge") ||
        lower.includes("propensity-score logit has perfect separation") ||
        lower.includes("propensity-score logit returned boundary scores") ||
        lower.includes("propensity-score design matrix is rank deficient") ||
        lower.includes("requires a full column rank")
      )
    ) {
      return terminal(
        "precondition_failure",
        "PSM 的共同支撑、样本量或协变量平衡门禁未通过，已停止自动改规格；请检查处理前协变量、分析单位和样本范围后，由用户决定是否调整。",
      )
    }
    const didStaticDesignFailure =
      input.toolName === "did_static" &&
      lower.includes("传统 did") &&
      (lower.includes("政策后变量必须同时包含 0 和 1") ||
        lower.includes("处理组变量必须同时包含 0 和 1"))
    if (
      didStaticDesignFailure ||
      (input.preventContinuation && lower.includes("传统 did") &&
        (lower.includes("四个样本单元") || lower.includes("四格样本结构")))
    ) {
      return terminal(
        "precondition_failure",
        "当前数据不满足传统 2×2 DID 的四格样本结构，已停止自动重试；请确认研究设计，或提供适用于交错处理的相对时期变量。",
      )
    }
    if (
      input.preventContinuation &&
      input.toolName === "did2s" &&
      (lower.includes("relative_time") || lower.includes("相对时期") || lower.includes("从未处理组") || lower.includes("实际首次处理时点"))
    ) {
      return terminal(
        "precondition_failure",
        "两阶段双重差分需要已核验的相对时期和从未处理组编码；当前数据设计前提尚未满足，本次未生成结果。请确认首次处理时期、未处理组编码，或提供可直接使用的相对时期列后再继续。",
      )
    }
    if (input.preventContinuation || input.failureType === "result_contract_failure") {
      return terminal("result_contract_failure", "工具结果未通过完整性或血缘校验，不能继续分析或报告。")
    }
    if (["TOOL_INPUT_INVALID", "PROCESS_CWD_DENIED", "PROCESS_COMMAND_DENIED"].includes(input.errorCode ?? "")) {
      return repair(
        "invalid_tool_input",
        "工具尚未执行，输入可以安全修正；只删除或修改报错字段后重试当前调用。",
        { preconditionOnly: true },
      )
    }
    switch (input.failureType) {
      case "tool_contract_failure":
      case "file_not_found":
      case "path_resolution_error":
      case "column_not_found":
      case "schema_mismatch":
      case "encoding_or_locale_error":
        // tool_contract_failure 意味着工具在执行前就拒绝了输入（参数校验失败），
        // 实际未产生任何副作用——幂等守卫不应阻断修复。其他几类同理：错误发生在
        // 前置检查阶段，工具尚未修改数据（2026-08-25 status-check 真实场景：
        // data_preprocess 参数不合法被拒，sideEffectLevel=session 导致 terminal）。
        return repair("invalid_tool_input", "工具输入可以修正；只修改失败字段并重试当前阶段。", { preconditionOnly: true })
      case "planning_failure":
      case "python_missing":
      case "dependency_broken":
      case "panel_integrity_failure":
        return repair(
          "precondition_failure",
          "先修复缺失的运行环境、数据或工作流前置条件，再继续失败阶段。",
          { preconditionOnly: true },
        )
      case "validate_blocked":
        return repair(
          "qa_blocked",
          "先处理 数据质量检查 阻断项并重新质检，不得跳过门禁。",
          { preconditionOnly: true },
        )
      case "estimation_failure":
        // 估计器失败不修改源数据（只写结果文件），重试安全——幂等守卫不应阻断。
        // 估计器 sideEffectLevel=filesystem 是因为写结果文件，但源数据不变，
        // 重试只是覆盖结果（2026-08-25 status-check：did_static 参数错误被 terminal 挡住）。
        return repair("estimation_failure", "检查同一计量设定的数据与诊断，只重试失败估计阶段。", { preconditionOnly: true })
      case "process_timeout":
        return repair("process_timeout", "缩小同一任务的范围后重试，不自动更换计量方法。")
      case "unknown_failure":
      case undefined:
        if (input.hookSuggestedRepair) return repair("unknown_tool_failure", "已有运行时hook给出明确修复方案，仅按该方案继续。")
        // 只读探查工具（glob/grep/read/tool_search…）失败没有改变任何状态：一次探查抽风
        // 不该终结整轮。把错误交回模型，让它换个查法、或据实向用户汇报能力缺口。
        if (input.readOnlyTool) {
          return repair(
            "unknown_tool_failure",
            "只读工具本次调用失败，未产生任何副作用；可改用其它只读方式查询，或据实向用户说明。不要据此推断分析结论。",
            { preconditionOnly: true },
          )
        }
        return terminal("unknown_tool_failure", "工具失败原因不明确，框架已停止，避免自行绕路后误报完成。")
      default:
        return terminal("unknown_tool_failure", "工具失败原因不明确，框架已停止并保留当前进度。")
    }
  }

  const PROGRESS_KEYS = new Set([
    "datasetId", "dataset_id", "stageId", "stage_id", "artifactRefs", "artifact_refs",
    "outputPath", "output_path", "resultPath", "result_path", "checkpointId", "workflowRunId",
  ])

  export function toolResultSignal(input: { output: string; metadata?: Record<string, unknown> }) {
    const evidence = new Set<string>()
    const visit = (value: unknown, depth: number) => {
      if (depth > 3 || !value || typeof value !== "object") return
      if (Array.isArray(value)) {
        value.slice(0, 20).forEach((item) => visit(item, depth + 1))
        return
      }
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (PROGRESS_KEYS.has(key) && nested !== undefined && nested !== null && nested !== "") evidence.add(key)
        visit(nested, depth + 1)
      }
    }
    visit(input.metadata, 0)
    const estimatedTokens = Token.estimate(input.output)
    return {
      outputBytes: Buffer.byteLength(input.output, "utf8"),
      estimatedTokens,
      progressEvidence: [...evidence].sort(),
      // 仅遥测，不在本阶段据此熔断。500 是候选阈值，不是 KillStata 已校准结论。
      lowSignal: estimatedTokens < 500 && evidence.size === 0,
    }
  }

  export function classifyCompaction(consecutiveFailures: number): FailureDecision | undefined {
    if (consecutiveFailures < MAX_CONSECUTIVE_COMPACTION_FAILURES) return undefined
    return {
      scope: "compaction",
      category: "compaction_circuit_open",
      disposition: "fallback",
      reason: `模型压缩连续失败 ${consecutiveFailures} 次`,
      userVisibleMessage: "模型压缩连续失败，已停止继续调用压缩模型并改用本地摘要；任务进度已保留，可信产物和恢复断点不会丢失。",
      maxConsecutiveFailures: MAX_CONSECUTIVE_COMPACTION_FAILURES,
    }
  }

  export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        clearTimeout(timeout)
        reject(new DOMException("Aborted", "AbortError"))
      }
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", abortHandler)
        resolve()
      }, Math.min(ms, RETRY_MAX_DELAY))
      signal.addEventListener("abort", abortHandler, { once: true })
    })
  }

  export function retryDelay(attempt: number, error?: MessageV2.APIError) {
    const bounded = (value: number) =>
      Number.isFinite(value) && value >= 0 ? Math.min(Math.ceil(value), RETRY_MAX_DELAY) : undefined
    const headers = error?.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsed = Number.parseFloat(retryAfterMs)
        const delay = bounded(parsed)
        if (delay !== undefined) return delay
      }
      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const seconds = Number.parseFloat(retryAfter)
        const secondDelay = bounded(seconds * 1_000)
        if (secondDelay !== undefined) return secondDelay
        const dateDelay = Date.parse(retryAfter) - Date.now()
        const httpDateDelay = bounded(dateDelay)
        if (httpDateDelay !== undefined && httpDateDelay > 0) return httpDateDelay
      }
      return RETRY_INITIAL_DELAY * RETRY_BACKOFF_FACTOR ** (attempt - 1)
    }
    return Math.min(RETRY_INITIAL_DELAY * RETRY_BACKOFF_FACTOR ** (attempt - 1), RETRY_MAX_DELAY_NO_HEADERS)
  }

  export const delay = retryDelay

  export function retryable(error: ReturnType<NamedError["toObject"]>, source: RequestSource = "foreground") {
    const decision = classifyModel(error, source)
    return decision.disposition === "retry" ? decision.reason : undefined
  }
}
