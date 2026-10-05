export type DesktopSlashCommand = {
  name: string
  aliases?: string[]
  description: string
  source: "local" | "core"
  execution: "local" | "core-command" | "session-operation"
  argumentMode: "none" | "text" | "effort"
}

const INITIAL_COMMANDS: DesktopSlashCommand[] = [
  { name: "new", aliases: ["clear"], description: "开始新会话", source: "local", execution: "local", argumentMode: "none" },
  { name: "config", aliases: ["connect", "settings"], description: "打开模型连接设置", source: "local", execution: "local", argumentMode: "none" },
  { name: "themes", description: "打开外观设置", source: "local", execution: "local", argumentMode: "none" },
  { name: "context", description: "查看当前会话上下文占用", source: "local", execution: "session-operation", argumentMode: "none" },
  { name: "copy", description: "复制当前会话的可见文本", source: "local", execution: "session-operation", argumentMode: "none" },
  { name: "doctor", description: "检查 Python、模型和分析依赖", source: "core", execution: "core-command", argumentMode: "text" },
  { name: "exit", aliases: ["quit", "q"], description: "关闭 KillStata Desktop", source: "local", execution: "local", argumentMode: "none" },
  { name: "export", description: "导出当前结果", source: "local", execution: "local", argumentMode: "none" },
  { name: "help", description: "显示当前可用命令", source: "local", execution: "local", argumentMode: "none" },
  { name: "model", aliases: ["models"], description: "打开模型选择设置", source: "local", execution: "local", argumentMode: "none" },
  { name: "reasoning", description: "查看或设置推理等级", source: "local", execution: "local", argumentMode: "effort" },
  { name: "rename", description: "修改当前研究标题", source: "local", execution: "session-operation", argumentMode: "text" },
  { name: "sessions", aliases: ["resume", "continue"], description: "打开最近研究并切换会话", source: "local", execution: "local", argumentMode: "none" },
  { name: "thinking", aliases: ["toggle-thinking"], description: "切换思考过程显示", source: "local", execution: "local", argumentMode: "none" },
  { name: "timestamps", aliases: ["toggle-timestamps"], description: "切换消息时间显示", source: "local", execution: "local", argumentMode: "none" },
  { name: "undo", description: "撤销上一条用户消息及其数据影响", source: "local", execution: "session-operation", argumentMode: "none" },
  { name: "redo", description: "恢复刚才撤销的消息状态", source: "local", execution: "session-operation", argumentMode: "none" },
  { name: "compact", aliases: ["summarize"], description: "压缩当前会话上下文", source: "local", execution: "session-operation", argumentMode: "text" },
]

export function desktopSlashCommandCatalog(): readonly DesktopSlashCommand[] {
  return INITIAL_COMMANDS
}

export function parseSlashInvocation(input: string) {
  const trimmed = input.trim()
  if (!trimmed.startsWith("/")) return undefined
  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
  if (!match) return undefined
  return { name: match[1], arguments: match[2] ?? "" }
}

export function normalizeSlashCommand(input: string) {
  const parsed = parseSlashInvocation(input)
  if (!parsed) return undefined
  const rawName = parsed.name
  const command = desktopSlashCommandCatalog().find((item) => item.name === rawName || item.aliases?.includes(rawName))
  if (!command) return undefined
  return { name: command.name, arguments: parsed.arguments }
}
