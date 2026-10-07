export type CleanupCommand = {
  matched: boolean
  dryRun: boolean
  keepTopSessions?: number
}

export function parseCleanupCommand(input: string): CleanupCommand {
  const tokens = input.trim().split(/\s+/)
  if (tokens[0] !== "/cleanup") return { matched: false, dryRun: false }

  let keepTopSessions: number | undefined
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!
    const raw = token.startsWith("keep=") ? token.slice("keep=".length) : token === "keep" ? tokens[index + 1] : undefined
    if (raw === undefined) continue
    const parsed = Number(raw)
    if (Number.isInteger(parsed) && parsed > 0) keepTopSessions = parsed
    if (token === "keep") index += 1
  }

  return {
    matched: true,
    dryRun: tokens.includes("--dry-run"),
    ...(keepTopSessions ? { keepTopSessions } : {}),
  }
}
