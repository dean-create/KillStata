import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  assertCoreReleaseForBuild,
  createCoreProvenanceManifest,
  readCoreReleaseManifest,
  sha256File,
  validateCoreProvenanceManifest,
  validateCoreReleaseManifest,
} from "./core-manifest"

const core = {
  schemaVersion: 1,
  coreVersion: "0.1.31",
  cliCommit: "a34d4f7a8d5944d873c26d2b67c6e94c35222fa6",
  sourceRepository: "https://github.com/dean-create/KillStata",
  sourceDirty: false,
  protocolVersion: "v1",
  targetTriple: "aarch64-apple-darwin",
  binarySha256: "1bdd1a7ac3cd5b3117c3d933758ebf3af9737a0b1310f7dea69dd62c1f08f85a",
} as const

describe("Core release provenance", () => {
  test("accepts a complete immutable core manifest", () => {
    expect(validateCoreReleaseManifest(core)).toEqual(core)
  })

  test("rejects dirty snapshots for normal release preparation", () => {
    const dirty = validateCoreReleaseManifest({ ...core, sourceDirty: true })
    expect(() => assertCoreReleaseForBuild(dirty, core.targetTriple)).toThrow("sourceDirty=false")
    expect(() => assertCoreReleaseForBuild(dirty, core.targetTriple, true)).not.toThrow()
  })

  test("rejects target, protocol, repository, and digest mismatches", () => {
    expect(() => assertCoreReleaseForBuild(core, "x86_64-apple-darwin")).toThrow("目标平台")
    expect(() => validateCoreReleaseManifest({ ...core, protocolVersion: "v2" })).toThrow("protocolVersion")
    expect(() => validateCoreReleaseManifest({ ...core, sourceRepository: "http://example.com" })).toThrow("https")
    expect(() => validateCoreReleaseManifest({ ...core, binarySha256: "tampered" })).toThrow("SHA-256")
  })

  test("requires provenance to retain the desktop version and timestamp", () => {
    const provenance = createCoreProvenanceManifest(core, "0.2.0", "2026-08-19T00:00:00.000Z")
    expect(validateCoreProvenanceManifest(provenance)).toMatchObject({ desktopVersion: "0.2.0", generatedAt: "2026-08-19T00:00:00.000Z" })
    expect(() => validateCoreProvenanceManifest({ ...core, desktopVersion: "" })).toThrow("desktopVersion")
  })

  test("rejects a tampered binary against the registered digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "killstata-core-tamper-"))
    const binary = join(root, "core.bin")
    try {
      await writeFile(binary, "tampered-core")
      expect(await sha256File(binary)).not.toBe(core.binarySha256)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("hashes the exact binary bytes and reads a manifest from disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "killstata-core-manifest-"))
    const binary = join(root, "core.bin")
    const manifest = join(root, "core.json")
    try {
      await writeFile(binary, "core-bytes")
      const digest = await sha256File(binary)
      expect(digest).toBe("ca5eede79ea435d7321eecbabb26ba72157ebd0ddbfcf4670b94bc20e626a496")
      await writeFile(manifest, JSON.stringify(core))
      await expect(readCoreReleaseManifest(manifest)).resolves.toEqual(core)
      expect(await readFile(manifest, "utf8")).toContain("a34d4f7a8d5944d873c26d2b67c6e94c35222fa6")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
