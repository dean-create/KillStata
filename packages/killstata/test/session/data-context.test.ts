import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { execFileSync } from "child_process"
import { Instance } from "@/project/instance"
import { DataImportTool } from "@/tool/data-import"
import { EconometricsTool } from "@/tool/econometrics"
import { DataContext } from "@/session/data-context"
import { resolveRuntimePythonCommand } from "@/killstata/runtime-config"

// 模型过去每轮只拿到 cwd 和日期——它不知道当前数据集是哪个、活跃阶段是哪个、试了几组设定，
// 只能靠翻对话历史去回忆，压缩之后连历史都没了。<data-context> 把这些已落盘的事实每轮
// 重新注入。这些断言锁住"注入的内容和数据的真实状态一致"。
async function supportsPython() {
  try {
    execFileSync(await resolveRuntimePythonCommand(), ["-c", "import pandas"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const ctx = {
  sessionID: "dctx-test",
  messageID: "",
  callID: "",
  agent: "general",
  abort: AbortSignal.any([]),
  metadata: async () => {},
  ask: async () => {},
} as never

async function withDataDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "killstata-dctx-")))
  try {
    return await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("data-context injection", () => {
  test("an empty working directory produces no data-context (no empty shell)", async () => {
    await withDataDir(async (dir) => {
      await Instance.provide({
        directory: dir,
        fn: async () => {
          expect(DataContext.build()).toBeUndefined()
        },
      })
    })
  })

  test("a data file present but nothing imported yet is surfaced as importable", async () => {
    await withDataDir(async (dir) => {
      fs.writeFileSync(path.join(dir, "面板.csv"), "id,year,y\n1,2020,3\n")
      await Instance.provide({
        directory: dir,
        fn: async () => {
          const ctxBlock = DataContext.build()
          expect(ctxBlock).toContain("可导入的数据文件")
          expect(ctxBlock).toContain("面板.csv")
        },
      })
    })
  })

  test("after import → regress → filter, the context reflects the true current state", async () => {
    if (!(await supportsPython())) return

    await withDataDir(async (dir) => {
      const csv = path.join(dir, "面板.csv")
      fs.copyFileSync(path.join(process.cwd(), "test", "fixtures", "golden", "grunfeld.csv"), csv)

      await Instance.provide({
        directory: dir,
        fn: async () => {
          const di = await DataImportTool.init()
          const eco = await EconometricsTool.init()
          const spec = {
            dependentVar: "invest",
            treatmentVar: "value",
            covariates: ["capital"],
            entityVar: "firm",
            timeVar: "year",
            clusterVar: "firm",
          }

          const imported = await di.execute({ action: "import", inputPath: csv } as never, ctx)
          const datasetId = (imported.metadata as { datasetId: string }).datasetId
          const baseStage = (imported.metadata as { stageId: string }).stageId

          // 刚导入：当前数据集 + 活跃阶段（220 行）
          const afterImport = DataContext.build()!
          expect(afterImport).toContain(datasetId)
          expect(afterImport).toContain("stage_000 [import]")
          expect(afterImport).toContain("220 行")
          // 还没跑回归，不该有"已试设定"
          expect(afterImport).not.toContain("已试设定")

          await eco.execute({ methodName: "panel_fe_regression", datasetId, ...spec } as never, ctx)
          const filtered = await di.execute(
            {
              action: "filter",
              datasetId,
              stageId: baseStage,
              filters: [{ column: "year", operator: "gte", value: 1940 }],
            } as never,
            ctx,
          )
          await eco.execute(
            { methodName: "panel_fe_regression", datasetId, stageId: (filtered.metadata as { stageId: string }).stageId, ...spec } as never,
            ctx,
          )

          // 跑了 2 次回归 + 换了样本：活跃阶段变 filter、阶段链、已试设定 2 次
          const afterWork = DataContext.build()!
          expect(afterWork).toContain("stage_001 [filter]")
          expect(afterWork).toContain("165 行")
          expect(afterWork).toContain("阶段链")
          expect(afterWork).toContain("stage_000(import,220行) → stage_001(filter,165行)")
          expect(afterWork).toContain("已试设定: 2 次")
        },
      })
    })
  }, 120_000)
})
