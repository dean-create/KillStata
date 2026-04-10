#!/usr/bin/env bun

import { $ } from "bun"
import { execSync } from "child_process"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
const rootDir = path.resolve(dir, "../..")
process.chdir(dir)

const args = process.argv.slice(2)

function readOption(name: string) {
  const exact = `--${name}`
  const prefixed = `--${name}=`
  const inline = args.find((arg) => arg.startsWith(prefixed))
  if (inline) return inline.slice(prefixed.length)
  const index = args.indexOf(exact)
  if (index === -1) return undefined
  return args[index + 1]
}

function hasFlag(name: string) {
  return args.includes(`--${name}`)
}

function fail(message: string): never {
  console.error(`release failed: ${message}`)
  process.exit(1)
}

function gitText(command: string) {
  return execSync(command, {
    cwd: rootDir,
    encoding: "utf-8",
  }).trim()
}

function tempNpmrcPath() {
  return path.join(dir, ".npmrc.release-temp")
}

function cleanupTempNpmrc(filepath: string) {
  fs.rmSync(filepath, { force: true })
}

const manualVersion = readOption("version")
const bump = (readOption("bump") ?? "patch").toLowerCase()
const dryRun = hasFlag("dry-run")
const skipTypecheck = hasFlag("skip-typecheck")
const allowDirty = hasFlag("allow-dirty")
const allowUnpushed = hasFlag("allow-unpushed")
const validBumps = new Set(["patch", "minor", "major"])

if (manualVersion && hasFlag("bump")) {
  fail("use either --version or --bump, not both")
}

if (!manualVersion && !validBumps.has(bump)) {
  fail(`unsupported bump "${bump}". Use patch, minor, or major.`)
}

const branch = gitText("git branch --show-current")
if (!["main", "master"].includes(branch)) {
  fail(`releases must run from main/master. Current branch: ${branch}`)
}

const status = gitText("git status --short")
if (status && !allowDirty) {
  fail("working tree is not clean. Commit or stash changes, or pass --allow-dirty.")
}

gitText(`git fetch origin ${branch}`)
const divergence = gitText(`git rev-list --left-right --count origin/${branch}...HEAD`)
const [behindRaw = "0", aheadRaw = "0"] = divergence.split(/\s+/)
const behind = Number(behindRaw) || 0
const ahead = Number(aheadRaw) || 0

if ((behind > 0 || ahead > 0) && !allowUnpushed) {
  fail(`local branch is not in sync with origin/${branch}. behind=${behind}, ahead=${ahead}. Pass --allow-unpushed to override.`)
}

const previousUserConfig = process.env.NPM_CONFIG_USERCONFIG
const previousBump = process.env.KILLSTATA_BUMP
const previousVersion = process.env.KILLSTATA_VERSION

if (manualVersion) {
  process.env.KILLSTATA_VERSION = manualVersion
  delete process.env.KILLSTATA_BUMP
} else {
  process.env.KILLSTATA_BUMP = bump
  delete process.env.KILLSTATA_VERSION
}

const { Script } = await import("@killstata/script")
const targetVersion = Script.version

console.log(`release plan`)
console.log(`  branch: ${branch}`)
console.log(`  version: ${targetVersion}`)
console.log(`  channel: ${Script.channel}`)
console.log(`  mode: windows-priority latest`)

if (!skipTypecheck) {
  console.log(`running typecheck`)
  await $`bun run typecheck`.cwd(rootDir)
}

if (dryRun) {
  console.log(`dry run complete`)
  process.env.NPM_CONFIG_USERCONFIG = previousUserConfig
  process.env.KILLSTATA_BUMP = previousBump
  process.env.KILLSTATA_VERSION = previousVersion
  process.exit(0)
}

const token = process.env.NPM_TOKEN?.trim()
if (!token) {
  fail("NPM_TOKEN is required. Set it in the environment before running the release script.")
}

const npmrcPath = tempNpmrcPath()
fs.writeFileSync(npmrcPath, `//registry.npmjs.org/:_authToken=${token}\nregistry=https://registry.npmjs.org/\n`, "ascii")
process.env.NPM_CONFIG_USERCONFIG = npmrcPath

try {
  console.log(`publishing packages`)
  await $`bun run publish:windows:latest`.cwd(dir)

  console.log(`verifying npm registry`)
  const cliVersion = (await $`npm view killstata@${targetVersion} version --json`.cwd(dir).text()).trim()
  const windowsVersion = (await $`npm view killstata-windows-x64@${targetVersion} version --json`.cwd(dir).text()).trim()
  const distTags = (await $`npm view killstata dist-tags --json`.cwd(dir).text()).trim()

  console.log(`published killstata version: ${cliVersion}`)
  console.log(`published killstata-windows-x64 version: ${windowsVersion}`)
  console.log(`killstata dist-tags: ${distTags}`)
  console.log(`done`)
  console.log(`windows users can install with: npm i -g killstata@latest`)
} finally {
  cleanupTempNpmrc(npmrcPath)
  process.env.NPM_CONFIG_USERCONFIG = previousUserConfig
  process.env.KILLSTATA_BUMP = previousBump
  process.env.KILLSTATA_VERSION = previousVersion
}
