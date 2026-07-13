import z from "zod"
import path from "path"
import { Instance } from "../project/instance"
import { NamedError } from "@killstata/util/error"
import { ConfigMarkdown } from "../config/markdown"
import { Log } from "../util/log"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Bus } from "@/bus"
import { Session } from "@/session"
import { doctorSkillFile, SkillSource, userSkillsRoot } from "./manage"

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

  const USER_SKILL_GLOB = new Bun.Glob("**/SKILL.md")

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
        return
      }

      skills[parsed.data.name] = {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
        source,
      }
    }

    const userRoot = userSkillsRoot()
    if (await Filesystem.isDir(userRoot)) {
      for await (const match of USER_SKILL_GLOB.scan({
        cwd: userRoot,
        absolute: true,
        onlyFiles: true,
        followSymlinks: true,
        dot: true,
      })) {
        await addSkill(match, "user")
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
