import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { runDataPreprocessBackend, validateDataPreprocessBackendResponse } from "../../src/tool/data-preprocess-backend"

const PYTHON = process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python")

describe("data_preprocess Python Harness contract", () => {
  test("runs one guarded Python process and accepts only its declared parquet result", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-backend-"))
    try {
      const source = path.join(root, "source.csv")
      const output = path.join(root, "output.parquet")
      fs.writeFileSync(source, "id,income\n1,1\n2,2\n3,\n4,100\n", "utf-8")
      const result = await Instance.provide({
        directory: root,
        fn: () => runDataPreprocessBackend({
          pythonCommand: PYTHON,
          cwd: root,
          sessionID: "ses_preprocess_backend",
          payload: {
            datasetId: "dataset_preprocess_backend",
            stageId: "stage_000",
            method: "winsorize",
            dataPath: source,
            outputPath: output,
            columns: ["income"],
            options: { lower: 0.25, upper: 0.25 },
          },
        }),
      })

      expect(result.success).toBe(true)
      expect(result.method).toBe("winsorize")
      expect(result.mutation).toBe(true)
      expect(result.outputPath).toBe(output)
      expect(fs.existsSync(output)).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("returns a classified runner failure instead of accepting a malformed operation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-backend-"))
    try {
      const source = path.join(root, "source.csv")
      fs.writeFileSync(source, "income\n1\n2\n", "utf-8")
      await expect(Instance.provide({
        directory: root,
        fn: () => runDataPreprocessBackend({
          pythonCommand: PYTHON,
          cwd: root,
          sessionID: "ses_preprocess_backend_error",
          payload: {
            datasetId: "dataset_preprocess_backend_error",
            stageId: "stage_000",
            method: "log_transform",
            dataPath: source,
            outputPath: path.join(root, "output.parquet"),
            columns: ["income"],
            options: { offset: -2 },
          },
        }),
      })).rejects.toThrow(/INVALID_DOMAIN|对数|positive/i)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects forged success responses before any result can reach a child stage", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-forged-"))
    try {
      const output = path.join(root, "expected.parquet")
      fs.writeFileSync(output, "not consulted when the path is forged", "utf-8")
      const payload = { datasetId: "dataset_preprocess_forged", stageId: "stage_000", method: "winsorize" as const, dataPath: path.join(root, "input.csv"), outputPath: output, columns: ["income"], options: {} }
      const forged = {
        success: true,
        method: "winsorize",
        mutation: true,
        rows_before: 5,
        rows_after: 5,
        columns_before: 2,
        columns_after: 2,
        operation: "winsorize_columns",
        rows_changed: 0,
        columns_changed: 0,
        affected_columns: ["income"],
        created_columns: [],
        warnings: [],
        output_path: path.join(root, "..", "escaped.parquet"),
      }
      expect(() => validateDataPreprocessBackendResponse({ payload, stdout: JSON.stringify(forged) })).toThrow(/不可信的输出路径/)
      expect(() => validateDataPreprocessBackendResponse({ payload, stdout: JSON.stringify({ ...forged, output_path: output, method: "trim" }) })).toThrow(/方法与请求不一致/)
      expect(() => validateDataPreprocessBackendResponse({
        payload: { ...payload, method: "listwise_deletion" },
        stdout: JSON.stringify({ ...forged, output_path: output, method: "listwise_deletion", rows_after: 6 }),
      })).toThrow(/不能增加样本量/)
      expect(() => validateDataPreprocessBackendResponse({ payload, stdout: "{\"success\":true,\"rows_before\":NaN}" })).toThrow(/可解析的 JSON/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
