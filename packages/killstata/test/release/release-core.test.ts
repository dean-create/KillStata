import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  EXPECTED_NATIVE_PACKAGE_NAMES,
  fileIntegrity,
  inspectRelease,
  NpmRegistry,
  parseReleaseVersion,
  publishRelease,
  validateReleaseManifest,
  verifyArtifactFiles,
  type ReleaseArtifact,
  type ReleaseManifest,
  type ReleaseRegistry,
} from "../../script/release-core"

const VERSION = "0.1.26"
const VALID_INTEGRITY =
  "sha512-m3HSJL1i83hdltRq0+o9czGb+8KJDKra4t/3JRlnPKcjI8PZm6XBHXx6zG4UuMXaDEZjR1wuXDre9G9zvN7AQw=="

function native(name: string, integrity = VALID_INTEGRITY): ReleaseArtifact {
  return {
    name,
    version: VERSION,
    tarball: `dist/${name}/${name}-${VERSION}.tgz`,
    integrity,
    role: "native",
  }
}

function launcher(dependencies: Record<string, string>, integrity = VALID_INTEGRITY): ReleaseArtifact {
  return {
    name: "killstata",
    version: VERSION,
    tarball: `dist/killstata/killstata-${VERSION}.tgz`,
    integrity,
    role: "launcher",
    optionalDependencies: dependencies,
  }
}

function completeNativeArtifacts() {
  return EXPECTED_NATIVE_PACKAGE_NAMES.map((name) => native(name))
}

function completeDependencies() {
  return Object.fromEntries(EXPECTED_NATIVE_PACKAGE_NAMES.map((name) => [name, VERSION]))
}

function manifest(artifacts: ReleaseArtifact[]): ReleaseManifest {
  return {
    schemaVersion: 1,
    version: VERSION,
    artifacts,
  }
}

class MemoryRegistry implements ReleaseRegistry {
  readonly published: string[] = []
  readonly tags: string[] = []
  readonly packages = new Map<string, string>()
  latest: string | undefined
  persistPublishedArtifact = true
  visibilityDelayReads = 0
  private readonly delayed = new Map<string, number>()

  key(name: string, version: string) {
    return `${name}@${version}`
  }

  async inspect(name: string, version: string) {
    const key = this.key(name, version)
    const remaining = this.delayed.get(key) ?? 0
    if (remaining > 0) {
      this.delayed.set(key, remaining - 1)
      return undefined
    }
    const integrity = this.packages.get(key)
    return integrity ? { integrity } : undefined
  }

  async publish(artifact: ReleaseArtifact) {
    this.published.push(artifact.name)
    if (this.persistPublishedArtifact) {
      const key = this.key(artifact.name, artifact.version)
      this.packages.set(key, artifact.integrity)
      this.delayed.set(key, this.visibilityDelayReads)
      if (artifact.role === "launcher") this.latest = artifact.version
    }
  }

  async getTag(name: string, tag: string) {
    if (name === "killstata" && tag === "latest") return this.latest
    return undefined
  }

  async setTag(name: string, version: string, tag: string) {
    this.tags.push(`${name}@${version}:${tag}`)
    if (name === "killstata" && tag === "latest") this.latest = version
  }
}

describe("npm release protocol", () => {
  test("authorizes only the Windows x64 native package", () => {
    expect(EXPECTED_NATIVE_PACKAGE_NAMES).toEqual(["killstata-windows-x64"])
  })

  test("exposes one pack command and one publish command without legacy Windows aliases", async () => {
    const packageJson = await Bun.file(new URL("../../package.json", import.meta.url)).json()
    const scripts = packageJson.scripts as Record<string, string>
    const releaseSource = await Bun.file(new URL("../../script/release.ts", import.meta.url)).text()

    expect(scripts["pack:release"]).toBe("bun run script/pack-release.ts")
    expect(scripts["release:npm"]).toBe("bun run script/release.ts")
    expect(Object.keys(scripts).filter((name) => /^(publish:|release:windows|pack:publish)/.test(name))).toEqual([])
    expect(releaseSource).not.toContain("NPM_TOKEN")
    expect(releaseSource).not.toContain(".npmrc.release-temp")
  })

  test("uses npm standard authentication without putting a token in command arguments", async () => {
    const calls: string[][] = []
    const registry = new NpmRegistry(async (args) => {
      calls.push(args)
      if (args[0] === "view" && args[1] === `missing@${VERSION}`) {
        return { exitCode: 1, stdout: "", stderr: "npm error code E404" }
      }
      if (args[0] === "view" && args[2] === "dist.integrity") {
        return { exitCode: 0, stdout: '"sha512-remote"\n', stderr: "" }
      }
      if (args[0] === "view" && args[2] === "dist-tags.latest") {
        return { exitCode: 0, stdout: `"${VERSION}"\n`, stderr: "" }
      }
      return { exitCode: 0, stdout: "", stderr: "" }
    })

    expect(await registry.inspect("missing", VERSION)).toBeUndefined()
    expect(await registry.inspect("killstata-windows-x64", VERSION)).toEqual({ integrity: "sha512-remote" })
    await registry.publish(native("killstata-windows-x64"))
    expect(await registry.getTag("killstata", "latest")).toBe(VERSION)
    await registry.setTag("killstata", VERSION, "latest")

    expect(calls).toContainEqual([
      "publish",
      `dist/killstata-windows-x64/killstata-windows-x64-${VERSION}.tgz`,
      "--access",
      "public",
      "--tag",
      "latest",
      "--registry",
      "https://registry.npmjs.org/",
    ])
    expect(calls).toContainEqual([
      "dist-tag",
      "add",
      `killstata@${VERSION}`,
      "latest",
      "--registry",
      "https://registry.npmjs.org/",
    ])
    expect(calls.flat().join(" ")).not.toContain("NPM_TOKEN")
    expect(calls.flat().join(" ")).not.toContain("_authToken")
    expect(calls.every((args) => args.includes("https://registry.npmjs.org/"))).toBe(true)
  })

  test("rejects a self-consistent manifest that omits supported platforms", () => {
    const unsupported = native("killstata-linux-x64")
    expect(() => validateReleaseManifest(manifest([unsupported, launcher({ [unsupported.name]: VERSION })]))).toThrow(
      `exactly ${EXPECTED_NATIVE_PACKAGE_NAMES.length} supported native packages`,
    )
  })

  test("rejects malformed SHA-512 SRI and detects a tarball changed after packing", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-release-tamper-"))
    const filepath = path.join(directory, "artifact.tgz")
    try {
      await Bun.write(filepath, "original")
      const artifact = native("killstata-windows-x64", await fileIntegrity(filepath))
      artifact.tarball = "artifact.tgz"
      await verifyArtifactFiles([artifact], directory)

      await Bun.write(filepath, "tampered")
      await expect(verifyArtifactFiles([artifact], directory)).rejects.toThrow("changed after packing")
      expect(() => validateReleaseManifest(manifest([{ ...artifact, integrity: "sha512-x" }, launcher({
        [artifact.name]: VERSION,
      })]))).toThrow("invalid integrity")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("computes npm-compatible SHA-512 integrity for a packed tarball", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-release-integrity-"))
    const filepath = path.join(directory, "artifact.tgz")
    try {
      await Bun.write(filepath, "hello")
      expect(await fileIntegrity(filepath)).toBe(
        "sha512-m3HSJL1i83hdltRq0+o9czGb+8KJDKra4t/3JRlnPKcjI8PZm6XBHXx6zG4UuMXaDEZjR1wuXDre9G9zvN7AQw==",
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("requires an explicit stable semantic version", () => {
    expect(() => parseReleaseVersion([])).toThrow("--version")
    expect(() => parseReleaseVersion(["--version", "next"])).toThrow("semantic version")
    expect(parseReleaseVersion(["--version=0.1.26"])).toBe(VERSION)
  })

  test("orders every native package before the launcher", () => {
    const nativeArtifacts = completeNativeArtifacts().reverse()
    const result = validateReleaseManifest(manifest([launcher(completeDependencies()), ...nativeArtifacts]))

    expect(result.map((item) => item.name)).toEqual([...EXPECTED_NATIVE_PACKAGE_NAMES, "killstata"])
  })

  test("rejects a launcher that omits a native package or points at another version", () => {
    const nativeArtifacts = completeNativeArtifacts()
    const missing = completeDependencies()
    delete missing[EXPECTED_NATIVE_PACKAGE_NAMES[0]]
    const wrongVersion = completeDependencies()
    wrongVersion[EXPECTED_NATIVE_PACKAGE_NAMES[0]] = "0.1.25"

    expect(() => validateReleaseManifest(manifest([...nativeArtifacts, launcher(missing)]))).toThrow(
      "optionalDependencies",
    )
    expect(() => validateReleaseManifest(manifest([...nativeArtifacts, launcher(wrongVersion)]))).toThrow(
      "optionalDependencies",
    )
  })

  test("resumes a partial release, skips identical artifacts, and publishes the launcher last", async () => {
    const windows = native("killstata-windows-x64")
    const cli = launcher({ [windows.name]: VERSION })
    const registry = new MemoryRegistry()
    registry.packages.set(registry.key(windows.name, VERSION), windows.integrity)

    const result = await publishRelease([windows, cli], registry)

    expect(result).toEqual([
      { name: windows.name, action: "skip" },
      { name: cli.name, action: "publish" },
    ])
    expect(registry.published).toEqual([cli.name])
  })

  test("dry-run inspection reports publish, skip, and conflict without mutating the registry", async () => {
    const windows = native("killstata-windows-x64")
    const cli = launcher({ [windows.name]: VERSION })
    const registry = new MemoryRegistry()
    registry.packages.set(registry.key(windows.name, VERSION), windows.integrity)
    registry.packages.set(registry.key(cli.name, VERSION), "sha512-conflict")

    expect(await inspectRelease([windows, cli], registry)).toEqual([
      { name: windows.name, action: "skip" },
      { name: cli.name, action: "conflict" },
    ])
    expect(registry.published).toEqual([])
  })

  test("stops before publishing when an immutable version has different content", async () => {
    const windows = native("killstata-windows-x64")
    const cli = launcher({ [windows.name]: VERSION })
    const registry = new MemoryRegistry()
    registry.packages.set(registry.key(windows.name, VERSION), "sha512-someone-else")

    await expect(publishRelease([windows, cli], registry)).rejects.toThrow(
      "integrity conflict",
    )
    expect(registry.published).toEqual([])
  })

  test("verifies registry integrity after each upload instead of trusting npm exit code", async () => {
    const windows = native("killstata-windows-x64")
    const cli = launcher({ [windows.name]: VERSION })
    const registry = new MemoryRegistry()
    registry.persistPublishedArtifact = false

    await expect(
      publishRelease([windows, cli], registry, { verificationDelayMs: 0 }),
    ).rejects.toThrow("registry verification failed")
    expect(registry.published).toEqual([windows.name])
  })

  test("rechecks a tarball immediately before upload", async () => {
    const windows = native("killstata-windows-x64")
    const cli = launcher({ [windows.name]: VERSION })
    const registry = new MemoryRegistry()
    let windowsChecks = 0

    await expect(
      publishRelease([windows, cli], registry, {
        verifyArtifact: async (artifact) => {
          if (artifact.name === windows.name && ++windowsChecks === 2) throw new Error("tarball changed after packing")
        },
      }),
    ).rejects.toThrow("changed after packing")
    expect(registry.published).toEqual([])
  })

  test("retries bounded registry verification while a published version is propagating", async () => {
    const windows = native("killstata-windows-x64")
    const cli = launcher({ [windows.name]: VERSION })
    const registry = new MemoryRegistry()
    registry.visibilityDelayReads = 2

    const result = await publishRelease([windows, cli], registry, {
      verificationAttempts: 3,
      verificationDelayMs: 0,
    })

    expect(result.map((item) => item.action)).toEqual(["publish", "publish"])
  })

  test("repairs the latest tag when every immutable artifact already exists", async () => {
    const windows = native("killstata-windows-x64")
    const cli = launcher({ [windows.name]: VERSION })
    const registry = new MemoryRegistry()
    registry.packages.set(registry.key(windows.name, VERSION), windows.integrity)
    registry.packages.set(registry.key(cli.name, VERSION), cli.integrity)
    registry.latest = "0.1.24"

    const result = await publishRelease([windows, cli], registry)

    expect(result.every((item) => item.action === "skip")).toBe(true)
    expect(registry.tags).toEqual([`killstata@${VERSION}:latest`])
    expect(registry.latest).toBe(VERSION)
  })
})
