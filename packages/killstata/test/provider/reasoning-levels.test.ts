import { describe, expect, test } from "bun:test"
import { ProviderTransform } from "@/provider/transform"

const model = {
  id: "deepseek-v4-flash",
  providerID: "deepseek",
  capabilities: { reasoning: true },
  api: { npm: "@ai-sdk/openai-compatible" },
} as any

describe("推理等级 provider 映射", () => {
  test("DeepSeek 暴露 low/medium/high/max 四档并映射 reasoningEffort", () => {
    expect(ProviderTransform.variants(model)).toEqual({
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
      max: { reasoningEffort: "max" },
    })
  })

  test("无推理能力的模型不暴露等级", () => {
    expect(ProviderTransform.variants({ ...model, capabilities: { reasoning: false } })).toEqual({})
  })
})
