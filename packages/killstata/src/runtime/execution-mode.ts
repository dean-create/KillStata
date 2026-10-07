import fs from "fs"
import path from "path"
import { Global } from "@/global"

export type ExecutionMode = "auto" | "plan"

/**
 * 执行模式（Auto / Plan）由 TUI 写在 `Global.Path.state/execution_mode.json`，
 * 运行时按需同步读取。
 *
 * - `auto`：模型自由决策调用工具完成任务。
 * - `plan`：不修改用户原始数据、不运行估计，只允许会话交互和受管 data_import 检查快照。
 *   工具**可见性与 Auto 完全一致**（模型照常 tool_search 加载估计方法、读数据画像，才能
 *   写出带方法名和参数的方案）；差异只在**执行层**，其余变更型工具会被拒绝执行。
 */
export function getExecutionMode(): ExecutionMode {
  try {
    const file = path.join(Global.Path.state, "execution_mode.json")
    if (!fs.existsSync(file)) return "auto"
    const data = JSON.parse(fs.readFileSync(file, "utf-8"))
    return data?.mode === "plan" ? "plan" : "auto"
  } catch {
    return "auto"
  }
}

/**
 * Plan 模式下仍允许执行的规划动作：不修改用户原始数据、不运行估计；question/todo
 * 只写会话态，data_import 的检查动作只生成受管的临时快照和数据就绪证据。
 * - `question`：主动向用户澄清（两种模式都必须支持）。
 * - `todowrite`：维护计划待办清单。
 * - `skill`：加载技能说明（只写会话态，不碰数据/文件系统）。
 */
export const PLAN_MODE_EXECUTION_ALLOWLIST = new Set(["question", "todowrite", "skill"])

/**
 * Plan 模式允许的 data_import 动作。
 *
 * 在本产品里「读一份 Excel」的唯一途径就是 data_import：import 把原始表转成受管
 * parquet 快照，profile/validate/correlation/frequency 在该快照上出画像与质检。
 * 这些动作不修改用户的原始文件，也不产生面向用户的分析交付物；它们会生成受管的
 * 检查快照，这是规划期允许的内部运行状态写入，不应再笼统称为“零副作用”。
 *
 * 放行它们是 Plan 模式能提出**数据驱动**问题的前提：拿不到真实列名、面板键和变量
 * 类型，就只能问空泛问题或臆造列名（question.txt 明确禁止后者）。
 *
 * export/rollback 不在此列：前者产出交付文件，后者改写阶段血缘，都属于真正的写操作。
 */
export const PLAN_MODE_DATA_ACTION_ALLOWLIST = new Set([
  "import",
  "profile",
  "validate",
  "correlation",
  "frequency",
  "healthcheck",
])

/** Plan 模式下该工具调用是否放行（工具名 + 具体 action 一起判定）。 */
export function isAllowedInPlanMode(toolName: string, args: unknown) {
  if (PLAN_MODE_EXECUTION_ALLOWLIST.has(toolName)) return true
  if (toolName !== "data_import") return false
  const action = (args as { action?: unknown } | null | undefined)?.action
  return typeof action === "string" && PLAN_MODE_DATA_ACTION_ALLOWLIST.has(action)
}
