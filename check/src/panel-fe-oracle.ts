import { execFileSync } from "child_process"
import path from "path"
import { type NumericResult } from "./numeric"

const ROOT = path.resolve(import.meta.dir, "..", "..")
const DID_PATH = "/Users/cw/Desktop/ks/test/did.xlsx"
const DID_SHEET = "Data_原始编码"

function pythonCommand() {
  return process.env.KILLSTATA_PYTHON?.trim() || "/Users/cw/.killstata/venv/bin/python"
}

export function runPanelFeOracle(): NumericResult {
  const script = path.join(ROOT, "check", "scripts", "panel_fe_oracle.py")
  const result = JSON.parse(
    execFileSync(pythonCommand(), [script, DID_PATH, DID_SHEET], { encoding: "utf-8" }),
  ) as NumericResult
  for (const key of ["rowsUsed", "coefficient", "stdError"] as const) {
    if (typeof result[key] !== "number" || !Number.isFinite(result[key])) {
      throw new Error(`Panel FE oracle returned invalid ${key}`)
    }
  }
  return result
}
