/**
 * 将业务事件映射到 Tool-Use Loop 的适配器。
 *
 * 引擎不认识 Provider、工作流、计量工具或消息格式；这些细节全由调用方在此转换。
 */
export type ToolCallBatchContext = {
  batchSize: number
  batchIndex: number
}

export type ToolUseLoopFailureStage =
  | "stream"
  | "schedule"
  | "prepare_results"
  | "result_event"
  | "tool_error_handler"
  | "after_results"
  | "append_results"
  | "result_decision"
  | "unhandled_tool_failure"

export class ToolCallSkippedError extends Error {
  readonly code = "TOOL_CALL_SKIPPED" as const

  constructor(message: string) {
    super(message)
    this.name = "ToolCallSkippedError"
  }
}

export class ToolUseLoopFailureError extends Error {
  readonly code = "TOOL_USE_LOOP_FAILURE" as const
  readonly stage: ToolUseLoopFailureStage
  readonly callIDs: string[]

  constructor(input: { stage: ToolUseLoopFailureStage; callIDs?: string[]; message: string; cause?: unknown }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = "ToolUseLoopFailureError"
    this.stage = input.stage
    this.callIDs = input.callIDs ?? []
  }
}

export type ToolCallFailure<Call, Event> = {
  call: Call
  error: unknown
  event: Event
  skipped: boolean
}

export interface ToolUseLoopAdapter<Request, Event, Call, Output, Decision> {
  stream(request: Request): AsyncIterable<Event> | Promise<AsyncIterable<Event>>
  callFromEvent(event: Event): Call | undefined
  decisionFromEvent(event: Event): Decision | undefined
  /** 由工具适配层提供并发属性；引擎只负责按该属性编排，不理解具体工具业务。 */
  canExecuteInParallel?(call: Call): boolean
  /** 只读批次的并发上限；未声明时使用 10，避免一个模型响应耗尽资源。 */
  maxParallelCalls?: number
  execute(call: Call, context?: ToolCallBatchContext): Promise<Output>
  resultEvent(call: Call, output: Output): Event
  errorEvent(call: Call, error: unknown): Event
  /** 调度器在执行前跳过调用时生成终态；不得把它送进普通失败/重试分类。 */
  skippedEvent?(call: Call, error: ToolCallSkippedError): Event
  prepareToolResults?(results: Array<{ call: Call; output: Output }>, failureCount?: number): Array<{ call: Call; output: Output }> | Promise<Array<{ call: Call; output: Output }>>
  /** 结果事件已交付给持久化消费端后调用；终止性混合失败也必须执行。 */
  afterToolResults?(results: Array<{ call: Call; output: Output }>): void
  appendToolResults(
    request: Request,
    results: Array<{ call: Call; output: Output }>,
    failures?: Array<ToolCallFailure<Call, Event>>,
    callOrder?: readonly Call[],
  ): Request | Promise<Request>
  /** 某个成功结果已经完成本轮目标时，适配器可阻止同一响应中尚未执行的调用。 */
  shouldStopAfterResult?(output: Output): boolean
  /** 多个工具同时失败时，由适配层合并各自的决策；引擎不猜测决策的业务优先级。 */
  mergeToolErrorDecisions?(current: Decision | undefined, next: Decision | undefined): Decision | undefined
  /** 工具结果要求外部决策时，适配器可以在下一次模型请求前结束本轮。 */
  shouldContinueAfterResults?(results: Array<{ call: Call; output: Output }>): boolean
  /** 若上一回调决定停止，适配器提供标准的终止决策事件，避免调用方误判为继续。 */
  decisionAfterResults?(results: Array<{ call: Call; output: Output }>): Decision | undefined
  onToolError(event: Event): Promise<Decision | undefined>
  /** 编排层自己的异常发生时，将其转换为本领域可持久化的终止事件；不得原样重跑工具。 */
  loopFailureEvent?(input: {
    stage: ToolUseLoopFailureStage
    error: unknown
    toolEvent?: Event
    callIDs?: string[]
  }): Event
  /** 混合批次中有成功调用时，适配器可决定是否保留成功结果并继续下一次模型请求。 */
  continueAfterMixedToolFailure?(input: {
    succeeded: Array<{ call: Call; output: Output }>
    failed: Array<{ call: Call; error: unknown }>
    decision: Decision
  }): boolean | Promise<boolean>
  continues(decision: Decision): boolean
  terminalEvent(decision: Decision): Event
}
