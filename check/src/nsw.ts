import { execFileSync } from "child_process"
import path from "path"

export type NswFixture = {
  path: string
  sourceUrl: string
  sha256: string
  rows: number
  columns: string[]
}

export type NswAnalysisFixture = NswFixture & { sourceSha256: string; uniqueUnitCount: number }

const ROOT = path.resolve(import.meta.dir, "..", "..")

function pythonCommand() {
  return process.env.KILLSTATA_PYTHON?.trim() || "/Users/cw/.killstata/venv/bin/python"
}

export function ensureNswFixture(): NswFixture {
  const script = path.join(ROOT, "check", "scripts", "ensure_nsw.py")
  const target = path.join(ROOT, "check", "data", "nsw_dw.dta")
  return JSON.parse(
    execFileSync(pythonCommand(), [script, target], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ) as NswFixture
}

export function ensureNswAnalysisFixture(): NswAnalysisFixture {
  const raw = ensureNswFixture()
  const script = path.join(ROOT, "check", "scripts", "create_nsw_analysis.py")
  const target = path.join(ROOT, "check", "data", "nsw_dw_analysis.csv")
  const derived = JSON.parse(
    execFileSync(pythonCommand(), [script, raw.path, target], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ) as Omit<NswAnalysisFixture, "sourceUrl">
  return { ...derived, sourceUrl: raw.sourceUrl }
}
