#!/usr/bin/env bun

import { $ } from "bun"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "url"
import {
  inspectRelease,
  NpmRegistry,
  parseReleaseVersion,
  publishRelease,
  validateReleaseManifest,
  verifyArtifactFiles,
  type NpmCommandResult,
  type ReleaseManifest,
} from "./release-core"

const dir = fileURLToPath(new URL("..", import.meta.url))
const rootDir = path.resolve(dir, "../..")
process.chdir(dir)

const args = process.argv.slice(2)
const version = parseReleaseVersion(args)
const dryRun = args.includes("--dry-run")

function fail(message: string): never {
  console.error(`release failed: ${message}`)
  process.exit(1)
}

function gitText(args: string[]) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf-8",
  }).trim()
}

console.log(`release plan`)
console.log(`  version: ${version}`)
console.log(`  mode: ${dryRun ? "dry-run" : "publish"}`)
console.log(`  order: native packages, then killstata launcher`)

if (!dryRun) {
  const branch = gitText(["branch", "--show-current"])
  if (!["main", "master"].includes(branch)) fail(`releases must run from main/master. Current branch: ${branch}`)
  if (gitText(["status", "--short"])) fail("working tree must be clean before publishing")

  execFileSync("git", ["fetch", "origin", branch], { cwd: rootDir, stdio: "inherit" })
  const divergence = gitText(["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`])
  const [behindRaw = "0", aheadRaw = "0"] = divergence.split(/\s+/)
  if (Number(behindRaw) !== 0 || Number(aheadRaw) !== 0) {
    fail(`local branch must match origin/${branch}. behind=${behindRaw}, ahead=${aheadRaw}`)
  }

  console.log(`running typecheck`)
  await $`bun run typecheck`.cwd(rootDir)
}

console.log(`building release packages`)
await $`bun run script/pack-release.ts --version ${version}`.cwd(dir)

const manifest = (await Bun.file(path.join(dir, "dist/release-manifest.json")).json()) as ReleaseManifest
if (manifest.version !== version) fail(`manifest version ${manifest.version} does not match requested version ${version}`)
const artifacts = validateReleaseManifest(manifest)
await verifyArtifactFiles(artifacts, dir)

async function runNpm(npmArgs: string[]): Promise<NpmCommandResult> {
  const child = Bun.spawn(["npm", ...npmArgs], {
    cwd: dir,
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (npmArgs[0] === "publish") {
    if (stdout.trim()) console.log(stdout.trim())
    if (stderr.trim()) console.error(stderr.trim())
  }
  return { exitCode, stdout, stderr }
}

const registry = new NpmRegistry(runNpm)
const inspection = await inspectRelease(artifacts, registry)
console.log(`registry plan`)
for (const item of inspection) console.log(`  ${item.action.padEnd(8)} ${item.name}@${version}`)

if (dryRun) {
  if (inspection.some((item) => item.action === "conflict")) fail("registry contains an immutable integrity conflict")
  console.log(`dry run complete: no packages were published`)
  process.exit(0)
}

const result = await publishRelease(artifacts, registry, {
  verifyArtifact: async (artifact) => verifyArtifactFiles([artifact], dir),
})
console.log(`release complete`)
for (const item of result) console.log(`  ${item.action.padEnd(8)} ${item.name}@${version}`)
console.log(`  latest   killstata@${version}`)
