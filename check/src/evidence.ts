import { type BenchmarkCatalog, resolveDatasetForTool } from "./catalog"

export type EvidenceGrade = "A" | "B" | "W" | "S" | "PENDING"
export type EvidenceStatus = "PASS" | "SAFE_REJECTION" | "PENDING"

export type EvidenceRecord = {
  toolId: string
  datasetId: string
  grade: EvidenceGrade
  status: EvidenceStatus
  harness?: { schemaAccepted: boolean; executorCalls: number; lifecycle: string[] }
  numericOracle?: { name: string; matched: boolean }
  safety?: { rejected: boolean; reason: string }
}

export function validateEvidenceRecord(catalog: BenchmarkCatalog, record: EvidenceRecord) {
  resolveDatasetForTool(catalog, record.toolId, record.datasetId)
  if (record.grade === "A" || record.grade === "B") {
    if (!record.numericOracle?.matched) throw new Error(`${record.grade} evidence requires an independent numeric oracle`)
  }
  if (record.grade === "W") {
    if (!record.harness?.schemaAccepted || record.harness.executorCalls !== 1) {
      throw new Error("W evidence requires a successful Harness execution")
    }
  }
  if (record.grade === "S") {
    if (record.status !== "SAFE_REJECTION") throw new Error("S evidence must be recorded as SAFE_REJECTION")
    if (!record.safety?.rejected) throw new Error("S evidence requires a concrete rejected safety gate")
  }
  if (record.status === "PASS" && record.grade === "S") throw new Error("safe rejection cannot be marked PASS")
  return { valid: true as const }
}

const rank: Record<EvidenceGrade, number> = { PENDING: 0, S: 1, W: 2, B: 3, A: 4 }

export function aggregateToolEvidence(records: EvidenceRecord[]) {
  if (!records.length) throw new Error("cannot aggregate an empty evidence set")
  const selected = records.reduce((best, candidate) => (rank[candidate.grade] > rank[best.grade] ? candidate : best))
  return { toolId: selected.toolId, grade: selected.grade, status: selected.status }
}
