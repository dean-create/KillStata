import { Bus } from "@/bus"
import { RuntimeEvents } from "./events"
import { RuntimeTaskLedger } from "./task-ledger"
import { RuntimeProtocol } from "./protocol"
import type { ExecPolicy, ExecPolicyDecision } from "./types"

function nowIso() {
  return new Date().toISOString()
}

function localId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export const DEFAULT_EXEC_POLICY: ExecPolicy = {
  profile: "local-default",
  safePrefixes: [
    "pwd",
    "echo",
    "git status",
    "git diff",
    "python --version",
    "python -V",
    "py --version",
    "where",
    "Get-ChildItem",
    "Select-String",
    "dir",
    "ls",
  ],
  askPrefixes: ["npm publish", "bun publish", "pip install", "uv pip install", "curl", "wget", "Invoke-WebRequest", "iwr"],
  denyPatterns: ["git reset --hard", "git clean -fd", "format ", "shutdown ", "reg delete"],
  networkRequiresApproval: true,
  externalWriteRequiresApproval: true,
}

function startsWithAny(command: string, prefixes: string[]) {
  const normalized = command.trim().toLowerCase()
  return prefixes.find((prefix) => normalized.startsWith(prefix.toLowerCase()))
}

function includesAny(command: string, patterns: string[]) {
  const normalized = command.toLowerCase()
  return patterns.find((pattern) => normalized.includes(pattern.toLowerCase()))
}

function commandLooksDestructive(command: string) {
  return /\b(Remove-Item|rm|del|rmdir)\b/i.test(command)
}

function commandTouchesTrustedArtifact(command: string) {
  return /\.parquet\b/i.test(command) && /(\>|Remove-Item|rm|del|Set-Content|Out-File)/i.test(command)
}

function commandUsesNetwork(command: string) {
  return /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b/i.test(command)
}

function commandRunsAdHocRegression(command: string) {
  return /\b(python|py|bun|node)\b/i.test(command) && /\b(PanelOLS|statsmodels|linearmodels|ols|regression)\b/i.test(command)
}

export function evaluateExecPolicy(input: {
  sessionID: string
  toolName: string
  command: string
  policy?: ExecPolicy
}) {
  const policy = input.policy ?? DEFAULT_EXEC_POLICY
  const denied = includesAny(input.command, policy.denyPatterns)
  const askPrefix = startsWithAny(input.command, policy.askPrefixes)
  const safePrefix = startsWithAny(input.command, policy.safePrefixes)
  const networkAccess = commandUsesNetwork(input.command)
  const trustedArtifactOverwrite = commandTouchesTrustedArtifact(input.command)
  const destructive = commandLooksDestructive(input.command)
  const adHocRegression = commandRunsAdHocRegression(input.command)

  let action: ExecPolicyDecision["action"] = "allow"
  let reason = "Command matches the local execution policy."
  let matchedRule = safePrefix ? `safe-prefix:${safePrefix}` : undefined
  let filesystemRisk: ExecPolicyDecision["filesystemRisk"] = "none"

  if (denied) {
    action = "deny"
    reason = "Command matches a forbidden execution rule."
    matchedRule = `deny-pattern:${denied}`
  } else if (trustedArtifactOverwrite) {
    action = "ask"
    reason = "Command may overwrite a canonical parquet or trusted artifact; approval and audit are required."
    matchedRule = "econometrics:trusted-artifact-overwrite"
    filesystemRisk = "trusted_artifact_overwrite"
  } else if (destructive) {
    action = "ask"
    reason = "Command may delete files or folders; approval and audit are required."
    matchedRule = "filesystem:destructive"
    filesystemRisk = "destructive"
  } else if (networkAccess && policy.networkRequiresApproval) {
    action = "ask"
    reason = "Command requests network access; approval and audit are required."
    matchedRule = "network:approval-required"
  } else if (adHocRegression) {
    action = "ask"
    reason = "Command appears to run ad hoc regression code; workflow audit is required before execution."
    matchedRule = "econometrics:adhoc-regression"
  } else if (askPrefix) {
    action = "ask"
    reason = "Command matches an approval-required prefix."
    matchedRule = `ask-prefix:${askPrefix}`
  }

  const decision: ExecPolicyDecision = {
    decisionId: localId("policy"),
    sessionID: input.sessionID,
    toolName: input.toolName,
    command: input.command,
    action,
    reason,
    matchedRule,
    networkAccess,
    filesystemRisk,
    createdAt: nowIso(),
  }
  Bus.publish(RuntimeEvents.ExecPolicyDecision, {
    sessionID: input.sessionID,
    decision,
  })
  RuntimeProtocol.publish({
    sessionID: input.sessionID,
    source: "tool",
    type: "exec_policy.decision",
    payload: { decision },
  })
  RuntimeTaskLedger.recordPolicyDecision(input.sessionID, decision)
  return decision
}
