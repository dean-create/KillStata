import { describe, expect, test } from "bun:test"
import { Instance } from "@/project/instance"
import fs from "fs"
import os from "os"
import path from "path"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_PROVIDER_ID } from "@/provider/deepseek-policy"
import { resolveTools } from "@/session/prompt/tools"
import {
  freshVerifierPrompt,
  freshVerifierToolOverrides,
  mergeVerifierEnvelope,
  applyMergedVerifierReport,
  parseVerifierEnvelope,
  prepareFreshVerifierEvidence,
} from "@/runtime/workflow/rerun"

describe("fresh verifier execution policy", () => {
  test("uses attached evidence in one model turn without any callable tools", async () => {
    return Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const overrides = await freshVerifierToolOverrides()
        expect(Object.values(overrides).every((enabled) => enabled === false)).toBe(true)
        const verifier = await Agent.get("verifier")
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const resolved = await resolveTools({
          agent: verifier,
          model,
          session: { id: "session-tool-free-verifier", permission: [] } as never,
          tools: overrides,
          processor: { message: { id: "message-tool-free" }, partFromToolCall: () => undefined } as never,
          intent: "verify",
        })
        expect(Object.keys(resolved.definitions)).toEqual([])

        const prompt = freshVerifierPrompt({
          stage: {
            stageId: "stage_001",
            kind: "baseline_estimate",
            branch: "main",
            replayInput: {},
            artifactRefs: [],
            readableArtifactRefs: [],
            datasetId: "dataset_1",
            metadata: {},
          } as never,
          workflow: {
            workflowRunId: "workflow_1",
            trustedArtifacts: [],
          } as never,
        })

        expect(prompt).toContain("可读产物已作为附件")
        expect(prompt).toContain("不得调用任何工具")
        expect(prompt).toContain("单次文本响应")
      },
    })
  })

  test("invalid fresh output cannot downgrade a local block", () => {
    expect(parseVerifierEnvelope("not tagged json")).toBeUndefined()
    const local = {
      status: "block" as const,
      checks: [{ key: "artifact", label: "artifact", status: "block" as const, message: "missing" }],
      blockingFindings: ["missing"],
      repairHints: ["rerun"],
      trustedArtifacts: [],
      createdAt: new Date().toISOString(),
    }
    const merged = mergeVerifierEnvelope(local, {
      status: "pass",
      checks: [],
      blockingFindings: [],
      repairHints: [],
      trustedArtifacts: ["untrusted.json"],
      summary: "pass",
      findings: [],
      agent: "verifier",
      mode: "fresh-run",
      createdAt: new Date().toISOString(),
    })
    expect(merged.status).toBe("block")
    expect(merged.blockingFindings).toContain("missing")
    expect(merged.trustedArtifacts).toEqual([])
  })

  test("a fresh block updates the verifier node and workflow state consistently", () => {
    const target = {
      nodeId: "main:stage_001",
      stageId: "stage_001",
      kind: "baseline_estimate",
      status: "completed",
      branch: "main",
      toolName: "panel_fe_regression",
      artifactRefs: ["result.json"],
      trustedArtifacts: ["result.json"],
      failure: {
        code: "PANEL_KEY_DUPLICATED",
        toolName: "panel_fe_regression",
        message: "duplicate panel key",
        retryStage: "validate",
        repairAction: "repair key",
        autoRepairAllowed: true,
        requiresVerifier: true,
        maxRetries: 3,
        createdAt: new Date().toISOString(),
      },
    } as any
    const verifier = {
      nodeId: "main:stage_001__verifier",
      stageId: "stage_001__verifier",
      kind: "verifier",
      status: "completed",
      branch: "main",
      parentStageId: "stage_001",
      artifactRefs: ["result.json"],
      trustedArtifacts: ["result.json"],
    } as any
    const run = {
      workflowRunId: "workflow_1",
      activeStage: "report",
      activeNodeId: verifier.nodeId,
      stages: [target, verifier],
      trustedArtifacts: ["result.json"],
      repairOnly: false,
    } as any
    applyMergedVerifierReport(run, target, {
      status: "block",
      checks: [],
      blockingFindings: ["fresh verifier found a contradiction"],
      repairHints: ["rerun estimate"],
      trustedArtifacts: [],
      createdAt: new Date().toISOString(),
    })
    expect(verifier.status).toBe("blocked")
    expect(run.activeStage).toBe("baseline_estimate")
    expect(run.repairOnly).toBe(true)
    expect(run.latestFailure?.code).toBe("PANEL_KEY_DUPLICATED")
    expect(run.latestFailure?.retryStage).toBe("validate")
    expect(run.trustedArtifacts).toEqual([])
  })

  test("evidence preparation fails closed for missing and oversized readable artifacts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-verifier-evidence-"))
    try {
      const good = path.join(root, "result.json")
      fs.writeFileSync(good, '{"ok":true}', "utf-8")
      const stage = (refs: string[]) => ({ artifactRefs: refs, readableArtifactRefs: refs }) as never
      expect(prepareFreshVerifierEvidence(stage([good]))?.text).toContain('{"ok":true}')
      expect(prepareFreshVerifierEvidence(stage([path.join(root, "missing.json")]))).toBeUndefined()
      const large = path.join(root, "large.json")
      fs.writeFileSync(large, "x".repeat(300_000), "utf-8")
      expect(prepareFreshVerifierEvidence(stage([large]))).toBeUndefined()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
