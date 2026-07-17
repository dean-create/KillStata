import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { resolveRuntimePythonCommand } from "@/killstata/runtime-config"
import { Instance } from "@/project/instance"
import { recordWorkflowStageSuccess } from "@/runtime/workflow"
import { DataImportTool } from "@/tool/data-import"
import { EconometricsRecommendTool, PanelFeRegressionTool } from "@/tool/econometrics-method-tools"
import { HdfeRegressionTool } from "@/tool/pyfixest"
import {
  loadRealPaperDatasetContract,
  resolveRealPaperDatasets,
  verifyRealPaperDataset,
} from "../helpers/real-paper-datasets"

const ctx = {
  sessionID: "real-paper-data-chain",
  messageID: "message",
  callID: "call",
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
  const python = await resolveRuntimePythonCommand()
  execFileSync(python, ["-c", "import pandas, pyarrow, linearmodels, pyfixest"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  return python
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
            createInspectionArtifacts: false,
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
          createInspectionArtifacts: false,
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
      expect(didProfile.metadata.profile?.duplicatePanelKeys).toBe(contract.did.duplicateEntityTimeRows)
      const didQa = await dataImport.execute(
        { action: "qa", preserveLabels: true, ...didSource, entityVar: "city", timeVar: "year", createInspectionArtifacts: false },
        ctx as never,
      )
      expect(didQa.metadata.qaGateStatus).not.toBe("block")

      const digitalImport = await dataImport.execute(
        {
          action: "import",
          preserveLabels: true,
          inputPath: files.digitalPath,
          sheetPolicy: { mode: "named_sheet", sheetName: contract.digital.sheet },
          createInspectionArtifacts: false,
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
      await expect(
        dataImport.execute(
          { action: "qa", preserveLabels: true, ...digitalSource, entityVar: "地区", timeVar: "年份", createInspectionArtifacts: false },
          ctx as never,
        ),
      ).rejects.toThrow(
        new RegExp(
          `Data operation blocked by QA gate:.*${contract.digital.duplicateEntityTimeRows} duplicate entity-time rows.*Reflection log`,
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
          createInspectionArtifacts: false,
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
          createInspectionArtifacts: false,
        },
        ctx as never,
      )
      const importedSource = { datasetId: imported.metadata.datasetId!, stageId: imported.metadata.stageId! }
      const repaired = await dataImport.execute(
        {
          action: "preprocess",
          preserveLabels: true,
          ...importedSource,
          operations: [
            {
              type: "combine_columns",
              variables: ["省份", "地区"],
              params: { output_column: "省份_地区", separator: "_" },
            },
          ],
          createInspectionArtifacts: false,
        },
        { ...ctx, agent: "explorer" } as never,
      )
      const source = { datasetId: repaired.metadata.datasetId!, stageId: repaired.metadata.stageId! }
      expect(source.datasetId).toBe(importedSource.datasetId)
      expect(source.stageId).not.toBe(importedSource.stageId)
      expect(repaired.metadata.result?.rows_after).toBe(contract.digital.rows)
      expect(repaired.metadata.result?.columns_after).toBe(contract.digital.columns + 1)

      const parquetPath = path.resolve(root, repaired.metadata.result!.output_path!)
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
        toolName: "data_import",
        args: { action: "preprocess", ...source },
        metadata: { action: "preprocess", ...source },
      })
      const profile = await recommend.execute(
        {
          ...source,
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
        args: source,
        metadata: source,
      })
      const qa = await dataImport.execute(
        {
          action: "qa",
          preserveLabels: true,
          ...source,
          entityVar: "省份_地区",
          timeVar: "年份",
          createInspectionArtifacts: false,
        },
        ctx as never,
      )
      expect(qa.metadata.qaGateStatus).not.toBe("block")
      recordWorkflowStageSuccess({
        sessionID: ctx.sessionID,
        toolName: "data_import",
        args: { action: "qa", ...source },
        metadata: { action: "qa", ...source, qaGateStatus: qa.metadata.qaGateStatus },
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
        },
        ctx as never,
      )
      const backend = result.metadata.result!
      expect(backend.rows_used).toBe(contract.digital.rows)
      expect(backend.cluster_var).toBe("省份_地区")
      expect(backend.degraded_from ?? null).toBeNull()
      expect(Number.isFinite(backend.coefficient)).toBe(true)
      expect(Number.isFinite(backend.std_error) && backend.std_error! > 0).toBe(true)
      expect(Number.isFinite(backend.p_value) && backend.p_value! >= 0 && backend.p_value! <= 1).toBe(true)
      expect(backend.coefficient).toBeCloseTo(calibration.digitalPanelFe.coefficient, 7)
      expect(backend.std_error).toBeCloseTo(calibration.digitalPanelFe.stdError, 7)
      expect(backend.p_value).toBeCloseTo(calibration.digitalPanelFe.pValue, 7)
      expect(backend.rows_used).toBe(calibration.digitalPanelFe.rowsUsed)
      expect(backend.cluster_var).toBe(calibration.digitalPanelFe.clusterVar)
      expect(result.output).not.toContain(files.digitalPath)
      if (process.env.KILLSTATA_PRINT_REAL_PAPER_RESULTS === "1") {
        console.log(
          `REAL_PAPER_DIGITAL_RESULT=${JSON.stringify({
            coefficient: backend.coefficient,
            stdError: backend.std_error,
            pValue: backend.p_value,
            rowsUsed: backend.rows_used,
            clusterVar: backend.cluster_var,
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
          createInspectionArtifacts: false,
        },
        ctx as never,
      )
      const source = { datasetId: imported.metadata.datasetId!, stageId: imported.metadata.stageId! }
      recordWorkflowStageSuccess({
        sessionID: ctx.sessionID,
        toolName: "data_import",
        args: { action: "import", ...source },
        metadata: { action: "import", ...source },
      })
      await recommend.execute(
        {
          ...source,
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
          action: "qa",
          preserveLabels: true,
          ...source,
          entityVar: contract.did.entityVar,
          timeVar: contract.did.timeVar,
          createInspectionArtifacts: false,
        },
        ctx as never,
      )
      recordWorkflowStageSuccess({
        sessionID: ctx.sessionID,
        toolName: "data_import",
        args: { action: "qa", ...source },
        metadata: { action: "qa", ...source, qaGateStatus: qa.metadata.qaGateStatus },
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
        },
        ctx as never,
      )
      const panel = panelResult.metadata.result!
      expect(panel.rows_used).toBe(contract.did.rows)
      expect(panel.backend).toContain("linearmodels")
      expect(Number.isFinite(panel.coefficient)).toBe(true)
      expect(Number.isFinite(panel.std_error) && panel.std_error! > 0).toBe(true)
      expect(Number.isFinite(panel.p_value) && panel.p_value! >= 0 && panel.p_value! <= 1).toBe(true)
      expect(panel.degraded_from ?? null).toBeNull()
      expect(panelResult.output).not.toContain(files.didPath)
      const diagnosticsPath = panel.diagnostics_path!
      const diagnostics = JSON.parse(
        fs.readFileSync(path.isAbsolute(diagnosticsPath) ? diagnosticsPath : path.resolve(root, diagnosticsPath), "utf-8"),
      ) as { panel?: { cluster_count?: number } }
      expect(diagnostics.panel?.cluster_count).toBe(contract.did.entities)

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

      const pointEstimateGap = Math.abs(panel.coefficient! - hdfeBackend.primary!.estimate!)
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
          coefficient: panel.coefficient!,
          stdError: panel.std_error!,
          pValue: panel.p_value!,
          rowsUsed: panel.rows_used!,
        },
      ]
      const resultPaths = new Set<string>([panel.output_path!])

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
          },
          ctx as never,
        )
        const backend = result.metadata.result!
        expect(backend.effective_method, specification.outcome).toBe("panel_fe")
        expect(backend.rows_used, specification.outcome).toBe(contract.did.rows)
        expect(Number.isFinite(backend.coefficient), specification.outcome).toBe(true)
        expect(Number.isFinite(backend.std_error) && backend.std_error! > 0, specification.outcome).toBe(true)
        expect(
          Number.isFinite(backend.p_value) && backend.p_value! >= 0 && backend.p_value! <= 1,
          specification.outcome,
        ).toBe(true)
        expect(backend.cluster_var, specification.outcome).toBe(contract.did.entityVar)
        expect(backend.degraded_from ?? null, specification.outcome).toBeNull()
        expect(result.output, specification.outcome).not.toContain(files.didPath)
        expect(resultPaths.has(backend.output_path!), `${specification.outcome}: result path was reused`).toBe(false)
        resultPaths.add(backend.output_path!)
        compactResults.push({
          kind: specification.kind,
          tool: "panel_fe_regression",
          outcome: specification.outcome,
          coefficient: backend.coefficient!,
          stdError: backend.std_error!,
          pValue: backend.p_value!,
          rowsUsed: backend.rows_used!,
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
