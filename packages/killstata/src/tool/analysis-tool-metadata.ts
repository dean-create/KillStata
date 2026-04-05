import type { NumericSnapshotDocument } from "./analysis-grounding"

export function numericSnapshotPreview(snapshot: NumericSnapshotDocument | undefined) {
  if (!snapshot) return undefined
  return {
    scope: snapshot.scope,
    entryCount: snapshot.entries.length,
    entries: snapshot.entries.slice(0, 8),
  }
}
