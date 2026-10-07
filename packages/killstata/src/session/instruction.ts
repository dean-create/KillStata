import { Instance } from "@/project/instance"
import type { MessageV2 } from "./message-v2"
import { loadCustomRules } from "./custom-rules"

/**
 * 提示词的**用户规则层**：把 AGENTS.md 这类项目约定读进 system prompt。
 * 具体读哪些文件由 `loadCustomRules` 决定。
 */
export namespace SessionInstruction {
  export async function system() {
    const rules = await loadCustomRules({ project: Instance.worktree })
    return rules.map((rule) => `# 项目自定义规则\n来源：${rule.path}\n${rule.content}`)
  }

  /**
   * read 工具的按需规则注入点：读到某个文件时，追加与它相关的规则说明。
   * 目前恒返回空（没有基于路径的规则来源），但 `tool/read.ts` 已消费其返回值，
   * 保留接口以免后续接入时再改调用方。
   */
  export async function resolve(_messages: MessageV2.WithParts[], _filepath: string, _messageID: string) {
    return [] as { filepath: string; content: string }[]
  }
}
