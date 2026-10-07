import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { Identifier } from "@/id/id"
import { PermissionNext } from "@/permission/next"
import { SessionProcessor } from "@/session/processor"
import type { MessageV2 } from "@/session/message-v2"
import { Tool } from "@/tool/tool"
import { RuntimeHooks } from "@/runtime/hooks"
import { Agent } from "@/agent/agent"
import { Global } from "@/global"
import { toolCallSignature } from "@/runtime/query-runtime"

function processorFor(sessionID: string, runRuntimeHooks = false) {
  return SessionProcessor.create({
    assistantMessage: { id: Identifier.ascending("message"), sessionID, agent: "analyst" } as MessageV2.Assistant,
    sessionID,
    model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
    abort: new AbortController().signal,
    runRuntimeHooks,
  })
}

function processorForWithResults(sessionID: string, successfulToolResults: Map<string, unknown>) {
  return SessionProcessor.create({
    assistantMessage: { id: Identifier.ascending("message"), sessionID, agent: "analyst" } as MessageV2.Assistant,
    sessionID,
    model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
    abort: new AbortController().signal,
    runRuntimeHooks: false,
    successfulToolResults,
  })
}

describe("有副作用工具的执行前确认", () => {
  test("当前 processor 内相同成功调用只执行一次并复用结果", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-tool-idempotent-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        let executions = 0
        const processor = processorFor("session-idempotent-tool", false)
        const call = () => processor.executeTool("read", { filePath: "known.txt" }, {
          callID: Identifier.ascending("part"),
          execution: Tool.Execution.readOnly,
          run: async () => {
            executions += 1
            return { title: "read", metadata: {}, output: "content" }
          },
        })

        const first = await call()
        const second = await call()
        expect(executions).toBe(1)
        expect(first.output).toBe("content")
        expect(second.output).toContain("已复用当前轮次同规格工具结果")
        expect(second.metadata).toMatchObject({ reused: true, noNewInformation: true })
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("重复 tool_search 必须重新返回完整 Schema，不复用可能被投影过的旧结果", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-tool-search-redisclose-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        let executions = 0
        const processor = processorFor("session-tool-search-redisclose", false)
        const schemaResult = [
          "工具搜索结果：",
          "- 方法：panel_random_effects",
          "  参数 Schema：{\"type\":\"object\",\"properties\":{\"entityVar\":{\"type\":\"string\"}}}",
          "  返回 Schema：{\"type\":\"object\",\"properties\":{\"success\":{\"type\":\"boolean\"}}}",
        ].join("\n")
        const call = () => processor.executeTool("tool_search", { query: "panel_random_effects", limit: 1 }, {
          callID: Identifier.ascending("part"),
          execution: Tool.Execution.readOnlySerial,
          run: async () => {
            executions += 1
            return { title: "工具搜索", metadata: { loadedToolIDs: ["panel_random_effects"] }, output: schemaResult }
          },
        })

        const first = await call()
        const second = await call()

        expect(first.output).toBe(schemaResult)
        expect(executions).toBe(2)
        expect(second.output).toBe(schemaResult)
        expect((second.metadata as Record<string, unknown>).reused).not.toBe(true)
        expect((second.metadata as Record<string, unknown>).noNewInformation).not.toBe(true)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("analysis_prepare 必须重新读取当前 stage，不能复用旧阶段的 preflight", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-analysis-prepare-cache-stage-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        let executions = 0
        let currentStage = "stage_000"
        const processor = processorFor("session-analysis-prepare-cache-stage", false)
        const args = {
          requestId: "analysis_request_1",
          methodID: "rdd_sharp",
          arguments: { dependentVar: "vote", runningVar: "margin", cutoff: 0 },
        }
        const call = () => processor.executeTool("analysis_prepare", args, {
          callID: Identifier.ascending("part"),
          execution: Tool.Execution.session,
          run: async () => {
            executions += 1
            return {
              title: "分析规格预检",
              metadata: { analysisSpecStatus: "repairable", stageId: currentStage },
              output: `preflight for ${currentStage}`,
            }
          },
        })

        await call()
        currentStage = "stage_001"
        const afterStageChange = await call()

        expect(executions).toBe(2)
        expect(afterStageChange.output).toBe("preflight for stage_001")
        expect(afterStageChange.metadata).toMatchObject({ stageId: "stage_001" })
        expect((afterStageChange.metadata as Record<string, unknown>).reused).not.toBe(true)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("Panel FE省略默认聚类列时不应因参数写法不同而重复估计", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-panel-fe-idempotent-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        let executions = 0
        const results = new Map<string, unknown>()
        const args = {
          datasetId: "dataset_gf",
          stageId: "stage_000",
          dependentVar: "绿色金融指数",
          treatmentVar: "绿色信贷",
          covariates: [],
          entityVar: "地区",
          timeVar: "年份",
          covariance: "clustered",
        }
        const call = (input: Record<string, unknown>) =>
          processorForWithResults("session-panel-fe-idempotent", results).executeTool("panel_fe_regression", input, {
            callID: Identifier.ascending("part"),
            execution: Tool.Execution.managedFilesystem,
            run: async () => {
              executions += 1
              return { title: "panel fe", metadata: {}, output: "result" }
            },
          })

        await call(args)
        const reused = await call({ ...args, clusterVar: "地区" })
        expect(executions).toBe(1)
        expect(reused.metadata).toMatchObject({ reused: true })
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("同一用户动作跨模型回合复用成功结果，新动作可重新执行", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-tool-cross-round-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const successfulToolResults = new Map<string, unknown>()
        let executions = 0
        const call = (processor: SessionProcessor.Info) => processor.executeTool("read", { filePath: "known.txt" }, {
          callID: Identifier.ascending("part"),
          execution: Tool.Execution.readOnly,
          run: async () => {
            executions += 1
            return { title: "read", metadata: {}, output: "content" }
          },
        })

        await call(processorForWithResults("session-cross-round", successfulToolResults))
        const reused = await call(processorForWithResults("session-cross-round", successfulToolResults))
        expect(executions).toBe(1)
        expect(reused.metadata).toMatchObject({ reused: true })

        await call(processorForWithResults("session-cross-round", new Map()))
        expect(executions).toBe(2)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("由工具按精确资源确认时，dispatcher 不再额外弹一次通用确认", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-tool-confirm-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const sessionID = Identifier.ascending("session")
          const processor = processorFor(sessionID)
          const result = await processor.executeTool("write", { filePath: "a.txt", content: "x" }, {
            callID: Identifier.ascending("part"),
            execution: Tool.Execution.protectedFilesystem,
            run: async () => ({ title: "write", metadata: {}, output: "ok" }),
          })

          expect(result.output).toBe("ok")
          expect((await PermissionNext.list()).filter((item) => item.sessionID === sessionID)).toHaveLength(0)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("dispatcher 负责确认的工具只请求一次，并能记住始终允许", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-dispatch-confirm-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const sessionID = Identifier.ascending("session")
          const processor = processorFor(sessionID)
          const call = () =>
            processor.executeTool("external_publish", { target: "report" }, {
              callID: Identifier.ascending("part"),
              execution: Tool.Execution.confirmExternal,
              run: async () => ({ title: "publish", metadata: {}, output: "ok" }),
            })

          const first = call()
          expect(await Promise.race([first.then(() => "resolved"), Bun.sleep(50).then(() => "pending")])).toBe("pending")
          const pending = (await PermissionNext.list()).filter((item) => item.sessionID === sessionID)
          expect(pending).toHaveLength(1)
          await PermissionNext.reply({ requestID: pending[0].id, reply: "always" })
          await first
          await expect(call()).resolves.toMatchObject({ output: "ok" })
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("hook 把参数升级为高风险动作后，必须按最终参数重新确认", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-hook-confirm-"))
    const preTool = spyOn(RuntimeHooks, "preTool").mockResolvedValue({ updatedInput: { action: "publish" } })
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const sessionID = Identifier.ascending("session")
          const processor = processorFor(sessionID, true)
          const execution: Tool.ExecutionPolicy = {
            ...Tool.Execution.readOnly,
            resolve(args) {
              return (args as { action?: string })?.action === "publish"
                ? Tool.Execution.confirmExternal
                : Tool.Execution.readOnly
            },
          }
          const call = processor.executeTool("dynamic_external", { action: "status" }, {
            callID: Identifier.ascending("part"),
            execution,
            run: async () => ({ title: "dynamic", metadata: {}, output: "ok" }),
          })

          expect(await Promise.race([call.then(() => "resolved"), Bun.sleep(50).then(() => "pending")])).toBe("pending")
          const pending = (await PermissionNext.list()).filter((item) => item.sessionID === sessionID)
          expect(pending).toHaveLength(1)
          expect(pending[0]?.metadata.input).toEqual({ action: "publish" })
          await PermissionNext.reply({ requestID: pending[0].id, reply: "once" })
          await expect(call).resolves.toMatchObject({ output: "ok" })
        },
      })
    } finally {
      preTool.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("hook 改写后的参数必须参与 repair 原样重试保护", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-hook-repair-"))
    const failedInput = { datasetId: "dataset-1", stageId: "stage-1", dependentVar: "y" }
    const preTool = spyOn(RuntimeHooks, "preTool").mockResolvedValue({ updatedInput: failedInput })
    let executions = 0
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const sessionID = Identifier.ascending("session")
          const processor = SessionProcessor.create({
            assistantMessage: {
              id: Identifier.ascending("message"),
              sessionID,
              agent: "analyst",
            } as MessageV2.Assistant,
            sessionID,
            model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
            abort: new AbortController().signal,
            runRuntimeHooks: true,
            repairToolName: "ols_regression",
            repairInputSignature: toolCallSignature("ols_regression", failedInput),
          })

          await expect(
            processor.executeTool("ols_regression", { dependentVar: "changed-by-model" }, {
              execution: Tool.Execution.managedFilesystem,
              run: async () => {
                executions += 1
                return { title: "ols", metadata: {}, output: "ok" }
              },
            }),
          ).rejects.toThrow("REPAIR_INPUT_UNCHANGED")
          expect(executions).toBe(0)
        },
      })
    } finally {
      preTool.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("方法前置检查必须读取 hook 改写后的最终参数", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-hook-final-args-"))
    const finalInput = { datasetId: "dataset-1", stageId: "stage-1", dependentVar: "from-hook" }
    const preTool = spyOn(RuntimeHooks, "preTool").mockResolvedValue({ updatedInput: finalInput })
    let checked: unknown
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const sessionID = Identifier.ascending("session")
          const processor = SessionProcessor.create({
            assistantMessage: { id: Identifier.ascending("message"), sessionID, agent: "analyst" } as MessageV2.Assistant,
            sessionID,
            model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
            abort: new AbortController().signal,
            runRuntimeHooks: true,
          })

          await processor.executeTool("ols_regression", { dependentVar: "from-model" }, {
            execution: Tool.Execution.managedFilesystem,
            beforeRun: async (args) => {
              checked = args
              return undefined
            },
            run: async () => ({ title: "ols", metadata: {}, output: "ok" }),
          })
        },
      })
      expect(checked).toEqual(finalInput)
    } finally {
      preTool.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("受管计量 runner 的声明为 automatic 时，默认权限不再重复弹 bash 确认", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-managed-auto-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const sessionID = Identifier.ascending("session")
          const agent = await Agent.get("analyst")
          const executable = path.join(Global.Path.data, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python")
          const pattern = `${executable} *data*`
          const request = PermissionNext.ask({
            sessionID,
            permission: "bash",
            patterns: [pattern],
            always: [pattern],
            metadata: { managedRuntime: true },
            ruleset: agent.permission,
          })
          const outcome = await Promise.race([request.then(() => "resolved"), Bun.sleep(50).then(() => "pending")])
          if (outcome === "pending") {
            for (const pending of (await PermissionNext.list()).filter((item) => item.sessionID === sessionID)) {
              await PermissionNext.reply({ requestID: pending.id, reply: "reject" })
            }
            await request.catch(() => undefined)
          }
          expect(outcome).toBe("resolved")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("普通 Bash 即使调用受管 Python，也不能借默认 allow 绕过 capability 确认", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-managed-deny-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const agent = await Agent.get("analyst")
          const executable = path.join(Global.Path.data, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python")
          for (const [index, metadata] of [{}, { managedRuntime: true }].entries()) {
            const sessionID = Identifier.ascending("session")
            const command = `${executable} -c arbitrary_code_${index}`
            const request = PermissionNext.ask({
              sessionID,
              permission: "bash",
              patterns: [command],
              always: [command],
              metadata,
              ruleset: agent.permission,
            })
            const outcome = await Promise.race([request.then(() => "resolved"), Bun.sleep(50).then(() => "pending")])
            expect(outcome).toBe("pending")
            const pending = (await PermissionNext.list()).find((item) => item.sessionID === sessionID)
            expect(pending).toBeDefined()
            if (pending) await PermissionNext.reply({ requestID: pending.id, reply: "reject" })
            await request.catch(() => undefined)
          }
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("受管运行时目录中的其他可执行文件和伪装 Python 命令一律需要确认", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-managed-executable-deny-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const agent = await Agent.get("analyst")
          const runtimeBin = path.join(Global.Path.data, "venv", process.platform === "win32" ? "Scripts" : "bin")
          const commands = process.platform === "win32"
            ? [
                `${path.join(runtimeBin, "pip.exe")} install untrusted-package`,
                `${path.join(runtimeBin, "python-malicious.exe")} *data*`,
              ]
            : [
                `${path.join(runtimeBin, "pip")} install untrusted-package`,
                `${path.join(runtimeBin, "bash")} -c arbitrary_code`,
                `${path.join(runtimeBin, "python-malicious")} *data*`,
              ]

          for (const command of commands) {
            const sessionID = Identifier.ascending("session")
            const request = PermissionNext.ask({
              sessionID,
              permission: "bash",
              patterns: [command],
              always: [command],
              metadata: { managedRuntime: true },
              ruleset: agent.permission,
            })
            const outcome = await Promise.race([request.then(() => "resolved"), Bun.sleep(50).then(() => "pending")])
            expect(outcome).toBe("pending")
            const pending = (await PermissionNext.list()).find((item) => item.sessionID === sessionID)
            expect(pending).toBeDefined()
            if (pending) await PermissionNext.reply({ requestID: pending.id, reply: "reject" })
            await request.catch(() => undefined)
          }
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
