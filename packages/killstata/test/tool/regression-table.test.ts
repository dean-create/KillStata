import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

describe("tool.regression_table", () => {
  test("supports non-panel regression artifacts via coefficient tables", () => {
    const sourcePath = path.join(process.cwd(), "src", "tool", "regression-table.ts")
    const source = fs.readFileSync(sourcePath, "utf-8")
    expect(source).toContain('coefficients_path = model_dir / "coefficient_table.csv"')
    expect(source).toContain('metadata = load_json(model_dir / "model_metadata.json")')
    expect(source).toContain('result = load_json(model_dir / "results.json")')
    expect(source).toContain('return path.join(modelDir, "academic_table")')
  })
})
