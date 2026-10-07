import { describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { managedPythonExecutable, resolveRuntimePythonCommand } from "@/killstata/runtime-config"
import { Instance } from "@/project/instance"
import { hasLocalRealData, localRealDataPath } from "../helpers/local-real-data"

async function managedPythonWithPandas() {
  const configured = process.env.KILLSTATA_PYTHON?.trim()
    || await resolveRuntimePythonCommand().catch(() => undefined)
  const candidates = [
    configured,
    managedPythonExecutable(),
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find((candidate) => spawnSync(candidate, ["-c", "import pandas"], { encoding: "utf-8" }).status === 0)
}

describe("canonical schema normalization", () => {
  test.skipIf(!hasLocalRealData("did.xlsx"))("normalizes the real DID workbook within the interactive import budget", async () => {
    const python = await managedPythonWithPandas()
    expect(python).toBeString()
    if (!python) return
    const workbook = localRealDataPath("did.xlsx")
    expect(fs.existsSync(workbook)).toBe(true)
    const script = [
      "import json, pandas as pd, sys, time",
      `sys.path.insert(0, ${JSON.stringify(path.join(process.cwd(), "..", "killstata-econometrics-engine", "python", "econometrics"))})`,
      "from data_schema import normalize_for_canonical",
      `source = ${JSON.stringify(workbook)}`,
      "frame = pd.read_excel(source, dtype=object, keep_default_na=False)",
      "started = time.monotonic()",
      "normalized, receipt = normalize_for_canonical(frame, source_path=source, source_format='xlsx', sheet_policy={'mode': 'first_sheet'})",
      "print(json.dumps({'rows': len(normalized), 'columns': len(normalized.columns), 'seconds': time.monotonic() - started, 'receiptColumns': len(receipt['columns'])}))",
    ].join("\n")

    const result = spawnSync(python, ["-c", script], { encoding: "utf-8", timeout: 8_000 })
    expect(result.status, result.stderr || `signal=${result.signal}`).toBe(0)
    if (result.status !== 0) return
    const output = JSON.parse(result.stdout) as { rows: number; columns: number; seconds: number; receiptColumns: number }
    expect(output).toMatchObject({ rows: 4709, columns: 34, receiptColumns: 34 })
    expect(output.seconds).toBeLessThan(5)
  }, 30_000)

  test("preserves identifiers and ambiguous text while safely converting plain numeric text", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-schema-normalization-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const python = await managedPythonWithPandas()
        expect(python).toBeString()
        if (!python) return
        const script = [
      "import json, pandas as pd, sys",
      `sys.path.insert(0, ${JSON.stringify(path.join(process.cwd(), "..", "killstata-econometrics-engine", "python", "econometrics"))})`,
      "from data_schema import normalize_for_canonical",
      "frame = pd.DataFrame({'firm_id': ['00123', '00124', '00001'], 'amount': ['1200', '1300', '1400'], 'literal': ['NA', '-', ''], 'percent': ['12%', '13%', '10%'], 'month': ['2025-01', '2025-02', '2025-03']})",
      "normalized, receipt = normalize_for_canonical(frame, source_path='firms.csv', source_format='csv', sheet_policy={})",
      "def values(series): return [None if pd.isna(value) else value for value in series.tolist()]",
      "print(json.dumps({'values': {name: values(normalized[name]) for name in normalized.columns}, 'dtypes': {name: str(normalized[name].dtype) for name in normalized.columns}, 'receipt': receipt}))",
        ].join("\n")
        const result = spawnSync(python, ["-c", script], { encoding: "utf-8" })
        expect(result.status, result.stderr).toBe(0)
        if (result.status !== 0) return

        const output = JSON.parse(result.stdout) as {
      values: Record<string, Array<string | number | null>>
      dtypes: Record<string, string>
      receipt: { columns: Array<{ name: string; decision: string; logicalType: string }> }
        }
        const column = (name: string) => output.receipt.columns.find((item) => item.name === name)
        expect(output.values.firm_id).toEqual(["00123", "00124", "00001"])
        expect(output.dtypes.firm_id).toContain("string")
        expect(column("firm_id")).toMatchObject({ decision: "preserve_identifier", logicalType: "identifier" })
        expect(output.values.amount).toEqual([1200, 1300, 1400])
        expect(column("amount")).toMatchObject({ decision: "safe_numeric", logicalType: "number" })
        expect(output.values.literal).toEqual(["NA", "-", null])
        expect(column("literal")).toMatchObject({ decision: "preserve_ambiguous_text" })
        expect(output.values.percent).toEqual(["12%", "13%", "10%"])
        expect(output.values.month).toEqual(["2025-01", "2025-02", "2025-03"])
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
