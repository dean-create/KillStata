#!/usr/bin/env bun
import { $ } from "bun"
import fs from "fs"
import pkg from "../package.json"
import { Script } from "@killstata/script"
import { fileURLToPath } from "url"
import { execSync } from "child_process"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)
const cliBinaryName = "killstata"
const packOnly = process.argv.includes("--pack-only")
const windowsPriorityFlag = process.argv.includes("--windows-priority")

function commandExists(cmd: string) {
  try {
    const check = process.platform === "win32" ? "where" : "which"
    execSync(`${check} ${cmd}`, { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

function currentBinaryPackageName() {
  const platform = process.platform === "win32" ? "windows" : process.platform
  return `${pkg.name}-${platform}-${process.arch}`
}

function removePackedTarballs(dirpath: string) {
  for (const entry of fs.readdirSync(dirpath)) {
    if (entry.endsWith(".tgz")) {
      fs.rmSync(`${dirpath}/${entry}`, { force: true })
    }
  }
}

async function localBinaryPath(name: string) {
  const windowsPath = `./dist/${name}/bin/${cliBinaryName}.exe`
  if (await Bun.file(windowsPath).exists()) return windowsPath
  return `./dist/${name}/bin/${cliBinaryName}`
}

const { binaries } = await import("./build.ts")
{
  const name = currentBinaryPackageName()
  const binaryPath = await localBinaryPath(name)
  console.log(`smoke test: running ${binaryPath} --version`)
  await $`${binaryPath} --version`
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
      version: Script.version,
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

const tags = [Script.channel]

const tasks = Object.entries(binaries).map(async ([name]) => {
  removePackedTarballs(`./dist/${name}`)
  if (process.platform !== "win32") {
    await $`chmod -R 755 .`.cwd(`./dist/${name}`)
  }
  await $`bun pm pack`.cwd(`./dist/${name}`)
  if (!packOnly) {
    for (const tag of tags) {
      await $`npm publish *.tgz --access public --tag ${tag}`.cwd(`./dist/${name}`)
    }
  }
})
await Promise.all(tasks)
removePackedTarballs(`./dist/${pkg.name}`)
await $`bun pm pack`.cwd(`./dist/${pkg.name}`)
if (!packOnly) {
  for (const tag of tags) {
    await $`npm publish *.tgz --access public --tag ${tag}`.cwd(`./dist/${pkg.name}`)
  }
}

const hasLinuxContainers = ["killstata-linux-arm64", "killstata-linux-x64"].every((name) => binaries[name])

if (!Script.preview && !packOnly) {
  // Create archives for GitHub release
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
    } else if (commandExists("zip")) {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
    } else {
      console.warn(`zip command not found; skipping GitHub release archive for ${key}`)
    }
  }

  if (!windowsPriorityFlag && hasLinuxContainers) {
    const image = "ghcr.io/anomalyco/killstata"
    const platforms = "linux/amd64,linux/arm64"
    const tags = [`${image}:${Script.version}`, `${image}:latest`]
    const tagFlags = tags.flatMap((t) => ["-t", t])
    await $`docker buildx build --platform ${platforms} ${tagFlags} --push .`
  }
}
