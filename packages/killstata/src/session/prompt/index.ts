/**
 * `session/prompt` 的公开门面。
 *
 * 原先是一个 2204 行的 namespace，同时承担意图识别、消息入库、队列调度、
 * 主循环、子任务、工具解析、自动修复、shell 与命令执行。拆分后这里重新组装出
 * **同名 namespace 与同样的成员**，外部使用点（SessionPrompt.prompt 等）
 * 一行都不用改。新代码请直接从子模块导入。
 */

import { AUTOMATIC_TOOL_REPAIR_LIMIT as _AUTOMATIC_TOOL_REPAIR_LIMIT, CommandInput as _CommandInput, OUTPUT_TOKEN_MAX as _OUTPUT_TOKEN_MAX, PromptInput as _PromptInput, ShellInput as _ShellInput, shouldAutomaticallyRepairTool as _shouldAutomaticallyRepairTool } from "./types"

import { detectInputIntent as _detectInputIntent } from "./intent"

import { assertNotBusy as _assertNotBusy } from "./queue"

import { resolvePromptParts as _resolvePromptParts } from "./message"

import { cancel as _cancel, loop as _loop, prompt as _prompt } from "./dispatch"

import { shell as _shell } from "./shell"

import { command as _command } from "./command"

import type { CommandInput as _CommandInputType, PromptInput as _PromptInputType, ShellInput as _ShellInputType } from "./types"

export namespace SessionPrompt {
  export const PromptInput = _PromptInput
  export type PromptInput = _PromptInputType
  export const ShellInput = _ShellInput
  export type ShellInput = _ShellInputType
  export const CommandInput = _CommandInput
  export type CommandInput = _CommandInputType
  export const OUTPUT_TOKEN_MAX = _OUTPUT_TOKEN_MAX
  export const AUTOMATIC_TOOL_REPAIR_LIMIT = _AUTOMATIC_TOOL_REPAIR_LIMIT
  export const shouldAutomaticallyRepairTool = _shouldAutomaticallyRepairTool
  export const detectInputIntent = _detectInputIntent
  export const assertNotBusy = _assertNotBusy
  export const prompt = _prompt
  export const loop = _loop
  export const cancel = _cancel
  export const resolvePromptParts = _resolvePromptParts
  export const shell = _shell
  export const command = _command
}

// 这两个原本声明在 namespace 之外（`import { AUTOMATIC_TOOL_REPAIR_LIMIT } from "./prompt"`），
// 保持同样的具名导出，调用方无需改写。
export { AUTOMATIC_TOOL_REPAIR_LIMIT, shouldAutomaticallyRepairTool } from "./types"
