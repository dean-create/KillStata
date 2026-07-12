import fs from "fs"
import path from "path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Octokit } from "@octokit/rest"
import z from "zod/v4"
import { Config } from "../config/config"

const SOURCE_ENTRY = path.resolve(import.meta.dir, "../git-github-mcp-server.ts")

type RepoContext = {
  root: string
  branch: string | null
  remoteUrl: string | null
  owner: string | null
  repo: string | null
}

type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

function bundledCommandViaBun() {
  return [process.execPath, "run", "--conditions=browser", SOURCE_ENTRY]
}

export function bundledGitGitHubServerCommand() {
  if (process.env.KILLSTATA_BIN_PATH) {
    return [process.env.KILLSTATA_BIN_PATH, "mcp", "git-github-server"]
  }

  if (process.versions.bun && fs.existsSync(SOURCE_ENTRY)) {
    return bundledCommandViaBun()
  }

  return ["killstata", "mcp", "git-github-server"]
}

export function createBuiltInGitGitHubMcpConfig(): Config.Mcp {
  return {
    type: "local",
    command: bundledGitGitHubServerCommand(),
    timeout: 120_000,
  }
}

function runCommand(command: string, args: string[], cwd = process.cwd(), env?: Record<string, string | undefined>): CommandResult {
  const proc = Bun.spawnSync([command, ...args], {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  return {
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
    exitCode: proc.exitCode,
  }
}

function runOrThrow(command: string, args: string[], cwd = process.cwd(), env?: Record<string, string | undefined>) {
  const result = runCommand(command, args, cwd, env)
  if (result.exitCode === 0) return result
  const detail = [result.stdout, result.stderr].filter(Boolean).join("\n")
  throw new Error(detail || `Command failed: ${command} ${args.join(" ")}`)
}

function textResult(text: string) {
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
  }
}

function optionalText(text: string, fallback: string) {
  return text.trim().length > 0 ? text : fallback
}

function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const match = url.match(/^(?:(?:https?|ssh):\/\/)?(?:git@)?github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (!match) return null
  return { owner: match[1], repo: match[2] }
}

function resolveRepoContext(): RepoContext {
  const root = runOrThrow("git", ["rev-parse", "--show-toplevel"]).stdout
  const branchResult = runCommand("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], root)
  const remoteResult = runCommand("git", ["remote", "get-url", "origin"], root)
  const remoteUrl = remoteResult.exitCode === 0 ? remoteResult.stdout : null
  const parsed = remoteUrl ? parseGitHubRemote(remoteUrl) : null

  return {
    root,
    branch: branchResult.exitCode === 0 ? branchResult.stdout : null,
    remoteUrl,
    owner: parsed?.owner ?? null,
    repo: parsed?.repo ?? null,
  }
}

function resolveGitHubToken(required = false) {
  const token = process.env["KILLSTATA_GITHUB_TOKEN"] || process.env["GITHUB_TOKEN"] || process.env["GH_TOKEN"]
  if (!token && required) {
    throw new Error("GitHub token is required. Set KILLSTATA_GITHUB_TOKEN, GITHUB_TOKEN, or GH_TOKEN.")
  }
  return token
}

function createOctokit(required = false) {
  const token = resolveGitHubToken(required)
  return new Octokit(token ? { auth: token } : {})
}

async function resolveGitHubRepo() {
  const repo = resolveRepoContext()
  if (!repo.owner || !repo.repo) {
    throw new Error("Current git remote origin is not a GitHub repository.")
  }
  return repo
}

function resolvePathspec(pathspec?: string[]) {
  if (!pathspec || pathspec.length === 0) return []
  return ["--", ...pathspec]
}

function summarizeStatus(root: string, shortStatus: string) {
  const lines = shortStatus.trim().length > 0 ? shortStatus.split(/\r?\n/) : []
  return [`Repository: ${root}`, `Changed entries: ${lines.length}`, optionalText(shortStatus, "Working tree clean")].join("\n")
}

function defaultLimit(limit: number | undefined, fallback: number, max = 100) {
  if (!limit || Number.isNaN(limit)) return fallback
  return Math.max(1, Math.min(limit, max))
}

function resolveDefaultBaseBranch(repo: RepoContext) {
  const originHead = runCommand("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repo.root)
  if (originHead.exitCode === 0 && originHead.stdout.includes("/")) {
    return originHead.stdout.split("/").slice(1).join("/")
  }
  return "main"
}

function withRepoRef(repo: RepoContext) {
  return `${repo.owner}/${repo.repo}`
}

export async function runBundledGitGitHubMcpServer() {
  const server = new McpServer({
    name: "killstata-git-github",
    version: "0.1.0",
  })

  server.tool(
    "git_status",
    "Show branch, tracking, and working tree status for the current repository.",
    {
      pathspec: z.array(z.string()).optional(),
    },
    async ({ pathspec }) => {
      const repo = resolveRepoContext()
      const args = ["status", "--short", "--branch", ...resolvePathspec(pathspec)]
      const result = runOrThrow("git", args, repo.root)
      return textResult(summarizeStatus(repo.root, result.stdout))
    },
  )

  server.tool(
    "git_diff",
    "Show a git diff for unstaged, staged, or ref-based changes.",
    {
      scope: z.enum(["unstaged", "staged", "ref"]).default("unstaged"),
      ref: z.string().optional(),
      pathspec: z.array(z.string()).optional(),
      nameOnly: z.boolean().optional(),
    },
    async ({ scope, ref, pathspec, nameOnly }) => {
      const repo = resolveRepoContext()
      const args = ["diff"]
      if (scope === "staged") args.push("--cached")
      if (nameOnly) args.push("--name-only")
      if (scope === "ref") {
        if (!ref) throw new Error("`ref` is required when scope is `ref`.")
        args.push(ref)
      }
      args.push(...resolvePathspec(pathspec))
      const result = runOrThrow("git", args, repo.root)
      return textResult(optionalText(result.stdout, "No diff output"))
    },
  )

  server.tool(
    "git_add",
    "Stage files in the current repository.",
    {
      files: z.array(z.string()).optional(),
      all: z.boolean().optional(),
    },
    async ({ files, all }) => {
      const repo = resolveRepoContext()
      if (!all && (!files || files.length === 0)) {
        throw new Error("Provide `all: true` or at least one file path.")
      }

      const args = all ? ["add", "-A"] : ["add", "--", ...files!]
      runOrThrow("git", args, repo.root)
      const status = runOrThrow("git", ["status", "--short", "--branch"], repo.root)
      return textResult(`Staging updated.\n\n${optionalText(status.stdout, "Working tree clean")}`)
    },
  )

  server.tool(
    "git_commit",
    "Create a commit in the current repository.",
    {
      message: z.string().min(1),
      all: z.boolean().optional(),
    },
    async ({ message, all }) => {
      const repo = resolveRepoContext()
      if (all) {
        runOrThrow("git", ["add", "-A"], repo.root)
      }
      const result = runOrThrow("git", ["commit", "-m", message], repo.root)
      return textResult(optionalText(result.stdout, "Commit created"))
    },
  )

  server.tool(
    "git_push",
    "Push the current branch or a specified branch to a remote.",
    {
      remote: z.string().optional(),
      branch: z.string().optional(),
      setUpstream: z.boolean().optional(),
    },
    async ({ remote, branch, setUpstream }) => {
      const repo = resolveRepoContext()
      const resolvedBranch = branch ?? repo.branch
      if (!resolvedBranch) {
        throw new Error("No current branch detected. Checkout a branch or provide `branch` explicitly.")
      }

      const args = ["push"]
      if (setUpstream) args.push("--set-upstream")
      if (remote) args.push(remote)
      if (resolvedBranch && (remote || setUpstream)) args.push(resolvedBranch)
      const result = runOrThrow("git", args, repo.root)
      return textResult(optionalText([result.stdout, result.stderr].filter(Boolean).join("\n"), "Push completed"))
    },
  )

  server.tool(
    "git_checkout",
    "Checkout an existing branch or create a new one.",
    {
      branch: z.string().min(1),
      create: z.boolean().optional(),
      startPoint: z.string().optional(),
    },
    async ({ branch, create, startPoint }) => {
      const repo = resolveRepoContext()
      const args = create ? ["checkout", "-b", branch] : ["checkout", branch]
      if (create && startPoint) args.push(startPoint)
      const result = runOrThrow("git", args, repo.root)
      return textResult(optionalText([result.stdout, result.stderr].filter(Boolean).join("\n"), `Checked out ${branch}`))
    },
  )

  server.tool(
    "git_log",
    "Show recent commit history.",
    {
      limit: z.number().int().positive().optional(),
      ref: z.string().optional(),
    },
    async ({ limit, ref }) => {
      const repo = resolveRepoContext()
      const args = [
        "log",
        `--max-count=${defaultLimit(limit, 10)}`,
        "--decorate",
        "--oneline",
      ]
      if (ref) args.push(ref)
      const result = runOrThrow("git", args, repo.root)
      return textResult(optionalText(result.stdout, "No commits found"))
    },
  )

  server.tool(
    "github_repo_info",
    "Fetch GitHub repository metadata for the current origin remote.",
    {},
    async () => {
      const repo = await resolveGitHubRepo()
      const octokit = createOctokit()
      const result = await octokit.rest.repos.get({
        owner: repo.owner!,
        repo: repo.repo!,
      })
      const data = result.data
      return textResult(
        [
          `Repository: ${data.full_name}`,
          `Private: ${data.private}`,
          `Default branch: ${data.default_branch}`,
          `Open issues: ${data.open_issues_count}`,
          `Clone URL: ${data.clone_url}`,
          `Description: ${data.description ?? ""}`,
        ].join("\n"),
      )
    },
  )

  server.tool(
    "github_list_pull_requests",
    "List pull requests for the current GitHub repository.",
    {
      state: z.enum(["open", "closed", "all"]).default("open"),
      limit: z.number().int().positive().optional(),
    },
    async ({ state, limit }) => {
      const repo = await resolveGitHubRepo()
      const octokit = createOctokit()
      const result = await octokit.rest.pulls.list({
        owner: repo.owner!,
        repo: repo.repo!,
        state,
        per_page: defaultLimit(limit, 10),
      })
      const lines = result.data.map((pr) => `#${pr.number} [${pr.state}] ${pr.title} (${pr.head.ref} -> ${pr.base.ref})`)
      return textResult(optionalText(lines.join("\n"), "No pull requests found"))
    },
  )

  server.tool(
    "github_view_pull_request",
    "View detailed information about a pull request.",
    {
      number: z.number().int().positive(),
    },
    async ({ number }) => {
      const repo = await resolveGitHubRepo()
      const octokit = createOctokit()
      const result = await octokit.rest.pulls.get({
        owner: repo.owner!,
        repo: repo.repo!,
        pull_number: number,
      })
      const pr = result.data
      return textResult(
        [
          `PR #${pr.number}: ${pr.title}`,
          `State: ${pr.state}${pr.draft ? " draft" : ""}`,
          `Author: ${pr.user?.login ?? "unknown"}`,
          `Branch: ${pr.head.ref} -> ${pr.base.ref}`,
          `URL: ${pr.html_url}`,
          "",
          pr.body ?? "",
        ].join("\n"),
      )
    },
  )

  server.tool(
    "github_create_pull_request",
    "Create a GitHub pull request from the current branch or a specified branch.",
    {
      title: z.string().min(1),
      body: z.string().optional(),
      base: z.string().optional(),
      head: z.string().optional(),
      draft: z.boolean().optional(),
    },
    async ({ title, body, base, head, draft }) => {
      const repo = await resolveGitHubRepo()
      const octokit = createOctokit(true)
      const resolvedHead = head ?? repo.branch
      if (!resolvedHead) {
        throw new Error("No current branch detected. Provide `head` explicitly.")
      }

      const resolvedBase = base ?? resolveDefaultBaseBranch(repo)
      const result = await octokit.rest.pulls.create({
        owner: repo.owner!,
        repo: repo.repo!,
        title,
        body,
        head: resolvedHead,
        base: resolvedBase,
        draft: draft ?? false,
      })

      return textResult(`Created PR #${result.data.number}\n${result.data.html_url}`)
    },
  )

  server.tool(
    "github_list_issues",
    "List issues for the current GitHub repository.",
    {
      state: z.enum(["open", "closed", "all"]).default("open"),
      limit: z.number().int().positive().optional(),
      labels: z.array(z.string()).optional(),
    },
    async ({ state, limit, labels }) => {
      const repo = await resolveGitHubRepo()
      const octokit = createOctokit()
      const result = await octokit.rest.issues.listForRepo({
        owner: repo.owner!,
        repo: repo.repo!,
        state,
        labels: labels?.join(","),
        per_page: defaultLimit(limit, 10),
      })

      const lines = result.data
        .filter((item) => !("pull_request" in item))
        .map((issue) => `#${issue.number} [${issue.state}] ${issue.title}`)

      return textResult(optionalText(lines.join("\n"), "No issues found"))
    },
  )

  server.tool(
    "github_view_issue",
    "View detailed information about an issue.",
    {
      number: z.number().int().positive(),
    },
    async ({ number }) => {
      const repo = await resolveGitHubRepo()
      const octokit = createOctokit()
      const result = await octokit.rest.issues.get({
        owner: repo.owner!,
        repo: repo.repo!,
        issue_number: number,
      })
      const issue = result.data
      return textResult(
        [
          `Issue #${issue.number}: ${issue.title}`,
          `State: ${issue.state}`,
          `Author: ${issue.user?.login ?? "unknown"}`,
          `URL: ${issue.html_url}`,
          "",
          issue.body ?? "",
        ].join("\n"),
      )
    },
  )

  server.tool(
    "github_comment",
    "Create a comment on an issue or pull request.",
    {
      number: z.number().int().positive(),
      body: z.string().min(1),
    },
    async ({ number, body }) => {
      const repo = await resolveGitHubRepo()
      const octokit = createOctokit(true)
      const result = await octokit.rest.issues.createComment({
        owner: repo.owner!,
        repo: repo.repo!,
        issue_number: number,
        body,
      })
      return textResult(`Created comment on ${withRepoRef(repo)}#${number}\n${result.data.html_url}`)
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
