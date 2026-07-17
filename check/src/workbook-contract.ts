import { execFileSync } from "child_process"
import path from "path"

const DID_PATH = "/Users/cw/Desktop/ks/test/did.xlsx"
const DIGITAL_PATH = "/Users/cw/Desktop/ks/test/test_datasets.xlsx"
const DID_SHA256 = "1f906de3652b904a1436b1e5169a049ac2bbc948001b072bb2b349b92c7bd5db"
const DIGITAL_SHA256 = "a001c91e746b69d37cb3beeb46b1059065691fa532cb65b1e462eb4c10a02927"

export type WorkbookContractReport = {
  did: {
    sha256: string
    rows: number
    entities: number
    periods: number
    duplicateEntityTimeRows: number
    treatmentReversals: number
  }
  digital: {
    sha256: string
    rows: number
    ambiguousDuplicateEntityTimeRows: number
    compositeEntities: number
    compositeDuplicateEntityTimeRows: number
  }
}

function pythonCommand() {
  return process.env.KILLSTATA_PYTHON?.trim() || "/Users/cw/.killstata/venv/bin/python"
}

export function verifyWorkbookContracts(): WorkbookContractReport {
  const script = path.resolve(import.meta.dir, "..", "scripts", "inspect_workbooks.py")
  const output = execFileSync(pythonCommand(), [script, DID_PATH, DIGITAL_PATH], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  const report = JSON.parse(output) as WorkbookContractReport
  if (report.did.sha256 !== DID_SHA256) throw new Error("did.xlsx 哈希已变化")
  if (report.digital.sha256 !== DIGITAL_SHA256) throw new Error("test_datasets.xlsx 哈希已变化")
  return report
}
