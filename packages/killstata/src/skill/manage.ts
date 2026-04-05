import fs from "fs/promises"
import path from "path"
import { Filesystem } from "@/util/filesystem"
import { ConfigMarkdown } from "@/config/markdown"
import { NamedError } from "@killstata/util/error"
import { Instance } from "@/project/instance"
import z from "zod"
import {
  defaultSkillsRoot as runtimeDefaultSkillsRoot,
  defaultSkillsManifestPath as runtimeDefaultSkillsManifestPath,
  ensureKillstataHomeDirectories,
  importedSkillsRoot as runtimeImportedSkillsRoot,
  legacyUserSkillRoot,
  localSkillsRoot as runtimeLocalSkillsRoot,
  userSkillRoot as runtimeUserSkillRoot,
} from "@/killstata/runtime-config"

export const SkillSource = z.enum(["builtin", "default", "user", "project", "imported"])
export type SkillSource = z.infer<typeof SkillSource>

export const DoctorFinding = z.object({
  level: z.enum(["info", "warn", "error"]),
  skill: z.string().optional(),
  path: z.string(),
  code: z.string(),
  message: z.string(),
})
export type DoctorFinding = z.infer<typeof DoctorFinding>

export const InstallFromGitHubError = NamedError.create(
  "SkillInstallFromGitHubError",
  z.object({
    message: z.string(),
  }),
)

const GITHUB_API_ROOT = "https://api.github.com"

type GithubItem = {
  type: "file" | "dir" | "symlink" | "submodule"
  path: string
  name: string
  download_url: string | null
  url: string
}

export function builtinSkillsRoot() {
  return path.resolve(import.meta.dir, "../../skills/builtin")
}

export function userSkillsRoot() {
  return runtimeUserSkillRoot()
}

export function importedSkillsRoot() {
  return runtimeImportedSkillsRoot()
}

export function defaultSkillsRoot() {
  return runtimeDefaultSkillsRoot()
}

export function defaultSkillsManifestPath() {
  return runtimeDefaultSkillsManifestPath()
}

export function localSkillsRoot() {
  return runtimeLocalSkillsRoot()
}

export function projectSkillsRoot() {
  const projectRoot = Instance.worktree || Instance.directory
  return path.join(projectRoot, ".killstata", "skills")
}

export async function ensureSkillDirectories() {
  await ensureKillstataHomeDirectories()
  await fs.mkdir(projectSkillsRoot(), { recursive: true })
}

export function pathWithin(parent: string, child: string) {
  const resolvedParent = path.resolve(parent)
  const resolvedChild = path.resolve(child)
  const parentNorm = process.platform === "win32" ? resolvedParent.toLowerCase() : resolvedParent
  const childNorm = process.platform === "win32" ? resolvedChild.toLowerCase() : resolvedChild
  if (parentNorm === childNorm) return true
  return childNorm.startsWith(parentNorm + path.sep)
}

function githubHeaders() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  return {
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

function assertSafeRelative(input: string, field: string) {
  if (!input || input.includes("\0")) {
    throw new InstallFromGitHubError({ message: `${field} must be a non-empty string` })
  }
  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "")
  if (!normalized || normalized.includes("..")) {
    throw new InstallFromGitHubError({ message: `${field} must not contain path traversal` })
  }
  return normalized
}

async function fetchGithubJson<T>(url: string, fetchFn: typeof fetch): Promise<T> {
  const response = await fetchFn(url, { headers: githubHeaders() })
  if (!response.ok) {
    throw new InstallFromGitHubError({ message: `GitHub request failed: ${response.status} ${response.statusText}` })
  }
  return (await response.json()) as T
}

async function fetchGithubText(url: string, fetchFn: typeof fetch): Promise<string> {
  const response = await fetchFn(url, { headers: githubHeaders() })
  if (!response.ok) {
    throw new InstallFromGitHubError({ message: `GitHub file download failed: ${response.status} ${response.statusText}` })
  }
  return response.text()
}

async function downloadGithubDirectory(
  repo: string,
  skillPath: string,
  ref: string,
  destination: string,
  fetchFn: typeof fetch,
) {
  const queue = [
    `${GITHUB_API_ROOT}/repos/${repo}/contents/${skillPath}?ref=${encodeURIComponent(ref)}`,
  ]
  let foundSkill = false

  while (queue.length > 0) {
    const url = queue.shift()!
    const payload = await fetchGithubJson<GithubItem[] | GithubItem>(url, fetchFn)
    const items = Array.isArray(payload) ? payload : [payload]

    for (const item of items) {
      const relative = assertSafeRelative(path.posix.relative(skillPath, item.path), "skill path")
      const dest = path.join(destination, relative)

      if (item.type === "dir") {
        queue.push(item.url)
        await fs.mkdir(dest, { recursive: true })
        continue
      }

      if (item.type !== "file") {
        throw new InstallFromGitHubError({ message: `Unsupported GitHub entry type "${item.type}" in ${item.path}` })
      }

      if (!item.download_url) {
        throw new InstallFromGitHubError({ message: `Missing download URL for ${item.path}` })
      }

      const content = await fetchGithubText(item.download_url, fetchFn)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await Bun.write(dest, content)
      if (path.basename(item.path) === "SKILL.md") foundSkill = true
    }
  }

  if (!foundSkill) {
    throw new InstallFromGitHubError({ message: `No SKILL.md found under ${repo}/${skillPath}` })
  }
}

export async function installSkillFromGitHub(input: {
  repo: string
  skillPath: string
  ref?: string
  destinationRoot?: string
  fetchFn?: typeof fetch
}) {
  const repo = input.repo.trim()
  const skillPath = assertSafeRelative(input.skillPath.trim(), "skillPath")
  const ref = input.ref?.trim() || "main"
  const destinationRoot = input.destinationRoot || projectSkillsRoot()
  const fetchFn = input.fetchFn || fetch

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new InstallFromGitHubError({ message: "repo must be in owner/repo format" })
  }

  const destination = path.join(destinationRoot, path.posix.basename(skillPath))
  if (await Filesystem.exists(destination)) {
    throw new InstallFromGitHubError({ message: `Skill already exists at ${destination}` })
  }

  await fs.mkdir(destinationRoot, { recursive: true })
  await downloadGithubDirectory(repo, skillPath, ref, destination, fetchFn)
  return {
    destination,
    repo,
    ref,
    skillPath,
  }
}

function extractReferencedRelativePaths(content: string) {
  const matches = new Set<string>()
  const patterns = [
    /\((scripts\/[^)\s]+|templates\/[^)\s]+|references\/[^)\s]+|assets\/[^)\s]+|resources\/[^)\s]+)\)/g,
    /`(scripts\/[^`\s]+|templates\/[^`\s]+|references\/[^`\s]+|assets\/[^`\s]+|resources\/[^`\s]+)`/g,
  ]

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const candidate = match[1]?.trim()
      if (candidate) matches.add(candidate)
    }
  }

  return Array.from(matches)
}

export async function doctorSkillFile(filePath: string) {
  const findings: DoctorFinding[] = []
  const root = path.dirname(filePath)

  const parsed = await ConfigMarkdown.parse(filePath).catch((error) => error)
  if (parsed instanceof Error) {
    findings.push({
      level: "error",
      path: filePath,
      code: "frontmatter_invalid",
      message: parsed.message,
    })
    return findings
  }

  const body = parsed.content.trim()
  if (!body) {
    findings.push({
      level: "warn",
      path: filePath,
      skill: parsed.data.name,
      code: "empty_body",
      message: "SKILL.md has no instruction body",
    })
  }

  const requiredAgentConfig =
    pathWithin(defaultSkillsRoot(), filePath) || pathWithin(path.resolve(import.meta.dir, "../../skills/default"), filePath)
  if (requiredAgentConfig) {
    const openaiYamlPath = path.join(root, "agents", "openai.yaml")
    if (!(await Filesystem.exists(openaiYamlPath))) {
      findings.push({
        level: "error",
        path: filePath,
        skill: parsed.data.name,
        code: "missing_agent_metadata",
        message: "Default skills must include agents/openai.yaml",
      })
    }
  }

  const expectedName = path.basename(root)
  if (parsed.data.name && parsed.data.name !== expectedName) {
    findings.push({
      level: "warn",
      path: filePath,
      skill: parsed.data.name,
      code: "name_mismatch",
      message: `Frontmatter name "${parsed.data.name}" differs from directory name "${expectedName}"`,
    })
  }

  for (const referenced of extractReferencedRelativePaths(body)) {
    const normalized = assertSafeRelative(referenced, "referenced path")
    const target = path.join(root, normalized)
    if (!(await Filesystem.exists(target))) {
      findings.push({
        level: "error",
        path: filePath,
        skill: parsed.data.name,
        code: "missing_helper",
        message: `Referenced helper file not found: ${referenced}`,
      })
    }
  }

  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const relative = path.relative(root, path.join(entry.path, entry.name))
    if (!relative) continue
    if (relative.includes("..")) {
      findings.push({
        level: "error",
        path: filePath,
        skill: parsed.data.name,
        code: "invalid_layout",
        message: `Found invalid relative path while scanning skill contents: ${relative}`,
      })
    }
  }

  return findings
}

export async function uninstallSkillDirectory(skillDir: string) {
  const allowedRoots = [
    projectSkillsRoot(),
    userSkillsRoot(),
    defaultSkillsRoot(),
    path.join(userSkillsRoot(), "imported"),
    path.join(userSkillsRoot(), "local"),
    legacyUserSkillRoot(),
    path.join(legacyUserSkillRoot(), "imported"),
    path.join(legacyUserSkillRoot(), "local"),
  ]
  if (!allowedRoots.some((root) => pathWithin(root, skillDir))) {
    throw new InstallFromGitHubError({
      message: `Refusing to uninstall skill outside ${projectSkillsRoot()} or ${userSkillsRoot()}`,
    })
  }
  await fs.rm(skillDir, { recursive: true, force: true })
}
