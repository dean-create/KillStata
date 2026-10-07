import { describe, expect, test } from "bun:test"
import { resolveToolAvailability } from "@/runtime/workflow/exposure"
import { TOOL_MANIFEST } from "@/runtime/tool-manifest"

/**
 * 2026-08-28 did.xlsx 真实会话的卡死主因。
 *
 * 用户追问「？」「结果呢？」时 intent 落到 conversation（或 activeAction 被清空后
 * 回落默认值），exposure 的 conversation 分支返回空 bundle，导致：
 *   1. 所有估计器从 direct 和 deferred 同时消失 → tool_search 返回 availableCount:0
 *   2. 连 repairToolName（正在修复的目标方法）都进不来 → 直调报 tool_not_found
 * 两个症状同源，模型只能盲试直到熔断。
 *
 * 正确语义：conversation 不该**主动发起**新分析，但当会话已有失败待修的分析时，
 * 修复目标和已确认方法必须保持可达，否则用户一句追问就把自己锁死。
 */
const toolIDs = TOOL_MANIFEST.map((entry) => entry.id)
const base = {
  agent: "analyst",
  platformCapabilities: { mcp: false, images: false, remote: false },
  modelCapabilities: { supportsTools: true, supportsImages: false },
} as const

describe("conversation intent 不得锁死进行中的分析", () => {
  test("修复模式下追问一句，repairToolName 仍必须可调用", () => {
    const r = resolveToolAvailability({
      policy: {
        ...base,
        inputIntent: "conversation",
        currentStage: "baseline_estimate",
        currentStageStatus: "failed",
        repairOnly: true,
        repairToolName: "hdfe_regression",
      },
      toolIDs,
    })
    expect(r.directToolIDs, "正在修复的目标方法必须可直接调用").toContain("hdfe_regression")
  })

  test("修复模式下追问一句，其他方法仍可被 tool_search 搜到", () => {
    const r = resolveToolAvailability({
      policy: {
        ...base,
        inputIntent: "conversation",
        currentStage: "baseline_estimate",
        currentStageStatus: "failed",
        repairOnly: true,
        repairToolName: "hdfe_regression",
      },
      toolIDs,
    })
    expect(r.deferredToolIDs, "换方法的候选必须仍可搜索").toContain("panel_fe_regression")
  })

  test("已确认的方法在 conversation 轮不被清空", () => {
    const r = resolveToolAvailability({
      policy: {
        ...base,
        inputIntent: "conversation",
        currentStage: "baseline_estimate",
        currentStageStatus: "completed",
        confirmedToolIDs: ["did2s"],
      },
      toolIDs,
    })
    expect(r.directToolIDs, "用户已确认的方法必须保持可达").toContain("did2s")
  })

  test("干净会话的闲聊仍不得主动暴露估计器", () => {
    const r = resolveToolAvailability({
      policy: { ...base, inputIntent: "conversation" },
      toolIDs,
    })
    const methods = (r.directToolIDs ?? []).filter((id) => /_regression$|^did|^psm_|^iv_|^rdd_/.test(id))
    expect(methods, "无分析上下文的闲聊不该主动给估计器").toEqual([])
  })

  test("概念式追问中明确点名的新方法仍可动态加载", () => {
    const r = resolveToolAvailability({
      policy: {
        ...base,
        inputIntent: "conversation",
        currentStage: "verifier",
        currentStageStatus: "completed",
        preferredToolIDs: ["probit_regression"],
      },
      toolIDs,
    })
    expect(r.directToolIDs, "用户明确要求对比的新方法不能因疑问句被隐藏").toContain("probit_regression")
  })

  test("失败阶段的状态查询保持只读，不自动打开修复工具包", () => {
    const r = resolveToolAvailability({
      policy: {
        ...base,
        inputIntent: "status",
        currentStage: "baseline_estimate",
        currentStageStatus: "failed",
        repairOnly: true,
      },
      toolIDs,
    })
    expect(r.directToolIDs).toContain("pipeline")
    // 系统工具按产品设计每轮常驻；状态轮真正不能直出的，是具体计量方法。
    expect(r.directToolIDs).toContain("data_import")
    expect(r.directToolIDs).not.toContain("did_static")
    expect(r.directToolIDs).not.toContain("ols_regression")
  })
})
