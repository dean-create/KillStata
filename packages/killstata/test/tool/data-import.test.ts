import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { PreprocessOperationSchema, schemaLooksLikeMojibake } from "../../src/tool/data-import"
import { resolveRuntimePythonCommand } from "../../src/killstata/runtime-config"

async function supportsPandas() {
  try {
    const pythonCommand = await resolveRuntimePythonCommand()
    execFileSync(pythonCommand, ["-c", "import pandas"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
    return pythonCommand
  } catch {
    return undefined
  }
}

function extractApplyFilterSource() {
  const sourcePath = path.join(process.cwd(), "src", "tool", "data-import.ts")
  const source = fs.readFileSync(sourcePath, "utf-8")
  const start = source.indexOf("def apply_filter(df, rule):")
  const end = source.indexOf("def summarize_dataframe(df, columns):")
  if (start === -1 || end === -1) throw new Error("apply_filter block not found")
  return source.slice(start, end)
}

describe("tool.data_import", () => {
  test("includes DTA encoding fallback logic", () => {
    const sourcePath = path.join(process.cwd(), "src", "tool", "data-import.ts")
    const source = fs.readFileSync(sourcePath, "utf-8")
    expect(source).toContain('"gbk"')
    expect(source).toContain('"latin1"')
    expect(source).toContain('_source_encoding')
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

  test("combine_columns requires an explicit collision-checkable composite-key contract", () => {
    expect(
      PreprocessOperationSchema.parse({
        type: "combine_columns",
        variables: ["省份", "地区"],
        params: { output_column: "省份_地区", separator: "_" },
      }),
    ).toEqual({
      type: "combine_columns",
      variables: ["省份", "地区"],
      params: { output_column: "省份_地区", separator: "_" },
    })

    for (const invalid of [
      { type: "combine_columns", variables: ["省份"], params: { output_column: "省份_地区" } },
      { type: "combine_columns", variables: ["省份", "省份"], params: { output_column: "省份_地区" } },
      { type: "combine_columns", variables: ["省份", "地区"], params: {} },
      {
        type: "combine_columns",
        variables: ["省份", "地区"],
        params: { output_column: "省份_地区", separator: "x".repeat(17) },
      },
    ]) {
      expect(PreprocessOperationSchema.safeParse(invalid).success).toBe(false)
    }
  })

  test("apply_filter rejects a non-numeric column instead of silently returning an empty result", async () => {
    const pythonCommand = await supportsPandas()
    if (!pythonCommand) return

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-apply-filter-"))
    try {
      const driverPath = path.join(tempDir, "driver.py")
      const driverScript = `
import json
import pandas as pd
${extractApplyFilterSource()}

df = pd.DataFrame({"city": ["北京", "上海", "广州"], "revenue": [100, 200, 300]})

def try_filter(rule):
    try:
        result = apply_filter(df, rule)
        return {"ok": True, "rows": len(result)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

output = {
    "text_column_gt": try_filter({"column": "city", "operator": "gt", "value": 100}),
    "string_numeric_value_gt": try_filter({"column": "revenue", "operator": "gt", "value": "150"}),
    "non_numeric_value_gt": try_filter({"column": "revenue", "operator": "gt", "value": "abc"}),
    "normal_numeric_gt": try_filter({"column": "revenue", "operator": "gt", "value": 150}),
}
print(json.dumps(output, ensure_ascii=False))
`
      fs.writeFileSync(driverPath, driverScript, "utf-8")
      const stdout = execFileSync(pythonCommand, [driverPath], { encoding: "utf-8" })
      const parsed = JSON.parse(stdout.trim().split("\n").pop()!)

      expect(parsed.text_column_gt.ok).toBe(false)
      expect(parsed.text_column_gt.error).toContain("city")
      expect(parsed.text_column_gt.error).toContain("does not look numeric")

      expect(parsed.string_numeric_value_gt.ok).toBe(true)
      expect(parsed.string_numeric_value_gt.rows).toBe(2)

      expect(parsed.non_numeric_value_gt.ok).toBe(false)
      expect(parsed.non_numeric_value_gt.error).toContain("must be numeric")

      expect(parsed.normal_numeric_gt.ok).toBe(true)
      expect(parsed.normal_numeric_gt.rows).toBe(2)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
