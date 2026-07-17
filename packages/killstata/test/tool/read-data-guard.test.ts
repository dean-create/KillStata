import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { buildParquetReadGuidance, ReadTool } from "../../src/tool/read"

const ctx = {
  // 必须是合法的 session id（ses_ 前缀）：read 成功路径上会拿它去查会话消息，
  // 用一个假串会在 Zod 校验处炸掉，而不是走到我们要测的逻辑。
  sessionID: Identifier.descending("session"),
  messageID: "",
  callID: "",
  agent: "econometrics",
  abort: AbortSignal.any([]),
  metadata: async () => undefined,
  ask: async () => undefined,
} as any

let root: string

// 造一份「像真实数据集」的 CSV：足够大，读进来只会是一个被截断的任意切片。
function writeBigCsv(target: string) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const header = "firm,year,invest,value,capital\n"
  const row = "1,1935,317.6,3078.5,2.8\n"
  // 256KB 是拦截线，这里写到约 500KB
  fs.writeFileSync(target, header + row.repeat(Math.ceil((500 * 1024) / row.length)))
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-read-guard-"))
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

async function read(filePath: string) {
  return Instance.provide({
    directory: root,
    fn: async () => {
      const tool = await ReadTool.init()
      return tool.execute({ filePath }, ctx)
    },
  })
}

describe("tool.read data guard", () => {
  test("refuses to read a raw dataset CSV as text", async () => {
    const target = path.join(root, "panel.csv")
    writeBigCsv(target)

    // 读它只会拿到一个被截断的任意切片；任何基于这个切片算出的统计量都是错的。
    await expect(read(target)).rejects.toThrow(/Refusing to read/)
  })

  test("the refusal tells the model what to do instead (not just 'no')", async () => {
    const target = path.join(root, "big.csv")
    writeBigCsv(target)

    const error = await read(target).catch((e: Error) => e.message)
    expect(error).toContain("data_import")
    expect(error).toContain("numeric_snapshot.json")
  })

  test("parquet guidance points to dedicated estimators instead of the legacy dispatcher", () => {
    const guidance = buildParquetReadGuidance(path.join(root, ".killstata", "datasets", "d1", "stages", "stage.parquet"))

    expect(guidance).toContain("dedicated estimator tool")
    expect(guidance).not.toContain("data_import or econometrics")
    expect(guidance).not.toContain("data_import/econometrics")
  })

  test("still reads our own result tables — those ARE the grounded artifacts", async () => {
    // coefficient_table.csv 这类产物必须能读，否则模型就没法引用回归结果了。
    const artifact = path.join(root, ".killstata", "datasets", "d1", "reports", "coefficient_table.csv")
    writeBigCsv(artifact)

    const result = await read(artifact)
    expect(result.output).toContain("firm")
  })

  test("still reads a small CSV — a tiny lookup table is not a dataset dump", async () => {
    const small = path.join(root, "labels.csv")
    fs.writeFileSync(small, "code,label\n1,处理组\n0,对照组\n")

    const result = await read(small)
    expect(result.output).toContain("处理组")
  })

  test("excel and stata files remain blocked regardless of size", async () => {
    const xlsx = path.join(root, "tiny.xlsx")
    fs.writeFileSync(xlsx, "not really xlsx")
    const dta = path.join(root, "tiny.dta")
    fs.writeFileSync(dta, "not really dta")

    await expect(read(xlsx)).rejects.toThrow(/Cannot read Excel workbook as text/)
    await expect(read(dta)).rejects.toThrow(/Cannot read Stata dataset as text/)
  })
})
