import { describe, expect, test } from "bun:test"
import { detectInputIntent, detectToolFocus } from "@/session/prompt/intent"
import { resolveToolAvailability } from "@/runtime/workflow"
import type { PromptInput } from "@/session/prompt/types"

function textParts(text: string): PromptInput["parts"] {
  return [{ type: "text", text }] as PromptInput["parts"]
}

const toolIDs = [
  "question",
  "read",
  "list",
  "glob",
  "grep",
  "skill",
  "pipeline",
  "tool_search",
  "econometrics_execute",
  "webfetch",
  "todoread",
  "todowrite",
  "data_import",
  "data_preprocess",
  "econometrics_recommend",
  "psm_construction",
  "psm_visualize",
  "psm_matching",
  "psm_ipw",
  "psm_regression",
  "psm_double_robust",
  "did_static",
  "did2s",
  "did_event_study_saturated",
  "ols_regression",
  "hdfe_regression",
  "panel_fe_regression",
  "iv_2sls",
  "iv_test",
  "task",
]

const basePolicy = {
  inputIntent: "analysis" as const,
  workflowMode: "econometrics" as const,
  currentStage: "baseline_estimate" as const,
  agent: "analyst",
  platformCapabilities: { mcp: false, images: false, remote: false },
  modelCapabilities: { supportsTools: true, supportsImages: false },
}

describe("本轮动态工具池聚焦", () => {
  test("status轮不重新暴露估计器", () => {
    const available = resolveToolAvailability({
      policy: { ...basePolicy, inputIntent: "status" },
      toolIDs,
    })

    expect(available.allowedToolIDs).not.toContain("ols_regression")
    expect(available.allowedToolIDs).not.toContain("panel_fe_regression")
    expect(available.deferredToolIDs).not.toContain("ols_regression")
    expect(available.deferredToolIDs).not.toContain("panel_fe_regression")
    expect(available.allowedToolIDs).toContain("pipeline")
  })

  test("无明确方法时全部系统工具直出，估计器通过搜索延迟加载", () => {
    const available = resolveToolAvailability({
      policy: { ...basePolicy, ...detectToolFocus(textParts("继续分析这份数据")) },
      toolIDs,
    })

    expect(available.directToolIDs).toEqual(expect.arrayContaining([
      "question", "read", "list", "glob", "grep", "skill", "pipeline", "tool_search",
      "data_import", "data_preprocess", "econometrics_recommend",
    ]))
    expect(available.directToolIDs).not.toContain("ols_regression")
    expect(available.deferredToolIDs).toContain("ols_regression")
  })

  test("只读质量体检不向模型直出 read，避免重复读取内部数据引用", () => {
    const available = resolveToolAvailability({
      policy: { ...basePolicy, qualityInspectionOnly: true },
      toolIDs,
    })

    expect(available.directToolIDs).not.toContain("read")
    expect(available.directToolIDs).toContain("data_import")
    expect(available.directToolIDs).toContain("question")
    expect(available.directToolIDs).not.toContain("econometrics_recommend")
  })

  test("只读质量体检不暴露预处理和计量方法，但保留方法搜索作为恢复通道", () => {
    const available = resolveToolAvailability({
      policy: { ...basePolicy, qualityInspectionOnly: true },
      toolIDs,
    })

    expect(available.directToolIDs).not.toContain("data_preprocess")
    expect(available.directToolIDs).not.toContain("composite_evaluation")
    expect(available.directToolIDs).toContain("tool_search")
    expect(available.deferredToolIDs).not.toContain("ols_regression")
    expect(available.deferredToolIDs).not.toContain("panel_fe_regression")
  })

  test("inspect 请求在只读质量上下文中可使用规格预检，但不能执行估计", () => {
    const available = resolveToolAvailability({
      policy: { ...basePolicy, qualityInspectionOnly: true, analysisRequestKind: "inspect" },
      toolIDs: [...toolIDs, "analysis_prepare"],
    })

    expect(available.directToolIDs).toContain("analysis_prepare")
    expect(available.directToolIDs).not.toContain("econometrics_execute")
    expect(available.deferredToolIDs).not.toContain("ols_regression")
  })

  test("PSM 仅诊断范围将所有效应估计器从可搜索方法池移除", () => {
    const available = resolveToolAvailability({
      policy: {
        ...basePolicy,
        inputIntent: "analysis",
        currentStage: "profile_or_diagnostics",
        psmToolScope: "diagnostics_only",
        preferredToolIDs: ["psm_construction", "psm_visualize", "psm_matching"],
      },
      toolIDs,
    })

    expect(available.bundle).toContain("psm_construction")
    expect(available.bundle).toContain("psm_visualize")
    expect(available.directToolIDs).toContain("econometrics_execute")
    expect(available.directToolIDs).toContain("tool_search")
    for (const toolID of [
      "psm_matching", "psm_ipw", "psm_regression", "psm_double_robust",
      "ols_regression", "panel_fe_regression", "did_static",
    ]) {
      expect(available.bundle).not.toContain(toolID)
      expect(available.deferredToolIDs).not.toContain(toolID)
    }
    for (const toolID of ["data_preprocess", "composite_evaluation", "econometrics_recommend", "iv_test", "heterogeneity_runner"]) {
      expect(available.bundle).not.toContain(toolID)
      expect(available.deferredToolIDs).not.toContain(toolID)
    }

    const confirmedFilter = resolveToolAvailability({
      policy: {
        ...basePolicy,
        inputIntent: "ingest",
        currentStage: "preprocess_or_filter",
        psmToolScope: "diagnostics_only",
        psmScopeFilter: { column: "year", value: 2021 },
        preferredToolIDs: ["psm_construction", "psm_visualize"],
      },
      toolIDs,
    })
    expect(confirmedFilter.bundle).toContain("data_preprocess")
    expect(confirmedFilter.bundle).not.toContain("composite_evaluation")
    expect(confirmedFilter.bundle).not.toContain("psm_matching")
  })

  test("PSM 咨询或明确拒绝执行时不暴露 PSM 工具", () => {
    const available = resolveToolAvailability({
      policy: {
        ...basePolicy,
        inputIntent: "analysis",
        currentStage: "profile_or_diagnostics",
        psmToolScope: "blocked",
        preferredToolIDs: ["psm_construction", "psm_visualize", "psm_matching"],
      },
      toolIDs,
    })

    for (const toolID of ["psm_construction", "psm_visualize", "psm_matching", "psm_ipw", "psm_regression", "psm_double_robust"]) {
      expect(available.bundle).not.toContain(toolID)
      expect(available.deferredToolIDs).not.toContain(toolID)
    }
    expect(available.directToolIDs).toContain("tool_search")
  })

  test("只读质量体检不暴露文件扫描和工作流控制工具", () => {
    const available = resolveToolAvailability({
      policy: { ...basePolicy, qualityInspectionOnly: true },
      toolIDs,
    })

    for (const toolID of ["list", "glob", "grep", "pipeline", "skill", "todoread", "todowrite", "task", "bash", "shell", "edit", "write", "webfetch"]) {
      expect(available.directToolIDs).not.toContain(toolID)
      expect(available.deferredToolIDs).not.toContain(toolID)
    }
  })

  test("质量体检中的缺失导入路径 repair 只恢复 Glob 文件定位，不开放文件读取或写入", () => {
    const available = resolveToolAvailability({
      policy: {
        ...basePolicy,
        inputIntent: "repair",
        currentStageStatus: "failed",
        repairOnly: true,
        repairToolName: "data_import",
        qualityInspectionOnly: true,
        allowFileDiscoveryDuringRepair: true,
      },
      toolIDs,
    })

    expect(available.directToolIDs).toContain("glob")
    expect(available.directToolIDs).toContain("data_import")
    for (const toolID of ["read", "list", "grep", "bash", "shell", "edit", "write"]) {
      expect(available.directToolIDs).not.toContain(toolID)
    }
    expect(available.directToolIDs).not.toContain("econometrics_execute")
  })

  test("只问方法推荐时只暴露只读画像工具，不暴露预处理和估计器", () => {
    const available = resolveToolAvailability({
      policy: { ...basePolicy, currentStage: "profile_or_schema_check", recommendationOnly: true },
      toolIDs,
    })

    expect(available.directToolIDs).toEqual(expect.arrayContaining([
      "question", "read", "list", "glob", "grep", "tool_search", "data_import", "econometrics_recommend",
    ]))
    for (const toolID of [
      "data_preprocess", "econometrics_execute", "did_static", "did2s", "ols_regression",
      "panel_fe_regression",
    ]) {
      expect(available.directToolIDs).not.toContain(toolID)
      expect(available.deferredToolIDs).not.toContain(toolID)
    }
  })

  test("质量检查后明确请求方法推荐时保留推荐工具但仍隐藏估计器", () => {
    const available = resolveToolAvailability({
      policy: {
        ...basePolicy,
        currentStage: "profile_or_schema_check",
        qualityInspectionOnly: true,
        recommendationOnly: true,
      },
      toolIDs,
    })

    expect(available.directToolIDs).toContain("econometrics_recommend")
    expect(available.directToolIDs).toContain("data_import")
    for (const toolID of ["data_preprocess", "econometrics_execute", "did_static", "ols_regression"]) {
      expect(available.directToolIDs).not.toContain(toolID)
      expect(available.deferredToolIDs).not.toContain(toolID)
    }
  })

  test("已确认的交错 DID 优先于认知工具占用直接预算", () => {
    const focus = detectToolFocus(textParts("数据已确认是交错处理，请使用 Gardner 两阶段 DID（did2s）"))
    const available = resolveToolAvailability({ policy: { ...basePolicy, ...focus }, toolIDs })

    expect(focus.confirmedToolIDs).toEqual(["did2s"])
    expect(available.directToolIDs?.[0]).toBe("did2s")
    expect(available.directToolIDs).toContain("did2s")
    expect(available.deferredToolIDs).not.toContain("did2s")
  })

  test("三项已确认方法与数据工作流工具分别计入预算，不互相挤占", () => {
    const confirmedToolIDs = ["did2s", "did_event_study_saturated", "ols_regression"]
    const available = resolveToolAvailability({
      policy: { ...basePolicy, confirmedToolIDs },
      toolIDs,
    })

    expect(available.directToolIDs).toEqual(expect.arrayContaining([
      ...confirmedToolIDs,
      "question",
      "read",
      "list",
      "pipeline",
      "tool_search",
      "data_import",
      "data_preprocess",
      "econometrics_recommend",
    ]))
    expect(available.directToolIDs?.filter((tool) => confirmedToolIDs.includes(tool))).toHaveLength(3)
  })

  test("十个明确计量方法同时可见，系统工具不占用方法预算", () => {
    const preferredToolIDs = [
      "did_static", "did2s", "did_event_study_saturated", "ols_regression", "panel_fe_regression",
      "iv_2sls", "iv_test", "psm_matching", "psm_ipw", "psm_regression",
    ]
    const available = resolveToolAvailability({
      policy: { ...basePolicy, preferredToolIDs },
      toolIDs,
    })

    expect(available.directToolIDs).toEqual(expect.arrayContaining(preferredToolIDs))
    expect(available.directToolIDs).toEqual(expect.arrayContaining([
      "question", "read", "glob", "grep", "data_import", "data_preprocess", "econometrics_recommend",
    ]))
  })

  test("明确 DID 请求只暴露 DID 方法族，并保留数据准备闭环", () => {
    const focus = detectToolFocus(textParts("用双重差分做平行趋势和事件研究"))
    const available = resolveToolAvailability({ policy: { ...basePolicy, ...focus }, toolIDs })

    expect(available.exposurePlan?.profile).toBe("focused")
    // 系统工具与具体计量方法分账：DID 三个方法不再挤掉数据准备闭环。
    expect(available.directToolIDs).toEqual(expect.arrayContaining([
      "data_import",
      "data_preprocess",
      "econometrics_recommend",
      "did_static",
      "did2s",
    ]))
    expect(available.directToolIDs).not.toContain("ols_regression")
    expect(available.directToolIDs).not.toContain("iv_2sls")
    expect(available.directToolIDs?.length).toBeLessThanOrEqual(18)
  })

  test("数据文件名不得触发同名计量方法，真实方法词仍优先", () => {
    const focus = detectToolFocus(textParts(
      "导入 /tmp/killstata-drive/did.xlsx，先跑 OLS，再做双向固定效应面板回归",
    ))
    expect(focus.preferredToolIDs).toEqual(expect.arrayContaining([
      "ols_regression",
      "panel_fe_regression",
      "hdfe_regression",
    ]))
    expect(focus.preferredToolIDs).not.toContain("did_static")
    expect(focus.preferredToolIDs).not.toContain("did2s")
    expect(focus.preferredToolIDs).not.toContain("did_event_study_saturated")
  })

  test("数据集标签 did 不得伪装成 DID 方法，明确 OLS 必须保留方法槽位", () => {
    const focus = detectToolFocus(textParts(
      "回到第一份 did 数据，不要重新导入；继续跑 OLS：创新指数 ~ 高质量发展指数。",
    ))
    expect(focus.preferredToolIDs).toContain("ols_regression")
    expect(focus.preferredToolIDs).not.toContain("did_static")
    expect(focus.preferredToolIDs).not.toContain("did2s")
    expect(focus.preferredToolIDs).not.toContain("did_event_study_saturated")
  })

  test("没有明确方法线索时保留完整延迟兜底，而不是把全部 schema 直接塞给模型", () => {
    const available = resolveToolAvailability({ policy: { ...basePolicy, ...detectToolFocus(textParts("继续分析")) }, toolIDs })

    expect(available.exposurePlan?.profile).toBe("workflow")
    expect(available.directToolIDs).not.toContain("ols_regression")
    expect(available.deferredToolIDs).toContain("ols_regression")
    expect(available.deferredToolIDs).toContain("did2s")
    expect(available.deferredToolIDs).toContain("iv_2sls")
  })

  test("泛 PSM 请求只直接加载构造、匹配与可视化，不暴露全部六种变体", () => {
    const focus = detectToolFocus(textParts("用倾向得分匹配分析处理效应"))
    const available = resolveToolAvailability({ policy: { ...basePolicy, ...focus }, toolIDs })

    // PSM 三件套占具体方法预算，仍不暴露用户没有请求的其他变体。
    expect(available.directToolIDs).toEqual(expect.arrayContaining([
      "psm_construction", "psm_visualize",
    ]))
    expect(available.directToolIDs).not.toContain("psm_ipw")
    expect(available.directToolIDs).not.toContain("psm_regression")
    expect(available.directToolIDs).not.toContain("psm_double_robust")
    expect(available.directToolIDs?.length).toBeLessThanOrEqual(18)
  })

  test("明确 IPW 或双重稳健时优先加载目标工具，不被泛 PSM 工具挤出预算", () => {
    const ipw = resolveToolAvailability({
      policy: { ...basePolicy, ...detectToolFocus(textParts("使用倾向得分 IPW 估计处理效应")) },
      toolIDs,
    })
    expect(ipw.directToolIDs).toContain("psm_ipw")
    expect(ipw.directToolIDs).not.toContain("psm_matching")

    const aipw = resolveToolAvailability({
      policy: { ...basePolicy, ...detectToolFocus(textParts("使用倾向得分双重稳健 AIPW")) },
      toolIDs,
    })
    expect(aipw.directToolIDs).toContain("psm_double_robust")
    expect(aipw.directToolIDs).not.toContain("psm_matching")
  })

  test("明确要求熵权 TOPSIS 时建立综合评价完成门禁", () => {
    const focus = detectToolFocus(textParts("用熵权 TOPSIS 构建综合评价并输出排名"))

    expect(focus.requiredToolIDs).toContain("composite_evaluation")
  })

  test("用户确认后说继续 DID2S 时仍建立估计完成门禁", () => {
    const focus = detectToolFocus(textParts(
      "我确认按 year - time 为每个地区构造 relative_time；did 必须和 year>=time 一致，从未处理组设为 -inf。确认后继续 DID2S。",
    ))

    expect(focus.requiredToolIDs).toContain("did2s")

    const denied = detectToolFocus(textParts("缺失编码仍需讨论，先不要继续 DID2S；请解释还缺什么信息。"))
    expect(denied.requiredToolIDs).not.toContain("did2s")
  })

  test("比较综合评价方法的区别不要求执行数据工具", () => {
    const focus = detectToolFocus(textParts("请比较熵权 TOPSIS 和 CRITIC 两种综合评价方法的区别。"))

    expect(focus.requiredToolIDs).toEqual([])

    const execution = detectToolFocus(textParts("请先分别执行 OLS 和面板固定效应回归，再比较两种估计结果。"))
    expect(execution.requiredToolIDs).toEqual(["ols_regression", "panel_fe_regression"])
  })

  test("明确要求基准 FE 后做异质性分析时两阶段都必须完成", () => {
    const requested = detectToolFocus(textParts(
      "请做面板固定效应回归，基准完成后再执行异质性分析，按省份对全部省份分组，报告全部组，只作条件关联解释。",
    ))
    expect(requested.requiredToolIDs).toEqual(["panel_fe_regression", "heterogeneity_runner"])

    const consultation = detectToolFocus(textParts("面板回归中的异质性分析是什么？先解释方法，不要运行。"))
    expect(consultation.requiredToolIDs).toEqual([])
  })

  test("把异质性请求说成进行或调用时仍建立完成门禁", () => {
    expect(detectToolFocus(textParts("请进行异质性分析。按省份分组并报告所有组。")).requiredToolIDs)
      .toEqual(["heterogeneity_runner"])
    expect(detectToolFocus(textParts("请调用异质性分析工具，基准完成后继续。")).requiredToolIDs)
      .toEqual(["heterogeneity_runner"])
    expect(detectToolFocus(textParts("请不要进行异质性分析，只解释方法。")).requiredToolIDs).toEqual([])
    expect(detectToolFocus(textParts("请不要调用异质性分析工具，只解释方法。")).requiredToolIDs).toEqual([])
    expect(detectToolFocus(textParts("请不要对异质性分析进行估计，只解释方法。")).requiredToolIDs).toEqual([])
    expect(detectToolFocus(textParts("不要对这份数据进行异质性分析，只解释方法。")).requiredToolIDs).toEqual([])
    expect(detectToolFocus(textParts("不允许对异质性分析执行工具，只解释方法。")).requiredToolIDs).toEqual([])
    expect(detectToolFocus(textParts("请勿对异质性分析调用工具，只解释方法。")).requiredToolIDs).toEqual([])
    expect(detectToolFocus(textParts("主效应不显著时进行异质性分析，并报告所有分组。")).requiredToolIDs)
      .toEqual(["heterogeneity_runner"])
    expect(detectToolFocus(textParts("请进行异质性分析，但不要执行，只解释方法。")).requiredToolIDs).toEqual([])
  })

  test("不估计处理效应不应撤销仅做 PSM 诊断的请求", () => {
    const focus = detectToolFocus(textParts(
      "只做 PSM 倾向得分诊断，处理变量=did，协变量=人口规模；暂不估计处理效应。",
    ))
    expect(focus.requiredToolIDs).toContain("psm_construction")
    expect(focus.requiredToolIDs).not.toContain("psm_matching")
    expect(focus.requiredToolIDs).not.toContain("psm_ipw")
  })

  test("不估计 ATT/ATE 仍应完成明确要求的 PSM 诊断和分布可视化", () => {
    const focus = detectToolFocus(textParts(
      "请只做倾向得分构造诊断和分布可视化，检查共同支撑，不估计 ATT/ATE 或作因果结论。",
    ))

    expect(focus.requiredToolIDs).toEqual(["psm_construction", "psm_visualize"])
    expect(focus.psmToolScope).toBe("diagnostics_only")
    expect(focus.preferredToolIDs).not.toContain("psm_matching")
    expect(focus.preferredToolIDs).not.toContain("psm_ipw")

    const explicitlyStopped = detectToolFocus(textParts(
      "请做倾向得分构造诊断和分布可视化，但不要执行诊断工具，只解释方法。",
    ))
    expect(explicitlyStopped.requiredToolIDs).toEqual([])

    const causalEffectWording = detectToolFocus(textParts(
      "只做 PSM 倾向得分构造诊断，不估计因果效应。",
    ))
    expect(causalEffectWording.requiredToolIDs).toContain("psm_construction")
    expect(causalEffectWording.psmToolScope).toBe("diagnostics_only")

    const deferredEstimator = detectToolFocus(textParts(
      "先只做倾向得分诊断，等我确认后再做 IPW。",
    ))
    expect(deferredEstimator.requiredToolIDs).toEqual(["psm_construction"])
    expect(deferredEstimator.psmToolScope).toBe("diagnostics_only")

    const explicitlyAuthorizedEstimator = detectToolFocus(textParts(
      "我确认后请执行 IPW 逆概率加权 ATE。",
    ))
    expect(explicitlyAuthorizedEstimator.requiredToolIDs).toEqual(["psm_ipw"])
    expect(explicitlyAuthorizedEstimator.psmToolScope).toBeUndefined()

    const authorizedDataFilter = detectToolFocus(textParts(
      "我确认按 year=2021 筛选，每个地区一行；继续刚才的诊断。",
    ))
    expect(authorizedDataFilter.psmScopeFilter).toEqual({ column: "year", value: 2021 })

    const deniedDataFilter = detectToolFocus(textParts(
      "不要筛选 year=2021；先告诉我影响。",
    ))
    expect(deniedDataFilter.psmScopeFilter).toBeUndefined()
    const deferredDataFilter = detectToolFocus(textParts(
      "先别按 year=2021 筛选，先告诉我影响。",
    ))
    expect(deferredDataFilter.psmScopeFilter).toBeUndefined()
  })

  test("前置否定和解释性提问不会要求执行 PSM 诊断", () => {
    const denied = detectToolFocus(textParts(
      "不要执行诊断工具，只解释倾向得分构造诊断和分布可视化的方法。",
    ))
    expect(denied.requiredToolIDs).toEqual([])
    expect(denied.psmToolScope).toBe("blocked")
    const deniedPool = resolveToolAvailability({
      policy: {
        ...basePolicy,
        inputIntent: "analysis",
        currentStage: "profile_or_diagnostics",
        ...denied,
      },
      toolIDs,
    })
    expect(deniedPool.bundle).not.toContain("psm_construction")
    expect(deniedPool.bundle).not.toContain("psm_visualize")
    expect(deniedPool.bundle).not.toContain("psm_matching")

    const deniedExplanation = detectToolFocus(textParts(
      "不要执行诊断工具；我只是想知道为什么有时只做倾向得分诊断，不估计 ATT？",
    ))
    expect(deniedExplanation.requiredToolIDs).toEqual([])
    expect(deniedExplanation.psmToolScope).toBe("blocked")

    const consultative = detectToolFocus(textParts(
      "请解释不估计 ATT/ATE 或作因果结论时，为什么仍然需要倾向得分诊断和分布可视化？",
    ))
    expect(consultative.requiredToolIDs).toEqual([])
    expect(consultative.psmToolScope).toBe("blocked")
    const consultativePool = resolveToolAvailability({
      policy: {
        ...basePolicy,
        inputIntent: "analysis",
        currentStage: "profile_or_diagnostics",
        ...consultative,
      },
      toolIDs,
    })
    expect(consultativePool.bundle).not.toContain("psm_construction")
    expect(consultativePool.bundle).not.toContain("psm_visualize")
    expect(consultativePool.bundle).not.toContain("psm_matching")
  })

  test("解释固定效应下的条件关联且不换方法仍保留 HDFE 完成门禁", () => {
    const focus = detectToolFocus(textParts(
      "请对地区年度面板做高维固定效应回归，吸收地区和 year 固定效应。只解释在这些固定效应下的条件关联，不称为因果效应，也不要换成其他方法。",
    ))

    expect(focus.requiredToolIDs).toEqual(["hdfe_regression"])
  })

  test("修复池保留失败工具和最小修复手段，但不恢复完整估计器池", () => {
    const available = resolveToolAvailability({
      policy: {
        ...basePolicy,
        inputIntent: "repair",
        currentStageStatus: "failed",
        repairOnly: true,
        repairToolName: "psm_ipw",
      },
      toolIDs,
    })

    expect(available.directToolIDs).toEqual(expect.arrayContaining([
      "question", "read", "pipeline", "tool_search", "data_import", "data_preprocess",
      "econometrics_recommend", "psm_ipw",
    ]))
    expect(available.directToolIDs).not.toContain("did2s")
    expect(available.directToolIDs).not.toContain("ols_regression")
    expect(available.directToolIDs?.length).toBeLessThanOrEqual(18)
  })

  test("修复期间仍保留同一用户请求中明确指定的其他方法，等待失败方法完成后再顺序执行", () => {
    const available = resolveToolAvailability({
      policy: {
        ...basePolicy,
        inputIntent: "repair",
        currentStageStatus: "failed",
        repairOnly: true,
        repairToolName: "ols_regression",
        preferredToolIDs: ["ols_regression", "panel_fe_regression"],
      },
      toolIDs,
    })

    expect(available.directToolIDs).toEqual(expect.arrayContaining([
      "ols_regression",
      "panel_fe_regression",
      "econometrics_execute",
    ]))
  })

  test("状态查询也保留完整系统工具面，计量方法仍不直出", () => {
    const available = resolveToolAvailability({
      policy: { ...basePolicy, inputIntent: "status", currentStage: "baseline_estimate" },
      toolIDs,
    })
    expect(available.directToolIDs).toEqual(expect.arrayContaining([
      "question", "read", "list", "glob", "grep", "skill", "pipeline", "tool_search",
      "data_import", "data_preprocess", "econometrics_recommend",
    ]))
    expect(available.directToolIDs).not.toContain("ols_regression")
  })

  test("普通对话每轮仍暴露系统工具，但不预装任何具体计量方法", () => {
    const available = resolveToolAvailability({
      policy: { ...basePolicy, inputIntent: "conversation", currentStage: undefined },
      toolIDs,
    })

    expect(available.directToolIDs).toEqual(expect.arrayContaining([
      "question", "read", "list", "glob", "grep", "pipeline", "tool_search", "data_import", "econometrics_recommend",
    ]))
    expect(available.directToolIDs).not.toContain("ols_regression")
    expect(available.directToolIDs).not.toContain("did_static")
  })

  test("task 只有在用户明确要求委派时才作为普通工具进入池", () => {
    const normal = resolveToolAvailability({ policy: { ...basePolicy, ...detectToolFocus(textParts("分析这份面板数据")) }, toolIDs })
    const delegated = resolveToolAvailability({ policy: { ...basePolicy, ...detectToolFocus(textParts("请让子 Agent 分头检查数据和模型")) }, toolIDs })

    expect(normal.directToolIDs).not.toContain("task")
    expect(delegated.directToolIDs).toContain("task")
  })

  test("明确委派在工作流尚未建立时也能使用 task，不要求切换模式", () => {
    const focus = detectToolFocus(textParts("请让子代理分头检查两个数据文件"))
    const available = resolveToolAvailability({
      policy: { ...basePolicy, currentStage: undefined, ...focus },
      toolIDs,
    })
    expect(available.directToolIDs).toContain("task")
  })

  test("真实意图链允许委派数据检查，但否定委派不会暴露 task", () => {
    const delegatedParts = textParts("请让子代理分头检查两个 Excel 数据文件")
    const delegated = resolveToolAvailability({
      policy: {
        ...basePolicy,
        currentStage: undefined,
        inputIntent: detectInputIntent(delegatedParts),
        ...detectToolFocus(delegatedParts),
      },
      toolIDs,
    })
    expect(delegated.policy.inputIntent).toBe("ingest")
    expect(delegated.directToolIDs).toContain("task")

    const deniedParts = textParts("不要使用子 agent，直接检查数据")
    const denied = resolveToolAvailability({
      policy: {
        ...basePolicy,
        currentStage: undefined,
        inputIntent: detectInputIntent(deniedParts),
        ...detectToolFocus(deniedParts),
      },
      toolIDs,
    })
    expect(denied.directToolIDs).not.toContain("task")
  })
})

/**
 * 客户端以 data URL 内联附件时，file part 的 url 是一大段无空白的 base64。
 * 它曾被直接拼进方法关键词文本，触发剥离文件引用那条正则的灾难性回溯
 * （`[^\s，,;；、]*` 在无空白输入上退化为 O(n²)），Core 因此在 prompt 派发阶段
 * 100% CPU 空转、永不返回——客户端表现为"发送带数据的问题后一直转圈"。
 */
describe("detectToolFocus 对内联附件的处理", () => {
  test("不会被 data URL 附件拖入灾难性回溯", () => {
    // 1 MB 无空白 base64，触发回溯所需的规模；修复前此调用不会返回。
    const base64 = "QUJDRA".repeat(180_000)
    const parts = [
      { type: "file", filename: "gf.xlsx", url: `data:application/vnd.ms-excel;base64,${base64}` },
      { type: "text", text: "导入这份数据并给出描述统计" },
    ] as PromptInput["parts"]

    const start = Date.now()
    const focus = detectToolFocus(parts)
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(1_000)
    // base64 噪音也不该被当成方法线索。
    expect(focus.preferredToolIDs ?? []).toEqual([])
  })

  test("仍从可读的文件路径引用中提取线索", () => {
    const parts = [
      { type: "file", filename: "panel.xlsx", url: "/tmp/killstata/panel.xlsx" },
      { type: "text", text: "用双重差分估计政策效应" },
    ] as PromptInput["parts"]

    expect(detectToolFocus(parts).preferredToolIDs).toContain("did_static")
  })
})

describe("detectToolFocus 对多方法任务的完成要求", () => {
  test("先后比较OLS与面板FE时记录两个必须实际执行的方法", () => {
    const parts = textParts("先跑个 OLS，然后换成双向固定效应面板再跑一次")
    expect(detectToolFocus(parts).requiredToolIDs).toEqual(["ols_regression", "panel_fe_regression"])
  })

  test("用户表达二选一时不把两个方法误设为必做", () => {
    const parts = textParts("OLS 或双向固定效应面板，选择适合当前数据的一种即可")
    expect(detectToolFocus(parts).requiredToolIDs).toEqual([])
  })

  test("用户明确拒绝继续剩余 Panel FE 时不能再次要求或授权执行", () => {
    const declined = detectToolFocus(textParts("OLS 已完成，我不继续面板固定效应回归，只保留当前结果。"))
    expect(declined.requiredToolIDs).toEqual([])

    const continued = detectToolFocus(textParts("我确认继续执行面板固定效应回归。"))
    expect(continued.requiredToolIDs).toEqual(["panel_fe_regression"])

    const refusedDataRepairButContinuesMethod = detectToolFocus(textParts("拒绝自动清洗，但继续执行 Panel FE 回归。"))
    expect(refusedDataRepairButContinuesMethod.requiredToolIDs).toEqual(["panel_fe_regression"])
  })
})

describe("detectToolFocus 对单方法执行请求的完成要求", () => {
  test("明确要求做 OLS 回归时记录必须完成的方法", () => {
    const parts = textParts(
      "导入 did.xlsx 做 OLS 回归：因变量=创新指数，核心解释变量=高质量发展指数；检查数据质量但不自动清洗。",
    )
    expect(detectToolFocus(parts).requiredToolIDs).toEqual(["ols_regression"])
  })

  test("用户要求条件满足后执行 OLS 时仍记录必须完成的方法", () => {
    const parts = textParts("如果数据条件适合就做 OLS 回归。")
    expect(detectToolFocus(parts).requiredToolIDs).toEqual(["ols_regression"])
  })

  test("询问 OLS 是否适合时不建立估计完成门禁", () => {
    const parts = textParts("这份数据适合做 OLS 回归吗？先告诉我建议，不要开始估计。")
    expect(detectToolFocus(parts).requiredToolIDs).toEqual([])
  })

  test("明确否定 OLS 时不建立估计完成门禁", () => {
    const parts = textParts("不要执行 OLS 回归，只检查这份数据的质量。")
    expect(detectToolFocus(parts).requiredToolIDs).toEqual([])
  })

  test("询问 OLS 概念时不建立估计完成门禁", () => {
    const parts = textParts("OLS 回归是什么？")
    expect(detectToolFocus(parts).requiredToolIDs).toEqual([])
  })

  test("询问如何使用 OLS 时不建立估计完成门禁", () => {
    const parts = textParts("如何用 OLS 回归？")
    expect(detectToolFocus(parts).requiredToolIDs).toEqual([])
  })

  test("表达不想执行 OLS 时不建立估计完成门禁", () => {
    const parts = textParts("我不想跑 OLS 回归，只解释它的适用条件。")
    expect(detectToolFocus(parts).requiredToolIDs).toEqual([])
  })

  test("咨询随机效应是否适用时不建立估计完成门禁", () => {
    expect(detectToolFocus(textParts("随机效应适合这份数据吗？先分析适用条件。")).requiredToolIDs).toEqual([])
  })

  test("只提泛 DID 或 RDD 时不擅自锁定具体估计器", () => {
    expect(detectToolFocus(textParts("这份数据做 DID 还是 RDD 更合适？先给我建议。")).requiredToolIDs).toEqual([])
  })

  test("Excel/CSV 路径后紧接中文句号时仍保留执行意图", () => {
    const focus = detectToolFocus(textParts(
      "导入 /tmp/rdrobust_senate.csv。请执行公开示例的锐性断点回归，结果变量=vote，运行变量=margin，断点=0。",
    ))
    expect(focus.preferredToolIDs).toContain("rdd_sharp")
    expect(focus.requiredToolIDs).toEqual(["rdd_sharp"])
  })

  test("文件路径后的明确否定仍不会建立估计完成门禁", () => {
    const focus = detectToolFocus(textParts(
      "导入 /tmp/rdrobust_senate.csv。不要执行锐性断点回归，只检查 vote 的数据类型。",
    ))
    expect(focus.requiredToolIDs).toEqual([])
  })

  test("2SLS 和用户明确要求的工具变量诊断都进入同一请求授权", () => {
    const focus = detectToolFocus(textParts(
      "请先做 2SLS，再报告工具变量强度、内生性和过度识别诊断；不要把诊断说成排除限制已获证明。",
    ))

    expect(focus.requiredToolIDs).toEqual(["iv_2sls", "iv_test"])
  })

  const explicitMethodRequests: Array<[string, string]> = [
    ["panel_random_effects", "请做随机效应面板回归"],
    ["hdfe_regression", "请做高维固定效应 HDFE 回归"],
    ["iv_2sls", "请执行两阶段最小二乘 2SLS"],
    ["iv_test", "请执行弱工具检验"],
    ["did_static", "请用传统两组两期 DID 估计政策前后关系"],
    ["did2s", "请做 Gardner 两阶段 DID"],
    ["did_event_study_saturated", "请执行事件研究法"],
    ["psm_construction", "请构造倾向得分并检查重叠"],
    ["psm_visualize", "请绘制共同支撑图"],
    ["psm_matching", "请复现官方样本的倾向得分最近邻匹配 ATT"],
    ["psm_ipw", "请执行 IPW 逆概率加权 ATE"],
    ["psm_regression", "请执行倾向得分回归调整 ATE"],
    ["psm_double_robust", "请执行 AIPW 双重稳健 ATE"],
    ["logit_regression", "请仅保留 year=2021 横截面，用 Logit 分析地区是否属于曾处理组"],
    ["probit_regression", "请用 Probit 描述这个二元结果与创新指数的关系"],
    ["poisson_regression", "我明确要求 Poisson 回归"],
    ["negbin_regression", "请执行负二项回归"],
    ["quantile_regression", "请做分位数回归"],
    ["rdd_sharp", "请执行公开 rdrobust Senate 示例的锐性断点回归"],
    ["rdd_fuzzy", "请做模糊断点回归"],
    ["multinomial_logit", "请做多项 Logit 回归"],
    ["robust_regression", "请做 M 估计稳健回归"],
    ["wls_regression", "我明确要求 WLS，若无可信权重请先停下来说明"],
  ]

  for (const [methodID, prompt] of explicitMethodRequests) {
    test(`明确请求 ${methodID} 时建立对应的完成门禁`, () => {
      expect(detectToolFocus(textParts(prompt)).requiredToolIDs).toEqual([methodID])
    })
  }
})
