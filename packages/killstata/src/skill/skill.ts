import z from "zod"
import path from "path"
import { Instance } from "../project/instance"
import { NamedError } from "@killstata/util/error"
import { ConfigMarkdown } from "../config/markdown"
import { Log } from "../util/log"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Flag } from "@/flag/flag"
import { Bus } from "@/bus"
import { Session } from "@/session"
import { builtinSkillsRoot, doctorSkillFile, pathWithin, SkillSource } from "./manage"
import { legacyUserSkillRoot } from "@/killstata/runtime-config"

export namespace Skill {
  const log = Log.create({ service: "skill" })
  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
    source: SkillSource,
  })
  export type Info = z.infer<typeof Info>

  export const InvalidError = NamedError.create(
    "SkillInvalidError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
    }),
  )

  export const NameMismatchError = NamedError.create(
    "SkillNameMismatchError",
    z.object({
      path: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  )

  const KILLSTATA_SKILL_GLOB = new Bun.Glob("{skill,skills}/**/SKILL.md")
  const CLAUDE_SKILL_GLOB = new Bun.Glob("skills/**/SKILL.md")
  const BUILTIN_SKILL_GLOB = new Bun.Glob("**/SKILL.md")
  const SKILL_SOURCE_PRIORITY: Record<SkillSource, number> = {
    builtin: 0,
    user: 1,
    project: 2,
  }

  function classifyKillstataSource(root: string, match: string): SkillSource {
    if (pathWithin(builtinSkillsRoot(), match)) return "builtin"
    if (pathWithin(path.join(Global.Path.home, ".killstata"), root)) return "user"
    return "project"
  }

  export const state = Instance.state(async () => {
    const skills: Record<string, Info> = {}

    const addSkill = async (match: string, source: SkillSource) => {
      const md = await ConfigMarkdown.parse(match).catch((err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse skill ${match}`
        Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load skill", { skill: match, err })
        return undefined
      })

      if (!md) return

      const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
      if (!parsed.success) return

      const existing = skills[parsed.data.name]
      if (existing) {
        log.warn("duplicate skill name", {
          name: parsed.data.name,
          existing: existing.location,
          duplicate: match,
        })
        if (SKILL_SOURCE_PRIORITY[source] < SKILL_SOURCE_PRIORITY[existing.source]) return
      }

      skills[parsed.data.name] = {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
        source,
      }
    }

    const builtinRoot = builtinSkillsRoot()
    if (await Filesystem.isDir(builtinRoot)) {
      for await (const match of BUILTIN_SKILL_GLOB.scan({
        cwd: builtinRoot,
        absolute: true,
        onlyFiles: true,
        followSymlinks: true,
      })) {
        await addSkill(match, "builtin")
      }
    }

    const userDirs = [path.join(Global.Path.home, ".killstata")]
    if (!Flag.KILLSTATA_DISABLE_CLAUDE_CODE_SKILLS) {
      userDirs.push(path.join(Global.Path.home, ".claude"))
    }

    for (const dir of userDirs) {
      const exists = await Filesystem.isDir(dir)
      if (!exists) continue

      const glob = path.basename(dir) === ".claude" ? CLAUDE_SKILL_GLOB : KILLSTATA_SKILL_GLOB
      const matches = await Array.fromAsync(
        glob.scan({
          cwd: dir,
          absolute: true,
          onlyFiles: true,
          followSymlinks: true,
          dot: true,
        }),
      ).catch((error) => {
        log.error("failed user directory scan for skills", { dir, error })
        return []
      })

      for (const match of matches) {
        await addSkill(match, "user")
      }
    }

    const projectDirs = await Array.fromAsync(
      Filesystem.up({
        targets: !Flag.KILLSTATA_DISABLE_CLAUDE_CODE_SKILLS ? [".killstata", ".claude"] : [".killstata"],
        start: Instance.directory,
        stop: Instance.worktree,
      }),
    )
    for (const dir of projectDirs.toReversed()) {
      const glob = path.basename(dir) === ".claude" ? CLAUDE_SKILL_GLOB : KILLSTATA_SKILL_GLOB
      for await (const match of glob.scan({
        cwd: dir,
        absolute: true,
        onlyFiles: true,
        followSymlinks: true,
        dot: true,
      })) {
        await addSkill(match, classifyKillstataSource(dir, match))
      }
    }

    return skills
  })

  export async function get(name: string) {
    return state().then((x) => x[name])
  }

  export async function all() {
    return state().then((x) => Object.values(x).sort((a, b) => a.name.localeCompare(b.name)))
  }

  export async function doctor() {
    const allSkills = await all()
    const findings = (
      await Promise.all(
        allSkills.map(async (skill) => {
          const issues = await doctorSkillFile(skill.location)
          return issues.map((issue) => ({ ...issue, skill: issue.skill ?? skill.name }))
        }),
      )
    ).flat()
    return findings.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code))
  }
}
