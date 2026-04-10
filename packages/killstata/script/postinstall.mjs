#!/usr/bin/env node

import { execSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"

const BOLD = "\x1b[1m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"
const RESET = "\x1b[0m"

function commandExists(cmd) {
  try {
    const check = os.platform() === "win32" ? "where" : "which"
    execSync(`${check} ${cmd}`, { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

function getVersion(cmd, flag = "--version") {
  try {
    return execSync(`${cmd} ${flag}`, { encoding: "utf-8" }).trim()
  } catch {
    return null
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function candidateBinaryPackages() {
  const platform = os.platform() === "win32" ? "windows" : os.platform()
  const arch = os.arch() === "x64" || os.arch() === "arm64" ? os.arch() : "x64"
  const names = [`killstata-${platform}-${arch}`]

  if (platform === "linux") {
    names.push(`killstata-${platform}-${arch}-musl`, `killstata-${platform}-${arch}-baseline`, `killstata-${platform}-${arch}-baseline-musl`)
  } else if (arch === "x64") {
    names.push(`killstata-${platform}-${arch}-baseline`)
  }

  return names
}

function hasInstalledNativeBinary() {
  const nodeModulesDirs = [
    path.resolve(import.meta.dirname, "../node_modules"),
    path.resolve(import.meta.dirname, "../../node_modules"),
  ]

  return candidateBinaryPackages().some((name) => nodeModulesDirs.some((dir) => fs.existsSync(path.join(dir, name))))
}

function readPackageInfo() {
  const pkgPath = path.resolve(import.meta.dirname, "../package.json")
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
  } catch {
    return { name: "killstata", version: "0.0.0" }
  }
}

function advertisedNativeBinary() {
  const pkg = readPackageInfo()
  const optionalDeps = Object.keys(pkg.optionalDependencies ?? {})
  return candidateBinaryPackages().some((name) => optionalDeps.includes(name))
}

function listManagedDefaultSkills(root) {
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort()
}

function copyDirectory(source, destination) {
  fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.cpSync(source, destination, { recursive: true, force: true })
}

function syncManagedDefaultSkills(sourceRoot, destinationRoot, manifestPath, version) {
  ensureDir(destinationRoot)

  const bundled = listManagedDefaultSkills(sourceRoot)
  let previous = {}
  if (fs.existsSync(manifestPath)) {
    try {
      previous = JSON.parse(fs.readFileSync(manifestPath, "utf-8") || "{}")
    } catch {
      previous = {}
    }
  }
  const previousSkills = Array.isArray(previous.skills) ? previous.skills : []

  for (const skillName of previousSkills) {
    if (bundled.includes(skillName)) continue
    fs.rmSync(path.join(destinationRoot, skillName), { recursive: true, force: true })
  }

  for (const skillName of bundled) {
    copyDirectory(path.join(sourceRoot, skillName), path.join(destinationRoot, skillName))
  }

  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        managedBy: "killstata-postinstall",
        version,
        generatedAt: new Date().toISOString(),
        skills: bundled,
      },
      null,
      2,
    ),
    "utf-8",
  )

  return bundled
}

const homeDir = process.env.KILLSTATA_TEST_HOME || os.homedir()
const killstataRoot = path.join(homeDir, ".killstata")
const skillRoot = path.join(killstataRoot, "skills")
const defaultRoot = path.join(skillRoot, "default")
const importedRoot = path.join(skillRoot, "imported")
const localRoot = path.join(skillRoot, "local")
const cacheRoot = path.join(skillRoot, "cache")
const managedManifestPath = path.join(defaultRoot, ".managed.json")
const builtinRoot = path.resolve(import.meta.dirname, "../skills/builtin")
const bundledDefaultRoot = path.resolve(import.meta.dirname, "../skills/default")
const pkg = readPackageInfo()

ensureDir(killstataRoot)
ensureDir(skillRoot)
ensureDir(defaultRoot)
ensureDir(importedRoot)
ensureDir(localRoot)
ensureDir(cacheRoot)

const syncedSkills = syncManagedDefaultSkills(bundledDefaultRoot, defaultRoot, managedManifestPath, pkg.version)

console.log("")
console.log(`${BOLD}${CYAN}killstata${RESET} - AI-powered Econometrics Agent`)
console.log("")

const hasNativeBinary = hasInstalledNativeBinary()
const hasAdvertisedNativeBinary = advertisedNativeBinary()
if (hasNativeBinary) {
  console.log(`  ${GREEN}[OK]${RESET} Native package installed for ${os.platform()}/${os.arch()}`)
} else if (hasAdvertisedNativeBinary) {
  console.log(`  ${YELLOW}[WARN]${RESET} Native package for ${os.platform()}/${os.arch()} was expected but is not installed`)
} else {
  console.log(`  ${YELLOW}[WARN]${RESET} This release does not bundle a native package for ${os.platform()}/${os.arch()}`)
}

const hasBun = commandExists("bun")
if (hasBun) {
  console.log(`  ${GREEN}[OK]${RESET} Bun runtime: ${getVersion("bun")}`)
} else if (hasNativeBinary) {
  console.log(`  ${GREEN}[OK]${RESET} Bun runtime not required for this install`)
} else {
  console.log(`  ${YELLOW}[WARN]${RESET} Bun runtime not found; this install will not run without Bun or a native binary`)
}

const pythonCmd = os.platform() === "win32" ? "python" : "python3"
if (commandExists(pythonCmd)) {
  console.log(`  ${GREEN}[OK]${RESET} Python: ${getVersion(pythonCmd)}`)
} else {
  console.log(`  ${YELLOW}[WARN]${RESET} Python not found`)
}

console.log(`  ${GREEN}[OK]${RESET} Skills root: ${skillRoot}`)
console.log(`  ${GREEN}[OK]${RESET} Default skills: ${defaultRoot} (${syncedSkills.length} managed)`)
console.log(`  ${GREEN}[OK]${RESET} Built-in skills: ${builtinRoot}`)
console.log(`  ${GREEN}[OK]${RESET} Imported skills: ${importedRoot}`)
console.log(`  ${GREEN}[OK]${RESET} Local skills: ${localRoot}`)
console.log(`  ${GREEN}[OK]${RESET} Managed default manifest: ${managedManifestPath}`)

console.log("")
console.log(`${BOLD}Next steps${RESET}`)
console.log(`  Run ${CYAN}killstata init${RESET} to set up the Python econometrics environment.`)
console.log(`  Run ${CYAN}killstata skills list${RESET} to inspect built-in, default, and custom skills.`)
console.log(`  Put custom skills under ${CYAN}${localRoot}${RESET} or project-local ${CYAN}.killstata/skills${RESET}.`)
console.log("")
