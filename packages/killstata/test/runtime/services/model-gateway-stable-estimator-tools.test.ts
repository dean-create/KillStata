import { afterEach, expect, spyOn, test } from "bun:test"
import * as AI from "ai"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ModelMessage } from "ai"
import { Agent } from "@/agent/agent"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { resolveTools } from "@/session/prompt/tools"
import { DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_PROVIDER_ID } from "@/provider/deepseek-policy"

const spies: Array<{ mockRestore(): void }> = []

afterEach(async () => {
  while (spies.length) spies.pop()?.mockRestore()
  await Instance.disposeAll()
})

test("tool_search adds the full method schema to conversation messages, not Provider tools", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-provider-stable-method-tools-"))
  try {
    await Instance.provide({ directory: root, fn: async () => {
      const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
      const agent = await Agent.get("analyst")
      const sessionID = "ses_provider_stable_method_tools"
      const resolved = await resolveTools({
        model,
        agent,
        session: { id: sessionID, permission: [] } as never,
        processor: {
          message: { id: "message_provider_stable_method_tools", parentID: "user_provider_stable_method_tools" },
          partFromToolCall: () => undefined,
          executeTool: async (_name: string, args: unknown, options: { run(input: unknown): Promise<unknown> }) => options.run(args),
        } as never,
        intent: "analysis",
      }) as Awaited<ReturnType<typeof resolveTools>>

      const providerRequests: Array<Record<string, any>> = []
      const emptyStream: AsyncIterable<never> = { async *[Symbol.asyncIterator]() {} }
      spies.push(spyOn(AI, "streamText").mockImplementation(((request: Record<string, any>) => {
        providerRequests.push(request)
        return { fullStream: emptyStream } as never
      }) as never))

      const baseInput = {
        user: {
          id: "user_provider_stable_method_tools",
          sessionID,
          role: "user" as const,
          time: { created: Date.now() },
          agent: "analyst",
          model: { providerID: model.providerID, modelID: model.id },
        },
        sessionID,
        model,
        agent,
        system: ["测试当前 Provider 请求的工具边界。"],
        abort: new AbortController().signal,
        messages: [{ role: "user", content: "查找 OLS 方法" }] as ModelMessage[],
        tools: resolved,
        inputIntent: "analysis" as const,
      }

      await ModelGateway.stream(baseInput)
      const search = await resolved.port.execute({
        id: "provider-search-ols",
        name: "tool_search",
        input: { query: "ols_regression", limit: 1 },
        abort: new AbortController().signal,
      }) as { output: string }
      await resolved.commitDeferredTools()
      await ModelGateway.stream({
        ...baseInput,
        messages: [{ role: "user", content: search.output }] as ModelMessage[],
      })

      expect(providerRequests).toHaveLength(2)
      const firstTools = providerRequests[0]!.tools as Record<string, unknown>
      const secondTools = providerRequests[1]!.tools as Record<string, unknown>
      const firstActive = providerRequests[0]!.activeTools as string[]
      const secondActive = providerRequests[1]!.activeTools as string[]
      expect(Object.keys(firstTools)).toContain("econometrics_execute")
      expect(Object.keys(secondTools)).toContain("econometrics_execute")
      expect(Object.keys(firstTools)).not.toContain("ols_regression")
      expect(Object.keys(secondTools)).not.toContain("ols_regression")
      expect(firstActive).not.toContain("ols_regression")
      expect(secondActive).not.toContain("ols_regression")
      expect(Object.keys(secondTools)).toEqual(Object.keys(firstTools))
      expect(secondActive).toEqual(firstActive)
      expect(search.output).toContain("参数 Schema")
      expect(search.output).toContain("dependentVar")
      expect(JSON.stringify(providerRequests[1]!.messages)).toContain("dependentVar")
    } })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
