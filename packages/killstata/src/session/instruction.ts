import os from "os"
import path from "path"
import { Config } from "@/config/config"
import { Filesystem } from "@/util/filesystem"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import type { MessageV2 } from "./message-v2"
import { userWorkspaceAgentsPath, userWorkspaceMemoryPath, userWorkspaceUserPath } from "@/killstata/runtime-config"

const log = Log.create({ service: "session.instruction" })
const FILES = ["AGENTS.md", ...(Flag.KILLSTATA_DISABLE_CLAUDE_CODE_PROMPT ? [] : ["CLAUDE.md"]), "CONTEXT.md"]
const USER_WORKSPACE_RULE_FILES = [userWorkspaceAgentsPath(), userWorkspaceMemoryPath(), userWorkspaceUserPath()]

function globalFiles() {
  const files = [path.join(Global.Path.config, "AGENTS.md"), ...USER_WORKSPACE_RULE_FILES]
  if (Flag.KILLSTATA_CONFIG_DIR) {
    files.unshift(path.join(Flag.KILLSTATA_CONFIG_DIR, "AGENTS.md"))
  }
  if (!Flag.KILLSTATA_DISABLE_CLAUDE_CODE_PROMPT) {
    files.push(path.join(os.homedir(), ".claude", "CLAUDE.md"))
  }
  return files
}

function extract(messages: MessageV2.WithParts[]) {
  const paths = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool" || part.tool !== "read" || part.state.status !== "completed") continue
      if (part.state.time.compacted) continue
      const loaded = part.state.metadata?.loaded
      if (!loaded || !Array.isArray(loaded)) continue
      for (const item of loaded) {
        if (typeof item === "string") paths.add(path.resolve(item))
      }
    }
  }
  return paths
}

async function resolveRelativeInstruction(instruction: string): Promise<string[]> {
  if (!Flag.KILLSTATA_DISABLE_PROJECT_CONFIG) {
    return Filesystem.globUp(instruction, Instance.directory, Instance.worktree).catch(() => [])
  }
  if (!Flag.KILLSTATA_CONFIG_DIR) {
    log.warn(
      `Skipping relative instruction "${instruction}" - no KILLSTATA_CONFIG_DIR set while project config is disabled`,
    )
    return []
  }
  return Filesystem.globUp(instruction, Flag.KILLSTATA_CONFIG_DIR, Flag.KILLSTATA_CONFIG_DIR).catch(() => [])
}

async function read(filepath: string) {
  return Bun.file(filepath)
    .text()
    .catch(() => "")
}

const state = Instance.state(() => ({
  claims: new Map<string, Set<string>>(),
}))

export namespace SessionInstruction {
  export function clear(messageID: string) {
    state().claims.delete(messageID)
  }

  export async function systemPaths() {
    const config = await Config.get()
    const paths = new Set<string>()

    if (!Flag.KILLSTATA_DISABLE_PROJECT_CONFIG) {
      for (const file of FILES) {
        const matches = await Filesystem.findUp(file, Instance.directory, Instance.worktree).catch(() => [])
        if (matches.length > 0) {
          matches.forEach((item) => paths.add(path.resolve(item)))
          break
        }
      }
    }

    for (const file of globalFiles()) {
      if (await Bun.file(file).exists()) {
        paths.add(path.resolve(file))
      }
    }

    for (const raw of config.instructions ?? []) {
      if (raw.startsWith("https://") || raw.startsWith("http://")) continue
      const instruction = raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw
      let matches: string[] = []
      if (path.isAbsolute(instruction)) {
        matches = await Array.fromAsync(
          new Bun.Glob(path.basename(instruction)).scan({
            cwd: path.dirname(instruction),
            absolute: true,
            onlyFiles: true,
          }),
        ).catch(() => [])
      } else {
        matches = await resolveRelativeInstruction(instruction)
      }
      matches.forEach((item) => paths.add(path.resolve(item)))
    }

    return paths
  }

  export async function system() {
    const config = await Config.get()
    const paths = await systemPaths()
    const urls = (config.instructions ?? []).filter((item) => item.startsWith("https://") || item.startsWith("http://"))

    const foundFiles = await Promise.all(
      Array.from(paths).map(async (item) => {
        const text = await read(item)
        return text ? `Instructions from: ${item}\n${text}` : ""
      }),
    )
    const foundUrls = await Promise.all(
      urls.map(async (url) => {
        const text = await fetch(url, { signal: AbortSignal.timeout(5000) })
          .then((res) => (res.ok ? res.text() : ""))
          .catch(() => "")
        return text ? `Instructions from: ${url}\n${text}` : ""
      }),
    )
    return [...foundFiles, ...foundUrls].filter(Boolean)
  }

  export async function find(dir: string) {
    for (const file of FILES) {
      const filepath = path.resolve(path.join(dir, file))
      if (await Bun.file(filepath).exists()) return filepath
    }
  }

  export async function resolve(messages: MessageV2.WithParts[], filepath: string, messageID: string) {
    const sys = await systemPaths()
    const already = extract(messages)
    const results: { filepath: string; content: string }[] = []
    const s = state()
    const root = path.resolve(Instance.directory)
    const target = path.resolve(filepath)
    let current = path.dirname(target)

    while (current.startsWith(root) && current !== root) {
      const found = await find(current)
      if (!found || found === target || sys.has(found) || already.has(found)) {
        current = path.dirname(current)
        continue
      }

      let set = s.claims.get(messageID)
      if (!set) {
        set = new Set()
        s.claims.set(messageID, set)
      }
      if (set.has(found)) {
        current = path.dirname(current)
        continue
      }

      set.add(found)
      const content = await read(found)
      if (content) {
        results.push({
          filepath: found,
          content: `Instructions from: ${found}\n${content}`,
        })
      }
      current = path.dirname(current)
    }

    return results
  }

  export function loaded(messages: MessageV2.WithParts[]) {
    return extract(messages)
  }
}
