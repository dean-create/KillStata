/**
 * did.xlsx 真实数据驱动测试——逐个计量方法走真实工具链，观察卡壳/意外 bug。
 *
 * 数据已知：截断面板——处理组只有政策后观测（2005-2011 无处理组行），
 * 因此 did_static/did2s/event_study 缺政策前单元，应当被工具正确拒绝（不是 bug）。
 *
 * 固定 fixture：test/fixtures/golden/did.csv（由仓库真实 did.xlsx 固化，
 * 从 data/did.xlsx 生成，SHA-256 锁定来源；测试只读检入的 CSV，不依赖 /tmp）。
 *
 * 运行：bun test test/tool/did-real-data.test.ts
 */

import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { ToolRegistry } from "@/tool/registry"
import { registerCanonicalDataset } from "../helpers/canonical-dataset"
import { resolveRuntimePythonCommand } from "@/killstata/runtime-config"
import { execFileSync } from "child_process"

const ctx = {
  sessionID: "did-real-data-drive",
  messageID: "",
  callID: "",
  agent: "econometrics",
  abort: AbortSignal.any([]),
  metadata: async () => undefined,
  ask: async () => undefined,
}

async function withInstance<T>(fn: (root: string) => Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-did-drive-"))
  const previousPython = process.env.KILLSTATA_PYTHON
  if (!previousPython) process.env.KILLSTATA_PYTHON = path.join(os.homedir(), ".killstata", "venv", "bin", "python")
  try {
    return await Instance.provide({ directory: root, fn: () => fn(root) })
  } finally {
    if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
    else process.env.KILLSTATA_PYTHON = previousPython
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function supportsEconometricsRuntime() {
  try {
    const pythonCommand = await resolveRuntimePythonCommand()
    execFileSync(pythonCommand, ["-c", "import pyfixest; import statsmodels; import linearmodels; import rdrobust"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return true
  } catch {
    return false
  }
}

// withInstance 内部再探测运行时（resolveRuntimePythonCommand 需要 Instance 上下文）
async function withRuntime<T>(fn: () => Promise<T>): Promise<T> {
  if (!(await supportsEconometricsRuntime())) {
    throw new Error("[did-drive] managed econometrics runtime 不可用，真实数据契约无法验证")
  }
  return fn()
}

const SOURCE = path.join(import.meta.dir, "../fixtures/golden/did.csv")
const DEP = "高质量发展指数"
const TREAT = "did"
const POST = "post"
const RELTIME = "relative_time"
const ENTITY = "地区"
const TIME = "year"
const COHORT = "time"
const CONTROLS = ["人口规模", "人均GDP", "金融发展程度"]

function context(sessionID: string) {
  return { ...ctx, sessionID }
}

describe("did.xlsx 真实数据驱动", () => {
  test("工具可见性：baseline_estimate 阶段能看到 DID 家族 + data_preprocess + recommend", async () => {
    await withInstance(async () => {
      const pool = await ToolRegistry.resolvePool(
        { providerID: "deepseek", modelID: "deepseek-v4-flash" },
        undefined,
        {
          inputIntent: "analysis",
          currentStage: "baseline_estimate",
          platformCapabilities: { mcp: false, images: false, remote: false },
          modelCapabilities: { supportsTools: true, supportsImages: false },
        },
      )
      expect(pool.resolution.directToolIDs).toEqual(expect.arrayContaining(["data_preprocess", "econometrics_recommend", "tool_search"]))
      expect(pool.resolution.deferredToolIDs).toEqual(expect.arrayContaining(["did_static", "did2s", "did_event_study_saturated"]))
      const didTools = await pool.load(["did_static", "did2s", "did_event_study_saturated"])
      expect(didTools.map((tool) => tool.id)).toEqual(["did_static", "did2s", "did_event_study_saturated"])
    })
  })

  test("did_static：截断数据应被拒绝（无处理组政策前单元）——工具正确行为", async () => {
    await withInstance(async () => {
      await withRuntime(async () => {
        const source = registerCanonicalDataset({
          sessionID: context("did-static").sessionID,
          sourcePath: SOURCE,
          datasetId: "dataset_did_xlsx_static",
        })
        const tool = await (await ToolRegistry.byID("did_static"))!.init()
        let rejected: unknown
        try {
          await tool.execute(
            {
              ...source,
              dependentVar: DEP,
              groupVar: TREAT,
              postVar: POST,
              covariates: CONTROLS,
              covariance: "HC1",
            },
            context("did-static") as never,
          )
        } catch (e) {
          rejected = e
        }
        expect(rejected).toBeInstanceOf(Error)
        const msg = (rejected as Error).message
        console.log(`  did_static: 正确拒绝 → ${msg.slice(0, 80)}`)
        expect(msg).toMatch(/四个样本单元|处理组|政策前|四/)
      })
    })
  }, 120_000)

  test("panel_fe_regression：个体+时间双固定效应", async () => {
    await withInstance(async () => {
      await withRuntime(async () => {
        const source = registerCanonicalDataset({
          sessionID: context("panel-fe").sessionID,
          sourcePath: SOURCE,
          datasetId: "dataset_did_xlsx_panel_fe",
        })
        const tool = await (await ToolRegistry.byID("panel_fe_regression"))!.init()
        const execution = await tool.execute(
          {
            ...source,
            dependentVar: DEP,
            treatmentVar: TREAT,
            covariates: CONTROLS,
            entityVar: ENTITY,
            timeVar: TIME,
            covariance: "robust",
          },
          context("panel-fe") as never,
        )
        const r = execution.metadata.result as Record<string, unknown> | undefined
        expect(r).toBeDefined()
        console.log(`  panel_fe: success=${(r as { success?: unknown }).success}`)
        expect((r as { success?: boolean }).success).toBe(true)
      })
    })
  }, 120_000)

  test("hdfe_regression：高维固定效应（clusterVars 复数参数）", async () => {
    await withInstance(async () => {
      await withRuntime(async () => {
        const source = registerCanonicalDataset({
          sessionID: context("hdfe").sessionID,
          sourcePath: SOURCE,
          datasetId: "dataset_did_xlsx_hdfe",
        })
        const tool = await (await ToolRegistry.byID("hdfe_regression"))!.init()
        const execution = await tool.execute(
          {
            ...source,
            dependentVar: DEP,
            treatmentVar: TREAT,
            covariates: CONTROLS,
            fixedEffects: [ENTITY, TIME],
            clusterVars: [ENTITY],
            covariance: "CRV1",
          },
          context("hdfe") as never,
        )
        const r = execution.metadata.result as Record<string, unknown> | undefined
        expect(r).toBeDefined()
        console.log(`  hdfe: success=${(r as { success?: unknown }).success}`)
        expect((r as { success?: boolean }).success).toBe(true)
      })
    })
  }, 120_000)

  test("ols_regression：横截面基准", async () => {
    await withInstance(async () => {
      await withRuntime(async () => {
        const source = registerCanonicalDataset({
          sessionID: context("ols").sessionID,
          sourcePath: SOURCE,
          datasetId: "dataset_did_xlsx_ols",
        })
        const tool = await (await ToolRegistry.byID("ols_regression"))!.init()
        const execution = await tool.execute(
          {
            ...source,
            dependentVar: DEP,
            treatmentVar: TREAT,
            covariates: CONTROLS,
            covariance: "HC1",
          },
          context("ols") as never,
        )
        const r = execution.metadata.result as Record<string, unknown> | undefined
        expect(r).toBeDefined()
        console.log(`  ols: success=${(r as { success?: unknown }).success}`)
        expect((r as { success?: boolean }).success).toBe(true)
      })
    })
  }, 120_000)
})
