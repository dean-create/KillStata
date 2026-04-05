import type { ProviderMetadata } from "ai"
import type { QueryEvent } from "./types"

function metadata(input: unknown): ProviderMetadata | undefined {
  return input as ProviderMetadata | undefined
}

export namespace ModelStreamAdapter {
  export async function* normalize(stream: AsyncIterable<any>): AsyncGenerator<QueryEvent> {
    for await (const value of stream) {
      switch (value.type) {
        case "start":
          yield { type: "stream-start" }
          break
        case "reasoning-start":
          yield { type: "reasoning-start", id: value.id, providerMetadata: metadata(value.providerMetadata) }
          break
        case "reasoning-delta":
          yield {
            type: "reasoning-delta",
            id: value.id,
            text: value.text,
            providerMetadata: metadata(value.providerMetadata),
          }
          break
        case "reasoning-end":
          yield { type: "reasoning-end", id: value.id, providerMetadata: metadata(value.providerMetadata) }
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
          yield { type: "text-start", providerMetadata: metadata(value.providerMetadata) }
          break
        case "text-delta":
          yield {
            type: "text-delta",
            text: value.text,
            providerMetadata: metadata(value.providerMetadata),
          }
          break
        case "text-end":
          yield { type: "text-end", providerMetadata: metadata(value.providerMetadata) }
          break
        case "finish":
          yield { type: "finish" }
          break
        case "error":
          throw value.error
        default:
          continue
      }
    }
  }
}
