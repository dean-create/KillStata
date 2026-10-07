import { describe, expect, test } from "bun:test"
import {
  WORKFLOW_ESTIMATE_TOOL_IDS,
  WORKFLOW_INPUT_INTENT_TOOL_BUNDLES,
  WORKFLOW_KNOWN_TOOL_IDS,
} from "@/runtime/tool-catalog"
import {
  ALL_ECONOMETRICS_ESTIMATOR_TOOL_IDS,
  MODEL_ADMITTED_ECONOMETRICS_ESTIMATOR_TOOL_IDS,
} from "@/runtime/econometrics-admission"
import { toolExecutionTraits } from "@/runtime/tool-policy"
import { allowMcpToolForWorkflow, explainMcpToolForWorkflow, resolveToolAvailability } from "@/runtime/workflow"
import { Tool } from "@/tool/tool"
import { WORKFLOW_EXECUTION } from "@/tool/pipeline"

describe("runtime tool policy", () => {
  test("workflow tool catalog uses real todo ids and has no duplicate known ids", () => {
    const known = [...WORKFLOW_KNOWN_TOOL_IDS]

    expect(known).toContain("todoread")
    expect(known).not.toContain("todo_read")
    expect(new Set(known).size).toBe(known.length)

    for (const bundle of Object.values(WORKFLOW_INPUT_INTENT_TOOL_BUNDLES)) {
      expect(bundle).not.toContain("todo_read")
    }
  })

  test("a new analysis workflow exposes intake only, not estimators or coding tools", () => {
    for (const toolID of ["edit", "write", "batch", "lsp", "plan_enter", "plan_exit"]) {
      expect(WORKFLOW_KNOWN_TOOL_IDS).not.toContain(toolID)
    }

    const available = resolveToolAvailability({
      policy: {
        inputIntent: "analysis",
        platformCapabilities: { mcp: false, images: false, remote: false },
        modelCapabilities: { supportsTools: true, supportsImages: false },
      },
      toolIDs: ["bash", "shell", "data_import", "data_batch", "ols_regression", "panel_fe_regression"],
    })

    expect(available.directToolIDs).toContain("data_import")
    expect(available.deferredToolIDs).toContain("ols_regression")
    expect(available.blockedToolIDs).not.toContain("ols_regression")
    expect(available.directToolIDs).not.toContain("ols_regression")
    expect(available.directToolIDs).not.toContain("bash")
    expect(available.directToolIDs).not.toContain("shell")
    expect(available.directToolIDs).not.toContain("data_batch")
  })

  test("exposes recommendation after import and keeps estimators searchable only after the QA gate", () => {
    const toolIDs = [
      "read",
      "pipeline",
      "data_import",
      "econometrics_recommend",
      "psm_matching",
      "did2s",
      "ols_regression",
    ]
    const basePolicy = {
      inputIntent: "analysis" as const,
      workflowMode: "econometrics" as const,
      platformCapabilities: { mcp: false, images: false, remote: false },
      modelCapabilities: { supportsTools: true, supportsImages: false },
    }

    const profile = resolveToolAvailability({
      policy: { ...basePolicy, currentStage: "profile_or_schema_check" },
      toolIDs,
    })
    expect(profile.directToolIDs).toContain("econometrics_recommend")
    expect(profile.directToolIDs).not.toContain("ols_regression")

    const qa = resolveToolAvailability({
      policy: { ...basePolicy, currentStage: "validate" },
      toolIDs,
    })
    expect(qa.directToolIDs).toContain("data_import")
    expect(qa.directToolIDs).not.toContain("ols_regression")

    const ready = resolveToolAvailability({
      policy: { ...basePolicy, currentStage: "preprocess_or_filter" },
      toolIDs,
    })
    expect(ready.directToolIDs).toContain("econometrics_recommend")
    expect(ready.deferredToolIDs).toEqual(expect.arrayContaining(["psm_matching", "did2s", "ols_regression"]))
    expect(ready.directToolIDs).not.toContain("ols_regression")
  })

  test("a data-quality request keeps data_import available so dedupe/QA can proceed (no deadlock)", () => {
    // 真实死锁复现（2026-07-18，2000-2022 面板）：导入后 QA 发现 115 条重复实体键，
    // 模型想调 data_import(action=filter, deduplicate=...) 去重，却因意图被判成 conversation
    // 而拿到空工具包，报"工具调用失败/请检查任务参数"。数据质检必须能调到修数据的工具。
    const toolIDs = ["read", "pipeline", "data_import", "ols_regression"]
    const caps = {
      platformCapabilities: { mcp: false, images: false, remote: false },
      modelCapabilities: { supportsTools: true, supportsImages: false },
    }

    // conversation 仍不应启动估计，但系统工具每轮直出，保证用户临时提出数据质检要求时
    // 不会因为上一轮意图被判成 conversation 而拿不到 data_import。
    const asConversation = resolveToolAvailability({
      policy: { inputIntent: "conversation" as const, currentStage: "validate", ...caps },
      toolIDs,
    })
    expect(asConversation.directToolIDs).toContain("data_import")

    // 修复后：数据质检请求归入 ingest，data_import 必须在 QA/去重相关 stage 全程可用。
    for (const currentStage of ["validate", "profile_or_schema_check", "preprocess_or_filter"] as const) {
      const ingest = resolveToolAvailability({
        policy: { inputIntent: "ingest" as const, currentStage, ...caps },
        toolIDs,
      })
      expect(ingest.directToolIDs, currentStage).toContain("data_import")
      // validate/profile 阶段 stage bundle 不含估计器——只做数据准备。
      // preprocess_or_filter/profile 阶段 stage bundle 含估计器（profile 阶段可边诊断边估计），
      // ingest 意图跟随 stage bundle 不删除（2026-08-05 修复：一条导入消息循环里模型会
      // 推进到 validate/profile/估计，ingest 收窄会让估计器在数据就绪后消失造成死锁）。
      if (currentStage === "validate" || currentStage === "profile_or_schema_check") {
        expect(ingest.directToolIDs, currentStage).not.toContain("ols_regression")
      }
    }
  })

  test("exposes each admitted estimator as its own analysis tool", () => {
    expect(WORKFLOW_ESTIMATE_TOOL_IDS).toEqual([...MODEL_ADMITTED_ECONOMETRICS_ESTIMATOR_TOOL_IDS])

    for (const toolID of WORKFLOW_ESTIMATE_TOOL_IDS) {
      expect(WORKFLOW_INPUT_INTENT_TOOL_BUNDLES.analysis).toContain(toolID)
    }
  })

  test("the estimate stage keeps data_import so derived variables (e.g. did2s relative-time) can be built", () => {
    // 真实死锁（2026-07-21，did.xlsx staggered）：模型选对 did2s 后，需要先构造相对时间变量
    // （relativeTimeVar = year - 首次处理年份）才能估计。若 baseline_estimate 阶段的工具包
    // 拿掉 data_import，模型一进入估计阶段就无法回头构造派生变量 → "unavailable tool data_import"。
    // profile 阶段本就 data_import 与估计器共存，估计阶段必须保持一致，否则需预构造变量的
    // 估计器（did2s / 交互项 / 变换 / 子样本）全部死锁。
    const toolIDs = ["read", "pipeline", "data_import", "did2s", "ols_regression"]
    const available = resolveToolAvailability({
      policy: {
        inputIntent: "analysis" as const,
        workflowMode: "econometrics" as const,
        currentStage: "baseline_estimate" as const,
        platformCapabilities: { mcp: false, images: false, remote: false },
        modelCapabilities: { supportsTools: true, supportsImages: false },
      },
      toolIDs,
    })
    expect(available.deferredToolIDs).toContain("did2s")
    expect(available.directToolIDs).toContain("data_import")
  })

  test("exposes only admitted estimators even though historical backends stay registered", () => {
    const available = resolveToolAvailability({
      policy: {
        inputIntent: "analysis",
        workflowMode: "econometrics",
        currentStage: "baseline_estimate",
        platformCapabilities: { mcp: false, images: false, remote: false },
        modelCapabilities: { supportsTools: true, supportsImages: false },
      },
      toolIDs: [...ALL_ECONOMETRICS_ESTIMATOR_TOOL_IDS],
    })

    expect([...(available.deferredToolIDs ?? [])].sort()).toEqual(
      [...MODEL_ADMITTED_ECONOMETRICS_ESTIMATOR_TOOL_IDS].sort(),
    )
    // 该测试只传入估计器 ID，因此不能据此否定产品在完整注册表上的系统工具常驻契约。
    expect(available.directToolIDs).toEqual([])
  })

  test("workflow action controls side-effect traits", () => {
    expect(toolExecutionTraits(WORKFLOW_EXECUTION, { action: "status" })).toMatchObject({
      concurrencySafe: true,
      sideEffectLevel: "none",
      approval: "automatic",
    })
    expect(toolExecutionTraits(WORKFLOW_EXECUTION, { action: "diagnostics" })).toMatchObject({
      concurrencySafe: true,
      sideEffectLevel: "none",
    })
    expect(toolExecutionTraits(WORKFLOW_EXECUTION, { action: "verify" })).toMatchObject({
      concurrencySafe: false,
      sideEffectLevel: "external",
    })
    expect(toolExecutionTraits(WORKFLOW_EXECUTION, { action: "restore" })).toMatchObject({
      concurrencySafe: false,
      sideEffectLevel: "session",
    })
    expect(toolExecutionTraits(WORKFLOW_EXECUTION, { action: "rerun" })).toMatchObject({
      concurrencySafe: false,
      sideEffectLevel: "filesystem",
    })
  })

  test("三档风险与未知工具 fail-closed", () => {
    expect(toolExecutionTraits(Tool.Execution.protectedFilesystem)).toMatchObject({
      approval: "confirm",
      confirmation: "tool",
      requiresConfirmation: true,
      concurrencySafe: false,
    })
    expect(toolExecutionTraits(Tool.Execution.managedFilesystem)).toMatchObject({
      approval: "automatic",
      requiresConfirmation: false,
      sideEffectLevel: "filesystem",
    })
    expect(toolExecutionTraits(Tool.Execution.protectedExternalRead)).toMatchObject({
      approval: "confirm",
      confirmation: "tool",
      concurrencySafe: false,
      sideEffectLevel: "external",
    })
    expect(toolExecutionTraits(undefined)).toMatchObject({
      approval: "blocked",
      concurrencySafe: false,
      sideEffectLevel: "external",
    })
  })

  test("Shell 声明的最大命令期限先于通用工具期限到期", () => {
    const policy = Tool.Execution.protectedCommand
    expect(policy.timeout).toMatchObject({ kind: "bounded" })
    if (policy.timeout.kind !== "bounded") throw new Error("Shell 工具必须有界超时")
    expect(policy.timeout.timeoutMs).toBeGreaterThan(Tool.Timeout.LONG_RUNNING_MS + 100)
  })

  test("mcp gating allows only safe non-Stata sidecars after core workflow stages", () => {
    const safePolicy = {
      currentStage: "baseline_estimate" as const,
      platformCapabilities: { mcp: true, images: true, remote: false },
      modelCapabilities: { supportsTools: true, supportsImages: true },
    }

    expect(allowMcpToolForWorkflow({ toolName: "safe_search", policy: safePolicy })).toBe(true)
    expect(allowMcpToolForWorkflow({ toolName: "browser_fetch", policy: safePolicy })).toBe(true)
    expect(allowMcpToolForWorkflow({ toolName: "stata_run", policy: safePolicy })).toBe(false)
    expect(allowMcpToolForWorkflow({ toolName: "context7_docs", policy: safePolicy })).toBe(false)
    expect(allowMcpToolForWorkflow({ toolName: "github_create_issue", policy: safePolicy })).toBe(false)
    expect(allowMcpToolForWorkflow({ toolName: "opaque_tool", policy: safePolicy })).toBe(false)

    const mutatingSidecar = explainMcpToolForWorkflow({
      toolName: "github_create_issue",
      policy: safePolicy,
    })
    expect(mutatingSidecar.reasons.join("\n")).toContain("read-only lookup/search/status")

    const early = explainMcpToolForWorkflow({
      toolName: "safe_search",
      policy: { ...safePolicy, currentStage: "import" },
    })
    expect(early.available).toBe(false)
    expect(early.reasons.join("\n")).toContain("early data-readiness")
  })

  test("ingest intent exposes data import tools before a workflow stage exists", () => {
    const available = resolveToolAvailability({
      policy: {
        inputIntent: "ingest",
        platformCapabilities: { mcp: true, images: true, remote: false },
        modelCapabilities: { supportsTools: true, supportsImages: true },
      },
      toolIDs: ["read", "pipeline", "data_import", "econometrics"],
    })

    expect(available.directToolIDs).toContain("data_import")
    expect(available.blockedToolIDs).toContain("econometrics")
  })

  test("conversation keeps the system tool surface without resuming an unfinished analysis workflow", () => {
    const available = resolveToolAvailability({
      policy: {
        inputIntent: "conversation",
        currentStage: "import",
        currentStageStatus: "blocked",
        repairOnly: true,
        platformCapabilities: { mcp: true, images: true, remote: false },
        modelCapabilities: { supportsTools: true, supportsImages: true },
      },
      toolIDs: ["read", "pipeline", "data_import", "econometrics"],
    })

    expect(available.directToolIDs).toEqual(expect.arrayContaining(["read", "pipeline", "data_import"]))
    expect(available.directToolIDs).not.toContain("econometrics")
    expect(
      allowMcpToolForWorkflow({
        toolName: "safe_search",
        policy: { inputIntent: "conversation", currentStage: "baseline_estimate" },
      }),
    ).toBe(false)
  })

  test("automatic repair exposes the failed estimator plus data-prep tools; only other estimators are locked", () => {
    const available = resolveToolAvailability({
      policy: {
        inputIntent: "repair",
        currentStage: "baseline_estimate",
        currentStageStatus: "failed",
        repairOnly: true,
        repairToolName: "psm_ipw",
        platformCapabilities: { mcp: false, images: false, remote: false },
        modelCapabilities: { supportsTools: true, supportsImages: false },
      },
      toolIDs: ["read", "data_import", "econometrics_recommend", "data_preprocess", "psm_ipw", "did2s", "ols_regression"],
    })

    // 只读 + 修复目标估计器可见
    expect(available.directToolIDs).toContain("read")
    expect(available.directToolIDs).toContain("psm_ipw")
    // 修复手段工具（重跑 import/QA、画像、清洗）必须可见：估计器失败（如缺 profile/QA）
    // 的 repairAction 指向 profile/clean 阶段，锁死这些工具会让修复循环死锁（2026-08-05 修复）。
    expect(available.directToolIDs).toContain("data_import")
    expect(available.directToolIDs).toContain("data_preprocess")
    expect(available.directToolIDs).toContain("econometrics_recommend")
    // 其他估计器仍被方法锁定：修复模式不允许换方法蒙混过关
    expect(available.directToolIDs).not.toContain("did2s")
    expect(available.directToolIDs).not.toContain("ols_regression")
  })

  test("automatic repair of a data-prep tool does not lock the tool surface", () => {
    // recommend（画像）失败本身不应锁工具面：锁定的语义是"不换估计方法"，
    // 数据工具失败后模型仍需能重试 recommend 或调用 data_import 修数据。
    const available = resolveToolAvailability({
      policy: {
        inputIntent: "repair",
        currentStage: "profile_or_schema_check",
        currentStageStatus: "failed",
        repairOnly: true,
        repairToolName: "econometrics_recommend",
        platformCapabilities: { mcp: false, images: false, remote: false },
        modelCapabilities: { supportsTools: true, supportsImages: false },
      },
      toolIDs: ["read", "data_import", "data_preprocess", "econometrics_recommend", "panel_fe_regression"],
    })

    expect(available.directToolIDs).toContain("econometrics_recommend")
    expect(available.directToolIDs).toContain("data_import")
    expect(available.directToolIDs).toContain("data_preprocess")
  })

  test("repair mode (QA blocked) keeps data_preprocess despite status/verify intent (2026-08-11)", () => {
    // 真实死锁（2026-08-11 correlation-before / time-missing）：QA gate 因重复键 blocked 后，
    // 模型发修复轮（intent 常被判成 status/verify——查 workflow 看阻断原因），
    // 修复模式 bundle 是完整修复包，但 intent 收窄把它滤成 readCore，data_preprocess
    // 消失——模型想用 combine_columns 修复合键却看不到工具。修复模式不按 intent 收窄。
    const toolIDs = ["read", "pipeline", "data_import", "data_preprocess", "econometrics_recommend", "panel_fe_regression"]
    const caps = {
      platformCapabilities: { mcp: false, images: false, remote: false },
      modelCapabilities: { supportsTools: true, supportsImages: false },
    }

    // QA blocked 后模型查状态（intent=status）：修复模式必须仍暴露修复工具
    const statusIntent = resolveToolAvailability({
      policy: {
        inputIntent: "status",
        currentStage: "validate",
        currentStageStatus: "blocked",
        repairOnly: true,
        ...caps,
      },
      toolIDs,
    })
    expect(statusIntent.directToolIDs).toContain("data_preprocess")
    expect(statusIntent.directToolIDs).toContain("data_import")
    expect(statusIntent.directToolIDs).toContain("econometrics_recommend")

    // verify 意图同样不拦截修复工具
    const verifyIntent = resolveToolAvailability({
      policy: {
        inputIntent: "verify",
        currentStage: "validate",
        currentStageStatus: "blocked",
        repairOnly: true,
        ...caps,
      },
      toolIDs,
    })
    expect(verifyIntent.directToolIDs).toContain("data_preprocess")

    // 系统工具不因 status 意图消失；具体计量方法仍按阶段/方法窗口控制。
    const normalStatus = resolveToolAvailability({
      policy: { inputIntent: "status", currentStage: "validate", currentStageStatus: "completed", ...caps },
      toolIDs,
    })
    expect(normalStatus.directToolIDs).toContain("data_preprocess")
  })
})
