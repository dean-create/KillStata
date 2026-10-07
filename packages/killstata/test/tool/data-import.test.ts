import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import {
  schemaLooksLikeMojibake,
  validateDataActionEngineResponse,
  validateImportEngineResponse,
  validateEngineAncillaryPaths,
} from "../../src/tool/data-import"
import { resolveRuntimePythonCommand } from "../../src/killstata/runtime-config"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"
import { Instance } from "@/project/instance"

function engine() {
  const managedPython = process.platform === "win32"
    ? path.join(os.homedir(), ".killstata", "venv", "Scripts", "python.exe")
    : path.join(os.homedir(), ".killstata", "venv", "bin", "python")
  return new EconometricsEngineClient({
    command: process.env.KILLSTATA_PYTHON ?? managedPython,
    cwd: path.resolve(process.cwd(), "../.."),
    pythonPath: path.resolve(process.cwd(), "../killstata-econometrics-engine/src"),
  })
}

async function supportsPandas() {
  const configuredPython = process.env.KILLSTATA_PYTHON?.trim()
  try {
    const pythonCommand = configuredPython ?? await resolveRuntimePythonCommand()
    execFileSync(pythonCommand, ["-c", "import pandas"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
    return pythonCommand
  } catch (error) {
    if (configuredPython) throw error
    return undefined
  }
}

describe("tool.data_import", () => {
  test("description matches the reduced CSV/JSON artifact contract", () => {
    const description = fs.readFileSync(path.join(process.cwd(), "src", "tool", "data-import.txt"), "utf-8")
    const analysisState = fs.readFileSync(path.join(process.cwd(), "src", "tool", "analysis-state.ts"), "utf-8")
    expect(description).not.toContain("inspection CSV/XLSX")
    expect(description).not.toContain("Save CSV, workbook, summary JSON")
    expect(description).not.toContain("inspection CSV / workbook paths")
    expect(description).not.toContain("numeric_snapshot.json for describe/correlation")
    expect(analysisState).not.toContain("open the inspection")
  })

  test("DTA读取能力由独立Python引擎负责", () => {
    const sourcePath = path.resolve(process.cwd(), "..", "killstata-econometrics-engine", "python", "data_import", "runner.py")
    const source = fs.readFileSync(sourcePath, "utf-8")
    expect(source).toContain('suffix == ".dta"')
    expect(source).toContain("pd.read_stata")
    expect(fs.readFileSync(path.join(process.cwd(), "src", "tool", "data-import", "index.ts"), "utf-8"))
      .not.toContain("_source_encoding")
  })

  test("schemaLooksLikeMojibake detects mojibake column names in the actual schema.json shape", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-schema-mojibake-"))
    try {
      const mojibakePath = path.join(tempDir, "mojibake_schema.json")
      fs.writeFileSync(
        mojibakePath,
        JSON.stringify({ schema: [{ name: "æµ‹è¯•", dtype: "object", missing_count: 0, missing_share: 0 }] }),
        "utf-8",
      )
      expect(schemaLooksLikeMojibake(mojibakePath)).toBe(true)

      const cleanPath = path.join(tempDir, "clean_schema.json")
      fs.writeFileSync(
        cleanPath,
        JSON.stringify({ schema: [{ name: "测试", dtype: "object", missing_count: 0, missing_share: 0 }] }),
        "utf-8",
      )
      expect(schemaLooksLikeMojibake(cleanPath)).toBe(false)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test("import 不接受缺少数据、schema 或结果文件的成功响应", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-import-response-contract-"))
    const managedRoot = path.join(root, ".killstata", "datasets", "dataset_import_contract")
    const inputPath = path.join(root, ".killstata", "sources", "source.csv")
    const dataPath = path.join(managedRoot, "stages", "stage_000.parquet")
    const schemaPath = path.join(managedRoot, "stages", "schema.json")
    const resultPath = path.join(managedRoot, "stages", "results.json")
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const base = { expectedInputPath: inputPath, expectedDataPath: dataPath, expectedSchemaPath: schemaPath, expectedResultPath: resultPath, managedRoot }
        expect(() => validateImportEngineResponse({ payload: { success: true }, ...base })).toThrow(/缺少.*导入源数据/)

        fs.mkdirSync(path.dirname(inputPath), { recursive: true })
        fs.mkdirSync(path.dirname(dataPath), { recursive: true })
        fs.writeFileSync(inputPath, "source")
        for (const filePath of [dataPath, schemaPath]) fs.writeFileSync(filePath, "present")
        expect(() => validateImportEngineResponse({
          payload: { success: true, input_path: inputPath, dataPath, schemaPath, resultPath },
          ...base,
        })).toThrow(/导入结果文件不存在/)

        fs.writeFileSync(resultPath, "present")
        expect(validateImportEngineResponse({
          payload: { success: true, input_path: inputPath, dataPath, schemaPath, resultPath },
          ...base,
        })).toEqual({
          inputPath: fs.realpathSync(inputPath),
          dataPath: fs.realpathSync(dataPath),
          schemaPath: fs.realpathSync(schemaPath),
          resultPath: fs.realpathSync(resultPath),
        })
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("Python 附属路径必须绑定到 Harness 为当前数据集预定的文件", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-import-foreign-artifact-"))
    const datasetA = path.join(root, ".killstata", "datasets", "dataset_a")
    const datasetB = path.join(root, ".killstata", "datasets", "dataset_b")
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const expected = path.join(datasetA, "audit", "stage_001_summary.json")
        const foreign = path.join(datasetB, "audit", "stage_009_summary.json")
        fs.mkdirSync(path.dirname(expected), { recursive: true })
        fs.mkdirSync(path.dirname(foreign), { recursive: true })
        fs.writeFileSync(expected, "current dataset summary")
        fs.writeFileSync(foreign, "another dataset summary")
        expect(() => validateEngineAncillaryPaths({
          payload: { summary_path: foreign },
          expectedPaths: { summary_path: expected },
          managedRoot: datasetA,
        })).toThrow(/与 Harness 预定目标不一致|受管数据目录之外/)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("frequency 的 Python 成功响应缺少预定产物时不能继续登记成功", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-frequency-output-contract-"))
    const managedRoot = path.join(root, ".killstata")
    const outputPath = path.join(managedRoot, "runtime", "health", "results.json")
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const request = {
          action: "frequency" as const,
          payload: { success: true, output_path: outputPath },
          expectedOutputPath: outputPath,
          expectedResultPath: outputPath,
          managedRoot,
        }
        expect(() => validateDataActionEngineResponse(request)).toThrow(/缺少.*frequency.*结果|缺少.*结果记录/)

        fs.mkdirSync(path.dirname(outputPath), { recursive: true })
        fs.writeFileSync(outputPath, "{}", "utf-8")
        expect(() => validateDataActionEngineResponse(request)).toThrow(/缺少.*frequency.*结果|缺少.*结果记录/)

        expect(validateDataActionEngineResponse({
          ...request,
          payload: { success: true, output_path: outputPath, resultPath: outputPath },
        })).toEqual({ outputPath: fs.realpathSync(outputPath), resultPath: fs.realpathSync(outputPath) })
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("combine_columns 的参数契约由 Python Registry 唯一校验", async () => {
    const client = engine()
    const runtime = {
      datasetId: "dataset_combine_columns",
      stageId: "stage_000",
      outputPath: "/tmp/killstata-combine-columns.parquet",
    }
    try {
      await expect(client.validate("data_preprocess", {
        method: "combine_columns",
        columns: ["省份", "地区"],
        options: { output_column: "省份_地区", separator: "_" },
      }, { runtime })).resolves.toMatchObject({
        method_id: "data_preprocess",
        arguments: { method: "combine_columns", columns: ["省份", "地区"] },
      })

      for (const arguments_ of [
        { method: "combine_columns", columns: ["省份"], options: { output_column: "省份_地区" } },
        { method: "combine_columns", columns: ["省份", "省份"], options: { output_column: "省份_地区" } },
        { method: "combine_columns", columns: ["省份", "地区"], options: {} },
        { method: "combine_columns", columns: ["省份", "地区"], options: { output_column: "省份_地区", separator: "x".repeat(17) } },
      ]) {
        await expect(client.validate("data_preprocess", arguments_, { runtime })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
      }
    } finally {
      await client.close()
    }
  })

  test("数据导入数值测试尊重显式受管 Python，而不静默跳过", async () => {
    if (!process.env.KILLSTATA_PYTHON) return
    expect(await supportsPandas()).toBe(process.env.KILLSTATA_PYTHON)
  })
})
