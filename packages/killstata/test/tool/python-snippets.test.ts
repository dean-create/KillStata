import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { resolveRuntimePythonCommand } from "../../src/killstata/runtime-config"
import { PY_READ_CSV_FALLBACK } from "../../src/tool/python-snippets"

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

describe("tool.python-snippets", () => {
  test("read_csv_with_fallback reads GBK-encoded CSVs and reports the encoding it used", async () => {
    const pythonCommand = await supportsPandas()
    if (!pythonCommand) {
      console.warn("[python-snippets] pandas 不可用，跳过真实数据断言")
      return
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-csv-fallback-"))
    try {
      const gbkPath = path.join(tempDir, "gbk.csv")
      const gbkBytes = execFileSync(pythonCommand, [
        "-c",
        `import sys; sys.stdout.buffer.write("城市,收入\\n北京,120000\\n上海,110000\\n".encode("gbk"))`,
      ])
      fs.writeFileSync(gbkPath, gbkBytes)

      const utf8Path = path.join(tempDir, "utf8.csv")
      fs.writeFileSync(utf8Path, "城市,收入\n北京,120000\n上海,110000\n", "utf-8")

      const driverPath = path.join(tempDir, "driver.py")
      const driverScript = `
import json
import pandas as pd
${PY_READ_CSV_FALLBACK}

result = {}
for label, path in [("gbk", ${JSON.stringify(gbkPath)}), ("utf8", ${JSON.stringify(utf8Path)})]:
    df = read_csv_with_fallback(path)
    result[label] = {
        "columns": list(df.columns),
        "encoding": df.attrs.get("_source_encoding"),
        "rows": len(df),
    }
print(json.dumps(result, ensure_ascii=False))
`
      fs.writeFileSync(driverPath, driverScript, "utf-8")

      const output = execFileSync(pythonCommand, [driverPath], { encoding: "utf-8" })
      const parsed = JSON.parse(output.trim().split("\n").pop()!)

      expect(parsed.gbk.encoding).toBe("gbk")
      expect(parsed.gbk.columns).toEqual(["城市", "收入"])
      expect(parsed.gbk.rows).toBe(2)

      expect(parsed.utf8.encoding).toBe("utf-8-sig")
      expect(parsed.utf8.columns).toEqual(["城市", "收入"])
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
