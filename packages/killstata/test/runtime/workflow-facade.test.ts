import { test, expect } from "bun:test"
import * as W from "@/runtime/workflow"
import fs from "fs"
import os from "os"
import path from "path"

/**
 * `runtime/workflow` 门面的公开 API 契约。
 *
 * 该模块原本是 3190 行单文件，2026-07-27 拆成 state/artifact/stage/rerun/exposure
 * 五个子模块。拆分的前提是**公开 API 一个不少、行为一字不改**，这里把这条契约
 * 钉死：下次有人往子模块里搬函数、或误删某个 re-export，测试会立刻变红。
 */
const EXPECTED = [
  "readWorkflowSession","writeWorkflowSession","isWorkflowArtifactRef","isVerifierReadableArtifactRef",
  "filterVerifierReadableArtifactRefs","sanitizeVerifierPromptMetadata","applyRepairHandler",
  "getActiveWorkflowRun","isAnalysisWorkflowActive","assertDatasetStageReadyForEstimation",
  "assertDatasetStageReadyForPreprocess","ensureAnalysisPlan","setAnalysisPlanApproval",
  "formatAnalysisChecklist","workflowPromptSummary","recommendedSkillBundle",
  "recordWorkflowStageSuccess","recordWorkflowStageFailure","latestFailedStage","buildRerunPlan",
  "executeRerunPlan","buildVerifierReport","runVerifierGate","runAutomaticVerifier",
  "deferAutomaticVerifier","flushDeferredAutomaticVerifiers","stageNeedsVerifier",
  "workflowStatusSummary","workflowStageDetails","workflowArtifactList","workflowTaskLedger",
  "restoreWorkflowCheckpoint","workflowToolPolicy","resolveToolAvailability","filterToolsForWorkflow",
  "explainMcpToolForWorkflow","allowMcpToolForWorkflow","datasetStageSnapshot",
]

test("门面导出全部公开符号", () => {
  for (const name of EXPECTED) {
    expect(typeof (W as any)[name], `${name} 应为函数`).toBe("function")
  }
  expect(EXPECTED.length).toBe(38)
})

test("跨模块调用链行为与拆分前一致", () => {
  // artifact 判定
  expect(W.isWorkflowArtifactRef("analysis/ols/results.json")).toBe(true)
  expect(W.isWorkflowArtifactRef("/usr/bin/python3", "python_executable")).toBe(false)
  expect(W.isWorkflowArtifactRef("python -m pip install x")).toBe(false)
  // 这两个函数末尾有 fs.existsSync：必须用真实文件测，否则永远返回 false
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-api-check-"))
  const json = path.join(dir, "diagnostics.json")
  const png = path.join(dir, "plot.png")
  fs.writeFileSync(json, "{}")
  fs.writeFileSync(png, "x")
  expect(W.isVerifierReadableArtifactRef(json)).toBe(true)
  expect(W.isVerifierReadableArtifactRef(png)).toBe(false)
  expect(W.isVerifierReadableArtifactRef(dir)).toBe(false)
  expect(W.filterVerifierReadableArtifactRefs([json, png, json])).toEqual([json])
  fs.rmSync(dir, { recursive: true, force: true })

  // 跨模块调用链：exposure → state
  const r = W.resolveToolAvailability({
    policy: { sessionID: "ses_api_check", agent: "analyst", inputIntent: "conversation",
      platformCapabilities: { mcp: false, images: false, remote: false },
      modelCapabilities: { supportsTools: true, supportsImages: false } },
    toolIDs: ["read","data_import","ols_regression"],
  })
  // 系统工具每轮直出；具体计量方法仍通过第二层搜索延迟加载。
  expect(r.directToolIDs).toEqual(expect.arrayContaining(["read", "data_import"]))
  expect(r.directToolIDs).not.toContain("ols_regression")

  // MCP 策略
  expect(W.allowMcpToolForWorkflow({ toolName: "ctx_delete_all", policy: { sessionID: "s" } })).toBe(false)
})
