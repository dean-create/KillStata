import fs from "fs/promises"
import path from "path"
import { projectSkillsRoot } from "./manage"
import { Skill } from "./skill"

export type SkillAliasDefinition = {
  capability: string
  requestedNames: string[]
  preferred: string[]
  fallback: string
}

export type SkillAliasAvailability = SkillAliasDefinition & {
  installed: boolean
  matchedSkillName?: string
  matchedSkillSource?: string
}

export const SKILL_ALIAS_DEFINITIONS: SkillAliasDefinition[] = [
  {
    capability: "xlsx_excel_processing",
    requestedNames: ["xlsx-processor", "xlsx"],
    preferred: ["xlsx"],
    fallback: "fall back to spreadsheet processing guidance or data_import/econometrics as appropriate",
  },
  {
    capability: "csv_summarization",
    requestedNames: ["csv-summarizer", "CSV Data Summarizer"],
    preferred: ["csv-data-summarizer", "CSV Data Summarizer"],
    fallback: "fall back to csv/tabular profiling through data_import",
  },
  {
    capability: "missing_data_handling",
    requestedNames: ["missing-data-handler"],
    preferred: ["missing-data-handler"],
    fallback: "fall back to data_import preprocessing operations",
  },
  {
    capability: "variable_engineering",
    requestedNames: ["variable-engineering"],
    preferred: ["variable-engineering"],
    fallback: "fall back to data_import preprocessing operations",
  },
  {
    capability: "diagnostic_testing",
    requestedNames: ["diagnostic-testing"],
    preferred: ["diagnostic-testing"],
    fallback: "fall back to econometrics built-in diagnostics",
  },
  {
    capability: "robustness_checks",
    requestedNames: ["robustness-check"],
    preferred: ["robustness-check"],
    fallback: "fall back to econometrics built-in robustness checks",
  },
  {
    capability: "research_briefing",
    requestedNames: ["research-briefing", "research_brief"],
    preferred: ["research-briefing"],
    fallback: "fall back to the research_brief tool directly",
  },
  {
    capability: "heterogeneity_analysis",
    requestedNames: ["heterogeneity-analysis", "heterogeneity_runner"],
    preferred: ["heterogeneity-analysis"],
    fallback: "fall back to the heterogeneity_runner tool directly",
  },
  {
    capability: "paper_drafting",
    requestedNames: ["paper-drafting", "paper_draft"],
    preferred: ["paper-drafting"],
    fallback: "fall back to the paper_draft tool directly",
  },
  {
    capability: "slide_generation",
    requestedNames: ["slide-generator", "slide_generator"],
    preferred: ["slide-generator"],
    fallback: "fall back to the slide_generator tool directly",
  },
] as const

function findInstalledSkillMatch(
  skills: Awaited<ReturnType<typeof Skill.all>>,
  preferred: readonly string[],
) {
  const lowered = skills.map((skill) => ({ ...skill, lower: skill.name.toLowerCase() }))
  for (const candidate of preferred) {
    const exact = lowered.find((skill) => skill.lower === candidate.toLowerCase())
    if (exact) return exact
  }
  for (const candidate of preferred) {
    const fuzzy = lowered.find((skill) => skill.lower.includes(candidate.toLowerCase()))
    if (fuzzy) return fuzzy
  }
  return undefined
}

export async function resolveSkillAliasAvailability(skills?: Awaited<ReturnType<typeof Skill.all>>) {
  const availableSkills = skills ?? (await Skill.all().catch(() => []))
  return SKILL_ALIAS_DEFINITIONS.map((alias) => {
    const match = findInstalledSkillMatch(availableSkills, alias.preferred)
    return {
      ...alias,
      installed: !!match,
      matchedSkillName: match?.name,
      matchedSkillSource: match?.source,
    } satisfies SkillAliasAvailability
  })
}

export function formatSkillAliasXml(aliases: SkillAliasAvailability[]) {
  if (aliases.length === 0) return ""
  return [
    "<skill_aliases>",
    ...aliases.map((alias) =>
      `  ${alias.capability}: ${alias.installed ? `${alias.matchedSkillName} [${alias.matchedSkillSource}]` : `unavailable; ${alias.fallback}`}`,
    ),
    "</skill_aliases>",
  ].join("\n")
}

export function formatSkillAliasText(aliases: SkillAliasAvailability[]) {
  if (aliases.length === 0) return ""
  return [
    "<skill_aliases>",
    ...aliases.flatMap((alias) => [
      "  <alias>",
      `    <capability>${alias.capability}</capability>`,
      `    <requested_names>${alias.requestedNames.join(", ")}</requested_names>`,
      `    <status>${alias.installed ? "installed" : "unavailable"}</status>`,
      `    <resolution>${alias.installed ? `${alias.matchedSkillName} [${alias.matchedSkillSource}]` : alias.fallback}</resolution>`,
      "  </alias>",
    ]),
    "</skill_aliases>",
  ].join("\n")
}

export async function writeSkillAliasReport(aliases?: SkillAliasAvailability[]) {
  const resolved = aliases ?? (await resolveSkillAliasAvailability())
  const destination = path.join(projectSkillsRoot(), "killstata-skill-alias-report.json")
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.writeFile(destination, JSON.stringify({ generatedAt: new Date().toISOString(), aliases: resolved }, null, 2), "utf-8")
  return destination
}
