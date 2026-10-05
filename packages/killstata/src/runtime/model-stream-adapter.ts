import type { ProviderMetadata } from "ai"
import type { QueryEvent } from "./types"

function metadata(input: unknown): ProviderMetadata | undefined {
  return input as ProviderMetadata | undefined
}

export namespace ModelStreamAdapter {
  /**
   * AI SDK 会先发送 start/start-step 等结构性事件。
   * 这些事件只能证明流已建立，不能证明模型已经开始产生响应；只有正文、思考或工具事件
   * 才能结束首字节等待，否则代理握手成功后无内容会错误地进入较长 idle 窗口。
   */
  function isMeaningfulResponseEvent(type: string | undefined) {
    return type === "text-delta" || type === "reasoning-delta" || type === "tool-input-start" ||
      type === "tool-call" || type === "tool-result" || type === "tool-error"
  }

  // 流式 idle watchdog：防止代理假死（首 token 超时 / 事件间隔超长）让整轮静默挂起。
  // 对齐 claude-code 的 Stream idle watchdog（90s 无 chunk 主动 abort）。超时即 abort 底层流
  // 并抛"stream disconnected"措辞的错误——SessionRetry 的 hasTransientDisconnect 能识别，
  // 让假死流走重试路径而不是把整轮卡死。
  // firstByteTimeoutMs：从发起请求到收到第一个事件；idleTimeoutMs：两个事件之间的间隔；
  // toolExecutionIdleTimeoutMs：模型已发出工具调用（tool-call 未完成）时的间隔上限——
  // 工具执行/权限等待/postTool 钩子期间流必然无事件，120s 会把"工具在跑"误判为假死
  // （2026-08-05 真实数据测试：verifier 子会话在 postTool 里跑 8 轮 >120s，已成功的
  // data_import(qa/describe) 被误标 "Tool execution aborted"，UI 显示两次失败）。
  // 工具执行有自身超时（受管进程 5 分钟），这里给工具执行期一个更宽裕的 idle 上限，
  // 让工具先超时报错而不是被流 watchdog 误杀；模型生成期的 120s 保持不变。
  // 释放底层流：AI SDK v5 的 StreamTextResult **没有** abort()（只有传给 streamText 的
  // abortSignal 能中断）。此前这里无条件调 stream.abort()，而它是 undefined——一旦
  // watchdog 超时，finally 里的 TypeError 会**顶替**掉原本可重试的 "stream disconnected"
  // 错误，整轮以 "stream.abort is not a function" 收尾，假死流重试路径实际从未生效
  // （2026-08-05 真实数据测试用户命中）。改为：优先用异步迭代器协议的 return() 释放
  // （标准做法，对 AI SDK 流有效），abort 存在才调；且释放失败绝不掩盖原始错误。
  function releaseStream(stream: { abort?: () => void | Promise<void> }, iterator: AsyncIterator<any>) {
    try {
      iterator.return?.()?.catch?.(() => {})
    } catch {}
    try {
      // abort 在某些 provider（OpenAI 兼容层 fetch wrapper 等）里返回 Promise，
      // 同步 try/catch 接不到 Promise reject——补一个 .catch 避免 unhandled rejection
      // 污染进程日志（审查报告 §4.1）。
      const result = stream.abort?.()
      if (result instanceof Promise) result.catch(() => {})
    } catch {}
  }

  export function withStreamIdleWatchdog(
    stream: { fullStream: AsyncIterable<any>; abort?: () => void },
    options?: { firstByteTimeoutMs?: number; idleTimeoutMs?: number; toolExecutionIdleTimeoutMs?: number },
  ): AsyncIterable<any> {
    const firstByteTimeoutMs = options?.firstByteTimeoutMs ?? 60_000
    const idleTimeoutMs = options?.idleTimeoutMs ?? 120_000
    const toolExecutionIdleTimeoutMs = options?.toolExecutionIdleTimeoutMs ?? 5 * 60_000
    return {
      async *[Symbol.asyncIterator]() {
        const iterator = stream.fullStream[Symbol.asyncIterator]()
        let receivedMeaningfulResponse = false
        let stalled = false
        const inFlight = new Set<string>()
        try {
          for (;;) {
            const timeoutMs = !receivedMeaningfulResponse
              ? firstByteTimeoutMs
              : inFlight.size > 0
                ? toolExecutionIdleTimeoutMs
                : idleTimeoutMs
            let timer: ReturnType<typeof setTimeout> | undefined
            const timeout = new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                const stage = receivedMeaningfulResponse ? "before completion" : "before first meaningful response"
                reject(
                  new Error(
                    `stream disconnected ${stage}: no events for ${timeoutMs}ms (idle watchdog)`,
                  ),
                )
              }, timeoutMs)
              // watchdog 是用户可感知的硬截止，不能因底层 Provider 请求未结束而失去
              // 计时；让定时器保持有引用，确保假死流按档位及时进入失败分类。
            })
            const next = iterator.next()
            // race 已经 settle 后，abort 引发的 rejection 不能变成 unhandled rejection
            next.catch(() => {})
            let result: IteratorResult<any>
            try {
              result = await Promise.race([next, timeout])
            } catch (error) {
              // 只有超时/异常路径 abort 底层流；正常结束不 abort（测试锁死该语义）。
              stalled = true
              throw error
            } finally {
              if (timer) clearTimeout(timer)
            }
            if (result.done) return
            // AI SDK fullStream 事件：tool-call/tool-input-start 表示模型发出工具调用，
            // 工具执行期间流暂停；tool-result/tool-error 表示工具完成。用 Set 跟踪
            // 每个 in-flight toolCallId——并行 tool-call 场景下任何一个工具完成都会
            // 清零 toolInFlight，导致剩余在飞工具被切回 120s 普通 idle 误杀
            // （2026-08-05 did.xlsx 审查报告 §2.3：用 thinking 模型触发并行工具时会撞）。
            const event = result.value as { type?: string; toolCallId?: string } | undefined
            const type = event?.type
            const toolCallId = event?.toolCallId
            if (isMeaningfulResponseEvent(type)) receivedMeaningfulResponse = true
            if (type === "tool-call" || type === "tool-input-start") {
              if (toolCallId) inFlight.add(toolCallId)
            } else if (type === "tool-result" || type === "tool-error") {
              if (toolCallId) inFlight.delete(toolCallId)
            }
            yield result.value
          }
        } finally {
          // 中止底层流：超时路径让挂起的 next() 尽快 settle。正常结束不释放（测试锁死该语义）。
          if (stalled) releaseStream(stream, iterator)
        }
      },
    }
  }

  export async function* normalize(stream: AsyncIterable<any>): AsyncGenerator<QueryEvent> {
    let textBuffer: { text: string; providerMetadata?: ProviderMetadata; streaming: boolean } | undefined
    const reasoningBuffers = new Map<string, { text: string; providerMetadata?: ProviderMetadata }>()
    const flushTextBuffer = function* (providerMetadata?: ProviderMetadata): Generator<QueryEvent> {
      if (!textBuffer) return
      const buffer = textBuffer
      textBuffer = undefined

      if (buffer.streaming) {
        yield { type: "text-end", providerMetadata: providerMetadata ?? buffer.providerMetadata }
        return
      }

      yield { type: "text-start", providerMetadata: buffer.providerMetadata }
      if (buffer.text) {
        yield { type: "text-delta", text: buffer.text, providerMetadata: buffer.providerMetadata }
      }
      yield { type: "text-end", providerMetadata: providerMetadata ?? buffer.providerMetadata }
    }

    const flushReasoningBuffers = function* (): Generator<QueryEvent> {
      for (const [id, buffer] of reasoningBuffers) {
        yield { type: "reasoning-start", id, providerMetadata: buffer.providerMetadata }
        if (buffer.text) {
          yield { type: "reasoning-delta", id, text: buffer.text, providerMetadata: buffer.providerMetadata }
        }
        yield { type: "reasoning-end", id, providerMetadata: buffer.providerMetadata }
      }
      reasoningBuffers.clear()
    }

    for await (const value of stream) {
      switch (value.type) {
        case "start":
          yield { type: "stream-start" }
          break
        case "reasoning-start":
          reasoningBuffers.set(value.id, { text: "", providerMetadata: metadata(value.providerMetadata) })
          break
        case "reasoning-delta":
          {
            const buffer = reasoningBuffers.get(value.id) ?? { text: "" }
            buffer.text += value.text
            buffer.providerMetadata = metadata(value.providerMetadata) ?? buffer.providerMetadata
            reasoningBuffers.set(value.id, buffer)
          }
          break
        case "reasoning-end":
          {
            const buffer = reasoningBuffers.get(value.id) ?? {
              text: "",
              providerMetadata: metadata(value.providerMetadata),
            }
            reasoningBuffers.delete(value.id)
            yield { type: "reasoning-start", id: value.id, providerMetadata: buffer.providerMetadata }
            if (buffer.text)
              yield {
                type: "reasoning-delta",
                id: value.id,
                text: buffer.text,
                providerMetadata: buffer.providerMetadata,
              }
            yield {
              type: "reasoning-end",
              id: value.id,
              providerMetadata: metadata(value.providerMetadata) ?? buffer.providerMetadata,
            }
          }
          break
        case "tool-input-start":
          yield { type: "tool-input-start", toolCallId: value.id, toolName: value.toolName }
          break
        case "tool-call":
          yield {
            type: "tool-call",
            toolCallId: value.toolCallId,
            toolName: value.toolName,
            input: value.input,
            providerMetadata: metadata(value.providerMetadata),
          }
          break
        case "tool-result":
          yield {
            type: "tool-result",
            toolCallId: value.toolCallId,
            toolName: value.toolName,
            input: value.input,
            output: value.output,
          }
          break
        case "tool-error":
          yield {
            type: "tool-error",
            toolCallId: value.toolCallId,
            toolName: value.toolName,
            input: value.input,
            error: value.error,
          }
          break
        case "start-step":
          yield { type: "step-start" }
          break
        case "finish-step":
          yield {
            type: "step-finish",
            finishReason: value.finishReason,
            usage: value.usage,
            providerMetadata: metadata(value.providerMetadata),
          }
          break
        case "text-start":
          textBuffer = { text: "", providerMetadata: metadata(value.providerMetadata), streaming: false }
          break
        case "text-delta":
          if (!textBuffer) textBuffer = { text: "", streaming: false }
          textBuffer.providerMetadata = metadata(value.providerMetadata) ?? textBuffer.providerMetadata
          if (textBuffer.streaming) {
            yield { type: "text-delta", text: value.text, providerMetadata: textBuffer.providerMetadata }
            break
          }
          textBuffer.text += value.text
          if (textBuffer.text.length > 0) {
            textBuffer.streaming = true
            yield { type: "text-start", providerMetadata: textBuffer.providerMetadata }
            yield { type: "text-delta", text: textBuffer.text, providerMetadata: textBuffer.providerMetadata }
            textBuffer.text = ""
          }
          break
        case "text-end":
          if (!textBuffer)
            textBuffer = { text: "", providerMetadata: metadata(value.providerMetadata), streaming: false }
          yield* flushTextBuffer(metadata(value.providerMetadata))
          break
        case "finish":
          yield* flushTextBuffer()
          yield* flushReasoningBuffers()
          yield { type: "finish" }
          break
        case "error":
          throw value.error
        default:
          continue
      }
    }

    yield* flushTextBuffer()
    yield* flushReasoningBuffers()
  }
}
