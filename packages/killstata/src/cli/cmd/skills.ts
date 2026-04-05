import { EOL } from "os"
import path from "path"
import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { Skill } from "../../skill"
import { ConfigMarkdown } from "../../config/markdown"
import { ensureSkillDirectories, installSkillFromGitHub, pathWithin, projectSkillsRoot, uninstallSkillDirectory, userSkillsRoot } from "../../skill"
import { UI } from "../ui"
import { legacyUserSkillRoot } from "@/killstata/runtime-config"

function formatSkillLine(skill: Awaited<ReturnType<typeof Skill.all>>[number]) {
  return `${skill.name} [${skill.source}] ${skill.location}`
}

export const SkillsCommand = cmd({
  command: "skills",
  describe: "manage built-in and custom killstata skills",
  builder: (yargs: Argv) =>
    yargs
      .command(SkillsListCommand)
      .command(SkillsShowCommand)
      .command(SkillsDoctorCommand)
      .command(SkillsInstallCommand)
      .command(SkillsUninstallCommand)
      .demandCommand(),
  async handler() {},
})

export const SkillsListCommand = cmd({
  command: "list",
  describe: "list available skills and their source tiers",
  async handler() {
    await bootstrap(process.cwd(), async () => {
      const skills = await Skill.all()
      if (skills.length === 0) {
        process.stdout.write("No skills found." + EOL)
        return
      }
      for (const skill of skills) {
        process.stdout.write(formatSkillLine(skill) + EOL)
      }
    })
  },
})

export const SkillsShowCommand = cmd({
  command: "show <name>",
  describe: "show the effective skill after precedence resolution",
  builder: (yargs: Argv) =>
    yargs.positional("name", {
      describe: "skill name",
      type: "string",
    }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const skill = await Skill.get(String(args.name))
      if (!skill) {
        UI.error(`Skill not found: ${args.name}`)
        return
      }
      const parsed = await ConfigMarkdown.parse(skill.location)
      process.stdout.write(
        [`# ${skill.name}`, `Source: ${skill.source}`, `Location: ${skill.location}`, "", parsed.content.trim()].join("\n") +
          EOL,
      )
    })
  },
})

export const SkillsDoctorCommand = cmd({
  command: "doctor",
  describe: "validate installed skills for malformed frontmatter and missing helper files",
  async handler() {
    await bootstrap(process.cwd(), async () => {
      const findings = await Skill.doctor()
      if (findings.length === 0) {
        process.stdout.write("Skills OK" + EOL)
        return
      }
      for (const finding of findings) {
        process.stdout.write(
          `[${finding.level}] ${finding.code} ${finding.skill || "unknown"} ${finding.path}${EOL}  ${finding.message}${EOL}`,
        )
      }
    })
  },
})

export const SkillsInstallCommand = cmd({
  command: "install",
  describe: "install a skill from GitHub into the current project's .killstata/skills directory",
  builder: (yargs: Argv) =>
    yargs
      .option("repo", {
        describe: "GitHub repository in owner/repo format",
        type: "string",
        demandOption: true,
      })
      .option("path", {
        describe: "Path to the skill directory inside the repository",
        type: "string",
        demandOption: true,
      })
      .option("ref", {
        describe: "Git ref to pin the imported skill to",
        type: "string",
      }),
  async handler(args) {
    await ensureSkillDirectories()
    const result = await installSkillFromGitHub({
      repo: String(args.repo),
      skillPath: String(args.path),
      ref: args.ref ? String(args.ref) : undefined,
      destinationRoot: projectSkillsRoot(),
    })
    process.stdout.write(
      [
        "Installed skill",
        `Repo: ${result.repo}`,
        `Ref: ${result.ref}`,
        `Path: ${result.skillPath}`,
        `Destination: ${result.destination}`,
      ].join(EOL) + EOL,
    )
  },
})

export const SkillsUninstallCommand = cmd({
  command: "uninstall <name>",
  describe: "remove a project, imported, or user-local skill",
  builder: (yargs: Argv) =>
    yargs.positional("name", {
      describe: "skill name",
      type: "string",
    }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const skill = await Skill.get(String(args.name))
      if (!skill) {
        UI.error(`Skill not found: ${args.name}`)
        return
      }
      if (skill.source === "builtin" || skill.source === "default") {
        UI.error(`Cannot uninstall ${skill.source} skill "${skill.name}"`)
        return
      }

      const skillDir = path.dirname(skill.location)
      const allowedRoots = [projectSkillsRoot(), userSkillsRoot(), legacyUserSkillRoot()]
      if (!allowedRoots.some((root) => pathWithin(root, skillDir))) {
        UI.error(`Refusing to uninstall non-project/non-user skill "${skill.name}" from ${skillDir}`)
        return
      }

      await uninstallSkillDirectory(skillDir)
      process.stdout.write(`Uninstalled ${skill.name} from ${skillDir}` + EOL)
    })
  },
})
