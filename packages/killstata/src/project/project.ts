import z from "zod"
import fs from "fs/promises"
import { Filesystem } from "../util/filesystem"
import path from "path"
import { Storage } from "../storage/storage"
import { Log } from "../util/log"
import { Session } from "../session"
import { work } from "../util/queue"
import { fn } from "@killstata/util/fn"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { existsSync } from "fs"
import { createHash } from "crypto"

export namespace Project {
  const log = Log.create({ service: "project" })

  // 数据目录就是项目身份：同一绝对路径稳定，不同目录隔离。
  function projectIdFromPath(root: string) {
    return createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16)
  }

  export const Info = z
    .object({
      id: z.string(),
      worktree: z.string(),
      name: z.string().optional(),
      icon: z
        .object({
          url: z.string().optional(),
          override: z.string().optional(),
          color: z.string().optional(),
        })
        .optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        initialized: z.number().optional(),
      }),
      sandboxes: z.array(z.string()),
    })
    .meta({ ref: "Project" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define("project.updated", Info),
  }

  export async function fromDirectory(directory: string) {
    log.info("fromDirectory", { directory })
    const start = path.resolve(directory)
    const markers = Filesystem.up({ targets: [".killstata"], start })
    const marker = await markers.next().then((item) => item.value)
    await markers.return()
    const worktree = marker ? path.dirname(marker) : start
    const deterministicID = projectIdFromPath(worktree)

    let projectID = deterministicID
    let existing = await Storage.read<Info>(["project", projectID]).catch(() => undefined)
    // Git 时代的 ID 由 root commit 决定。目录未变时沿用旧 ID，避免升级后既有会话消失。
    if (!existing) {
      const keys = await Storage.list(["project"]).catch(() => [])
      for (const key of keys) {
        const candidate = await Storage.read<Info>(key).catch(() => undefined)
        if (candidate?.worktree && path.resolve(candidate.worktree) === worktree) {
          existing = candidate
          projectID = candidate.id
          break
        }
      }
    }

    if (!existing) {
      existing = {
        id: projectID,
        worktree,
        sandboxes: [],
        time: { created: Date.now(), updated: Date.now() },
      }
      await migrateFromGlobal(projectID, worktree)
    }

    // 旧存储记录可能有 vcs 字段；读旧会话、写新项目时将它剥离。
    const { vcs: _legacyVcs, ...withoutVcs } = existing as Info & { vcs?: string }
    const result: Info = {
      ...withoutVcs,
      id: projectID,
      worktree,
      sandboxes: (withoutVcs.sandboxes ?? []).filter((item) => existsSync(item)),
      time: { ...withoutVcs.time, updated: Date.now() },
    }
    await Storage.write<Info>(["project", projectID], result)
    GlobalBus.emit("event", {
      payload: { type: Event.Updated.type, properties: result },
    })
    return { project: result, sandbox: worktree }
  }

  export async function discover(input: Info) {
    if (input.icon?.override || input.icon?.url) return
    const glob = new Bun.Glob("**/{favicon}.{ico,png,svg,jpg,jpeg,webp}")
    const matches = await Array.fromAsync(
      glob.scan({
        cwd: input.worktree,
        absolute: true,
        onlyFiles: true,
        followSymlinks: false,
        dot: false,
      }),
    )
    const shortest = matches.sort((a, b) => a.length - b.length)[0]
    if (!shortest) return
    const file = Bun.file(shortest)
    const buffer = await file.arrayBuffer()
    const mime = file.type || "image/png"
    await update({
      projectID: input.id,
      icon: { url: `data:${mime};base64,${Buffer.from(buffer).toString("base64")}` },
    })
  }

  async function migrateFromGlobal(newProjectID: string, worktree: string) {
    const globalProject = await Storage.read<Info>(["project", "global"]).catch(() => undefined)
    if (!globalProject) return

    const globalSessions = await Storage.list(["session", "global"]).catch(() => [])
    if (globalSessions.length === 0) return
    log.info("migrating sessions from global", { newProjectID, worktree, count: globalSessions.length })

    await work(10, globalSessions, async (key) => {
      const sessionID = key[key.length - 1]
      const session = await Storage.read<Session.Info>(key).catch(() => undefined)
      if (!session || (session.directory && session.directory !== worktree)) return
      session.projectID = newProjectID
      log.info("migrating session", { sessionID, from: "global", to: newProjectID })
      await Storage.write(["session", newProjectID, sessionID], session)
      await Storage.remove(key)
    }).catch((error) => {
      log.error("failed to migrate sessions from global to project", { error, projectId: newProjectID })
    })
  }

  export async function setInitialized(projectID: string) {
    await Storage.update<Info>(["project", projectID], (draft) => {
      draft.time.initialized = Date.now()
    })
  }

  export async function list() {
    const keys = await Storage.list(["project"])
    const projects = await Promise.all(keys.map((key) => Storage.read<Info>(key)))
    return projects.map((project) => ({
      ...project,
      sandboxes: project.sandboxes?.filter((sandbox) => existsSync(sandbox)),
    }))
  }

  export const update = fn(
    z.object({
      projectID: z.string(),
      name: z.string().optional(),
      icon: Info.shape.icon.optional(),
    }),
    async (input) => {
      const result = await Storage.update<Info>(["project", input.projectID], (draft) => {
        if (input.name !== undefined) draft.name = input.name
        if (input.icon !== undefined) {
          draft.icon = { ...draft.icon }
          if (input.icon.url !== undefined) draft.icon.url = input.icon.url
          if (input.icon.override !== undefined) draft.icon.override = input.icon.override || undefined
          if (input.icon.color !== undefined) draft.icon.color = input.icon.color
        }
        draft.time.updated = Date.now()
      })
      GlobalBus.emit("event", { payload: { type: Event.Updated.type, properties: result } })
      return result
    },
  )

  export async function sandboxes(projectID: string) {
    const project = await Storage.read<Info>(["project", projectID]).catch(() => undefined)
    if (!project?.sandboxes) return []
    const valid: string[] = []
    for (const dir of project.sandboxes) {
      const stat = await fs.stat(dir).catch(() => undefined)
      if (stat?.isDirectory()) valid.push(dir)
    }
    return valid
  }

  export async function removeSandbox(projectID: string, directory: string) {
    const result = await Storage.update<Info>(["project", projectID], (draft) => {
      draft.sandboxes = (draft.sandboxes ?? []).filter((sandbox) => sandbox !== directory)
      draft.time.updated = Date.now()
    })
    GlobalBus.emit("event", { payload: { type: Event.Updated.type, properties: result } })
    return result
  }
}
