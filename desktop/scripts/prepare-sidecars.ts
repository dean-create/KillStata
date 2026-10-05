import { chmod, copyFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import packageDefinition from "../package.json"
import { assertCoreReleaseForBuild, createCoreProvenanceManifest, readCoreReleaseManifest, sha256File, writeCoreProvenanceManifest } from "./core-manifest"

const desktopRoot = resolve(import.meta.dir, "..")
const coreBinaryInput = process.env.KILLSTATA_ENGINE_BINARY
const coreManifestInput = process.env.KILLSTATA_CORE_MANIFEST
const coreVersion = process.env.KILLSTATA_ENGINE_VERSION
const allowDirty = process.env.KILLSTATA_ALLOW_DIRTY_CORE === "true"

if (!coreBinaryInput) {
  throw new Error("KILLSTATA_ENGINE_BINARY 必须指向已验证的 KillStata 原生核心二进制")
}
if (!coreManifestInput) {
  throw new Error("KILLSTATA_CORE_MANIFEST 必须指向已登记的 Core manifest；本地 dirty 验收也必须显式提供")
}
if (!coreVersion) {
  throw new Error("KILLSTATA_ENGINE_VERSION 必须与核心二进制的 --version 输出完全一致")
}

const coreBinary = resolve(desktopRoot, coreBinaryInput)
if (!existsSync(coreBinary)) {
  throw new Error(`找不到指定的 KillStata 核心二进制：${coreBinary}`)
}

const target = Bun.spawnSync(["rustc", "--print", "host-tuple"])
const targetTriple = new TextDecoder().decode(target.stdout).trim()
if (target.exitCode !== 0 || !targetTriple) {
  throw new Error("无法读取当前 Rust 目标三元组")
}

const coreManifest = await readCoreReleaseManifest(resolve(desktopRoot, coreManifestInput))
assertCoreReleaseForBuild(coreManifest, targetTriple, allowDirty)
if (coreManifest.coreVersion !== coreVersion) {
  throw new Error(`Core manifest 版本不匹配：期望 ${coreVersion}，实际 ${coreManifest.coreVersion}`)
}

const actualHash = await sha256File(coreBinary)
if (actualHash !== coreManifest.binarySha256) {
  throw new Error(`Core 二进制 SHA-256 不匹配：期望 ${coreManifest.binarySha256}，实际 ${actualHash}`)
}

const versionCheck = Bun.spawnSync([coreBinary, "--version"])
const actualVersion = new TextDecoder().decode(versionCheck.stdout).trim()
if (versionCheck.exitCode !== 0 || actualVersion !== coreVersion) {
  throw new Error(`KillStata 核心版本不匹配：期望 ${coreVersion}，实际 ${actualVersion || "不可读取"}`)
}

const sidecarDirectory = join(desktopRoot, "src-tauri", "binaries")
const resourceDirectory = join(desktopRoot, "src-tauri", "resources")
const coreSidecar = join(sidecarDirectory, `killstata-core-${targetTriple}`)
const provenancePath = join(resourceDirectory, "killstata-core-provenance.json")
await mkdir(sidecarDirectory, { recursive: true })
await mkdir(resourceDirectory, { recursive: true })

await copyFile(coreBinary, coreSidecar)
await writeCoreProvenanceManifest(provenancePath, createCoreProvenanceManifest({ ...coreManifest, binarySha256: actualHash }, packageDefinition.version))
await chmod(coreSidecar, 0o755)

console.log(JSON.stringify({ targetTriple, coreVersion, cliCommit: coreManifest.cliCommit, binarySha256: actualHash, coreSidecar, provenancePath }))
