import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import fs from "fs"
import path from "path"
import { Provider } from "@/provider/provider"
import { Instance } from "@/project/instance"
import { DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_PROVIDER_ID } from "@/provider/deepseek-policy"
import { MessageV2 } from "@/session/message-v2"
import { readSourceUnit } from "../helpers/read-source"

const SRC = path.join(process.cwd(), "src")

describe("OpenAI-compatible tool protocol", () => {
  test("DeepSeek uses the OpenAI-compatible SDK transport", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
        expect(model.api.url).toBe("https://api.deepseek.com")
      },
    })
  })

  test("the active LLM path has no LiteLLM or Anthropic tool-format shim", () => {
    const source = fs.readFileSync(path.join(SRC, "runtime", "services", "model-gateway.ts"), "utf-8")
    expect(source).not.toContain("litellmProxy")
    expect(source).not.toContain('tools["_noop"]')
    expect(source).not.toContain("Anthropic proxy compatibility")
  })

  test("the analysis model never connects an MCP tool sidecar", () => {
    const source = readSourceUnit("session/prompt")
    expect(source).toContain("mcp: false")
    expect(source).not.toContain("Object.entries(await MCP.tools())")
  })

  test("DeepSeek transport errors are bounded and redacted before session persistence", () => {
    const error = new APICallError({
      message: `DeepSeek request failed api_key=sk-message-secret ${"m".repeat(20_000)}`,
      url: "https://api.deepseek.com/chat/completions?api_key=sk-url-secret",
      requestBodyValues: { messages: ["private prompt"] },
      statusCode: 500,
      responseHeaders: {
        authorization: "Bearer response-header-secret",
        "set-cookie": "session=response-cookie-secret",
        "retry-after": "2",
        "x-request-id": "request-123",
      },
      responseBody: JSON.stringify({
        error: `api_key=sk-body-secret ${"b".repeat(20_000)}`,
      }),
    })

    const persisted = MessageV2.fromError(error, { providerID: "deepseek" })
    const serialized = JSON.stringify(persisted)

    expect(MessageV2.APIError.isInstance(persisted)).toBe(true)
    expect(Buffer.byteLength(serialized)).toBeLessThan(16 * 1024)
    expect(serialized).not.toContain("sk-message-secret")
    expect(serialized).not.toContain("sk-url-secret")
    expect(serialized).not.toContain("sk-body-secret")
    expect(serialized).not.toContain("response-header-secret")
    expect(serialized).not.toContain("response-cookie-secret")
    expect((persisted as MessageV2.APIError).data.responseHeaders).toEqual({
      "retry-after": "2",
      "x-request-id": "request-123",
    })
  })

  test("the stream logger records only a sanitized error summary", () => {
    const source = fs.readFileSync(path.join(SRC, "runtime", "services", "model-gateway.ts"), "utf-8")
    const onError = source.slice(source.indexOf("onError({ error })"), source.indexOf("experimental_repairToolCall"))
    expect(onError).toContain("onError({ error })")
    expect(onError).toContain("summarizeToolError(error)")
    expect(onError).not.toMatch(/\berror,?\s*\n/)
  })

  test("OpenTelemetry 不记录模型输入或输出正文", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "runtime", "services", "model-gateway.ts"), "utf-8")
    const agent = fs.readFileSync(path.join(process.cwd(), "src", "agent", "agent.ts"), "utf-8")
    expect(source).toContain("recordInputs: false")
    expect(source).toContain("recordOutputs: false")
    expect(agent).toContain("recordInputs: false")
    expect(agent).toContain("recordOutputs: false")
  })

  test("running tool metadata is sanitized at the session persistence boundary", () => {
    const source = readSourceUnit("session/prompt")
    const start = source.indexOf("const updateMetadata = async (val")
    const callback = source.slice(start, source.indexOf("const toolContext", start))

    expect(callback).toContain("prepareToolMetadata({ ...(match.state.metadata ?? {}), ...(val.metadata ?? {}) })")
    expect(callback).not.toContain("metadata: val.metadata")
  })
})
