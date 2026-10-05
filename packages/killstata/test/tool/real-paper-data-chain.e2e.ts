import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { resolveRuntimePythonCommand } from "@/killstata/runtime-config"
import { Instance } from "@/project/instance"
import { recordWorkflowStageSuccess } from "@/runtime/workflow"
import { DataImportTool } from "@/tool/data-import"
import { DataPreprocessTool } from "@/tool/data-preprocess"
import { EconometricsRecommendTool, PanelFeRegressionTool } from "../../../../trash/killstata-legacy-econometrics/tool/econometrics-method-tools"
import { HdfeRegressionTool } from "../../../../trash/killstata-legacy-econometrics/tool/pyfixest"
import {
  loadRealPaperDatasetContract,
  resolveRealPaperDatasets,
  verifyRealPaperDataset,
} from "../helpers/real-paper-datasets"

const ctx = {
  // 工具契约要求这些标识使用各自的前缀；无效 sessionID 会让导入产物无法
  // 关联到工作流，进而把后续真实数据问题伪装成“缺少画像/阶段未就绪”。
  sessionID: "ses_real_paper_data_chain",
  messageID: "msg_real_paper_data_chain",
  callID: "call_real_paper_data_chain",
  agent: "econometrics",
  abort: new AbortController().signal,
  metadata: async () => undefined,
  ask: async () => undefined,
}

const BASELINE_CONTROLS = [
  "人口密度",
  "金融发展程度",
  "城镇化水平",
  "产业结构整体升级",
  "产业结构高级化",
  "教育水平支出",
  "人力资本",
] as const

async function requireRealEconometricsRuntime() {
  // runtime-config 会从 Instance 读取项目级 Python 配置；测试原先在
  // withTempProject 之前调用它，导致“缺少 Instance 上下文”而非真正检查依赖。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-real-paper-python-"))
  try {
    return await Instance.provide({
      directory: root,
      fn: async () => {
        const python = await resolveRuntimePythonCommand()
        execFileSync(python, ["-c", "import pandas, pyarrow, linearmodels, pyfixest"], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        })
        return python
      },
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function withTempProject<T>(fn: (root: string) => Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-real-paper-"))
  try {
    return await Instance.provide({ directory: root, fn: async () => fn(root) })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function inspectImportedDidPanel(python: string, parquetPath: string) {
  const script = String.raw`
import json
import sys

import pandas as pd

df = pd.read_parquet(sys.argv[1]).sort_values(["city", "year"])
did = pd.to_numeric(df["did"], errors="raise")
cohorts = (
    df.loc[did.eq(1)]
    .groupby("city", sort=True)["year"]
    .min()
    .value_counts()
    .sort_index()
)
time_as_number = pd.to_numeric(df["time"], errors="coerce")
summary = {
    "rows": int(len(df)),
    "entities": int(df["city"].nunique()),
    "periods": int(df["year"].nunique()),
    "balanced": bool(df.groupby("city").size().eq(df["year"].nunique()).all()),
    "duplicateEntityTimeRows": int(df.duplicated(["city", "year"]).sum()),
    "didValues": sorted(int(value) for value in did.unique()),
    "treatedRows": int(did.sum()),
    "everTreated": int(did.groupby(df["city"]).max().sum()),
    "neverTreated": int(did.groupby(df["city"]).max().eq(0).sum()),
    "treatmentReversals": int(did.groupby(df["city"]).diff().lt(0).sum()),
    "cohortCounts": {str(int(year)): int(count) for year, count in cohorts.items()},
    "importedMissingCohortRows": int(time_as_number.isna().sum()),
    "numericCohorts": sorted(int(value) for value in time_as_number.dropna().unique()),
}
print(json.dumps(summary, ensure_ascii=False))
`
  return JSON.parse(
    execFileSync(python, ["-c", script, parquetPath], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ) as {
    rows: number
    entities: number
    periods: number
    balanced: boolean
    duplicateEntityTimeRows: number
    didValues: number[]
    treatedRows: number
    everTreated: number
    neverTreated: number
    treatmentReversals: number
    cohortCounts: Record<string, number>
    importedMissingCohortRows: number
    numericCohorts: number[]
  }
}

function loadBackendCalibration() {
  const filePath = path.resolve(process.cwd(), "..", "..", "test", "real-paper-chain", "backend-results.json")
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
    sourceHashes: Record<string, string>
    panelFe: {
      results: Array<{
        kind: string
        outcome: string
        coefficient: number
        stdError: number
        pValue: number
        rowsUsed: number
      }>
    }
    hdfeCrosscheck: {
      coefficient: number
      stdError: number
      pValue: number
      rowsUsed: number
      coefficientGapVsPanelFe: number
    }
    digitalPanelFe: {
      coefficient: number
      stdError: number
      pValue: number
      rowsUsed: number
      clusterVar: string
    }
  }
}

describe("real paper Excel chain", () => {
  test("locks both source workbooks by SHA-256 before analysis", () => {
    const contract = loadRealPaperDatasetContract()
    const files = resolveRealPaperDatasets()

    expect(() => verifyRealPaperDataset(files.didPath, contract.did.sha256)).not.toThrow()
    expect(() => verifyRealPaperDataset(files.digitalPath, contract.digital.sha256)).not.toThrow()
  })

  test("imports the declared sheets without losing Chinese columns", async () => {
    await requireRealEconometricsRuntime()
    const contract = loadRealPaperDatasetContract()
    const files = resolveRealPaperDatasets()

    await withTempProject(async (root) => {
      const tool = await DataImportTool.init()
      for (const source of [
        { path: files.didPath, contract: contract.did },
        { path: files.digitalPath, contract: contract.digital },
      ]) {
        const imported = await tool.execute(
          {
            action: "import",
            preserveLabels: true,
            inputPath: source.path,
            sheetPolicy: { mode: "named_sheet", sheetName: source.contract.sheet },
          },
          ctx as never,
        )
        expect(imported.metadata.result?.rows_after).toBe(source.contract.rows)
        expect(imported.metadata.result?.columns_after).toBe(source.contract.columns)
        const schemaPath = imported.metadata.result?.schema_path
        expect(typeof schemaPath).toBe("string")
        const schema = JSON.parse(fs.readFileSync(path.resolve(root, schemaPath!), "utf-8")) as {
          schema: Array<{ name: string }>
        }
        const names = schema.schema.map((column) => column.name)
        expect(names).toEqual(source.contract.headers)
      }
    })
  }, 120_000)

  test("QA accepts the true DID panel key and blocks the ambiguous digital key", async () => {
    await requireRealEconometricsRuntime()
    const contract = loadRealPaperDatasetContract()
    const files = resolveRealPaperDatasets()

    await withTempProject(async () => {
      const dataImport = await DataImportTool.init()
      const recommend = await EconometricsRecommendTool.init()

      const didImport = await dataImport.execute(
        {
          action: "import",
          preserveLabels: true,
          inputPath: files.didPath,
          sheetPolicy: { mode: "named_sheet", sheetName: contract.did.sheet },
        },
        ctx as never,
      )
      const didSource = { datasetId: didImport.metadata.datasetId!, stageId: didImport.metadata.stageId! }
      const didProfile = await recommend.execute(
        {
          ...didSource,
          dependentVar: "经济发展水平",
          treatmentVar: "did",
          entityVar: "city",
          timeVar: "year",
        },
        ctx as never,
      )
      expect(didProfile.metadata.profile?.dataStructure).toBe("panel")
      expect(didProfile.output).toContain("面板数据")
      expect(didProfile.output).not.toContain("数据结构：panel")
      expect(didProfile.output).toContain("列名不能替代识别策略")
      expect(didProfile.metadata.analysisView).toMatchObject({
        kind: "econometrics",
        results: expect.arrayContaining([{ label: "数据结构", value: "面板数据" }]),
      })
      expect(didProfile.metadata.profile?.duplicatePanelKeys).toBe(contract.did.duplicateEntityTimeRows)
      const didQa = await dataImport.execute(
        {
          action: "validate",
          preserveLabels: true,
          ...didSource,
          entityVar: "city",
          timeVar: "year",
        },
        ctx as never,
      )
      expect(didQa.metadata.qaGateStatus).not.toBe("block")

      const digitalImport = await dataImport.execute(
        {
          action: "import",
          preserveLabels: true,
          inputPath: files.digitalPath,
          sheetPolicy: { mode: "named_sheet", sheetName: contract.digital.sheet },
        },
        ctx as never,
      )
      const digitalSource = { datasetId: digitalImport.metadata.datasetId!, stageId: digitalImport.metadata.stageId! }
      const digitalProfile = await recommend.execute(
        {
          ...digitalSource,
          dependentVar: "数字普惠金融指数",
          entityVar: "地区",
          timeVar: "年份",
        },
        ctx as never,
      )
      expect(digitalProfile.metadata.profile?.duplicatePanelKeys).toBe(contract.digital.duplicateEntityTimeRows)
      expect(digitalProfile.output).toContain("面板数据")
      expect(digitalProfile.output).toContain(`重复实体-时间键：${contract.digital.duplicateEntityTimeRows}`)
      expect(digitalProfile.output).toContain("面板固定效应估计前应先修复")
      expect(digitalProfile.metadata.analysisView).toMatchObject({
        results: expect.arrayContaining([{ label: "重复实体-时间键", value: String(contract.digital.duplicateEntityTimeRows) }]),
      })
      await expect(
        dataImport.execute(
          {
            action: "validate",
            preserveLabels: true,
            ...digitalSource,
            entityVar: "地区",
            timeVar: "年份",
          },
          ctx as never,
        ),
      ).rejects.toThrow(
        new RegExp(
          `数据动作被(?: QA 门禁| 数据质量检查)阻断：.*${contract.digital.duplicateEntityTimeRows} duplicate entity-time rows.*诊断记录`,
          "s",
        ),
      )
    })
  }, 180_000)

  test("preserves the staggered-DID design facts and exposes the imported missing-cohort representation", async () => {
    const python = await requireRealEconometricsRuntime()
    const contract = loadRealPaperDatasetContract()
    const files = resolveRealPaperDatasets()

    await withTempProject(async (root) => {
      const dataImport = await DataImportTool.init()
      const imported = await dataImport.execute(
        {
          action: "import",
          preserveLabels: true,
          inputPath: files.didPath,
          sheetPolicy: { mode: "named_sheet", sheetName: contract.did.sheet },
        },
        ctx as never,
      )
      const outputPath = imported.metadata.result?.output_path
      expect(typeof outputPath).toBe("string")
      const facts = inspectImportedDidPanel(python, path.resolve(root, outputPath!))

      expect(facts).toMatchObject({
        rows: contract.did.rows,
        entities: contract.did.entities,
        periods: contract.did.periods,
        balanced: true,
        duplicateEntityTimeRows: contract.did.duplicateEntityTimeRows,
        didValues: [0, 1],
        treatedRows: contract.did.treatedRows,
        everTreated: contract.did.everTreated,
        neverTreated: contract.did.neverTreated,
        treatmentReversals: 0,
        importedMissingCohortRows: contract.did.importedMissingCohortRows,
        numericCohorts: contract.did.cohorts,
      })
      expect(facts.cohortCounts).toEqual({ "2012": 32, "2013": 39, "2014": 27 })
    })
  }, 120_000)

  test("repairs the ambiguous regional key with an audited composite column before fixed-effects estimation", async () => {
    await requireRealEconometricsRuntime()
    const contract = loadRealPaperDatasetContract()
    const calibration = loadBackendCalibration()
    const files = resolveRealPaperDatasets()

    await withTempProject(async (root) => {
      const dataImport = await DataImportTool.init()
      const recommend = await EconometricsRecommendTool.init()
      const imported = await dataImport.execute(
        {
          action: "import",
          preserveLabels: true,
          inputPath: files.digitalPath,
          sheetPolicy: { mode: "named_sheet", sheetName: contract.digital.sheet },
        },
        ctx as never,
      )
      const importedSource = {
        datasetId: imported.metadata.datasetId!,
        stageId: imported.metadata.stageId!,
        runId: imported.metadata.runId,
      }
      // data_preprocess 的真实前置条件是当前会话已完成导入与画像；先记录这两步，
      // 再测试“复合实体键修复”，避免把测试夹具缺少工作流状态误报为工具故障。
      recordWorkflowStageSuccess({
        sessionID: ctx.sessionID,
        toolName: "data_import",
        args: { action: "import", ...importedSource },
        metadata: { action: "import", ...importedSource },
      })
      await recommend.execute(
        {
          datasetId: importedSource.datasetId,
          stageId: importedSource.stageId,
          dependentVar: "数字普惠金融指数",
          entityVar: "地区",
          timeVar: "年份",
        },
        ctx as never,
      )
      recordWorkflowStageSuccess({
        sessionID: ctx.sessionID,
        toolName: "econometrics_recommend",
        args: importedSource,
        metadata: importedSource,
      })
      const preprocessTool = await DataPreprocessTool.init()
      const repaired = await preprocessTool.execute(
        {
          datasetId: importedSource.datasetId,
          stageId: importedSource.stageId,
          method: "combine_columns",
          columns: ["省份", "地区"],
          options: { output_column: "省份_地区", separator: "_" },
        },
        { ...ctx, agent: "explorer" } as never,
      )
      const source = { datasetId: repaired.metadata.datasetId!, stageId: repaired.metadata.stageId! }
      const sourceWorkflow = { ...source, runId: repaired.metadata.runId }
      expect(source.datasetId).toBe(importedSource.datasetId)
      expect(source.stageId).not.toBe(importedSource.stageId)
      const r = repaired.metadata.result!
      expect(r.rowsAfter).toBe(contract.digital.rows)
      expect(r.columnsAfter).toBe(contract.digital.columns + 1)

      const parquetPath = path.resolve(root, r.outputPath!)
      const compositeFacts = JSON.parse(
        execFileSync(
          await resolveRuntimePythonCommand(),
          [
            "-c",
            [
              "import json, pandas as pd, sys",
              "df = pd.read_parquet(sys.argv[1])",
              "print(json.dumps({'entities': int(df['省份_地区'].nunique()), 'duplicates': int(df.duplicated(['省份_地区', '年份']).sum()), 'missing': int(df['省份_地区'].isna().sum())}))",
            ].join("; "),
            parquetPath,
          ],
          { encoding: "utf-8" },
        ),
      ) as { entities: number; duplicates: number; missing: number }
      expect(compositeFacts).toEqual({
        entities: contract.digital.compositeEntities,
        duplicates: 0,
        missing: 0,
      })

      recordWorkflowStageSuccess({
        sessionID: ctx.sessionID,
        toolName: "data_preprocess",
        args: { method: "combine_columns", ...sourceWorkflow },
        metadata: { method: "combine_columns", ...sourceWorkflow },
      })
      const profile = await recommend.execute(
        {
          datasetId: source.datasetId,
          stageId: source.stageId,
          dependentVar: "数字普惠金融指数",
          treatmentVar: "每百人互联网用户数",
          entityVar: "省份_地区",
          timeVar: "年份",
        },
        ctx as never,
      )
      expect(profile.metadata.profile?.duplicatePanelKeys).toBe(0)
      recordWorkflowStageSuccess({
        sessionID: ctx.sessionID,
        toolName: "econometrics_recommend",
        args: sourceWorkflow,
        metadata: sourceWorkflow,
      })
      const qa = await dataImport.execute(
        {
          action: "validate",
          preserveLabels: true,
          ...source,
          entityVar: "省份_地区",
          timeVar: "年份",
        },
        ctx as never,
      )
      expect(qa.metadata.qaGateStatus).not.toBe("block")
      recordWorkflowStageSuccess({
        sessionID: ctx.sessionID,
        toolName: "data_import",
        args: { action: "validate", ...sourceWorkflow },
        metadata: { action: "validate", ...sourceWorkflow, qaGateStatus: qa.metadata.qaGateStatus },
      })

      const panelFe = await PanelFeRegressionTool.init()
      const result = await panelFe.execute(
        {
          ...source,
          dependentVar: "数字普惠金融指数",
          treatmentVar: "每百人互联网用户数",
          covariates: ["计算机服务和软件从业人员占比", "人均电信业务总量", "每百人移动电话用户数"],
          entityVar: "省份_地区",
          timeVar: "年份",
          clusterVar: "省份_地区",
          covariance: "clustered",
        },
        ctx as never,
      )
      const backend = result.metadata.result!
      const primary = backend.primary!
      expect(backend.rowsUsed).toBe(contract.digital.rows)
      expect(backend.clusterVar).toBe("省份_地区")
      expect(backend.covariance).toBe("clustered")
      expect(Number.isFinite(primary.estimate)).toBe(true)
      expect(Number.isFinite(primary.stdError) && primary.stdError! > 0).toBe(true)
      expect(Number.isFinite(primary.pValue) && primary.pValue! >= 0 && primary.pValue! <= 1).toBe(true)
      expect(primary.estimate).toBeCloseTo(calibration.digitalPanelFe.coefficient, 7)
      expect(primary.stdError).toBeCloseTo(calibration.digitalPanelFe.stdError, 7)
      expect(primary.pValue).toBeCloseTo(calibration.digitalPanelFe.pValue, 7)
      expect(backend.rowsUsed).toBe(calibration.digitalPanelFe.rowsUsed)
      expect(backend.clusterVar).toBe(calibration.digitalPanelFe.clusterVar)
      expect(result.output).not.toContain(files.digitalPath)
      if (process.env.KILLSTATA_PRINT_REAL_PAPER_RESULTS === "1") {
        console.log(
          `REAL_PAPER_DIGITAL_RESULT=${JSON.stringify({
            coefficient: primary.estimate,
            stdError: primary.stdError,
            pValue: primary.pValue,
            rowsUsed: backend.rowsUsed,
            clusterVar: backend.clusterVar,
          })}`,
        )
      }
    })
  }, 240_000)

  test("runs the declared two-way FE baseline and cross-checks the point estimate with PyFixest HDFE", async () => {
    await requireRealEconometricsRuntime()
    const contract = loadRealPaperDatasetContract()
    const calibration = loadBackendCalibration()
    const files = resolveRealPaperDatasets()
    expect(calibration.sourceHashes[contract.did.file]).toBe(contract.did.sha256)

    await withTempProject(async (root) => {
      const dataImport = await DataImportTool.init()
      const recommend = await EconometricsRecommendTool.init()
      const imported = await dataImport.execute(
        {
          action: "import",
          preserveLabels: true,
          inputPath: files.didPath,
          sheetPolicy: { mode: "named_sheet", sheetName: contract.did.sheet },
        },
        ctx as never,
      )
      const source = {
        datasetId: imported.metadata.datasetId!,
        stageId: imported.metadata.stageId!,
        runId: imported.metadata.runId,
      }
      recordWorkflowStageSuccess({
        sessionID: ctx.sessionID,
        toolName: "data_import",
        args: { action: "import", ...source },
        metadata: { action: "import", ...source },
      })
      await recommend.execute(
        {
          datasetId: source.datasetId,
          stageId: source.stageId,
          dependentVar: "经济发展水平",
          treatmentVar: "did",
          entityVar: contract.did.entityVar,
          timeVar: contract.did.timeVar,
        },
        ctx as never,
      )
      recordWorkflowStageSuccess({
        sessionID: ctx.sessionID,
        toolName: "econometrics_recommend",
        args: source,
        metadata: source,
      })
      const qa = await dataImport.execute(
        {
          action: "validate",
          preserveLabels: true,
          ...source,
          entityVar: contract.did.entityVar,
          timeVar: contract.did.timeVar,
        },
        ctx as never,
      )
      recordWorkflowStageSuccess({
        sessionID: ctx.sessionID,
        toolName: "data_import",
        args: { action: "validate", ...source },
        metadata: { action: "validate", ...source, qaGateStatus: qa.metadata.qaGateStatus },
      })

      const panelFe = await PanelFeRegressionTool.init()
      const panelResult = await panelFe.execute(
        {
          ...source,
          dependentVar: "经济发展水平",
          treatmentVar: "did",
          covariates: [...BASELINE_CONTROLS],
          entityVar: contract.did.entityVar,
          timeVar: contract.did.timeVar,
          clusterVar: contract.did.entityVar,
          covariance: "clustered",
        },
        ctx as never,
      )
      const panel = panelResult.metadata.result!
      const panelPrimary = panel.primary!
      expect(panel.rowsUsed).toBe(contract.did.rows)
      expect(panel.backend).toContain("linearmodels")
      expect(panel.covariance).toBe("clustered")
      expect(Number.isFinite(panelPrimary.estimate)).toBe(true)
      expect(Number.isFinite(panelPrimary.stdError) && panelPrimary.stdError! > 0).toBe(true)
      expect(Number.isFinite(panelPrimary.pValue) && panelPrimary.pValue! >= 0 && panelPrimary.pValue! <= 1).toBe(true)
      expect(panelResult.output).not.toContain(files.didPath)
      expect(panel.clusterCount).toBe(contract.did.entities)

      const hdfe = await HdfeRegressionTool.init()
      const hdfeResult = await hdfe.execute(
        {
          ...source,
          dependentVar: "经济发展水平",
          treatmentVar: "did",
          covariates: [...BASELINE_CONTROLS],
          fixedEffects: [contract.did.entityVar, contract.did.timeVar],
          clusterVars: [contract.did.entityVar],
          covariance: "CRV1",
        },
        ctx as never,
      )
      const hdfeBackend = hdfeResult.metadata.result
      expect(hdfeBackend.rowsUsed).toBe(contract.did.rows)
      expect(hdfeBackend.droppedRows).toBe(0)
      expect(hdfeBackend.fixedEffects).toEqual([contract.did.entityVar, contract.did.timeVar])
      expect(hdfeBackend.clusterCounts?.[contract.did.entityVar]).toBe(contract.did.entities)
      expect(hdfeBackend.primary?.term).toBe("did")
      expect(Number.isFinite(hdfeBackend.primary?.estimate)).toBe(true)
      expect(Number.isFinite(hdfeBackend.primary?.stdError) && hdfeBackend.primary!.stdError! > 0).toBe(true)
      expect(hdfeResult.output).not.toContain(files.didPath)

      const pointEstimateGap = Math.abs(panelPrimary.estimate! - hdfeBackend.primary!.estimate!)
      expect(pointEstimateGap).toBeLessThan(1e-6)

      const additionalSpecifications = [
        { kind: "robustness", outcome: "人均GDP", controls: [...BASELINE_CONTROLS] },
        { kind: "robustness", outcome: "高质量发展指数", controls: [...BASELINE_CONTROLS] },
        { kind: "robustness", outcome: "包容性TFP指数", controls: [...BASELINE_CONTROLS] },
        { kind: "mechanism_screen", outcome: "创新指数", controls: [...BASELINE_CONTROLS] },
        { kind: "mechanism_screen", outcome: "产业结构高级化2", controls: [...BASELINE_CONTROLS] },
        {
          kind: "mechanism_screen",
          outcome: "金融发展程度",
          controls: BASELINE_CONTROLS.filter((column) => column !== "金融发展程度"),
        },
      ] as const
      const compactResults = [
        {
          kind: "baseline",
          tool: "panel_fe_regression",
          outcome: "经济发展水平",
          coefficient: panelPrimary.estimate!,
          stdError: panelPrimary.stdError!,
          pValue: panelPrimary.pValue!,
          rowsUsed: panel.rowsUsed!,
        },
      ]
      const resultPaths = new Set<string>([panel.resultPath!])

      for (const specification of additionalSpecifications) {
        const result = await panelFe.execute(
          {
            ...source,
            dependentVar: specification.outcome,
            treatmentVar: "did",
            covariates: [...specification.controls],
            entityVar: contract.did.entityVar,
            timeVar: contract.did.timeVar,
            clusterVar: contract.did.entityVar,
            covariance: "clustered",
          },
          ctx as never,
        )
        const backend = result.metadata.result!
        const primary = backend.primary!
        expect(backend.rowsUsed, specification.outcome).toBe(contract.did.rows)
        expect(Number.isFinite(primary.estimate), specification.outcome).toBe(true)
        expect(Number.isFinite(primary.stdError) && primary.stdError! > 0, specification.outcome).toBe(true)
        expect(
          Number.isFinite(primary.pValue) && primary.pValue! >= 0 && primary.pValue! <= 1,
          specification.outcome,
        ).toBe(true)
        expect(backend.clusterVar, specification.outcome).toBe(contract.did.entityVar)
        expect(backend.covariance, specification.outcome).toBe("clustered")
        expect(result.output, specification.outcome).not.toContain(files.didPath)
        expect(resultPaths.has(backend.resultPath!), `${specification.outcome}: result path was reused`).toBe(false)
        resultPaths.add(backend.resultPath!)
        compactResults.push({
          kind: specification.kind,
          tool: "panel_fe_regression",
          outcome: specification.outcome,
          coefficient: primary.estimate!,
          stdError: primary.stdError!,
          pValue: primary.pValue!,
          rowsUsed: backend.rowsUsed!,
        })
      }

      expect(new Set(compactResults.map((item) => item.coefficient.toFixed(8))).size).toBe(compactResults.length)
      for (const result of compactResults) {
        const expected = calibration.panelFe.results.find((item) => item.outcome === result.outcome)
        expect(expected, `${result.outcome}: missing calibrated backend result`).toBeDefined()
        if (!expected) continue
        expect(result.kind).toBe(expected.kind)
        expect(result.rowsUsed).toBe(expected.rowsUsed)
        expect(result.coefficient).toBeCloseTo(expected.coefficient, 7)
        expect(result.stdError).toBeCloseTo(expected.stdError, 7)
        expect(result.pValue).toBeCloseTo(expected.pValue, 7)
      }
      expect(hdfeBackend.primary!.estimate!).toBeCloseTo(calibration.hdfeCrosscheck.coefficient, 7)
      expect(hdfeBackend.primary!.stdError!).toBeCloseTo(calibration.hdfeCrosscheck.stdError, 7)
      expect(hdfeBackend.primary!.pValue!).toBeCloseTo(calibration.hdfeCrosscheck.pValue, 7)
      expect(hdfeBackend.rowsUsed).toBe(calibration.hdfeCrosscheck.rowsUsed)
      expect(pointEstimateGap).toBeCloseTo(calibration.hdfeCrosscheck.coefficientGapVsPanelFe, 14)
      if (process.env.KILLSTATA_PRINT_REAL_PAPER_RESULTS === "1") {
        console.log(
          `REAL_PAPER_RESULTS=${JSON.stringify({
            panel: compactResults,
            hdfeCrosscheck: {
              tool: "hdfe_regression",
              outcome: "经济发展水平",
              coefficient: hdfeBackend.primary!.estimate!,
              stdError: hdfeBackend.primary!.stdError!,
              pValue: hdfeBackend.primary!.pValue!,
              rowsUsed: hdfeBackend.rowsUsed!,
              coefficientGap: pointEstimateGap,
              pyfixestVersion: hdfeBackend.pyfixestVersion,
            },
          })}`,
        )
      }
    })
  }, 240_000)
})
