import { describe, expect, test } from "bun:test"
import { Instance } from "@/project/instance"
import { deferredToolDescriptors } from "@/runtime/deferred-tools"
import type { ToolAvailabilityResolution } from "@/runtime/types"
import { ToolRegistry } from "@/tool/registry"
import { Agent } from "@/agent/agent"
import { Tool } from "@/tool/tool"

describe("deferred tool protocol", () => {
  test("registry pool只初始化直接工具，延迟工具可按ID加载，阻断工具不可加载", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const agent = await Agent.get("analyst")
        const pool = await (ToolRegistry as any).resolvePool(
          { providerID: "deepseek", modelID: "deepseek-chat" },
          agent,
          {
            inputIntent: "analysis",
            workflowMode: "econometrics",
            currentStage: "baseline_estimate",
            agent: "analyst",
            platformCapabilities: { mcp: false, images: false, remote: false },
            modelCapabilities: { supportsTools: true, supportsImages: false },
          },
        )

        // 当前授权的系统工具始终直出；具体计量方法由独立 Python Registry 延迟披露，
        // 不进入 TypeScript ToolRegistry 的可加载实现池。
        expect(pool.resolution.directToolIDs).toEqual(expect.arrayContaining([
          "read", "list", "glob", "grep", "pipeline", "tool_search", "data_import", "econometrics_recommend",
        ]))
        expect(pool.resolution.deferredToolIDs).toContain("ols_regression")
        expect(pool.searchable.map((item: any) => item.id)).not.toContain("ols_regression")
        expect(pool.direct.map((item: any) => item.id)).not.toContain("ols_regression")
        // 历史 replay 可以显式回查旧实现，但该实现不属于本轮模型工具面。
        const replay = await pool.load(["ols_regression"])
        expect(replay.map((item: any) => item.id)).toEqual(["ols_regression"])
        await expect(pool.load(["bash"])).rejects.toThrow(/不可通过工具搜索加载/)
      },
    })
  })

  test("自定义工具不能复用内置或 manifest ID 借用准入身份", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const collision = Tool.define("ols_regression", Tool.Execution.readOnly, {
          namespace: "econometrics_estimator",
          useWhen: "测试冲突。",
          doNotUseWhen: "始终不要使用。",
          returns: "无。",
          failureRecovery: "停止。",
        }, {
          description: "冲突实现",
          parameters: (await import("zod")).default.object({}),
          execute: async () => ({ title: "冲突", metadata: {}, output: "冲突" }),
        })
        await expect(ToolRegistry.register(collision)).rejects.toThrow(/内置|保留|冲突/)
      },
    })
  })

  test("serializes deferred implementation descriptors and skips unknown ids", async () => {
    const resolution = {
      policy: {} as any,
      bundle: [],
      allowedToolIDs: [],
      directToolIDs: [],
      deferredToolIDs: ["read", "unknown_tool"],
      blockedToolIDs: [],
      explanations: [],
      exposurePlan: {
        profile: "workflow",
        directTools: [],
        deferredTools: [
          {
            toolID: "read",
            reason: "stage deferred",
            enableWhen: ["matching stage"],
            remoteSafe: true,
            repairOnlyAllowed: true,
          },
          {
            toolID: "unknown_tool",
            reason: "missing implementation",
            enableWhen: [],
            remoteSafe: true,
            repairOnlyAllowed: true,
          },
        ],
        blockedTools: [],
        policy: {} as any,
      },
    } satisfies ToolAvailabilityResolution

    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const descriptors = await deferredToolDescriptors(resolution)
        expect(descriptors).toHaveLength(1)
        expect(descriptors[0]?.toolID).toBe("read")
        expect(descriptors[0]?.description).toContain("读取")
      },
    })
  })
})
