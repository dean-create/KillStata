import type { ProviderMetadata } from "ai"
import type { QueryEvent } from "./types"

function metadata(input: unknown): ProviderMetadata | undefined {
  return input as ProviderMetadata | undefined
}

export namespace ModelStreamAdapter {
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
            const buffer = reasoningBuffers.get(value.id) ?? { text: "", providerMetadata: metadata(value.providerMetadata) }
            reasoningBuffers.delete(value.id)
            yield { type: "reasoning-start", id: value.id, providerMetadata: buffer.providerMetadata }
            if (buffer.text) yield { type: "reasoning-delta", id: value.id, text: buffer.text, providerMetadata: buffer.providerMetadata }
            yield { type: "reasoning-end", id: value.id, providerMetadata: metadata(value.providerMetadata) ?? buffer.providerMetadata }
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
          if (!textBuffer) textBuffer = { text: "", providerMetadata: metadata(value.providerMetadata), streaming: false }
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
