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

const WINDOWS_X64_NATIVE_PACKAGE = "killstata-windows-x64"

function hasInstalledNativeBinary() {
  const nodeModulesDirs = [
    path.resolve(import.meta.dirname, "../node_modules"),
    path.resolve(import.meta.dirname, "../../node_modules"),
  ]

  return nodeModulesDirs.some((dir) => fs.existsSync(path.join(dir, WINDOWS_X64_NATIVE_PACKAGE)))
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
  return optionalDeps.includes(WINDOWS_X64_NATIVE_PACKAGE)
}

console.log("")
console.log(`${BOLD}${CYAN}killstata${RESET} - AI-powered Econometrics Agent`)
console.log("")

const hasNativeBinary = hasInstalledNativeBinary()
const hasAdvertisedNativeBinary = advertisedNativeBinary()
const supportedPlatform = os.platform() === "win32" && os.arch() === "x64"
if (!supportedPlatform) {
  console.log(`${YELLOW}[WARN]${RESET} This npm release supports Windows x64 only.`)
} else if (hasNativeBinary) {
  console.log(`  ${GREEN}[OK]${RESET} Native package installed for ${os.platform()}/${os.arch()}`)
} else if (hasAdvertisedNativeBinary) {
  console.log(`  ${YELLOW}[WARN]${RESET} Native package for ${os.platform()}/${os.arch()} was expected but was not found after install`)
} else {
  console.log(`  ${YELLOW}[WARN]${RESET} This release does not currently bundle a native package for ${os.platform()}/${os.arch()}`)
}

const hasBun = commandExists("bun")
if (!supportedPlatform) {
  console.log(`  ${YELLOW}[WARN]${RESET} Install KillStata on Windows x64 to run the npm package.`)
} else if (hasBun) {
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
