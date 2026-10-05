import { describe, expect, test } from "bun:test"
import { resolveEffectiveEffort, resolveModelCapabilities } from "@/provider/capabilities"
import { classifyCacheBreak, promptFingerprint } from "@/runtime/prompt-fingerprint"

const model = (variants: Record<string, unknown>) =>
  ({
    id: "model",
    providerID: "provider",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 1, output: 1, cache: { read: 0.1, write: 1 } },
    limit: { context: 100_000, output: 8_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    variants,
  }) as any

function fingerprint(overrides: Record<string, unknown> = {}) {
  return promptFingerprint({
    modelID: "model",
    providerID: "provider",
    system: ["stable"],
    tools: { z: { description: "z" }, a: { description: "a" } },
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  })
}

describe("model capability and effort policy", () => {
  test("exposes supported effort levels from provider variants", () => {
    const capabilities = resolveModelCapabilities(model({ low: {}, medium: {}, high: {} }))
    expect(capabilities.effortLevels).toEqual(["off", "low", "medium", "high"])
    expect(capabilities.supportsEffort).toBe(true)
  })

  test("downgrades unsupported effort and explains why", () => {
    const resolved = resolveEffectiveEffort(model({ low: {}, medium: {}, high: {} }), "xhigh")
    expect(resolved.effective).toBe("high")
    expect(resolved.downgradeReason).toContain("does not support effort=xhigh")
  })
})

describe("prompt fingerprint", () => {
  test("sorts tool keys so insertion order does not break the fingerprint", () => {
    const left = fingerprint({ tools: { a: { description: "a" }, z: { description: "z" } } })
    const right = fingerprint()
    expect(left.toolSchemaHash).toBe(right.toolSchemaHash)
    expect(left.promptHash).toBe(right.promptHash)
  })

  test("classifies changed prompt dimensions", () => {
    const base = fingerprint()
    expect(classifyCacheBreak(undefined, base)).toBe("first_request")
    expect(classifyCacheBreak(base, fingerprint({ modelID: "other" }))).toBe("model_changed")
    expect(classifyCacheBreak(base, fingerprint({ system: ["changed"] }))).toBe("system_changed")
    expect(classifyCacheBreak(base, fingerprint({ tools: { a: {} } }))).toBe("tools_changed")
    expect(classifyCacheBreak(base, fingerprint({ providerOptions: { temperature: 0.2 } }))).toBe(
      "provider_options_changed",
    )
    expect(classifyCacheBreak(base, fingerprint({ contextVersion: 2 }))).toBe("context_changed")
  })

  test("动态方法引用只改变尾部指纹，不伪装成稳定工具前缀变化", () => {
    const base = fingerprint({ dynamicMethodReferences: [] })
    const withOLS = fingerprint({
      dynamicMethodReferences: [{
        toolID: "ols_regression",
        inputSchema: { type: "object", properties: { dependentVar: { type: "string" } } },
      }],
    })

    expect(withOLS.stableToolSchemaHash).toBe(base.stableToolSchemaHash)
    expect(withOLS.toolSchemaHash).toBe(base.toolSchemaHash)
    expect(withOLS.dynamicMethodTailHash).not.toBe(base.dynamicMethodTailHash)
    expect(classifyCacheBreak(base, withOLS)).toBe("dynamic_method_tail_changed")
  })

  test("当前轮系统目录变化只改变动态尾部，不伪装成稳定 system 变化", () => {
    const first = fingerprint({ stableSystem: ["stable"], dynamicSystemTail: ["工具目录：tool_search"] })
    const second = fingerprint({ stableSystem: ["stable"], dynamicSystemTail: ["工具目录：tool_search, data_import"] })

    expect(second.stableSystemHash).toBe(first.stableSystemHash)
    expect(second.systemHash).toBe(first.systemHash)
    expect(second.dynamicSystemTailHash).not.toBe(first.dynamicSystemTailHash)
    expect(classifyCacheBreak(first, second)).toBe("dynamic_prompt_tail_changed")
  })
})
