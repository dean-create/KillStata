import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"

const desktopRoot = resolve(import.meta.dir, "..")
const appBundle = join(desktopRoot, "src-tauri", "target", "release", "bundle", "macos", "KillStata.app")
const appBinary = join(appBundle, "Contents", "MacOS", "killstata-desktop")

if (!existsSync(appBinary)) {
  throw new Error("找不到已封装的 macOS 应用；请先运行带 --bundles app 的 desktop:build")
}

type ProcessEntry = { pid: number; ppid: number; command: string }

function processEntries(): ProcessEntry[] {
  const output = new TextDecoder().decode(Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="]).stdout)
  return output
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : []
    })
}

function isDesktopProcess(entry: ProcessEntry) {
  return entry.command === appBinary || entry.command.startsWith(`${appBinary} `)
}

function descendantsOf(parentPID: number) {
  const entries = processEntries()
  const descendants = new Set<number>([parentPID])
  let changed = true
  while (changed) {
    changed = false
    for (const entry of entries) {
      if (!descendants.has(entry.ppid) || descendants.has(entry.pid)) continue
      descendants.add(entry.pid)
      changed = true
    }
  }
  return entries.filter((entry) => descendants.has(entry.pid) && entry.pid !== parentPID)
}

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, label: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const value = read()
    if (predicate(value)) return value
    await Bun.sleep(100)
  }
  throw new Error(`${label} 未在 6 秒内达到预期状态`)
}

const sandbox = await mkdtemp("/tmp/killstata-desktop-lifecycle-")
let appPID: number | undefined
let sidecarPIDs: number[] = []

try {
  const existingDesktop = processEntries().find(isDesktopProcess)
  if (existingDesktop) throw new Error("生命周期验收前已有同一打包应用在运行，拒绝关闭用户进程")
  const launcher = Bun.spawn([
    "open",
    appBundle,
    "--args",
    "--killstata-eager-engine-test",
  ], {
    cwd: sandbox,
    stdout: "ignore",
    stderr: "ignore",
  })
  if (await launcher.exited !== 0) throw new Error("无法通过 macOS LaunchServices 启动打包应用")
  const desktop = await waitFor(
    () => processEntries().find(isDesktopProcess),
    (entry): entry is ProcessEntry => Boolean(entry),
    "Desktop 应用启动",
  )
  appPID = desktop?.pid
  if (!appPID) throw new Error("无法读取 Desktop 进程标识")
  const sidecars = await waitFor(
    () => descendantsOf(appPID ?? -1).filter((entry) => /killstata-(core|bridge)(?:\s|$)/.test(entry.command)),
    (entries) => entries.length === 2,
    "Desktop sidecar 启动",
  )
  sidecarPIDs = sidecars.map((entry) => entry.pid)
  process.kill(appPID, "SIGTERM")
  await waitFor(
    () => processEntries().filter((entry) => sidecarPIDs.includes(entry.pid)),
    (entries) => entries.length === 0,
    "Desktop sidecar 回收",
  )
  console.log(JSON.stringify({ verified: true, sidecarPIDs }))
} finally {
  if (appPID && processEntries().some((entry) => entry.pid === appPID)) process.kill(appPID, "SIGTERM")
  for (const entry of processEntries()) {
    if (sidecarPIDs.includes(entry.pid)) process.kill(entry.pid, "SIGTERM")
  }
  await rm(sandbox, { recursive: true, force: true })
}
