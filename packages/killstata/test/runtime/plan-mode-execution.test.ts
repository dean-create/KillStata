import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { resolveToolAvailability } from "@/runtime/workflow/exposure"
import { WORKFLOW_ESTIMATE_TOOL_IDS } from "@/runtime/tool-catalog"
import { FailurePolicy } from "@/runtime/failure-policy"
import { toolIDsByFamily } from "@/runtime/tool-manifest"
import { Instance } from "@/project/instance"
import { SystemPrompt } from "@/session/system"
import { Global } from "@/global"
import { isAllowedInPlanMode } from "@/runtime/execution-mode"

const ALL_TOOL_IDS = toolIDsByFamily(
  "read_core",
  "system",
  "import",
  "recommend",
  "data_method",
  "diagnostic",
  "estimator",
  "report",
)

function resolveAt(executionMode: "auto" | "plan") {
  return resolveToolAvailability({
    toolIDs: [...ALL_TOOL_IDS],
    policy: {
      sessionID: "s1",
      agent: "analyst",
      inputIntent: "analysis",
      currentStage: "validate",
      currentStageStatus: "completed",
      executionMode,
      platformCapabilities: { mcp: false, images: false, remote: false },
      modelCapabilities: { supportsTools: true, supportsImages: false },
    },
  })
}

describe("P1 — Plan 模式不裁剪工具可见性", () => {
  // 2026-08-28 冲突已由用户拍板：可见性 = Auto，只读边界只在执行层（processor.ts 的
  // PLAN_MODE_EXECUTION_BLOCKED）。exposure.ts 里残留的 planAllowed 可见层过滤已删除，
  // 本测试从 todo 恢复为正式回归门禁——再有人加回可见层裁剪，这里会直接红灯。
  test("Plan 与 Auto 的可搜索(deferred)工具集一致，估计器都在", () => {
    const auto = resolveAt("auto")
    const plan = resolveAt("plan")

    const autoSearchable = new Set([...(auto.directToolIDs ?? []), ...(auto.deferredToolIDs ?? [])])
    const planSearchable = new Set([...(plan.directToolIDs ?? []), ...(plan.deferredToolIDs ?? [])])

    // 回归点：真实对话里 Plan 模式把估计器从 bundle 里删掉，tool_search 永远搜不到，
    // 模型空转一整轮后被 glob 崩溃硬停。可见性必须与 Auto 完全一致。
    for (const id of WORKFLOW_ESTIMATE_TOOL_IDS) {
      expect(planSearchable.has(id), `plan 模式应能搜到估计器 ${id}`).toBe(true)
    }
    expect(planSearchable.has("data_import")).toBe(true)
    expect(planSearchable.has("data_preprocess")).toBe(true)
    expect([...autoSearchable].sort()).toEqual([...planSearchable].sort())
  })
})

describe("P4 — 只读工具未知失败不终结整轮", () => {
  test("readOnlyTool + unknown_failure → repair（不 stop）", () => {
    const decision = FailurePolicy.classifyTool({
      toolName: "glob",
      message: "boom",
      failureType: "unknown_failure",
      readOnlyTool: true,
    })
    expect(decision.disposition).toBe("repair")
  })

  test("非只读工具的 unknown_failure 仍然 stop（不回退现有行为）", () => {
    const decision = FailurePolicy.classifyTool({
      toolName: "panel_fe_regression",
      message: "boom",
      failureType: "unknown_failure",
      readOnlyTool: false,
    })
    expect(decision.disposition).toBe("stop")
  })

  test("readOnlyTool 不影响明确分类的失败（估计器失败仍走 estimation_failure repair）", () => {
    const decision = FailurePolicy.classifyTool({
      toolName: "read",
      message: "boom",
      failureType: "estimation_failure",
      readOnlyTool: true,
    })
    expect(decision.category).toBe("estimation_failure")
    expect(decision.disposition).toBe("repair")
  })
})

describe("P3 — system prompt 携带 Plan 模式说明", () => {
  async function environmentWithMode(mode: "auto" | "plan"): Promise<string> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-plan-mode-"))
    try {
      return await Instance.provide({
        directory: root,
        fn: async () => {
          const file = path.join(Global.Path.state, "execution_mode.json")
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, JSON.stringify({ mode }))
          const sections = await SystemPrompt.environment({ sessionID: "s1" })
          return sections.join("\n")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  test("Plan 模式含说明段落，Auto 模式不含", async () => {
    const plan = await environmentWithMode("plan")
    expect(plan).toContain("执行模式=Plan")
    expect(plan).toContain("受管检查快照")
    expect(plan).toContain("PLAN_MODE_EXECUTION_BLOCKED")

    const auto = await environmentWithMode("auto")
    expect(auto).not.toContain("执行模式=Plan")
  })

  // 两种模式的提问倾向必须写进 system prompt，否则模型只能靠猜：真实对话里 Auto 模式
  // 每一步都停下来确认，Plan 模式反而直接假设研究设计。
  test("Plan 要求主动多问，Auto 要求克制提问", async () => {
    const plan = await environmentWithMode("plan")
    expect(plan).toContain("提问策略（Plan 模式要主动）")
    expect(plan).toContain("每轮只问一个核心决策")

    const auto = await environmentWithMode("auto")
    expect(auto).toContain("执行模式=Auto")
    expect(auto).toContain("不要为确认而确认")
  })
})

describe("P5 — Plan 模式放行只读数据动作", () => {
  // Plan 模式要能基于**真实列名**提问，就必须先读到 Excel；而本产品里读 Excel 的唯一
  // 途径就是 data_import。import/profile/validate 等不改用户原始文件，属于只读。
  test("data_import 的只读动作放行", () => {
    for (const action of ["import", "profile", "validate", "correlation", "frequency", "healthcheck"]) {
      expect(isAllowedInPlanMode("data_import", { action }), action).toBe(true)
    }
  })

  test("data_import 的写动作与其他分析工具仍被拒", () => {
    expect(isAllowedInPlanMode("data_import", { action: "export" })).toBe(false)
    expect(isAllowedInPlanMode("data_import", { action: "rollback" })).toBe(false)
    expect(isAllowedInPlanMode("data_preprocess", { method: "winsorize" })).toBe(false)
    expect(isAllowedInPlanMode("panel_fe_regression", {})).toBe(false)
    expect(isAllowedInPlanMode("write", { filePath: "/tmp/a.txt" })).toBe(false)
  })

  test("缺少 action 或 action 非法时不放行（不靠工具名兜底）", () => {
    expect(isAllowedInPlanMode("data_import", {})).toBe(false)
    expect(isAllowedInPlanMode("data_import", undefined)).toBe(false)
    expect(isAllowedInPlanMode("data_import", { action: 1 })).toBe(false)
  })

  test("规划期交互工具照常放行", () => {
    expect(isAllowedInPlanMode("question", {})).toBe(true)
    expect(isAllowedInPlanMode("todowrite", {})).toBe(true)
    expect(isAllowedInPlanMode("skill", {})).toBe(true)
  })
})
