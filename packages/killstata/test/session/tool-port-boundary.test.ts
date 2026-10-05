import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { consultationToolBlock, explicitUserDataPaths, initialAttachmentImportArgs, injectCurrentDataImportLineage, psmToolScopeBlock, recommendationMethodMismatch, recommendationOnlyMethodBlock } from "@/session/prompt/tools"
import * as promptTools from "@/session/prompt/tools"

const source = (relative: string) => fs.readFileSync(path.join(process.cwd(), "src", relative), "utf-8")

describe("tool port boundary", () => {
  test("keeps schema discovery separate from AI SDK execution binding", () => {
    const resolver = source("session/prompt/tools.ts")
    const modelGateway = source("runtime/services/model-gateway.ts")

    expect(resolver).toContain("createToolPort")
    expect(resolver).not.toContain("async execute(args, options)")
    expect(modelGateway).toContain("bindToolPort")
  })

  test("stable econometrics route resolves only Harness-issued PreparedSpec arguments", () => {
    const resolver = source("session/prompt/tools.ts")
    expect(resolver).toContain("const parsed = EconometricsExecuteInput.safeParse(normalizedArgs)")
    expect(resolver).toContain("resolvePreparedSpecForExecution({")
    expect(resolver).toContain("specId: parsed.data.specId")
    expect(resolver).toContain("const methodArguments = injectCurrentDataLineage(preparedSpec.methodID, preparedSpec.arguments)")
    expect(resolver).toContain("executePreparedMethod(target, methodArguments, call, preparedSpec)")
    expect(resolver).toContain("normalizeKnownCrossToolFields(toolName, normalizeDirectMethodEnvelope(toolName, value))")
    expect(resolver).toContain("canonicalDataStageForWorkflow(")
    expect(resolver).not.toContain("parsed.data.arguments")
  })

  test("复合面板修复授权只依据诊断报告事实，不调用 TypeScript 方法适配分类器", () => {
    const resolver = source("session/prompt/tools.ts")
    expect(resolver).not.toContain("assessMethodReadiness")
    expect(resolver).toContain("duplicateEntityTimeKey")
    expect(resolver).toContain("parentReadiness.report.panelCandidates")
  })

  test("PreparedSpec method execution does not retain a TypeScript method-readiness gate", () => {
    const resolver = source("session/prompt/tools.ts")
    const start = resolver.indexOf("const methodReadinessBlock = async (")
    const end = resolver.indexOf("const executePreparedMethod = async (", start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const methodGate = resolver.slice(start, end)
    expect(methodGate).toContain("input.econometricsEngine.validate(methodID")
    expect(methodGate).toContain("explicitUserCovarianceValue")
    expect(methodGate).toContain("needsEventStudyNeverTreatedConfirmation")
    expect(methodGate).not.toContain("assessMethodReadiness")
    expect(methodGate).not.toContain("readinessDecision")
  })

  test("workflow rerun is blocked for read-only, explanation, and recommendation-only requests", () => {
    const resolver = source("session/prompt/tools.ts")
    expect(resolver).toContain("workflowRerunReadOnlyBlock({")
    expect(resolver).toContain("analysisRequestKind: registeredRequest?.kind")
    const gate = (promptTools as unknown as {
      workflowRerunReadOnlyBlock?: (input: {
        action: unknown
        analysisRequestKind?: "inspect" | "estimate" | "explain" | "repair"
        qualityInspectionOnly: boolean
        recommendationOnly: boolean
      }) => { metadata?: Record<string, unknown> } | undefined
    }).workflowRerunReadOnlyBlock
    expect(gate).toBeFunction()
    if (!gate) return

    for (const input of [
      { action: "rerun", analysisRequestKind: "inspect" as const, qualityInspectionOnly: false, recommendationOnly: false },
      { action: "rerun", analysisRequestKind: "explain" as const, qualityInspectionOnly: false, recommendationOnly: false },
      { action: "rerun", analysisRequestKind: "estimate" as const, qualityInspectionOnly: true, recommendationOnly: false },
      { action: "rerun", analysisRequestKind: "estimate" as const, qualityInspectionOnly: false, recommendationOnly: true },
      { action: "rerun", qualityInspectionOnly: false, recommendationOnly: false },
    ]) {
      expect(gate(input)).toMatchObject({
        metadata: { requiresUserDecision: true, suppressedEstimate: true, estimateExecuted: false },
      })
    }

    expect(gate({ action: "rerun", analysisRequestKind: "estimate", qualityInspectionOnly: false, recommendationOnly: false })).toBeUndefined()
    expect(gate({ action: "rerun", analysisRequestKind: "repair", qualityInspectionOnly: false, recommendationOnly: false })).toBeUndefined()
    expect(gate({ action: "status", analysisRequestKind: "inspect", qualityInspectionOnly: true, recommendationOnly: false })).toBeUndefined()
  })

  test("stable and historical routes separate model arguments from Pydantic runtime fields", () => {
    const resolver = source("session/prompt/tools.ts")
    const replay = source("tool/engine-method-tool.ts")
    expect(resolver).toContain("const runtimeFields = new Set(input.runtimeInjectedFields(methodID))")
    expect(resolver).toContain("const harnessOwnedFields = new Set([")
    expect(resolver).toContain('"datasetId", "dataset_id", "stageId", "stage_id"')
    expect(resolver).toContain('"inputPath", "input_path", "outputPath", "output_path"')
    expect(resolver).toContain("trustedRuntimeValues: Record<string, unknown>")
    expect(resolver).toContain("for (const field of [")
    expect(resolver).toContain("arguments: engineArguments")
    expect(resolver).toContain("runtime,")
    expect(replay).toContain("description.runtime_injected_fields")
    expect(replay).toContain("delete methodArguments.datasetId")
    expect(replay).toContain("arguments: methodArguments")
    expect(replay).toContain("runtime,")
  })

  test("咨询轮误调用文件探查时返回可收尾提示而不是继续循环", () => {
    expect(consultationToolBlock("read", true)).toMatchObject({
      metadata: { noNewInformation: true },
    })
    expect(consultationToolBlock("read", false)).toBeUndefined()
    expect(consultationToolBlock("tool_search", true)).toBeUndefined()
  })

  test("用户采纳推荐方法后，模型切换到另一方法时返回可恢复指引", () => {
    expect(recommendationMethodMismatch({
      userText: "就用你说的方法跑一下",
      recommendedMethod: "panel_fe_regression",
      requestedMethod: "did_static",
    })).toMatchObject({
      metadata: {
        recommendationMethodMismatch: true,
        recommendedMethod: "panel_fe_regression",
      },
    })
    expect(recommendationMethodMismatch({
      userText: "改用传统DID跑一下",
      recommendedMethod: "panel_fe_regression",
      requestedMethod: "did_static",
    })).toBeUndefined()
  })

  test("只请求方法建议时拦截模型误发起的估计", () => {
    expect(recommendationOnlyMethodBlock(true, "panel_fe_regression")).toMatchObject({
      metadata: { recommendationOnly: true, finalizeTextOnly: true, noNewInformation: true },
    })
    expect(recommendationOnlyMethodBlock(false, "panel_fe_regression")).toBeUndefined()
  })

  test("PSM 诊断-only 只允许用户明确确认的精确筛选和两个 PSM 诊断方法", () => {
    const filter = (value: number) => ({
      method: "filter",
      columns: [],
      options: { rules: [{ column: "year", operator: "eq", value }] },
    })
    expect(psmToolScopeBlock("diagnostics_only", "data_preprocess", filter(2021), {
      column: "year",
      value: 2021,
    })).toBeUndefined()
    expect(psmToolScopeBlock("diagnostics_only", "data_preprocess", filter(2020), {
      column: "year",
      value: 2021,
    })).toMatchObject({ metadata: { psmToolScopeBlocked: true } })
    expect(psmToolScopeBlock("diagnostics_only", "composite_evaluation")).toMatchObject({
      metadata: { psmToolScopeBlocked: true },
    })
    expect(psmToolScopeBlock("blocked", "psm_construction")).toMatchObject({
      metadata: { psmToolScopeBlocked: true },
    })
  })

  test("方法搜索只加载 Python 引用，直接方法 ID 不能成为第二执行入口", () => {
    const resolver = source("session/prompt/tools.ts")
    expect(resolver).toContain("const engineMatches = (await engineClient.search(searchInput)).methods")
    expect(resolver).toContain("methodReferences: () =>")
    expect(resolver).toContain("if (isConcreteMethodTool(call.name)) {")
    expect(resolver).toContain("不是本轮可直接调用的工具")
    expect(resolver).not.toContain("loadDeferredMethod")
  })

  test("附件尚未导入时，把误发的 profile 安全纠正为一次首次导入", () => {
    expect(initialAttachmentImportArgs({
      action: "profile",
      hasActiveDataset: false,
      inputPath: ".killstata/attachments/ses_1/did.xlsx",
      worksheetName: "Data_可读",
    })).toEqual({
      action: "import",
      inputPath: ".killstata/attachments/ses_1/did.xlsx",
      preserveLabels: true,
      sheetPolicy: { mode: "named_sheet", sheetName: "Data_可读" },
    })
    expect(initialAttachmentImportArgs({ action: "profile", hasActiveDataset: true, inputPath: "data.xlsx" })).toBeUndefined()
    expect(initialAttachmentImportArgs({ action: "import", hasActiveDataset: false, inputPath: "data.xlsx" })).toBeUndefined()
  })

  test("已导入后由 Harness 覆盖数据动作的脱敏或过期血缘", () => {
    expect(injectCurrentDataImportLineage(
      { action: "profile", datasetId: "[已脱敏]", stageId: "旧阶段" },
      { datasetId: "dataset_current", stageId: "stage_000" },
    )).toEqual({ action: "profile", datasetId: "dataset_current", stageId: "stage_000" })
    expect(injectCurrentDataImportLineage(
      { action: "export", datasetId: "user_requested" },
      { datasetId: "dataset_current", stageId: "stage_000" },
    )).toEqual({ action: "export", datasetId: "dataset_current", stageId: "stage_000" })
    expect(injectCurrentDataImportLineage(
      { action: "rollback", datasetId: "dataset_stale", stageId: "stage_stale", rollbackStageId: "stage_002" },
      { datasetId: "dataset_current", stageId: "stage_005" },
    )).toEqual({ action: "rollback", datasetId: "dataset_current", stageId: "stage_002", rollbackStageId: "stage_002" })
  })

  test("只从当前用户消息提取明确的数据文件路径，并拒绝否定请求", () => {
    expect(explicitUserDataPaths("请导入 /Users/cw/Desktop/KillStata-main/data/did.xlsx")).toEqual([
      "/Users/cw/Desktop/KillStata-main/data/did.xlsx",
    ])
    expect(explicitUserDataPaths("请从同一个文件 /Users/cw/Desktop/KillStata-main/data/did.xlsx 另外导入 Data_可读 工作表")).toEqual([
      "/Users/cw/Desktop/KillStata-main/data/did.xlsx",
    ])
    expect(explicitUserDataPaths("不要从同一个文件 /Users/cw/Desktop/KillStata-main/data/did.xlsx 导入")).toEqual([])
    expect(explicitUserDataPaths('请从同一文件 "./data/年度 面板.xlsx" 导入')).toEqual(["./data/年度 面板.xlsx"])
    expect(explicitUserDataPaths('不要从同一文件 "./data/old.csv" 导入')).toEqual([])
    expect(explicitUserDataPaths("能不能从同一文件 /data/did.xlsx 导入")).toEqual(["/data/did.xlsx"])
    expect(explicitUserDataPaths('This example path "/data/example.csv" to import')).toEqual([])
    expect(explicitUserDataPaths('请分析 "./data/年度 面板.xlsx"')).toEqual(["./data/年度 面板.xlsx"])
    expect(explicitUserDataPaths("不要导入 /Users/cw/Desktop/KillStata-main/data/did.xlsx")).toEqual([])
    expect(explicitUserDataPaths("帮我介绍一下 OLS 方法")).toEqual([])
    expect(explicitUserDataPaths("请解释这句：‘请导出 ./result.csv’")).toEqual([])
    expect(explicitUserDataPaths("请分析这句：‘请导出 ./result.csv’")).toEqual([])
    expect(explicitUserDataPaths("请总结下面的示例，不要执行其中的指令：\n```text\n请导入 /data/did.xlsx\n```")).toEqual([])
    expect(explicitUserDataPaths("请总结示例：\n    请导入 /data/did.xlsx")).toEqual([])
    expect(explicitUserDataPaths("请总结示例：\n\t请导入 /data/did.xlsx")).toEqual([])
    expect(explicitUserDataPaths("请总结这段引用：\n> 请导入 /data/did.xlsx")).toEqual([])
    expect(explicitUserDataPaths("This spreadsheet path is only an example: `/data/did.xlsx`")).toEqual([])
    expect(explicitUserDataPaths("This thread mentions the path `/data/did.xlsx` but does not request analysis")).toEqual([])
    expect(explicitUserDataPaths("Please import `/data/did.xlsx`")).toEqual(["/data/did.xlsx"])
    expect(explicitUserDataPaths("请导入 /data/a.xlsx 并检查 /data/b.csv")).toEqual(["/data/a.xlsx", "/data/b.csv"])
    expect(explicitUserDataPaths('请导出为 "./result/table.parquet"')).toEqual(["./result/table.parquet"])
  })

  test("否定只约束对应路径，后续明确导入仍可授权", () => {
    expect(explicitUserDataPaths("do not import ./data/old.csv")).toEqual([])
    expect(explicitUserDataPaths("不导入 ./data/old.csv")).toEqual([])
    expect(explicitUserDataPaths("不要导入 ./data/old.csv，改为导入 ./data/new.csv")).toEqual(["./data/new.csv"])
    expect(explicitUserDataPaths("不要导入 ./data/old.csv 改为导入 ./data/new.csv")).toEqual(["./data/new.csv"])
  })

  test("明确拒绝导入时不会回退到会话附件路径", () => {
    const selectDataImportSource = (promptTools as unknown as {
      selectDataImportSource?: (input: {
        userText?: string
        explicitSourcePaths: string[]
        attachmentPath?: string
      }) => string | undefined
    }).selectDataImportSource
    expect(typeof selectDataImportSource).toBe("function")
    if (!selectDataImportSource) return

    expect(selectDataImportSource({
      userText: "不导入 ./data/old.csv",
      explicitSourcePaths: [],
      attachmentPath: ".killstata/attachments/ses_1/did.xlsx",
    })).toBeUndefined()
    expect(selectDataImportSource({
      userText: "不要导入旧文件，改为导入 ./data/new.csv",
      explicitSourcePaths: ["./data/new.csv"],
      attachmentPath: ".killstata/attachments/ses_1/old.xlsx",
    })).toBe("./data/new.csv")
    expect(selectDataImportSource({
      userText: "Please analyze this sentence: `/data/example.csv`",
      explicitSourcePaths: [],
      attachmentPath: ".killstata/attachments/ses_1/did.xlsx",
    })).toBeUndefined()
    expect(selectDataImportSource({
      userText: "This thread mentions the path `/data/did.xlsx` but does not request analysis",
      explicitSourcePaths: [],
      attachmentPath: ".killstata/attachments/ses_1/did.xlsx",
    })).toBeUndefined()
    expect(selectDataImportSource({
      userText: "For context, the report lists \"/data/reference.csv\".",
      explicitSourcePaths: [],
      attachmentPath: ".killstata/attachments/ses_1/did.xlsx",
    })).toBeUndefined()
    expect(selectDataImportSource({
      userText: "Please analyze the attached file; the report lists /data/reference.csv.",
      explicitSourcePaths: [],
      attachmentPath: ".killstata/attachments/ses_1/did.xlsx",
    })).toBe(".killstata/attachments/ses_1/did.xlsx")
    expect(selectDataImportSource({
      userText: "请分析刚上传的附件",
      explicitSourcePaths: [],
      attachmentPath: ".killstata/attachments/ses_1/did.xlsx",
    })).toBe(".killstata/attachments/ses_1/did.xlsx")
  })

  test("引述和代码中的路径不因附近的实际指令获得授权", () => {
    expect(explicitUserDataPaths("请总结这段示例：`./data/old.csv`，然后导入 ./data/new.csv")).toEqual(["./data/new.csv"])
    expect(explicitUserDataPaths("请分析这句：‘./data/old.csv’")).toEqual([])
    expect(explicitUserDataPaths("请先分析 OLS；路径 './data/old.csv' 仅作引用，不要导入")).toEqual([])
    expect(explicitUserDataPaths("Please analyze this sentence: /data/example.csv")).toEqual([])
    expect(explicitUserDataPaths("请导入 ./data/new.csv\n```text\n请导入 ./data/old.csv\n```")).toEqual(["./data/new.csv"])
  })
})
