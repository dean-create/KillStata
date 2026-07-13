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

console.log("")
console.log(`${BOLD}${CYAN}killstata${RESET} - AI-powered Econometrics Agent`)
console.log("")

const hasNativeBinary = hasInstalledNativeBinary()
const hasAdvertisedNativeBinary = advertisedNativeBinary()
if (hasNativeBinary) {
  console.log(`  ${GREEN}[OK]${RESET} Native package installed for ${os.platform()}/${os.arch()}`)
} else if (hasAdvertisedNativeBinary) {
  console.log(`  ${YELLOW}[WARN]${RESET} Native package for ${os.platform()}/${os.arch()} was expected but was not found after install`)
} else {
  console.log(`  ${YELLOW}[WARN]${RESET} This release does not currently bundle a native package for ${os.platform()}/${os.arch()}`)
}

const hasBun = commandExists("bun")
if (hasBun) {
  console.log(`  ${GREEN}[OK]${RESET} Bun runtime: ${getVersion("bun")}`)
} else if (hasNativeBinary) {
  console.log(`  ${GREEN}[OK]${RESET} Bun runtime not required for this install`)
} else {
  console.log(`  ${YELLOW}[WARN]${RESET} Bun runtime not found; this install will not run without Bun or a bundled native binary`)
}

console.log("")
console.log(`${BOLD}Next steps${RESET}`)
console.log(`  Windows users: reinstall with ${CYAN}npm i -g killstata@latest${RESET} if the native binary was not installed correctly.`)
console.log(`  Run ${CYAN}killstata${RESET} to begin. KillStata will prepare its analysis tools automatically.`)
console.log("")
