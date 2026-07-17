import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export const NPM_PUBLIC_REGISTRY = "https://registry.npmjs.org/"

export const EXPECTED_NATIVE_PACKAGE_NAMES = [
  "killstata-darwin-arm64",
  "killstata-darwin-x64",
  "killstata-darwin-x64-baseline",
  "killstata-linux-arm64",
  "killstata-linux-arm64-musl",
  "killstata-linux-x64",
  "killstata-linux-x64-baseline",
  "killstata-linux-x64-baseline-musl",
  "killstata-linux-x64-musl",
  "killstata-windows-x64",
  "killstata-windows-x64-baseline",
] as const

export interface ReleaseArtifact {
  name: string
  version: string
  tarball: string
  integrity: string
  role: "native" | "launcher"
  optionalDependencies?: Record<string, string>
}

export interface ReleaseManifest {
  schemaVersion: 1
  version: string
  artifacts: ReleaseArtifact[]
}

export interface ReleaseRegistry {
  inspect(name: string, version: string): Promise<{ integrity: string } | undefined>
  publish(artifact: ReleaseArtifact): Promise<void>
  getTag(name: string, tag: string): Promise<string | undefined>
  setTag(name: string, version: string, tag: string): Promise<void>
}

export interface ReleaseResult {
  name: string
  action: "publish" | "skip"
}

export interface ReleaseInspection {
  name: string
  action: "publish" | "skip" | "conflict"
}

export interface PublishReleaseOptions {
  verificationAttempts?: number
  verificationDelayMs?: number
  verifyArtifact?: (artifact: ReleaseArtifact) => Promise<void>
}

export interface NpmCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type NpmCommandRunner = (args: string[]) => Promise<NpmCommandResult>

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export async function fileIntegrity(filepath: string) {
  const hash = createHash("sha512")
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filepath)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", resolve)
  })
  return `sha512-${hash.digest("base64")}`
}

export async function verifyArtifactFiles(artifacts: ReleaseArtifact[], baseDir: string) {
  for (const artifact of artifacts) {
    const actual = await fileIntegrity(path.resolve(baseDir, artifact.tarball))
    if (actual !== artifact.integrity) {
      throw new Error(`${artifact.name}@${artifact.version} tarball changed after packing`)
    }
  }
}

export function parseReleaseVersion(args: string[]) {
  const inline = args.find((arg) => arg.startsWith("--version="))?.slice("--version=".length)
  const index = args.indexOf("--version")
  const version = inline ?? (index >= 0 ? args[index + 1] : undefined)

  if (!version) throw new Error("release requires --version X.Y.Z")
  if (!STABLE_SEMVER.test(version)) throw new Error(`release version must be a stable semantic version: ${version}`)
  return version
}

function jsonScalar(output: string) {
  const value = output.trim()
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === "string" ? parsed : undefined
  } catch {
    return value
  }
}

export class NpmRegistry implements ReleaseRegistry {
  constructor(private readonly run: NpmCommandRunner) {}

  async inspect(name: string, version: string) {
    const result = await this.run([
      "view",
      `${name}@${version}`,
      "dist.integrity",
      "--json",
      "--registry",
      NPM_PUBLIC_REGISTRY,
    ])
    if (result.exitCode !== 0) {
      if (/\bE404\b|404 Not Found/i.test(result.stderr)) return undefined
      throw new Error(`npm view failed for ${name}@${version}: ${result.stderr.trim()}`)
    }
    const integrity = jsonScalar(result.stdout)
    if (!integrity) throw new Error(`npm returned no integrity for ${name}@${version}`)
    return { integrity }
  }

  async publish(artifact: ReleaseArtifact) {
    const result = await this.run([
      "publish",
      artifact.tarball,
      "--access",
      "public",
      "--tag",
      "latest",
      "--registry",
      NPM_PUBLIC_REGISTRY,
    ])
    if (result.exitCode !== 0) {
      throw new Error(`npm publish failed for ${artifact.name}@${artifact.version}: ${result.stderr.trim()}`)
    }
  }

  async getTag(name: string, tag: string) {
    const result = await this.run([
      "view",
      name,
      `dist-tags.${tag}`,
      "--json",
      "--registry",
      NPM_PUBLIC_REGISTRY,
    ])
    if (result.exitCode !== 0) throw new Error(`npm dist-tag lookup failed for ${name}: ${result.stderr.trim()}`)
    return jsonScalar(result.stdout)
  }

  async setTag(name: string, version: string, tag: string) {
    const result = await this.run([
      "dist-tag",
      "add",
      `${name}@${version}`,
      tag,
      "--registry",
      NPM_PUBLIC_REGISTRY,
    ])
    if (result.exitCode !== 0) throw new Error(`npm dist-tag update failed for ${name}: ${result.stderr.trim()}`)
  }
}

export function validateReleaseManifest(manifest: ReleaseManifest) {
  if (manifest.schemaVersion !== 1) throw new Error("unsupported release manifest schema")
  if (!STABLE_SEMVER.test(manifest.version)) throw new Error("release manifest has an invalid semantic version")

  const names = new Set<string>()
  for (const artifact of manifest.artifacts) {
    if (names.has(artifact.name)) throw new Error(`duplicate release artifact: ${artifact.name}`)
    names.add(artifact.name)
    if (artifact.version !== manifest.version) throw new Error(`mixed release versions are not allowed: ${artifact.name}`)
    if (!artifact.tarball.endsWith(".tgz")) throw new Error(`release artifact is not a tarball: ${artifact.name}`)
    const digest = artifact.integrity.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/)?.[1]
    const decoded = digest ? Buffer.from(digest, "base64") : undefined
    if (!digest || decoded?.byteLength !== 64 || decoded.toString("base64") !== digest) {
      throw new Error(`release artifact has invalid integrity: ${artifact.name}`)
    }
  }

  const launchers = manifest.artifacts.filter((artifact) => artifact.role === "launcher")
  const native = manifest.artifacts.filter((artifact) => artifact.role === "native").sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  if (launchers.length !== 1 || launchers[0]?.name !== "killstata") {
    throw new Error("release manifest must contain exactly one killstata launcher")
  }
  if (
    native.length !== EXPECTED_NATIVE_PACKAGE_NAMES.length ||
    native.some((artifact, index) => artifact.name !== EXPECTED_NATIVE_PACKAGE_NAMES[index])
  ) {
    throw new Error(
      `release manifest must contain exactly ${EXPECTED_NATIVE_PACKAGE_NAMES.length} supported native packages`,
    )
  }

  const launcher = launchers[0]!
  const actual = launcher.optionalDependencies ?? {}
  const expected = Object.fromEntries(native.map((artifact) => [artifact.name, manifest.version]))
  if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(expected).sort())) {
    throw new Error("launcher optionalDependencies must exactly match every native release artifact")
  }

  return [...native, launcher]
}

export async function inspectRelease(artifacts: ReleaseArtifact[], registry: ReleaseRegistry) {
  const result: ReleaseInspection[] = []
  for (const artifact of artifacts) {
    const state = await registry.inspect(artifact.name, artifact.version)
    result.push({
      name: artifact.name,
      action: !state ? "publish" : state.integrity === artifact.integrity ? "skip" : "conflict",
    })
  }
  return result
}

export async function publishRelease(
  artifacts: ReleaseArtifact[],
  registry: ReleaseRegistry,
  options: PublishReleaseOptions = {},
) {
  const verificationAttempts = options.verificationAttempts ?? 5
  const verificationDelayMs = options.verificationDelayMs ?? 1_000
  if (options.verifyArtifact) {
    for (const artifact of artifacts) await options.verifyArtifact(artifact)
  }
  // npm 的版本不可覆盖，所以先把全部冲突找完，再上传任何一个包，避免可预防的半发布。
  const inspection = await inspectRelease(artifacts, registry)
  const conflict = inspection.find((item) => item.action === "conflict")
  if (conflict) {
    const artifact = artifacts.find((item) => item.name === conflict.name)!
    throw new Error(`${artifact.name}@${artifact.version} integrity conflict`)
  }

  const result: ReleaseResult[] = []
  for (const [index, artifact] of artifacts.entries()) {
    if (inspection[index]?.action === "skip") {
      result.push({ name: artifact.name, action: "skip" })
      continue
    }

    if (options.verifyArtifact) await options.verifyArtifact(artifact)
    await registry.publish(artifact)
    let verified = false
    for (let attempt = 1; attempt <= verificationAttempts; attempt++) {
      const published = await registry.inspect(artifact.name, artifact.version)
      if (published && published.integrity !== artifact.integrity) {
        throw new Error(`${artifact.name}@${artifact.version} registry integrity changed after publish`)
      }
      if (published?.integrity === artifact.integrity) {
        verified = true
        break
      }
      if (attempt < verificationAttempts && verificationDelayMs > 0) await Bun.sleep(verificationDelayMs)
    }
    if (!verified) {
      throw new Error(`${artifact.name}@${artifact.version} registry verification failed`)
    }
    result.push({ name: artifact.name, action: "publish" })
  }

  const launcher = artifacts.at(-1)
  if (!launcher || launcher.role !== "launcher") throw new Error("launcher must be published last")
  if ((await registry.getTag(launcher.name, "latest")) !== launcher.version) {
    await registry.setTag(launcher.name, launcher.version, "latest")
  }
  if ((await registry.getTag(launcher.name, "latest")) !== launcher.version) {
    throw new Error(`${launcher.name}@latest does not point to ${launcher.version} after dist-tag repair`)
  }

  return result
}
