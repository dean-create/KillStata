import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"

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

const runtime = {
  datasetId: "dataset_preprocess_contract",
  stageId: "stage_000",
  outputPath: "/tmp/killstata-preprocess-contract.parquet",
}

describe("data_preprocess Python Registry contract", () => {
  test("Pydantic accepts admitted parameters and rejects unrelated or invalid options", async () => {
    const client = engine()
    try {
      await expect(client.validate("data_preprocess", {
        method: "winsorize",
        columns: ["income"],
        options: { lower: 0.01, upper: 0.01 },
      }, { runtime })).resolves.toMatchObject({
        method_id: "data_preprocess",
        arguments: { method: "winsorize", columns: ["income"] },
      })
      for (const arguments_ of [
        { method: "winsorize", columns: ["income"], options: { threshold: 3 } },
        { method: "winsorize", columns: ["income", "income"], options: {} },
        { method: "winsorize", columns: ["income"], options: { lower: 0.6, upper: 0.4 } },
        { method: "not_admitted", columns: ["income"], options: {} },
      ]) {
        await expect(client.validate("data_preprocess", arguments_, { runtime })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
      }
    } finally {
      await client.close()
    }
  })

  test("Python-generated input schema explains both tail proportions", async () => {
    const client = engine()
    try {
      const described = await client.describe("data_preprocess")
      const inputSchema = described.input_schema as { $defs?: Record<string, any> }
      const upper = inputSchema.$defs?.DataPreprocessOptions?.properties?.upper?.description
      expect(upper).toContain("上尾比例")
      expect(upper).toContain("不是填上分位点 0.99")
      expect(JSON.stringify(inputSchema)).not.toContain("outputPath")
    } finally {
      await client.close()
    }
  })

  test("create_column without a comparison rule receives a field-level rejection", async () => {
    const client = engine()
    try {
      await expect(client.validate("data_preprocess", {
        method: "create_column",
        columns: ["index"],
        options: { output_column: "index_三分位组" },
      }, { runtime })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
    } finally {
      await client.close()
    }
  })
})
