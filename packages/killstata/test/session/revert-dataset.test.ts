import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { execFileSync } from "child_process"
import { Instance } from "@/project/instance"
import { DataImportTool } from "@/tool/data-import"
import { RevertDataset } from "@/session/revert-dataset"
import { readDatasetManifest } from "@/tool/analysis-state"
import { resolveRuntimePythonCommand } from "@/killstata/runtime-config"

// /undo 在 OpenCode 里是"用 git 影子仓库还原源文件"。计量用户不改源文件，而且他们的数据目录
// 不是 git 仓库——那套机制在他们身上从来就是静默失效的：AI 把数据洗错了，没有任何退路。
//
// 这里锁住的是新语义：撤销 = 数据退回上一个阶段，且历史不被抹掉。
async function supportsPython() {
  try {
    execFileSync(await resolveRuntimePythonCommand(), ["-c", "import pandas"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const ctx = {
  sessionID: "revert-test",
  messageID: "",
  callID: "",
  agent: "general",
  abort: AbortSignal.any([]),
  metadata: async () => {},
  ask: async () => {},
} as never

function toolMessage(action: string, datasetId: string, stageId: string) {
  return {
    info: { id: "msg_1", role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: "data_import",
        state: { status: "completed", metadata: { action, datasetId, stageId } },
      },
    ],
  } as never
}

async function withDataDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "killstata-revert-")))
  try {
    return await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("session revert = dataset rollback", () => {
  test("a chat-only turn has nothing to roll back (undo degrades to message removal)", () => {
    const messages = [
      { info: { id: "m1", role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
    ] as never
    expect(RevertDataset.findTarget(messages)).toBeUndefined()
  })

  test("qa/describe are not rollback anchors — they read a stage, they do not create one", () => {
    // 这是最容易写错的一处：qa 的 metadata 里同样有 stageId，但它没有推进数据。
    // 拿它的父阶段去回滚，会把用户的数据退回到一个他们根本没要求撤销的地方。
    for (const action of ["qa", "describe", "correlation"]) {
      expect(RevertDataset.findTarget([toolMessage(action, "ds_1", "stage_001")])).toBeUndefined()
    }
  })

  test("rolling back a filter returns the data to the previous stage, without erasing history", async () => {
    if (!(await supportsPython())) return

    await withDataDir(async (dir) => {
      const csv = path.join(dir, "面板.csv")
      fs.copyFileSync(path.join(process.cwd(), "test", "fixtures", "golden", "grunfeld.csv"), csv)

      await Instance.provide({
        directory: dir,
        fn: async () => {
          const di = await DataImportTool.init()

          const imported = await di.execute({ action: "import", inputPath: csv } as never, ctx)
          const datasetId = (imported.metadata as { datasetId: string }).datasetId
          const baseStage = (imported.metadata as { stageId: string }).stageId

          // AI 剔掉了一批样本——用户后悔了
          const filtered = await di.execute(
            {
              action: "filter",
              datasetId,
              stageId: baseStage,
              filters: [{ column: "year", operator: "gte", value: 1940 }],
            } as never,
            ctx,
          )
          const filteredStage = (filtered.metadata as { stageId: string }).stageId

          const before = readDatasetManifest(datasetId)
          expect(before.stages.find((s) => s.stageId === filteredStage)?.rowCount).toBe(165)

          // /undo
          const target = RevertDataset.findTarget([toolMessage("filter", datasetId, filteredStage)])
          expect(target).toBeDefined()
          expect(target!.stageId).toBe(baseStage)
          expect(target!.undoneAction).toBe("filter")

          await RevertDataset.rollback(target!, "revert-test")

          const after = readDatasetManifest(datasetId)
          const latest = after.stages.at(-1)!

          // 数据真的退回去了
          expect(latest.action).toBe("rollback")
          expect(latest.rowCount).toBe(220)
          expect(latest.parentStageId).toBe(baseStage)

          // 而且历史没被抹掉——被撤销的那一步仍然在血缘里。
          // 这是学术诚信的要求：试过什么就得留痕，不能假装没试过。
          expect(after.stages.some((s) => s.stageId === filteredStage)).toBe(true)
        },
      })
    })
  }, 120_000)

  test("undoing the initial import has no parent to fall back to", async () => {
    // import 是根阶段，再往前就没有数据了——不该假装能回滚
    expect(RevertDataset.findTarget([toolMessage("import", "ds_1", "stage_000")])).toBeUndefined()
  })
})
