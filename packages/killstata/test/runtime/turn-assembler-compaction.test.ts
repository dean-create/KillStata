import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { Identifier } from "@/id/id"
import { TurnAssembler } from "@/runtime/turn-assembler"
import { ToolUseLoopFailureError } from "@/runtime/engine/types"
import { parseVerifierEnvelope } from "@/runtime/workflow/rerun"

describe("TurnAssembler 压缩控制流", () => {
  test("verifier 的结构化 envelope 内部可解析，但不会作为正文泄漏", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-verifier-envelope-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({})
        const user = await Session.updateMessage({
          id: Identifier.ascending("message"), role: "user", sessionID: session.id,
          time: { created: Date.now() }, agent: "analyst", model: { providerID: "test", modelID: "test" },
        } as never)
        const assistant = await Session.updateMessage({
          id: Identifier.ascending("message"), role: "assistant", parentID: user.id, sessionID: session.id,
          mode: "analyst", agent: "verifier", path: { cwd: root, root }, cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "test", providerID: "test", time: { created: Date.now() },
        } as never)
        const envelope = `<verifier_result>${JSON.stringify({
          status: "pass",
          checks: [{ key: "rlm-result", label: "RLM 结果", status: "pass", message: "估计结果与指定数据阶段及方法参数一致。" }],
          blockingFindings: [], repairHints: [], trustedArtifacts: [],
          summary: "RLM 结果已按当前阶段核验。", findings: [],
        })}</verifier_result>`
        const assembler = new TurnAssembler({ assistantMessage: assistant as never, sessionID: session.id, model: { id: "test", providerID: "test" } as never })
        await assembler.consume({ type: "text-start" } as never)
        await assembler.consume({ type: "text-delta", text: envelope } as never)
        await assembler.consume({ type: "text-end" } as never)
        await assembler.finalize("continue")

        const stored = (await Session.messages({ sessionID: session.id })).find((item) => item.info.id === assistant.id)
        const textPart = stored?.parts.find((part) => part.type === "text")
        const internalEnvelope = textPart?.type === "text" ? textPart.metadata?.internalVerifierEnvelope : undefined
        expect(textPart?.type === "text" ? textPart.text : undefined).not.toContain("<verifier_result>")
        expect(internalEnvelope).toBe(envelope)
        expect(parseVerifierEnvelope(String(internalEnvelope))?.status).toBe("pass")
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("导出请求没有模型正文时，提示已找到结果但没有伪称交付成功", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-export-fallback-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "user", sessionID: session.id,
            time: { created: Date.now() }, agent: "analyst", model: { providerID: "test", modelID: "test" },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: user.id, sessionID: session.id,
            type: "text", text: "把回归结果导出成 CSV 文件，放到当前目录",
          } as never)
          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "assistant", parentID: user.id, sessionID: session.id,
            mode: "analyst", agent: "analyst", path: { cwd: root, root }, cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test", providerID: "test", time: { created: Date.now() },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: assistant.id, sessionID: session.id,
            type: "tool", tool: "pipeline", callID: "call-export-artifacts",
            state: {
              status: "completed", input: { action: "artifacts" },
              output: JSON.stringify({ artifacts: [".killstata/datasets/demo/coefficients.csv"] }),
              title: "可信产物", metadata: { artifactRefs: [".killstata/datasets/demo/coefficients.csv"] },
              time: { start: Date.now(), end: Date.now() },
            },
          } as never)

          const assembler = new TurnAssembler({ assistantMessage: assistant as never, sessionID: session.id, model: { id: "test", providerID: "test" } as never })
          await assembler.finalize("continue")
          const stored = (await Session.messages({ sessionID: session.id })).find((item) => item.info.id === assistant.id)
          const visible = stored?.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? ""
          expect(visible).toContain("尚未完成结果文件交付")
          expect(visible).not.toContain("已导出")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("不可恢复工具错误且模型未收尾时生成中文用户停点", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-failure-fallback-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID: session.id,
            time: { created: Date.now() },
            agent: "analyst",
            model: { providerID: "test", modelID: "test" },
          } as never)
          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "assistant",
            parentID: user.id,
            sessionID: session.id,
            mode: "analyst",
            agent: "analyst",
            path: { cwd: root, root },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test",
            providerID: "test",
            time: { created: Date.now() },
          } as never)

          const assembler = new TurnAssembler({
            assistantMessage: assistant as never,
            sessionID: session.id,
            model: { id: "test", providerID: "test" } as never,
            inputIntent: "ingest",
          })
          await assembler.finalize("stop", new Error("当前任务不存在可调用的工具 read，框架不会重复调用或猜测替代工具。"))

          const stored = (await Session.messages({ sessionID: session.id })).find((item) => item.info.id === assistant.id)
          const text = stored?.parts.find((part) => part.type === "text")
          expect(text?.type === "text" ? text.text : undefined).toContain("已停止继续尝试")
          expect(text?.type === "text" ? text.text : undefined).not.toContain("read")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("框架超时且模型未收尾时生成超时停点，用户主动取消仍不走该文案", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-timeout-fallback-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID: session.id,
            time: { created: Date.now() },
            agent: "analyst",
            model: { providerID: "test", modelID: "test" },
          } as never)
          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "assistant",
            parentID: user.id,
            sessionID: session.id,
            mode: "analyst",
            agent: "analyst",
            path: { cwd: root, root },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test",
            providerID: "test",
            time: { created: Date.now() },
          } as never)
          const assembler = new TurnAssembler({
            assistantMessage: assistant as never,
            sessionID: session.id,
            model: { id: "test", providerID: "test" } as never,
            inputIntent: "analysis",
          })

          await assembler.finalize("stop", new Session.TimeoutError(session.id, 60_000))

          const stored = (await Session.messages({ sessionID: session.id })).find((item) => item.info.id === assistant.id)
          const text = stored?.parts.find((part) => part.type === "text")
          expect(text?.type === "text" ? text.text : undefined).toContain("等待超过60000毫秒")
          expect(text?.type === "text" ? text.text : undefined).toContain("已完成的数据和结果会保留")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("工具错误终止且模型未收尾时，依据工具错误生成用户停点", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-tool-error-fallback-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "user", sessionID: session.id,
            time: { created: Date.now() }, agent: "analyst", model: { providerID: "test", modelID: "test" },
          } as never)
          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "assistant", parentID: user.id, sessionID: session.id,
            mode: "analyst", agent: "analyst", path: { cwd: root, root }, cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test", providerID: "test", time: { created: Date.now() },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: assistant.id, sessionID: session.id,
            type: "tool", tool: "read", callID: "call_read_error",
            state: {
              status: "error",
              input: { filePath: "tool-output/missing" },
              error: "当前任务不存在可调用的工具 read，框架不会重复调用或猜测替代工具。",
              time: { start: Date.now(), end: Date.now() },
            },
          } as never)
          const assembler = new TurnAssembler({
            assistantMessage: assistant as never, sessionID: session.id,
            model: { id: "test", providerID: "test" } as never, inputIntent: "ingest",
          })

          await assembler.finalize("stop")

          const stored = (await Session.messages({ sessionID: session.id })).find((item) => item.info.id === assistant.id)
          const text = stored?.parts.find((part) => part.type === "text")
          expect(text?.type === "text" ? text.text : undefined).toContain("已停止")
          expect(text?.type === "text" ? text.text : undefined).not.toContain("read")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("终止型 DID 错误不会被模型的进度句遮住", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-did-stop-fallback-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "user", sessionID: session.id,
            time: { created: Date.now() }, agent: "analyst", model: { providerID: "test", modelID: "test" },
          } as never)
          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "assistant", parentID: user.id, sessionID: session.id,
            mode: "analyst", agent: "analyst", path: { cwd: root, root }, cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test", providerID: "test", time: { created: Date.now() },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: assistant.id, sessionID: session.id,
            type: "text", text: "理解，继续执行传统DID。由于 did = post，我先尝试运行传统双重差分。",
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: assistant.id, sessionID: session.id,
            type: "tool", tool: "did_static", callID: "call_did_error",
            state: {
              status: "error",
              input: { dependentVar: "创新指数", groupVar: "did", postVar: "post" },
              error: "[ValueError] 传统 DID 必须同时包含处理组/对照组与政策前/政策后四个样本单元",
              time: { start: Date.now(), end: Date.now() },
            },
          } as never)

          const assembler = new TurnAssembler({
            assistantMessage: assistant as never, sessionID: session.id,
            model: { id: "test", providerID: "test" } as never, inputIntent: "analysis",
          })
          await assembler.finalize("stop")

          const stored = (await Session.messages({ sessionID: session.id })).find((item) => item.info.id === assistant.id)
          const text = stored?.parts.find((part) => part.type === "text")
          expect(text?.type === "text" ? text.text : undefined).toContain("四格样本结构")
          expect(text?.type === "text" ? text.text : undefined).toContain("停止自动重试")
          expect(text?.type === "text" ? text.text : undefined).not.toContain("我先尝试运行传统双重差分")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("终止型 DID 错误不会被后续的推荐摘要遮住", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-did-summary-fallback-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "user", sessionID: session.id,
            time: { created: Date.now() }, agent: "analyst", model: { providerID: "test", modelID: "test" },
          } as never)
          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "assistant", parentID: user.id, sessionID: session.id,
            mode: "analyst", agent: "analyst", path: { cwd: root, root }, cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test", providerID: "test", time: { created: Date.now() },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: assistant.id, sessionID: session.id,
            type: "text", text: "流程：数据检查 -> 计量方法推荐\n当前：已完成计量方法推荐\n结果：推荐面板固定效应回归。",
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: assistant.id, sessionID: session.id,
            type: "tool", tool: "did_static", callID: "call_did_summary_error",
            state: {
              status: "error",
              input: { dependentVar: "创新指数", groupVar: "did", postVar: "post" },
              error: "当前数据不满足传统 2×2 DID 的四格样本结构，已停止自动重试",
              time: { start: Date.now(), end: Date.now() },
            },
          } as never)

          const assembler = new TurnAssembler({
            assistantMessage: assistant as never, sessionID: session.id,
            model: { id: "test", providerID: "test" } as never, inputIntent: "analysis",
          })
          await assembler.finalize("stop")

          const stored = (await Session.messages({ sessionID: session.id })).find((item) => item.info.id === assistant.id)
          const text = stored?.parts.find((part) => part.type === "text")
          expect(text?.type === "text" ? text.text : undefined).toContain("四格样本结构")
          expect(text?.type === "text" ? text.text : undefined).toContain("停止自动重试")
          expect(text?.type === "text" ? text.text : undefined).not.toContain("推荐面板固定效应回归")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("status 轮只有 pipeline 结果时自动生成中文状态回复", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-status-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID: session.id,
            time: { created: Date.now() },
            agent: "analyst",
            model: { providerID: "test", modelID: "test" },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: user.id,
            sessionID: session.id,
            type: "text",
            text: "跑完了吗？",
          } as never)

          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "assistant",
            parentID: user.id,
            sessionID: session.id,
            mode: "analyst",
            agent: "analyst",
            path: { cwd: root, root },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test",
            providerID: "test",
            time: { created: Date.now() },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: assistant.id,
            sessionID: session.id,
            type: "tool",
            tool: "pipeline",
            callID: "call_status",
            state: {
              status: "completed",
              input: { action: "status" },
              output: JSON.stringify({
                workflowState: {
                  activeStage: "verifier",
                  latestFailure: null,
                  verifier: { status: "warn", blockingFindings: [], trustedArtifactCount: 8 },
                  currentChecklistItem: { label: "结果报告", status: "pending" },
                },
              }),
              title: "Workflow Status",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
          } as never)

          const assembler = new TurnAssembler({
            assistantMessage: assistant as never,
            sessionID: session.id,
            model: { id: "test", providerID: "test" } as never,
            inputIntent: "status",
          })
          await assembler.consume({ type: "text-start" })
          await assembler.consume({ type: "text-delta", text: "我先查询当前工作流的真实状态。" })
          await assembler.consume({ type: "text-end" })
          await assembler.finalize("stop")

          const stored = (await Session.messages({ sessionID: session.id }))
            .find((item) => item.info.id === assistant.id)
          const text = stored?.parts.find((part) => part.type === "text")
          expect(text?.type === "text" ? text.text : undefined).toContain("结果已经生成")
          expect(text?.type === "text" ? text.text : undefined).not.toMatch(/workflow|stage_|trustedArtifact|pending|sessionID/)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("分析回复落盘前会清理模型遗留的未核验占位文案", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-sanitize-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID: session.id,
            time: { created: Date.now() },
            agent: "analyst",
            model: { providerID: "test", modelID: "test" },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: user.id,
            sessionID: session.id,
            type: "text",
            text: "请完成 OLS 分析",
          } as never)

          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "assistant",
            parentID: user.id,
            sessionID: session.id,
            mode: "analyst",
            agent: "analyst",
            path: { cwd: root, root },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test",
            providerID: "test",
            time: { created: Date.now() },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: assistant.id,
            sessionID: session.id,
            type: "tool",
            tool: "ols_regression",
            callID: "call_ols",
            state: {
              status: "completed",
              input: { dependentVar: "y", treatmentVar: "x" },
              output: "ok",
              title: "OLS 已完成",
              time: { start: Date.now(), end: Date.now() },
              metadata: {
                analysisView: {
                  kind: "econometrics",
                  step: "ols_regression",
                  results: [{ label: "x 系数", value: "0.52" }],
                },
              },
            },
          } as never)

          const assembler = new TurnAssembler({
            assistantMessage: assistant as never,
            sessionID: session.id,
            model: { id: "test", providerID: "test" } as never,
          })
          const first = "已确认工作表：“Data_可读”（本次导入）。"
          const second = "已确认工作表：“Data_可读”（本次导入）。\nOLS 已完成。\n- x 系数为 0.52。\n- 未核验的统计量：coefficient、p_value。"
          await assembler.consume({ type: "text-start" })
          await assembler.consume({ type: "text-delta", text: first })
          await assembler.consume({ type: "text-end" })
          await assembler.consume({ type: "text-start" })
          await assembler.consume({ type: "text-delta", text: second })
          await assembler.consume({ type: "text-end" })
          await assembler.finalize("stop")

          const stored = (await Session.messages({ sessionID: session.id }))
            .find((item) => item.info.id === assistant.id)
          const texts = stored?.parts
            .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
            .map((part) => part.text) ?? []
          expect(texts).toHaveLength(2)
          expect(texts[0]).toContain("已确认工作表")
          expect(texts[1]).not.toContain("已确认工作表")
          expect(texts[1]).not.toContain("未核验的统计量")
          expect(texts[1]).toContain("x 系数")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("同一 assistant 消息不会重复展示跨回合的核验摘要", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-analysis-disclosure-dedupe-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "user", sessionID: session.id,
            time: { created: Date.now() }, agent: "analyst", model: { providerID: "test", modelID: "test" },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: user.id, sessionID: session.id,
            type: "text", text: "比较 OLS 和双向固定效应回归。",
          } as never)
          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "assistant", parentID: user.id, sessionID: session.id,
            mode: "analyst", agent: "analyst", path: { cwd: root, root }, cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test", providerID: "test", time: { created: Date.now() },
          } as never)
          const result = (step: string, value: string) => ({
            analysisView: {
              kind: "econometrics", step,
              results: [
                { label: "x 系数", value },
                { label: "p 值", value: "0.001" },
                { label: "N", value: "10" },
              ],
            },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: assistant.id, sessionID: session.id,
            type: "tool", tool: "ols_regression", callID: "call_ols_dedupe",
            state: { status: "completed", input: { dependentVar: "y", treatmentVar: "x" }, output: "ok", title: "OLS", metadata: result("ols_regression", "0.50"), time: { start: Date.now(), end: Date.now() } },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: assistant.id, sessionID: session.id,
            type: "tool", tool: "panel_fe_regression", callID: "call_fe_dedupe",
            state: { status: "completed", input: { dependentVar: "y", treatmentVar: "x", entityVar: "id", timeVar: "year" }, output: "ok", title: "FE", metadata: result("panel_fe_regression", "0.80"), time: { start: Date.now(), end: Date.now() } },
          } as never)

          const assembler = new TurnAssembler({
            assistantMessage: assistant as never, sessionID: session.id,
            model: { id: "test", providerID: "test" } as never,
          })
          const duplicate = "已核验的面板固定效应回归结果：x 系数=0.80，p 值=0.001；N=10。"
          const panelSupplement = "已核验的面板固定效应回归补充：组内 R²=0.80，N=10。"
          const olsDetailed = "已核验的OLS回归结果：x 系数=0.50；N=10。"
          const olsShort = "已核验的OLS回归结果：x 系数=0.50。"
          const completeReport = "数据：did.xlsx\n\n**OLS（合并面板）**\n- 系数：0.50；N=10。\n\n**双向固定效应面板**\n- 系数：0.80；N=10。"
          await assembler.consume({ type: "text-start" })
          await assembler.consume({ type: "text-delta", text: duplicate })
          await assembler.consume({ type: "text-end" })
          await assembler.consume({ type: "text-start" })
          await assembler.consume({ type: "text-delta", text: `${duplicate}\n${duplicate}\n${olsDetailed}\n${olsShort}\n${panelSupplement}\n${completeReport}` })
          await assembler.consume({ type: "text-end" })
          await assembler.finalize("stop")

          const stored = (await Session.messages({ sessionID: session.id })).find((item) => item.info.id === assistant.id)
          const visibleTexts = stored?.parts
            .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text" && !part.synthetic)
            .map((part) => part.text) ?? []
          const visible = visibleTexts.join("\n")
          expect((visible.match(/已核验的面板固定效应回归结果：x 系数=0\.80，p 值=0\.001；N=10。/g) ?? []).length).toBe(1)
          expect(visibleTexts[1]).not.toContain("已核验的OLS回归结果")
          expect(visibleTexts[1]).not.toContain("已核验的面板固定效应回归补充")
          expect(visible).toContain("**OLS（合并面板）**")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("模型在回归小节标题处提前收尾时，使用结构化结果补齐最终摘要", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-incomplete-analysis-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID: session.id,
            time: { created: Date.now() },
            agent: "analyst",
            model: { providerID: "test", modelID: "test" },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: user.id,
            sessionID: session.id,
            type: "text",
            text: "先做 OLS，再做面板固定效应回归",
          } as never)

          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "assistant",
            parentID: user.id,
            sessionID: session.id,
            mode: "analyst",
            agent: "analyst",
            path: { cwd: root, root },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test",
            providerID: "test",
            time: { created: Date.now() },
          } as never)

          const addEstimator = async (tool: string, results: Array<{ label: string; value: string }>) => {
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: assistant.id,
              sessionID: session.id,
              type: "tool",
              tool,
              callID: `call_${tool}`,
              state: {
                status: "completed",
                input: {},
                output: "ok",
                title: tool,
                metadata: {
                  analysisView: {
                    kind: "econometrics",
                    step: tool,
                    results,
                    conclusion: `${tool} 已完成。`,
                  },
                },
                time: { start: Date.now(), end: Date.now() },
              },
            } as never)
          }

          await addEstimator("ols_regression", [
            { label: "高质量发展指数 系数", value: "0.8502" },
            { label: "p 值", value: "0.0000" },
            { label: "N", value: "4709" },
            { label: "R²", value: "0.9895" },
          ])
          await addEstimator("panel_fe_regression", [
            { label: "高质量发展指数 系数", value: "0.8555" },
            { label: "标准误", value: "0.0080" },
            { label: "p 值", value: "0.0000" },
            { label: "N", value: "4709" },
            { label: "组内 R²", value: "0.9576" },
          ])

          const assembler = new TurnAssembler({
            assistantMessage: assistant as never,
            sessionID: session.id,
            model: { id: "test", providerID: "test" } as never,
          })
          await assembler.consume({ type: "text-start" })
          await assembler.consume({
            type: "text-delta",
            text: "导入并估计完成，两项结果如下。\n\n**1. 合并面板OLS**（创新指数~高质量发展指数）\n\n**对比说明**",
          })
          await assembler.consume({ type: "text-end" })
          await assembler.finalize("stop")

          const stored = (await Session.messages({ sessionID: session.id })).find((item) => item.info.id === assistant.id)
          const texts = stored?.parts
            .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
            .map((part) => part.text) ?? []
          const finalText = texts.at(-1) ?? ""
          expect(finalText).toContain("OLS回归")
          expect(finalText).toContain("面板固定效应回归")
          expect(finalText).toContain("标准误 0.0080")
          expect(finalText).not.toMatch(/\*\*1\. 合并面板OLS\*\*[^\n]*$/)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("质量检查收尾为空时，使用结构化事实生成中文结论", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-quality-fallback-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID: session.id,
            time: { created: Date.now() },
            agent: "analyst",
            model: { providerID: "test", modelID: "test" },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: user.id,
            sessionID: session.id,
            type: "text",
            text: "请检查这份数据有没有重复、缺失和异常值，并给我结论。",
          } as never)

          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "assistant",
            parentID: user.id,
            sessionID: session.id,
            mode: "analyst",
            agent: "analyst",
            path: { cwd: root, root },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test",
            providerID: "test",
            time: { created: Date.now() },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: assistant.id,
            sessionID: session.id,
            type: "tool",
            tool: "data_import",
            callID: "call_quality_import",
            state: {
              status: "completed",
              input: { action: "import", inputPath: "did.xlsx" },
              output: "quality facts",
              title: "Data import",
              metadata: {
                finalizeTextOnly: true,
                analysisView: {
                  kind: "data_import",
                  step: "data_import(import)",
                  foundInputFile: "did.xlsx",
                  results: [
                    { label: "行数变化", value: "4709 -> 4709" },
                    { label: "列数变化", value: "34 -> 34" },
                  ],
                  warnings: [
                    "质量检查事实：缺失：time 缺失 3043 行；重复键：地区×year 存在 12 行重复键；异常值：人口密度检测到潜在异常值",
                  ],
                },
              },
              time: { start: Date.now(), end: Date.now() },
            },
          } as never)

          const assembler = new TurnAssembler({
            assistantMessage: assistant as never,
            sessionID: session.id,
            model: { id: "test", providerID: "test" } as never,
            inputIntent: "analysis",
          })
          await assembler.finalize("stop")

          const stored = (await Session.messages({ sessionID: session.id }))
            .find((item) => item.info.id === assistant.id)
          const text = stored?.parts.find((part) => part.type === "text")
          const visible = text?.type === "text" ? text.text : ""
          expect(visible).toContain("缺失")
          expect(visible).toContain("重复")
          expect(visible).toContain("异常")
          expect(visible).not.toMatch(/datasetId|stageId|workflow_|stage_\d+/)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("工具返回需要用户决策时，用户看到决策停点而不是导入摘要", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-decision-fallback-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID: session.id,
            time: { created: Date.now() },
            agent: "analyst",
            model: { providerID: "test", modelID: "test" },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: user.id,
            sessionID: session.id,
            type: "text",
            text: "请用 OLS：创新指数 ~ 城镇化率。",
          } as never)
          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "assistant",
            parentID: user.id,
            sessionID: session.id,
            mode: "analyst",
            agent: "analyst",
            path: { cwd: root, root },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test",
            providerID: "test",
            time: { created: Date.now() },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: assistant.id,
            sessionID: session.id,
            type: "tool",
            tool: "ols_regression",
            callID: "call_missing_variable",
            state: {
              status: "completed",
              input: { dependentVar: "创新指数", treatmentVar: "城镇化率" },
              output: "尚未执行 ols_regression。原因：当前数据中找不到变量：城镇化率。请确认变量角色或真实列名后再继续。",
              title: "需要确认模型规格",
              metadata: { requiresUserDecision: true },
              time: { start: Date.now(), end: Date.now() },
            },
          } as never)

          const assembler = new TurnAssembler({
            assistantMessage: assistant as never,
            sessionID: session.id,
            model: { id: "test", providerID: "test" } as never,
            inputIntent: "analysis",
          })
          await assembler.finalize("stop")

          const stored = (await Session.messages({ sessionID: session.id }))
            .find((item) => item.info.id === assistant.id)
          const text = stored?.parts.find((part) => part.type === "text")
          const visible = text?.type === "text" ? text.text : ""
          expect(visible).toContain("尚未执行")
          expect(visible).toContain("请确认")
          expect(visible).not.toContain("正在准备后续校验或清洗")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("自动 repair 中间态不提前写入终止文案", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-repair-intermediate-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "user", sessionID: session.id,
            time: { created: Date.now() }, agent: "analyst", model: { providerID: "test", modelID: "test" },
          } as never)
          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "assistant", parentID: user.id,
            sessionID: session.id, mode: "analyst", agent: "analyst", path: { cwd: root, root },
            cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test", providerID: "test", time: { created: Date.now() },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: assistant.id, sessionID: session.id,
            type: "tool", tool: "data_import", callID: "call_repairable",
            state: {
              status: "error", input: { action: "profile", datasetId: "d1", stageId: "bad" },
              error: "Stage not found: datasetId=d1, stageId=bad",
              time: { start: Date.now(), end: Date.now() },
            },
          } as never)
          const assembler = new TurnAssembler({
            assistantMessage: assistant as never, sessionID: session.id,
            model: { id: "test", providerID: "test" } as never, inputIntent: "repair",
          })
          await assembler.finalize({
            type: "repair",
            toolName: "data_import",
            retryStage: "ingest",
            repairAction: "从最新 manifest 恢复真实 stage 后重试",
          }, new Error("repair will continue"))
          const stored = (await Session.messages({ sessionID: session.id }))
            .find((item) => item.info.id === assistant.id)
          const visible = stored?.parts
            .map((part) => part.type === "text" && !part.synthetic ? part.text : "")
            .join("\n") ?? ""
          expect(visible).not.toContain("本轮操作未完成")
          expect(visible).toBe("")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("repair 收尾会标记同批次前序失败后未执行的排队工具，不把它当成真实取消", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-repair-skipped-tool-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "user", sessionID: session.id,
            time: { created: Date.now() }, agent: "analyst", model: { providerID: "test", modelID: "test" },
          } as never)
          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "assistant", parentID: user.id,
            sessionID: session.id, mode: "analyst", agent: "analyst", path: { cwd: root, root },
            cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test", providerID: "test", time: { created: Date.now() },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: assistant.id, sessionID: session.id,
            type: "tool", tool: "data_import", callID: "call_skipped_after_failure",
            state: {
              status: "running", input: { action: "import", inputPath: "did.xlsx" },
              time: { start: Date.now() },
            },
          } as never)
          const assembler = new TurnAssembler({
            assistantMessage: assistant as never, sessionID: session.id,
            model: { id: "test", providerID: "test" } as never, inputIntent: "repair",
          })
          await assembler.finalize({
            type: "repair",
            toolName: "magic_causal_wizard",
            retryStage: "verify",
            repairAction: "调用 tool_search 后改用已注册工具",
          })
          const stored = (await Session.messages({ sessionID: session.id }))
            .find((item) => item.info.id === assistant.id)
          const tool = stored?.parts.find((part) => part.type === "tool")
          expect(tool?.type).toBe("tool")
          if (tool?.type === "tool" && tool.state.status === "error") {
            expect(tool.state.metadata?.skippedAfterPriorToolFailure).toBe(true)
            expect(tool.state.error).toContain("前序工具失败")
          } else {
            throw new Error("expected the queued tool to be finalized as an error")
          }
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("用户决策停点会标记排队工具为跳过，不伪装成 Tool execution aborted", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-user-decision-skipped-tool-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "user", sessionID: session.id,
            time: { created: Date.now() }, agent: "analyst", model: { providerID: "test", modelID: "test" },
          } as never)
          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "assistant", parentID: user.id,
            sessionID: session.id, mode: "analyst", agent: "analyst", path: { cwd: root, root },
            cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test", providerID: "test", time: { created: Date.now() },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: assistant.id, sessionID: session.id,
            type: "tool", tool: "panel_fe_regression", callID: "call_decision_stop",
            state: {
              status: "completed", input: { timeVar: "年份" }, output: "尚未执行面板回归。",
              metadata: { requiresUserDecision: true }, title: "需要确认模型规格",
              time: { start: Date.now(), end: Date.now() },
            },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: assistant.id, sessionID: session.id,
            type: "tool", tool: "read", callID: "call_skipped_after_decision",
            state: { status: "running", input: { filePath: "results.json" }, time: { start: Date.now() } },
          } as never)

          const assembler = new TurnAssembler({
            assistantMessage: assistant as never, sessionID: session.id,
            model: { id: "test", providerID: "test" } as never, inputIntent: "analysis",
          })
          await assembler.finalize("stop")

          const stored = (await Session.messages({ sessionID: session.id })).find((item) => item.info.id === assistant.id)
          const skipped = stored?.parts.find((part) => part.type === "tool" && part.tool === "read")
          expect(skipped?.type).toBe("tool")
          if (skipped?.type === "tool" && skipped.state.status === "error") {
            expect(skipped.state.metadata?.skippedAfterUserDecision).toBe(true)
            expect(skipped.state.error).not.toBe("Tool execution aborted")
          } else {
            throw new Error("expected the queued read to be marked as skipped")
          }
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("AgentEngine 显式发送的 skipped 事件会持久化为跳过元数据", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-explicit-skipped-tool-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "user", sessionID: session.id,
            time: { created: Date.now() }, agent: "analyst", model: { providerID: "test", modelID: "test" },
          } as never)
          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "assistant", parentID: user.id,
            sessionID: session.id, mode: "analyst", agent: "analyst", path: { cwd: root, root },
            cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test", providerID: "test", time: { created: Date.now() },
          } as never)
          const assembler = new TurnAssembler({
            assistantMessage: assistant as never, sessionID: session.id,
            model: { id: "test", providerID: "test" } as never,
          })
          await assembler.consume({ type: "tool-input-start", toolCallId: "call_explicit_skip", toolName: "read" } as never)
          await assembler.consume({ type: "tool-call", toolCallId: "call_explicit_skip", toolName: "read", input: { filePath: "result.csv" } } as never)
          await assembler.consume({
            type: "tool-error", toolCallId: "call_explicit_skip", toolName: "read",
            error: "同批次前序失败，未执行", skipped: true, blocked: true, metadata: { skipped: true },
          } as never)

          const stored = (await Session.messages({ sessionID: session.id })).find((item) => item.info.id === assistant.id)
          const skipped = stored?.parts.find((part) => part.type === "tool")
          expect(skipped?.type).toBe("tool")
          if (skipped?.type === "tool" && skipped.state.status === "error") {
            expect(skipped.state.metadata?.skipped).toBe(true)
            expect(skipped.state.metadata?.blocked).toBe(true)
            expect(skipped.state.error).toContain("未执行")
          } else {
            throw new Error("expected the skipped tool call to have a persisted terminal state")
          }
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("Agent Loop 结果处理异常把未确认工具标成需核对，不伪装成用户取消", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-loop-failure-tool-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "user", sessionID: session.id,
            time: { created: Date.now() }, agent: "analyst", model: { providerID: "test", modelID: "test" },
          } as never)
          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "assistant", parentID: user.id,
            sessionID: session.id, mode: "analyst", agent: "analyst", path: { cwd: root, root },
            cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test", providerID: "test", time: { created: Date.now() },
          } as never)
          const assembler = new TurnAssembler({
            assistantMessage: assistant as never, sessionID: session.id,
            model: { id: "test", providerID: "test" } as never,
          })
          await assembler.consume({ type: "tool-input-start", toolCallId: "call_unconfirmed", toolName: "data_preprocess" } as never)
          await assembler.consume({ type: "tool-call", toolCallId: "call_unconfirmed", toolName: "data_preprocess", input: { action: "filter" } } as never)
          await assembler.finalize("stop", new ToolUseLoopFailureError({
            stage: "prepare_results", callIDs: ["call_unconfirmed"], message: "结果整理异常",
          }))

          const stored = (await Session.messages({ sessionID: session.id })).find((item) => item.info.id === assistant.id)
          const tool = stored?.parts.find((part) => part.type === "tool")
          expect(tool?.type).toBe("tool")
          if (tool?.type === "tool" && tool.state.status === "error") {
            expect(tool.state.metadata?.unconfirmed).toBe(true)
            expect(tool.state.metadata?.failureStage).toBe("prepare_results")
            expect(tool.state.error).toContain("核对")
            expect(tool.state.error).not.toContain("用户取消")
          } else {
            throw new Error("expected an unresolved tool call to be marked as unconfirmed")
          }
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("咨询轮空收尾时，引用上一轮结果并明确稳健性尚未执行", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-consultation-fallback-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const firstUser = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "user", parentID: null, sessionID: session.id,
            time: { created: Date.now() }, agent: "analyst", model: { providerID: "test", modelID: "test" },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: firstUser.id, sessionID: session.id,
            type: "text", text: "请完成 OLS：创新指数 ~ 城镇化水平。",
          } as never)
          const firstAssistant = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "assistant", parentID: firstUser.id,
            sessionID: session.id, mode: "analyst", agent: "analyst", path: { cwd: root, root },
            cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test", providerID: "test", time: { created: Date.now() },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: firstAssistant.id, sessionID: session.id,
            type: "tool", tool: "ols_regression", callID: "call_previous_ols",
            state: {
              status: "completed", input: { dependentVar: "创新指数", treatmentVar: "城镇化水平" },
              output: "OLS 已完成", title: "OLS", metadata: {
                analysisView: {
                  kind: "econometrics", step: "ols_regression",
                  results: [
                    { label: "城镇化水平 系数", value: "0.1675" },
                    { label: "p 值", value: "0.0000" },
                    { label: "N", value: "4709" },
                  ],
                  conclusion: "OLS 回归已完成。",
                },
              }, time: { start: Date.now(), end: Date.now() },
            },
          } as never)

          const currentUser = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "user", parentID: firstAssistant.id,
            sessionID: session.id, time: { created: Date.now() }, agent: "analyst",
            model: { providerID: "test", modelID: "test" },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: currentUser.id, sessionID: session.id,
            type: "text", text: "这个结果靠谱吗？有没有稳健性检验？",
          } as never)
          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "assistant", parentID: currentUser.id,
            sessionID: session.id, mode: "analyst", agent: "analyst", path: { cwd: root, root },
            cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test", providerID: "test", time: { created: Date.now() },
          } as never)

          const assembler = new TurnAssembler({
            assistantMessage: assistant as never, sessionID: session.id,
            model: { id: "test", providerID: "test" } as never, inputIntent: "analysis",
          })
          await assembler.finalize("stop")

          const stored = (await Session.messages({ sessionID: session.id }))
            .find((item) => item.info.id === assistant.id)
          const text = stored?.parts.find((part) => part.type === "text")
          const visible = text?.type === "text" ? text.text : ""
          expect(visible).toContain("稳健性检验")
          expect(visible).toContain("尚未执行")
          expect(visible).toContain("0.1675")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("真实无 parentID 消息的咨询轮在工具探索失败后也不能返回空白", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-consultation-parentless-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const firstUser = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "user", sessionID: session.id,
            time: { created: Date.now() }, agent: "analyst", model: { providerID: "test", modelID: "test" },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: firstUser.id, sessionID: session.id,
            type: "text", text: "请完成 OLS：创新指数 ~ 城镇化水平。",
          } as never)
          const firstAssistant = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "assistant", parentID: firstUser.id, sessionID: session.id,
            mode: "analyst", agent: "analyst", path: { cwd: root, root }, cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test", providerID: "test", time: { created: Date.now() },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: firstAssistant.id, sessionID: session.id,
            type: "tool", tool: "ols_regression", callID: "call_parentless_ols",
            state: {
              status: "completed", input: { dependentVar: "创新指数", treatmentVar: "城镇化水平" },
              output: "OLS 已完成", title: "OLS", metadata: {
                analysisView: {
                  kind: "econometrics", step: "ols_regression",
                  results: [
                    { label: "城镇化水平 系数", value: "0.1675" },
                    { label: "p 值", value: "0.0000" },
                    { label: "N", value: "4709" },
                  ],
                  conclusion: "OLS 回归已完成。",
                },
              }, time: { start: Date.now(), end: Date.now() },
            },
          } as never)

          const currentUser = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "user", parentID: firstAssistant.id, sessionID: session.id,
            time: { created: Date.now() }, agent: "analyst", model: { providerID: "test", modelID: "test" },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: currentUser.id, sessionID: session.id,
            type: "text", text: "这个结果靠谱吗？有没有稳健性检验？",
          } as never)
          const assistant = await Session.updateMessage({
            // 模拟真实流中间插入 repair/synthetic 消息后父链指向旧 assistant；当前
            // 用户消息仍按时间顺序位于当前 assistant 之前，兜底不应因此失效。
            id: Identifier.ascending("message"), role: "assistant", parentID: firstAssistant.id, sessionID: session.id,
            mode: "analyst", agent: "analyst", path: { cwd: root, root }, cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test", providerID: "test", time: { created: Date.now() },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: assistant.id, sessionID: session.id,
            type: "tool", tool: "read", callID: "call_parentless_read",
            state: {
              status: "error", input: { filePath: "results.json" },
              error: "找不到文件：results.json",
              time: { start: Date.now(), end: Date.now() },
            },
          } as never)

          const assembler = new TurnAssembler({
            assistantMessage: assistant as never, sessionID: session.id,
            model: { id: "test", providerID: "test" } as never, inputIntent: "analysis",
          })
          await assembler.finalize("stop")

          const stored = (await Session.messages({ sessionID: session.id })).find((item) => item.info.id === assistant.id)
          const visible = stored?.parts
            .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text" && !part.synthetic)
            .map((part) => part.text)
            .join("\n") ?? ""
          expect(visible).toContain("稳健性检验")
          expect(visible).toContain("尚未执行")
          expect(visible).toContain("0.1675")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("方法切换轮只做检查后也必须给出中文收尾，不返回空白", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-method-switch-fallback-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "user", sessionID: session.id,
            time: { created: Date.now() }, agent: "analyst", model: { providerID: "test", modelID: "test" },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: user.id, sessionID: session.id,
            type: "text", text: "上一轮传统DID失败，请改用两阶段双重差分（did2s）重新评估；缺少相对时期时先说明并停止。",
          } as never)
          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"), role: "assistant", parentID: user.id, sessionID: session.id,
            mode: "analyst", agent: "analyst", path: { cwd: root, root }, cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test", providerID: "test", time: { created: Date.now() },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: assistant.id, sessionID: session.id,
            type: "text", text: "需要从 time（首次处理期）构造 cohort 列，再构造 relative_time。",
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"), messageID: assistant.id, sessionID: session.id,
            type: "tool", tool: "data_import", callID: "call_method_switch_profile",
            state: {
              status: "completed", input: { action: "profile" }, output: "数据画像已完成", title: "数据画像",
              metadata: { analysisView: { kind: "data_import", step: "data_import(profile)", results: [{ label: "结构", value: "面板数据" }] } },
              time: { start: Date.now(), end: Date.now() },
            },
          } as never)

          const assembler = new TurnAssembler({
            assistantMessage: assistant as never, sessionID: session.id,
            model: { id: "test", providerID: "test" } as never, inputIntent: "analysis",
          })
          await assembler.finalize("continue")

          const stored = (await Session.messages({ sessionID: session.id })).find((item) => item.info.id === assistant.id)
          const visible = stored?.parts
            .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text" && !part.synthetic)
            .map((part) => part.text)
            .join("\n") ?? ""
          expect(visible).toContain("尚未生成新的两阶段双重差分结果")
          expect(visible).toContain("相对时期")
          expect(visible).toContain("请确认")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("收集工具 analysisView 的数值快照，不因局部变量遮蔽而丢失", async () => {
    const assembler = new TurnAssembler({
      assistantMessage: {} as never,
      sessionID: "ses_test",
      model: {} as never,
    })

    const evidence = await (
      assembler as unknown as {
        collectTurnNumericEvidence: (tools: unknown[]) => Promise<{ snapshots: Array<{ entries: unknown[] }> }>
      }
    ).collectTurnNumericEvidence([
      {
        tool: "ols_regression",
        state: {
          status: "completed",
          metadata: {
            analysisView: {
              kind: "econometrics",
              step: "ols_regression",
              results: [{ label: "x 系数", value: "0.52" }],
            },
          },
        },
      },
    ])

    expect(evidence.snapshots).toHaveLength(1)
    expect(evidence.snapshots[0]?.entries).toEqual([
      expect.objectContaining({ metric: "coefficient", term: "x", value: 0.52 }),
    ])
  })

  test("compact 是框架控制信号，不持久化成 assistant 错误", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-compact-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const message = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "assistant",
            parentID: "user",
            sessionID: session.id,
            mode: "analyst",
            agent: "analyst",
            path: { cwd: root, root },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test",
            providerID: "test",
            time: { created: Date.now() },
          } as never)
          const assembler = new TurnAssembler({
            assistantMessage: message as never,
            sessionID: session.id,
            model: { id: "test", providerID: "test" } as never,
          })
          await assembler.finalize("compact", new Error("context threshold reached"))
          const stored = (await Session.messages({ sessionID: session.id }))
            .find((item) => item.info.id === message.id)
          expect(stored?.info.role).toBe("assistant")
          if (stored?.info.role !== "assistant") throw new Error("assistant missing")
          expect(stored.info.error).toBeUndefined()
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("摘要文本不经过普通计量数字接地改写", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-turn-summary-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID: session.id,
            time: { created: Date.now() },
            agent: "analyst",
            model: { providerID: "test", modelID: "test" },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: user.id,
            sessionID: session.id,
            type: "text",
            text: "总结 DID 估计，系数为 0.123。",
          } as never)
          const message = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "assistant",
            parentID: user.id,
            sessionID: session.id,
            mode: "compaction",
            agent: "analyst",
            summary: true,
            path: { cwd: root, root },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test",
            providerID: "test",
            time: { created: Date.now() },
          } as never)
          const assembler = new TurnAssembler({
            assistantMessage: message as never,
            sessionID: session.id,
            model: { id: "test", providerID: "test" } as never,
          })
          const raw = "<summary>8. 当前工作：DID 系数 0.123，等待稳健性检验。</summary>"
          await assembler.consume({ type: "text-start" })
          await assembler.consume({ type: "text-delta", text: raw })
          await assembler.consume({ type: "text-end" })
          await assembler.finalize("stop")
          const stored = (await Session.messages({ sessionID: session.id }))
            .find((item) => item.info.id === message.id)
          const text = stored?.parts.find((part) => part.type === "text")
          expect(text?.type === "text" ? text.text : undefined).toBe(raw)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
