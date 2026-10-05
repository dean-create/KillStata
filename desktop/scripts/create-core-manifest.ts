import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { sha256File, validateCoreReleaseManifest, writeCoreReleaseManifest } from "./core-manifest"

const desktopRoot = resolve(import.meta.dir, "..")
const binaryInput = process.env.KILLSTATA_ENGINE_BINARY
const cliRoot = process.env.KILLSTATA_CLI_ROOT
const output = resolve(desktopRoot, process.env.KILLSTATA_CORE_MANIFEST ?? "core-release.json")
const sourceRepository = process.env.KILLSTATA_CORE_SOURCE_REPOSITORY ?? "https://github.com/dean-create/KillStata"

if (!binaryInput) throw new Error("KILLSTATA_ENGINE_BINARY 必须指向待登记的 KillStata Core 二进制")
if (!cliRoot) throw new Error("KILLSTATA_CLI_ROOT 必须指向生成该 Core 的 CLI Git 工作树")

const binary = resolve(desktopRoot, binaryInput)
const git = (args: string[]) => execFileSync("git", ["-C", cliRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const versionResult = Bun.spawnSync([binary, "--version"])
const coreVersion = new TextDecoder().decode(versionResult.stdout).trim()
if (versionResult.exitCode !== 0 || !coreVersion) throw new Error("无法从 Core 二进制读取 --version")

const manifest = validateCoreReleaseManifest({
  schemaVersion: 1,
  coreVersion,
  cliCommit: git(["rev-parse", "HEAD"]),
  sourceRepository,
  sourceDirty: Boolean(git(["status", "--porcelain"])),
  protocolVersion: "v1",
  targetTriple: new TextDecoder().decode(Bun.spawnSync(["rustc", "--print", "host-tuple"]).stdout).trim(),
  binarySha256: await sha256File(binary),
})
await writeCoreReleaseManifest(output, manifest)
console.log(JSON.stringify({ output, ...manifest }, null, 2))
