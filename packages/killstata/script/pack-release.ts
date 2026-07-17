#!/usr/bin/env bun
import { $ } from "bun"
import fs from "node:fs"
import path from "node:path"
import pkg from "../package.json"
import { fileURLToPath } from "url"
import { fileIntegrity, parseReleaseVersion, validateReleaseManifest, type ReleaseManifest } from "./release-core"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)
const cliBinaryName = "killstata"
const version = parseReleaseVersion(process.argv.slice(2))
process.env.KILLSTATA_VERSION = version

async function localBinaryPath(name: string) {
  const windowsPath = `./dist/${name}/bin/${cliBinaryName}.exe`
  if (await Bun.file(windowsPath).exists()) return windowsPath
  return `./dist/${name}/bin/${cliBinaryName}`
}

const { binaries } = await import("./build.ts")
{
  const name = `${pkg.name}-windows-x64`
  const binaryPath = await localBinaryPath(name)
  if (!(await Bun.file(binaryPath).exists())) throw new Error(`missing Windows binary: ${binaryPath}`)
  if (process.platform === "win32" && process.arch === "x64") {
    console.log(`smoke test: running ${binaryPath} --version`)
    const builtVersion = await $`${binaryPath} --version`.text().then((output) => output.trim())
    if (builtVersion !== version) throw new Error(`binary version mismatch: expected ${version}, got ${builtVersion}`)
  } else {
    console.log(`smoke test: Windows binary exists; runtime smoke requires Windows x64`)
  }
}

fs.mkdirSync(`./dist/${pkg.name}`, { recursive: true })
fs.cpSync("./bin", `./dist/${pkg.name}/bin`, { recursive: true })
fs.copyFileSync("./script/postinstall.mjs", `./dist/${pkg.name}/postinstall.mjs`)
fs.copyFileSync("./README.md", `./dist/${pkg.name}/README.md`)
fs.copyFileSync("../../LICENSE", `./dist/${pkg.name}/LICENSE`)

await Bun.file(`./dist/${pkg.name}/package.json`).write(
  JSON.stringify(
    {
      name: pkg.name,
      description: pkg.description,
      license: pkg.license,
      author: pkg.author,
      homepage: pkg.homepage,
      repository: pkg.repository,
      keywords: pkg.keywords,
      bin: {
        [pkg.name]: `./bin/${pkg.name}`,
      },
      scripts: {
        postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs",
      },
      version,
      os: ["win32"],
      cpu: ["x64"],
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

const artifacts: ReleaseManifest["artifacts"] = []
for (const name of Object.keys(binaries).sort()) {
  if (process.platform !== "win32") {
    await $`chmod -R 755 .`.cwd(`./dist/${name}`)
  }
  await $`bun pm pack`.cwd(`./dist/${name}`)
  const tarball = path.posix.join("dist", name, `${name}-${version}.tgz`)
  artifacts.push({
    name,
    version,
    tarball,
    integrity: await fileIntegrity(path.resolve(dir, tarball)),
    role: "native",
  })
}

await $`bun pm pack`.cwd(`./dist/${pkg.name}`)
const launcherTarball = path.posix.join("dist", pkg.name, `${pkg.name}-${version}.tgz`)
artifacts.push({
  name: pkg.name,
  version,
  tarball: launcherTarball,
  integrity: await fileIntegrity(path.resolve(dir, launcherTarball)),
  role: "launcher",
  optionalDependencies: binaries,
})

const manifest: ReleaseManifest = {
  schemaVersion: 1,
  version,
  artifacts,
}
validateReleaseManifest(manifest)
await Bun.write("./dist/release-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`release package set ready: ${artifacts.length} packages at ${version}`)
console.log(`manifest: ${path.join(dir, "dist/release-manifest.json")}`)
