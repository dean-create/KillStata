import { afterEach, expect, spyOn, test } from "bun:test"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { MessageV2 } from "@/session/message-v2"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { QueryRuntime } from "@/runtime/query-runtime"
import { RuntimeHooks } from "@/runtime/hooks"
import type { QueryEvent } from "@/runtime/types"

const spies: Array<{ mockRestore(): void }> = []
afterEach(() => {
  while (spies.length) spies.pop()?.mockRestore()
})

/**
 * 门禁把 did_static 拒掉并确认改用 did2s 时，confirmedToolIDs 由 postToolFailure
 * 在 **顶层** 返回（与 repair 平级，见 runtime/default-hooks.ts）。此前 QueryRuntime
 * 误从 hookResult.repair 里取该字段，导致它恒为 undefined：dispatch 无法释放
 * did_static 的工具锁，下一轮 did2s 会被 REPAIR_TOOL_MISMATCH 拦下形成死锁。
 */
test("确认的替代方法从 hook 顶层透传到 repair 结果，供 dispatch 释放旧方法锁", async () => {
  async function* fullStream() {
    yield {
      type: "tool-error",
      toolCallId: "call_did_static",
      toolName: "did_static",
      input: { datasetId: "dataset_1", stageId: "stage_001" },
      error: new Error("传统 DID 必须同时包含处理组/对照组与政策前/政策后四个样本单元"),
    }
  }

  spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
  spies.push(spyOn(ModelGateway, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
  spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
  spies.push(
    spyOn(RuntimeHooks, "postToolFailure").mockResolvedValue({
      metadata: { reflection: { failureType: "estimation_failure", retryStage: "baseline_estimate" } },
      repair: {
        toolName: "did_static",
        retryStage: "baseline_estimate",
        repairAction: "数据是交错处理，改用 did2s。",
      },
      confirmedToolIDs: ["did2s"],
    }),
  )

  const runtime = new QueryRuntime({
    assistantMessage: { id: "message_confirmed", sessionID: "session_confirmed", agent: "analyst" } as MessageV2.Assistant,
    sessionID: "session_confirmed",
    model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
    abort: new AbortController().signal,
    partFromToolCall: () => undefined,
  })

  const events: QueryEvent[] = []
  await Instance.provide({
    directory: process.cwd(),
    fn: async () => {
      for await (const event of runtime.run({ tools: {} } as never)) events.push(event)
    },
  })

  expect(events.at(-1)).toMatchObject({
    type: "turn-finish",
    result: { type: "repair", toolName: "did_static", confirmedToolIDs: ["did2s"] },
  })
})
