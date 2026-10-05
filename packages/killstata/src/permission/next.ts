import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Config } from "@/config/config"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { Storage } from "@/storage/storage"
import { fn } from "@killstata/util/fn"
import { Log } from "@/util/log"
import { Wildcard } from "@/util/wildcard"
import os from "os"
import z from "zod"
import { Global } from "@/global"

export namespace PermissionNext {
  const log = Log.create({ service: "permission" })

  function expand(pattern: string): string {
    if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
    if (pattern === "~") return os.homedir()
    if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
    if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
    return pattern
  }

  export const Action = z.enum(["allow", "deny", "ask"]).meta({
    ref: "PermissionAction",
  })
  export type Action = z.infer<typeof Action>

  export const Rule = z
    .object({
      permission: z.string(),
      pattern: z.string(),
      action: Action,
    })
    .meta({
      ref: "PermissionRule",
    })
  export type Rule = z.infer<typeof Rule>

  export const Ruleset = Rule.array().meta({
    ref: "PermissionRuleset",
  })
  export type Ruleset = z.infer<typeof Ruleset>

  export function fromConfig(permission: Config.Permission) {
    const ruleset: Ruleset = []
    for (const [key, value] of Object.entries(permission)) {
      if (typeof value === "string") {
        ruleset.push({
          permission: key,
          action: value,
          pattern: "*",
        })
        continue
      }
      ruleset.push(
        ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
      )
    }
    return ruleset
  }

  export function merge(...rulesets: Ruleset[]): Ruleset {
    return rulesets.flat()
  }

  export const Request = z
    .object({
      id: Identifier.schema("permission"),
      sessionID: Identifier.schema("session"),
      permission: z.string(),
      patterns: z.string().array(),
      metadata: z.record(z.string(), z.any()),
      always: z.string().array(),
      tool: z
        .object({
          messageID: z.string(),
          callID: z.string(),
        })
        .optional(),
    })
    .meta({
      ref: "PermissionRequest",
    })

  export type Request = z.infer<typeof Request>

  export const Reply = z.enum(["once", "always", "reject"])
  export type Reply = z.infer<typeof Reply>

  export const Approval = z.object({
    projectID: z.string(),
    patterns: z.string().array(),
  })

  export const Event = {
    Asked: BusEvent.define("permission.asked", Request),
    Replied: BusEvent.define(
      "permission.replied",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
        reply: Reply,
      }),
    ),
  }

  const state = Instance.state(async () => {
    const projectID = Instance.project.id
    const stored = await Storage.read<Ruleset>(["permission", projectID]).catch(() => [] as Ruleset)

    const pending: Record<
      string,
      {
        info: Request
        resolve: () => void
        reject: (e: any) => void
      }
    > = {}

    return {
      pending,
      approved: stored,
    }
  })

  function managedRuntimeSafetyAction(
    permission: string,
    normalizedPattern: string,
    metadata: Record<string, unknown>,
  ): Action | undefined {
    if (permission !== "bash") return undefined
    const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const globalRuntimeRoot = `${Global.Path.data.replaceAll("\\", "/")}/venv`
    const legacyRuntimeRoot = `${os.homedir().replaceAll("\\", "/")}/.killstata/venv`
    const runtimeRoot = `(?:${escapeRegExp(globalRuntimeRoot)}|${escapeRegExp(legacyRuntimeRoot)}|\\.killstata/venv)`
    const executable = "(?:bin/python(?:\\d+(?:\\.\\d+)*)?|Scripts/python(?:\\.exe)?)"
    const runtimeCommand = new RegExp(`^${runtimeRoot}/(.+)$`, "i").exec(normalizedPattern)
    if (!runtimeCommand) return undefined
    const match = new RegExp(`^${executable}\\s+(.+)$`, "i").exec(runtimeCommand[1])

    // 自动放行的是“受管解释器 + 单个方法 capability”，不是解释器本身。
    // 只要命令位于受管 runtime 根目录，就进入该安全边界：非 Python 可执行文件、
    // 伪装名称，以及 -c、脚本路径、重定向或组合命令全部必须确认，不能回落到
    // agent.ts 为内部 runner 设置的目录级 allow 规则。
    const capability = match?.[1]
    if (metadata.managedRuntime === true && capability && /^\*[A-Za-z0-9_-]+\*$/.test(capability)) {
      return "allow"
    }
    return "ask"
  }

  // safetyCheck：敏感路径即使被 allow 规则命中也要弹权限（对齐 claude-code 的
  // safetyCheck 免疫 bypass）。.env* 是密钥文件，用户/项目规则不能把它们静默
  // 放行给模型——**无论读写**都拦。
  //
  // .killstata/ 是本产品的内部状态目录（datasets/inspection/reports/runtime），
  // 模型读它是正常工作流（读检查表、看 stage 状态），因此只拦**写**操作
  // （edit/write/bash 改内部状态要用户批准），只读工具（read/glob/grep）
  // 放行。这是与 claude-code 的关键差异：claude-code 保护的是用户机器的
  // .git/.env（产品从不读），而 killstata 必须读自己的 .killstata。
  function safetyActionFor(
    permission: string,
    pattern: string,
    metadata: Record<string, unknown>,
  ): Action | undefined {
    const normalized = pattern.replaceAll("\\", "/")
    const managedRuntimeAction = managedRuntimeSafetyAction(permission, normalized, metadata)
    if (managedRuntimeAction) return managedRuntimeAction
    // 边界要求：敏感路径前必须是"非路径字符"（空格/引号/操作符/字符串首尾），
    // 不能只认 / 或字符串开头——bash 权限传入的是整条命令字符串（tool/bash.ts
    // patterns 为 token 拼接，如 "rm -rf .killstata/datasets"），.killstata 前是空格
    // 而不是 /。右边界用 lookahead 防误报：.killstata.bak / .killstata_backup /
    // backup.killstata.tar.gz 这类不相关文件名不能命中。
    const NON_PATH_BOUNDARY = "[^A-Za-z0-9_.-]"
    const isKillstata = new RegExp(`(^|${NON_PATH_BOUNDARY})\\.killstata(?=${NON_PATH_BOUNDARY}|$)`).test(normalized)
    const isEnv = new RegExp(`(^|${NON_PATH_BOUNDARY})\\.env(?=[./]|${NON_PATH_BOUNDARY}|$)`, "i").test(normalized)
    if (isEnv) return "ask"
    if (isKillstata) {
      const readOnly = ["read", "glob", "grep", "list"].includes(permission)
      if (readOnly) return undefined
      return "ask"
    }
    return undefined
  }

  export const ask = fn(
    Request.partial({ id: true }).extend({
      ruleset: Ruleset,
    }),
    async (input) => {
      const s = await state()
      const { ruleset, ...request } = input
      for (const pattern of request.patterns ?? []) {
        const rule = evaluate(request.permission, pattern, ruleset, s.approved)
        log.info("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny")
          throw new DeniedError(ruleset.filter((r) => Wildcard.match(request.permission, r.permission)))
        const safeAction = safetyActionFor(request.permission, pattern, request.metadata)
        if (rule.action === "ask" || (rule.action === "allow" && safeAction === "ask")) {
          const id = input.id ?? Identifier.ascending("permission")
          return new Promise<void>((resolve, reject) => {
            const info: Request = {
              id,
              ...request,
            }
            s.pending[id] = {
              info,
              resolve,
              reject,
            }
            Bus.publish(Event.Asked, info)
          })
        }
        if (rule.action === "allow") continue
      }
    },
  )

  export const reply = fn(
    z.object({
      requestID: Identifier.schema("permission"),
      reply: Reply,
      message: z.string().optional(),
    }),
    async (input) => {
      const s = await state()
      const existing = s.pending[input.requestID]
      if (!existing) return
      delete s.pending[input.requestID]
      Bus.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })
      if (input.reply === "reject") {
        existing.reject(input.message ? new CorrectedError(input.message) : new RejectedError())
        // Reject all other pending permissions for this session
        const sessionID = existing.info.sessionID
        for (const [id, pending] of Object.entries(s.pending)) {
          if (pending.info.sessionID === sessionID) {
            delete s.pending[id]
            Bus.publish(Event.Replied, {
              sessionID: pending.info.sessionID,
              requestID: pending.info.id,
              reply: "reject",
            })
            pending.reject(new RejectedError())
          }
        }
        return
      }
      if (input.reply === "once") {
        existing.resolve()
        return
      }
      if (input.reply === "always") {
        for (const pattern of existing.info.always) {
          s.approved.push({
            permission: existing.info.permission,
            pattern,
            action: "allow",
          })
        }

        // 持久化 always 批准：重启后仍然有效（对齐 claude-code persistPermissionUpdates）。
        // 先落盘再放行——用户看到"已记住"时重启一定生效。写盘失败不阻断本次放行。
        await Storage.write(["permission", Instance.project.id], s.approved).catch((error) => {
          log.warn("failed to persist permission ruleset", { error })
        })

        existing.resolve()

        const sessionID = existing.info.sessionID
        for (const [id, pending] of Object.entries(s.pending)) {
          if (pending.info.sessionID !== sessionID) continue
          const ok = pending.info.patterns.every(
            (pattern) => evaluate(pending.info.permission, pattern, s.approved).action === "allow",
          )
          if (!ok) continue
          delete s.pending[id]
          Bus.publish(Event.Replied, {
            sessionID: pending.info.sessionID,
            requestID: pending.info.id,
            reply: "always",
          })
          pending.resolve()
        }
        return
      }
    },
  )

  export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
    const merged = merge(...rulesets)
    log.info("evaluate", { permission, pattern, ruleset: merged })
    const match = merged.findLast(
      (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
    )
    return match ?? { action: "ask", permission, pattern: "*" }
  }

  const EDIT_TOOLS = ["edit", "write", "patch"]

  function permissionForTool(tool: string) {
    if (EDIT_TOOLS.includes(tool)) return "edit"
    if (tool === "shell") return "bash"
    return tool
  }

  export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
    const result = new Set<string>()
    for (const tool of tools) {
      const permission = permissionForTool(tool)

      const rule = ruleset.findLast((r) => Wildcard.match(permission, r.permission))
      if (!rule) continue
      if (rule.pattern === "*" && rule.action === "deny") result.add(tool)
    }
    return result
  }

  /** User rejected without message - halts execution */
  export class RejectedError extends Error {
    constructor() {
      super(`The user rejected permission to use this specific tool call.`)
    }
  }

  /** User rejected with message — terminal; feedback is persisted for the next user-directed run. */
  export class CorrectedError extends Error {
    constructor(public readonly feedback: string) {
      super(`The user rejected permission to use this specific tool call with the following feedback: ${feedback}`)
    }
  }

  /** Auto-rejected by config rule - halts execution */
  export class DeniedError extends Error {
    constructor(public readonly ruleset: Ruleset) {
      super(
        `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(ruleset)}`,
      )
    }
  }

  export async function list() {
    return state().then((x) => Object.values(x.pending).map((x) => x.info))
  }
}
