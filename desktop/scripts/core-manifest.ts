import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"

export const CORE_MANIFEST_SCHEMA_VERSION = 1 as const
export const DESKTOP_ENGINE_PROTOCOL_VERSION = "v1" as const

export type CoreReleaseManifest = {
  schemaVersion: typeof CORE_MANIFEST_SCHEMA_VERSION
  coreVersion: string
  cliCommit: string
  sourceRepository: string
  sourceDirty: boolean
  protocolVersion: typeof DESKTOP_ENGINE_PROTOCOL_VERSION
  targetTriple: string
  binarySha256: string
}

export type CoreProvenanceManifest = CoreReleaseManifest & {
  desktopVersion: string
  generatedAt: string
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Core manifest 必须是 JSON 对象")
  }
  return value as Record<string, unknown>
}

function requiredText(input: Record<string, unknown>, field: string, maximum: number) {
  const value = input[field]
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > maximum || /[\r\n]/.test(value)) {
    throw new Error(`Core manifest 的 ${field} 无效`)
  }
  return value
}

function validateCommit(value: string) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) {
    throw new Error("Core manifest 的 cliCommit 必须是 40 或 64 位 Git commit")
  }
  return value.toLowerCase()
}

function validateRepository(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Core manifest 的 sourceRepository 必须是合法 URL")
  }
  if (url.protocol !== "https:") {
    throw new Error("Core manifest 的 sourceRepository 必须使用 https")
  }
  return value
}

function validateTargetTriple(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
    throw new Error("Core manifest 的 targetTriple 无效")
  }
  return value
}

function validateSha256(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error("Core manifest 的 binarySha256 必须是 SHA-256 hex")
  }
  return value.toLowerCase()
}

export function validateCoreReleaseManifest(value: unknown): CoreReleaseManifest {
  const input = record(value)
  if (input.schemaVersion !== CORE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`不支持的 Core manifest schema：${String(input.schemaVersion)}`)
  }
  const coreVersion = requiredText(input, "coreVersion", 256)
  const cliCommit = validateCommit(requiredText(input, "cliCommit", 64))
  const sourceRepository = validateRepository(requiredText(input, "sourceRepository", 512))
  if (typeof input.sourceDirty !== "boolean") throw new Error("Core manifest 的 sourceDirty 无效")
  if (input.protocolVersion !== DESKTOP_ENGINE_PROTOCOL_VERSION) {
    throw new Error("Core manifest 的 protocolVersion 必须是 v1")
  }
  const targetTriple = validateTargetTriple(requiredText(input, "targetTriple", 128))
  const binarySha256 = validateSha256(requiredText(input, "binarySha256", 128))
  return {
    schemaVersion: CORE_MANIFEST_SCHEMA_VERSION,
    coreVersion,
    cliCommit,
    sourceRepository,
    sourceDirty: input.sourceDirty,
    protocolVersion: DESKTOP_ENGINE_PROTOCOL_VERSION,
    targetTriple,
    binarySha256,
  }
}

export function validateCoreProvenanceManifest(value: unknown): CoreProvenanceManifest {
  const input = record(value)
  const core = validateCoreReleaseManifest(input)
  const desktopVersion = requiredText(input, "desktopVersion", 128)
  const generatedAt = requiredText(input, "generatedAt", 128)
  return { ...core, desktopVersion, generatedAt }
}

export async function readCoreReleaseManifest(filepath: string): Promise<CoreReleaseManifest> {
  let text: string
  try {
    text = await readFile(filepath, "utf8")
  } catch {
    throw new Error(`找不到 Core manifest：${filepath}`)
  }
  try {
    return validateCoreReleaseManifest(JSON.parse(text))
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Core manifest 无效")
  }
}

export async function readCoreProvenanceManifest(filepath: string): Promise<CoreProvenanceManifest> {
  let text: string
  try {
    text = await readFile(filepath, "utf8")
  } catch {
    throw new Error(`找不到 Core provenance manifest：${filepath}`)
  }
  try {
    return validateCoreProvenanceManifest(JSON.parse(text))
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Core provenance manifest 无效")
  }
}

export function assertCoreReleaseForBuild(manifest: CoreReleaseManifest, targetTriple: string, allowDirty = false) {
  if (manifest.targetTriple !== targetTriple) {
    throw new Error(`Core manifest 目标平台不匹配：期望 ${targetTriple}，实际 ${manifest.targetTriple}`)
  }
  if (manifest.sourceDirty && !allowDirty) {
    throw new Error("Core manifest 来自未清洁的 CLI 工作树；正式发布必须使用 sourceDirty=false 的 Core 快照")
  }
}

export async function sha256File(filepath: string): Promise<string> {
  const hash = createHash("sha256")
  hash.update(await readFile(filepath))
  return hash.digest("hex")
}

export function createCoreReleaseManifest(input: CoreReleaseManifest): CoreReleaseManifest {
  return validateCoreReleaseManifest(input)
}

export async function writeCoreReleaseManifest(filepath: string, manifest: CoreReleaseManifest) {
  const validated = validateCoreReleaseManifest(manifest)
  await writeFile(filepath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 })
}

export function createCoreProvenanceManifest(
  core: CoreReleaseManifest,
  desktopVersion: string,
  generatedAt = new Date().toISOString(),
): CoreProvenanceManifest {
  const validated = validateCoreReleaseManifest(core)
  if (!desktopVersion.trim() || /[\r\n]/.test(desktopVersion)) throw new Error("Desktop version 无效")
  return validateCoreProvenanceManifest({ ...validated, desktopVersion, generatedAt })
}

export async function writeCoreProvenanceManifest(filepath: string, manifest: CoreProvenanceManifest) {
  const validated = validateCoreProvenanceManifest(manifest)
  await writeFile(filepath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 })
}
