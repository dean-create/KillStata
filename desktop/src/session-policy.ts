/**
 * 会话策略：工具权限档位与推理等级。
 *
 * 权限档位是 Desktop 面向研究者的语义封装；真正的授权判定仍由 Core 的
 * PermissionNext 执行，Desktop 只在 session.create 时提交规则集，不自行放行任何调用。
 * 原始数据文件从不被引擎直接读写（Desktop 上传的是副本），引擎只在自己的工作区活动。
 */

export type PermissionMode = "read_only" | "workspace_write" | "full_access"

/** 与 Core PermissionRule 同形；提交给 session.create 的 permission 字段。 */
export type SessionPermissionRule = {
  permission: string
  pattern: string
  action: "allow" | "deny" | "ask"
}

export type PermissionModeInfo = {
  id: PermissionMode
  label: string
  description: string
}

export const PERMISSION_MODES: ReadonlyArray<PermissionModeInfo> = [
  {
    id: "read_only",
    label: "只读分析",
    description: "只读取与检索工作区文件；写入和命令执行都需要你逐次确认。",
  },
  {
    id: "workspace_write",
    label: "工作区读写",
    description: "在分析工作区内读写阶段产物；受管的 Python 计量命令仍逐次确认。",
  },
  {
    id: "full_access",
    label: "完全访问",
    description: "工作区内读写与受管命令自动放行；仍不允许联网取数或越界读取。",
  },
]

export const DEFAULT_PERMISSION_MODE: PermissionMode = "workspace_write"

export function permissionModeInfo(mode: PermissionMode): PermissionModeInfo {
  return PERMISSION_MODES.find((item) => item.id === mode) ?? PERMISSION_MODES[1]!
}

/**
 * 档位 → Core 规则集。
 *
 * 三档共享的硬边界（任何档位都不放开，避免模型绕开本地数据边界）：
 * - external_directory=deny：不得读取工作区外的任意路径。
 * - webfetch/websearch=deny：不允许联网取数。
 * - task=deny：不允许派生子代理。
 */
export function permissionRuleset(mode: PermissionMode): SessionPermissionRule[] {
  const readAction = "allow" as const
  const editAction = mode === "read_only" ? "ask" : "allow"
  const bashAction = mode === "full_access" ? "allow" : "ask"
  const rule = (permission: string, action: "allow" | "deny" | "ask"): SessionPermissionRule => ({
    permission,
    pattern: "*",
    action,
  })
  return [
    rule("read", readAction),
    rule("glob", readAction),
    rule("grep", readAction),
    rule("list", readAction),
    rule("todoread", "allow"),
    rule("todowrite", "allow"),
    rule("question", "allow"),
    rule("edit", editAction),
    rule("write", editAction),
    rule("patch", editAction),
    rule("bash", bashAction),
    rule("task", "deny"),
    rule("webfetch", "deny"),
    rule("websearch", "deny"),
    rule("external_directory", "deny"),
  ]
}

/**
 * 推理等级：Core 把它作为 agent variant 传给 provider。
 * 只暴露 KillStata 支持的两家 provider 都能落地的档位；模型不支持时 Core 自行降级。
 */
export type ReasoningEffort = "default" | "low" | "medium" | "high"

export const REASONING_EFFORTS: ReadonlyArray<{ id: ReasoningEffort; label: string }> = [
  { id: "default", label: "默认" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
]

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "default"

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "default" || value === "low" || value === "medium" || value === "high"
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "read_only" || value === "workspace_write" || value === "full_access"
}

/** 模型 ID 去掉 provider 前缀后的展示名，如 deepseek/deepseek-v4-flash → deepseek-v4-flash。 */
export function modelDisplayName(model: string | undefined): string {
  if (!model?.trim()) return "未配置模型"
  const trimmed = model.trim()
  const separator = trimmed.indexOf("/")
  return separator > 0 ? trimmed.slice(separator + 1) : trimmed
}
