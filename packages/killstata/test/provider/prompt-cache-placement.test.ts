import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { ProviderTransform } from "@/provider/transform"

const model = {
  providerID: "anthropic",
  id: "claude-test",
  api: { id: "claude-test", npm: "@ai-sdk/anthropic" },
  capabilities: { interleaved: false },
} as never

function cacheMarker(message: ModelMessage) {
  return (message as any).providerOptions?.anthropic?.cacheControl
}

describe("provider prompt cache placement", () => {
  test("仅缓存全局稳定前缀，并保持会话与单轮消息可变", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "全局角色与方法论" },
      { role: "system", content: "会话级项目规则" },
      { role: "system", content: "单轮运行状态" },
      { role: "user", content: "第一轮请求" },
      { role: "assistant", content: "第一轮回答" },
      { role: "user", content: "最新请求" },
    ]

    const transformed = ProviderTransform.message(messages, model, {})

    expect(cacheMarker(transformed[0])).toEqual({ type: "ephemeral" })
    expect(cacheMarker(transformed[1])).toBeUndefined()
    expect(cacheMarker(transformed[2])).toBeUndefined()
    expect(cacheMarker(transformed[3])).toBeUndefined()
    expect(cacheMarker(transformed[4])).toEqual({ type: "ephemeral" })
    expect(cacheMarker(transformed[5])).toEqual({ type: "ephemeral" })
  })
})
