import { $, semver } from "bun"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const cliPkgPath = path.resolve(import.meta.dir, "../../killstata/package.json")
const cliPkg = await Bun.file(cliPkgPath)
  .json()
  .catch(() => ({ name: "killstata", version: "0.1.0" }))
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  KILLSTATA_CHANNEL: process.env["KILLSTATA_CHANNEL"],
  KILLSTATA_BUMP: process.env["KILLSTATA_BUMP"],
  KILLSTATA_VERSION: process.env["KILLSTATA_VERSION"],
}
const CURRENT_BRANCH = await $`git branch --show-current`.text().then((x) => x.trim())
const CHANNEL = await (async () => {
  if (env.KILLSTATA_CHANNEL) return env.KILLSTATA_CHANNEL
  if (env.KILLSTATA_BUMP) return "latest"
  if (env.KILLSTATA_VERSION && !env.KILLSTATA_VERSION.startsWith("0.0.0-")) return "latest"
  if (CURRENT_BRANCH === "main" || CURRENT_BRANCH === "master") return "latest"
  return CURRENT_BRANCH
})()
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = await (async () => {
  if (env.KILLSTATA_VERSION) return env.KILLSTATA_VERSION
  if (IS_PREVIEW) return `0.0.0-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  const version = await fetch(`https://registry.npmjs.org/${encodeURIComponent(cliPkg.name)}/latest`)
    .then(async (res) => {
      if (res.status === 404) return null
      if (!res.ok) throw new Error(res.statusText)
      return res.json()
    })
    .then((data: any) => data?.version ?? null)

  if (!version) return cliPkg.version

  const [major, minor, patch] = version.split(".").map((x: string) => Number(x) || 0)
  const t = env.KILLSTATA_BUMP?.toLowerCase()
  if (t === "major") return `${major + 1}.0.0`
  if (t === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
})()

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
}
console.log(`killstata script`, JSON.stringify(Script, null, 2))
