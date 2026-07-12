import path from "path"
import fs from "fs"
import { Instance } from "../project/instance"
import type { Tool } from "./tool"

type AccessMode = "read" | "write"

type SessionPathConfirmationState = {
  confirmed: Record<string, true>
}

function normalizeAbsolute(filePath: string) {
  return path.normalize(path.resolve(filePath))
}

function workspaceRoot() {
  return Instance.directory
}

export function resolveWorkspacePath(filePath: string, root = workspaceRoot()) {
  return normalizeAbsolute(path.isAbsolute(filePath) ? filePath : path.join(root, filePath))
}

function projectRoot() {
  if (Instance.worktree && Instance.worktree !== "/") {
    return normalizeAbsolute(Instance.worktree)
  }
  return workspaceRoot()
}

function isWithinRoot(targetPath: string, rootPath: string) {
  const relative = path.relative(rootPath, targetPath)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function confirmationKey(toolName: string, mode: AccessMode, absolutePath: string) {
  return `${toolName}:${mode}:${absolutePath}`
}

const state = Instance.state(() => {
  const data: Record<string, SessionPathConfirmationState> = {}
  return data
})

function sessionState(sessionID: string) {
  const current = state()[sessionID] ?? { confirmed: {} }
  state()[sessionID] = current
  return current
}

export function analysisWorkspaceRoot() {
  return workspaceRoot()
}

export function isAnalysisPathAutoAllowed(input: {
  absolutePath: string
  workspaceRoot: string
  projectRoot: string
}) {
  const target = normalizeAbsolute(input.absolutePath)
  const workspace = normalizeAbsolute(input.workspaceRoot)
  const project = normalizeAbsolute(input.projectRoot)

  if (isWithinRoot(target, workspace)) {
    return true
  }

  const whitelistRoots = [
    path.join(project, "test"),
    path.join(project, "modelpctest"),
    path.join(project, "killstata_outputs"),
    path.join(workspace, ".killstata"),
  ].map(normalizeAbsolute)

  return whitelistRoots.some((root) => isWithinRoot(target, root))
}

export function relativeWithinProject(filePath: string) {
  const relative = path.relative(Instance.directory, filePath)
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return relative || "."
  }
  return path.normalize(filePath)
}

export async function resolveToolPath(input: {
  filePath: string
  mode: AccessMode
  toolName: string
  sessionID: string
  callID?: string
  messageID: string
  ask: Tool.Context["ask"]
}) {
  const root = workspaceRoot()
  const project = projectRoot()
  const absolutePath = resolveWorkspacePath(input.filePath, root)

  if (
    Instance.containsPath(absolutePath) ||
    isWithinRoot(absolutePath, root) ||
    isAnalysisPathAutoAllowed({
      absolutePath,
      workspaceRoot: root,
      projectRoot: project,
    })
  ) {
    return absolutePath
  }

  const key = confirmationKey(input.toolName, input.mode, absolutePath)
  const current = sessionState(input.sessionID)
  if (current.confirmed[key]) {
    return absolutePath
  }

  const parentDir =
    input.mode === "write"
      ? absolutePath
      : fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()
        ? absolutePath
        : path.dirname(absolutePath)
  const glob = path.join(parentDir, "*")

  await input.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: absolutePath,
      parentDir,
    },
  })

  current.confirmed[key] = true
  return absolutePath
}
