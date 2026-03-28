#!/usr/bin/env node

import { execSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"

const BOLD = "\x1b[1m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"
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

const homeDir = process.env.OPENCODE_TEST_HOME || os.homedir()
const killstataRoot = path.join(homeDir, ".killstata")
const skillRoot = path.join(killstataRoot, "skill")
const importedRoot = path.join(skillRoot, "imported")
const localRoot = path.join(skillRoot, "local")
const builtinRoot = path.resolve(import.meta.dirname, "../skills/builtin")

ensureDir(skillRoot)
ensureDir(importedRoot)
ensureDir(localRoot)

console.log("")
console.log(`${BOLD}${CYAN}killstata${RESET} - AI-powered Econometrics Agent`)
console.log("")

const hasBun = commandExists("bun")
if (hasBun) {
  console.log(`  ${GREEN}[OK]${RESET} Bun runtime: ${getVersion("bun")}`)
} else {
  console.log(`  ${RED}[FAIL]${RESET} Bun runtime not found`)
}

const pythonCmd = os.platform() === "win32" ? "python" : "python3"
if (commandExists(pythonCmd)) {
  console.log(`  ${GREEN}[OK]${RESET} Python: ${getVersion(pythonCmd)}`)
} else {
  console.log(`  ${YELLOW}[WARN]${RESET} Python not found`)
}

console.log(`  ${GREEN}[OK]${RESET} Skill directory: ${skillRoot}`)
console.log(`  ${GREEN}[OK]${RESET} Built-in skills: ${builtinRoot}`)
console.log(`  ${GREEN}[OK]${RESET} Imported skills: ${importedRoot}`)
console.log(`  ${GREEN}[OK]${RESET} Local skills: ${localRoot}`)

console.log("")
console.log(`${BOLD}Next steps${RESET}`)
console.log(`  Run ${CYAN}killstata init${RESET} to set up the Python econometrics environment.`)
console.log(`  Run ${CYAN}killstata skills list${RESET} to inspect the bundled skill catalog.`)
console.log(`  Put custom skills under ${CYAN}${localRoot}${RESET} or project-local ${CYAN}.killstata/skill${RESET}.`)
console.log("")
