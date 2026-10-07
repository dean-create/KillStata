import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { resolveToolAvailability } from "@/runtime/workflow/exposure"
import { TOOL_MANIFEST } from "@/runtime/tool-manifest"
import type { StageStatus, ToolAvailabilityPolicy, WorkflowInputIntent, WorkflowStageKind } from "@/runtime/types"

/**
 * exposure 的特征化（characterization）基线：**不断言"应该是什么"，只锁定"现在是什么"**。
 *
 * resolveToolAvailability 是纯函数——所有 IO（读 workflow state、读 execution_mode.json）
 * 都在 workflowToolPolicy 里，它只接收 {policy, toolIDs}。因此全组合枚举不需要任何 mock。
 *
 * 用途：重构 exposure 内部结构时，基线零 diff == 行为未变。任何 diff 都必须能被解释成
 * 一次有意的行为变更，不接受"这个 diff 看起来合理"。
 *
 * 刻意不用 toMatchSnapshot：全组合基线约 200KB/agent，bun 的 snapshot parser 在这个
 * 体量上会报 "Failed to parse snapshot file"（且只在与其他快照文件同批运行时才暴露，
 * 单独跑因为走内存缓存而假通过）。自管理 fixture 同时让 diff 回到普通 git diff。
 *
 * 基线变更：KILLSTATA_UPDATE_EXPOSURE_MATRIX=1 bun test test/runtime/exposure-matrix.test.ts
 * 更新后必须逐条确认 git diff 里的每一处变化都是有意为之。
 */

const STAGES: Array<WorkflowStageKind | undefined> = [
  undefined,
  "healthcheck",
  "import",
  "profile_or_schema_check",
  "validate",
  "preprocess_or_filter",
  "profile_or_diagnostics",
  "baseline_estimate",
  "verifier",
  "report",
]
const INTENTS: WorkflowInputIntent[] = ["conversation", "status", "repair", "verify", "report", "analysis", "ingest"]
const AGENTS = ["analyst", "verifier", "explore", "general"]
const APPROVALS: Array<ToolAvailabilityPolicy["approvalStatus"]> = ["approved", "required"]
const MODES: Array<"auto" | "plan"> = ["auto", "plan"]
// running 与 blocked 分别代表正常推进与修复模式（isRepairMode 由 status 推导）
const STATUSES: StageStatus[] = ["running", "blocked"]

const allToolIDs = TOOL_MANIFEST.map((entry) => entry.id)
const FIXTURE_DIR = path.join(import.meta.dir, "fixtures")
const shouldUpdate = process.env.KILLSTATA_UPDATE_EXPOSURE_MATRIX === "1"

function renderRow(policy: ToolAvailabilityPolicy) {
  const resolution = resolveToolAvailability({ policy, toolIDs: allToolIDs })
  const direct = [...(resolution.directToolIDs ?? [])].sort().join(",")
  const deferred = [...(resolution.deferredToolIDs ?? [])].sort().join(",")
  const key = [
    policy.currentStage ?? "-",
    policy.inputIntent,
    policy.agent,
    policy.approvalStatus,
    policy.executionMode,
    policy.currentStageStatus,
  ].join("|")
  return `${key}\n  direct  : ${direct || "(none)"}\n  deferred: ${deferred || "(none)"}`
}

function matrixFor(agent: string) {
  const rows: string[] = []
  for (const stage of STAGES) {
    for (const intent of INTENTS) {
      for (const approvalStatus of APPROVALS) {
        for (const executionMode of MODES) {
          for (const currentStageStatus of STATUSES) {
            rows.push(
              renderRow({
                currentStage: stage,
                currentStageStatus,
                inputIntent: intent,
                agent,
                approvalStatus,
                executionMode,
                workflowMode: "econometrics",
                platformCapabilities: { mcp: false, images: false, remote: false },
                modelCapabilities: { supportsTools: true, supportsImages: false },
              }),
            )
          }
        }
      }
    }
  }
  return rows.join("\n") + "\n"
}

describe("exposure 全组合特征化基线", () => {
  test("未登记数据请求时只暴露 analysis_request；inspect 与 estimate 可预检，但 explain 不开放规格准备", () => {
    const basePolicy = {
      agent: "analyst",
      inputIntent: "analysis" as const,
      workflowMode: "econometrics" as const,
      approvalStatus: "approved" as const,
      platformCapabilities: { mcp: false, images: false, remote: false },
      modelCapabilities: { supportsTools: true, supportsImages: false },
    }

    const registrationRequired = resolveToolAvailability({
      policy: { ...basePolicy, analysisRequestRequired: true },
      toolIDs: allToolIDs,
    })
    const alreadyRegistered = resolveToolAvailability({
      policy: { ...basePolicy, analysisRequestRequired: false, analysisRequestKind: "explain" },
      toolIDs: allToolIDs,
    })
    const estimateRegistered = resolveToolAvailability({
      policy: { ...basePolicy, analysisRequestRequired: false, analysisRequestKind: "estimate" },
      toolIDs: allToolIDs,
    })
    const inspectRegistered = resolveToolAvailability({
      policy: { ...basePolicy, analysisRequestRequired: false, analysisRequestKind: "inspect" },
      toolIDs: allToolIDs,
    })

    expect(registrationRequired.directToolIDs).toEqual(["analysis_request"])
    expect(registrationRequired.deferredToolIDs).toEqual([])
    expect(alreadyRegistered.directToolIDs).not.toContain("analysis_request")
    expect(alreadyRegistered.directToolIDs).not.toContain("analysis_prepare")
    expect(estimateRegistered.directToolIDs).toContain("analysis_prepare")
    expect(inspectRegistered.directToolIDs).toContain("analysis_prepare")
  })

  // 按 agent 拆分：一次改动通常只影响其中一两份，diff 范围更小
  for (const agent of AGENTS) {
    test(`agent=${agent} 的 stage×intent×approval×mode×status 全组合`, () => {
      const fixture = path.join(FIXTURE_DIR, `exposure-matrix-${agent}.txt`)
      const actual = matrixFor(agent)
      if (shouldUpdate || !fs.existsSync(fixture)) {
        fs.mkdirSync(FIXTURE_DIR, { recursive: true })
        fs.writeFileSync(fixture, actual, "utf-8")
        return
      }
      expect(actual).toBe(fs.readFileSync(fixture, "utf-8"))
    })
  }

  test("组合数与维度声明一致（防止枚举漏项后基线悄悄变小）", () => {
    const perAgent = STAGES.length * INTENTS.length * APPROVALS.length * MODES.length * STATUSES.length
    expect(perAgent).toBe(10 * 7 * 2 * 2 * 2)
    // 每个组合固定三行：key / direct / deferred，末尾一个换行
    expect(matrixFor("analyst").trimEnd().split("\n").length).toBe(perAgent * 3)
  })
})
