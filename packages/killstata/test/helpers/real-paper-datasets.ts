import crypto from "crypto"
import fs from "fs"
import path from "path"

export type RealPaperDatasetContract = {
  did: {
    file: string
    sha256: string
    sheet: string
    rows: number
    columns: number
    headers: string[]
    entityVar: string
    timeVar: string
    entities: number
    periods: number
    duplicateEntityTimeRows: number
    everTreated: number
    neverTreated: number
    treatedRows: number
    cohorts: number[]
    rawNeverTreatedCohortValue: string
    rawNeverTreatedCohortRows: number
    importedNeverTreatedCohortRepresentation: "missing"
    importedMissingCohortRows: number
  }
  digital: {
    file: string
    sha256: string
    sheet: string
    rows: number
    columns: number
    headers: string[]
    plannedDerivedColumns: string[]
    ambiguousEntityVar: string
    timeVar: string
    ambiguousEntities: number
    distinctDuplicateEntityTimeKeys: number
    duplicateEntityTimeRows: number
    rowsInDuplicateEntityTimeGroups: number
    ambiguousEntityValue: string
    compositeEntities: number
    periods: number
  }
}

const DEFAULT_REAL_PAPER_DATA_DIR = "/Users/cw/Desktop/ks/test"

export function loadRealPaperDatasetContract(): RealPaperDatasetContract {
  const contractPath = path.resolve(process.cwd(), "..", "..", "test", "real-paper-chain", "dataset-contract.json")
  return JSON.parse(fs.readFileSync(contractPath, "utf-8")) as RealPaperDatasetContract
}

export function resolveRealPaperDatasets() {
  const contract = loadRealPaperDatasetContract()
  const root = process.env.KILLSTATA_REAL_PAPER_DATA_DIR?.trim() || DEFAULT_REAL_PAPER_DATA_DIR
  return {
    didPath: path.join(root, contract.did.file),
    digitalPath: path.join(root, contract.digital.file),
  }
}

export function sha256File(filePath: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
}

export function verifyRealPaperDataset(filePath: string, expectedSha256: string) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `真实论文测试数据不存在：${filePath}。请恢复该文件，或把 KILLSTATA_REAL_PAPER_DATA_DIR 指向包含两份 Excel 的目录。`,
    )
  }
  const actual = sha256File(filePath)
  if (actual !== expectedSha256) {
    throw new Error(`真实论文测试数据已变化：${path.basename(filePath)}；期望 SHA-256 ${expectedSha256}，实际 ${actual}`)
  }
}
