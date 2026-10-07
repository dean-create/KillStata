import z from "zod"
import { Flag } from "../../flag/flag"
import { Identifier } from "../../id/id"
import { Log } from "../../util/log"
import { MessageV2 } from "../message-v2"

/**
 * 会话提示流程的共享类型、常量与模块级单例。
 *
 * 最底层：其余模块都可以依赖它，它谁也不依赖。
 */

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

/** 连续三次仍未修复才熔断；与模型/压缩失败的三次上限保持一致。 */
export const AUTOMATIC_TOOL_REPAIR_LIMIT = 3

export function shouldAutomaticallyRepairTool(attempts: number) {
  return attempts < AUTOMATIC_TOOL_REPAIR_LIMIT
}

export const log = Log.create({ service: "session.prompt" })

export const OUTPUT_TOKEN_MAX = Flag.KILLSTATA_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

export const PromptInput = z.object({
  sessionID: Identifier.schema("session"),
  messageID: Identifier.schema("message").optional(),
  model: z
    .object({
      providerID: z.string(),
      modelID: z.string(),
    })
    .optional(),
  agent: z.string().optional(),
  noReply: z.boolean().optional(),
  tools: z
    .record(z.string(), z.boolean())
    .optional()
    .describe(
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
    ),
  system: z.string().optional(),
  variant: z.string().optional(),
  queuePriority: z.number().int().optional(),
  queueActionType: z.enum(["prompt", "command", "shell", "continue", "retry", "repair", "compaction"]).optional(),
  queueMetadata: z.record(z.string(), z.any()).optional(),
  intent: z.enum(["conversation", "status", "repair", "verify", "report", "analysis", "ingest"]).optional(),
  parts: z.array(
    z.discriminatedUnion("type", [
      MessageV2.TextPart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "TextPartInput",
        }),
      MessageV2.FilePart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "FilePartInput",
        }),
      MessageV2.AgentPart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "AgentPartInput",
        }),
      MessageV2.SubtaskPart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "SubtaskPartInput",
        }),
    ]),
  ),
})

export type PromptInput = z.infer<typeof PromptInput>

export const ShellInput = z.object({
  sessionID: Identifier.schema("session"),
  agent: z.string(),
  model: z
    .object({
      providerID: z.string(),
      modelID: z.string(),
    })
    .optional(),
  command: z.string(),
})

export type ShellInput = z.infer<typeof ShellInput>

export const CommandInput = z.object({
  messageID: Identifier.schema("message").optional(),
  sessionID: Identifier.schema("session"),
  agent: z.string().optional(),
  model: z.string().optional(),
  arguments: z.string(),
  command: z.string(),
  variant: z.string().optional(),
  queuePriority: z.number().int().optional(),
  queueMetadata: z.record(z.string(), z.any()).optional(),
  parts: z
    .array(
      z.discriminatedUnion("type", [
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        }).partial({
          id: true,
        }),
      ]),
    )
    .optional(),
})

export type CommandInput = z.infer<typeof CommandInput>

export const bashRegex = /!`([^`]+)`/g

// Match [Image N] as single token, quoted strings, or non-space sequences
export const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi

export const placeholderRegex = /\$(\d+)/g

export const quoteTrimRegex = /^["']|["']$/g
