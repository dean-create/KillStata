import path from "path"
import { Instance } from "../project/instance"
import { Question } from "../question"

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
}) {
  const root = workspaceRoot()
  const absolutePath = resolveWorkspacePath(input.filePath, root)

  if (Instance.containsPath(absolutePath) || isWithinRoot(absolutePath, root)) {
    return absolutePath
  }

  const key = confirmationKey(input.toolName, input.mode, absolutePath)
  const current = sessionState(input.sessionID)
  if (current.confirmed[key]) {
    return absolutePath
  }

  const answers = await Question.ask({
    sessionID: input.sessionID,
    questions: [
      {
        header: "Path Access",
        question: `${input.toolName} wants ${input.mode} access to project-external path:\n${absolutePath}\nAllow this access for the current session?`,
        custom: false,
        options: [
          {
            label: "Yes",
            description: "Allow this external path access for the current session",
          },
          {
            label: "No",
            description: "Reject this external path access",
          },
        ],
      },
    ],
    tool: input.callID ? { messageID: input.messageID, callID: input.callID } : undefined,
  })

  if (answers[0]?.[0] !== "Yes") {
    throw new Question.RejectedError()
  }

  current.confirmed[key] = true
  return absolutePath
}
