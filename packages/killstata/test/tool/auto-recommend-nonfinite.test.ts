import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { EconometricsRecommendTool } from "@/tool/auto-recommend"
import { registerCanonicalDataset } from "../helpers/canonical-dataset"

function context(sessionID: string) {
  return {
    sessionID,
    messageID: "msg_auto_recommend_nonfinite",
    callID: "call_auto_recommend_nonfinite",
    agent: "econometrics",
    abort: new AbortController().signal,
    metadata: async () => undefined,
    ask: async () => undefined,
  }
}

describe("econometrics_recommend non-finite panel sentinels", () => {
  test("profiles DID2S -inf never-treated relative time without crashing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-auto-recommend-nonfinite-"))
    const sourcePath = path.join(root, "panel.csv")
    fs.writeFileSync(
      sourcePath,
      [
        "unit,time,y,treat,relative_time",
        "a,1,1,0,-inf",
        "a,2,1.2,0,-inf",
        "b,1,2,1,-1",
        "b,2,3,1,0",
      ].join("\n") + "\n",
      "utf-8",
    )

    const previousPython = process.env.KILLSTATA_PYTHON
    if (!previousPython) process.env.KILLSTATA_PYTHON = path.join(os.homedir(), ".killstata", "venv", "bin", "python")

    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const source = registerCanonicalDataset({
            sessionID: "ses_auto_recommend_nonfinite",
            sourcePath,
            datasetId: "dataset_auto_recommend_nonfinite",
          })
          const tool = await EconometricsRecommendTool.init()
          const result = await tool.execute(
            {
              ...source,
              entityVar: "unit",
              timeVar: "time",
            },
            context("ses_auto_recommend_nonfinite") as never,
          )

          expect(result.title).toBe("数据智能分析")
          expect(result.output).toContain("数据画像与推荐方案已生成")
          const profile = (result.metadata as { profile?: { columns?: Array<{ name: string; integerLike: boolean }> } }).profile
          expect(profile?.columns?.find((column) => column.name === "relative_time")?.integerLike).toBe(false)
        },
      })
    } finally {
      if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
      else process.env.KILLSTATA_PYTHON = previousPython
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
