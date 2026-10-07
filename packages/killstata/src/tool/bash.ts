import z from "zod"
import { spawn } from "child_process"
import { Tool } from "./tool"
import { ToolModel } from "./model-contracts"
import path from "path"
import DESCRIPTION from "./bash.txt"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { lazy } from "@killstata/util/lazy"
import { Language } from "web-tree-sitter"

import { $ } from "bun"
import { Filesystem } from "@/util/filesystem"
import { fileURLToPath } from "url"
import { Flag } from "@/flag/flag.ts"
import { Shell } from "@/shell/shell"

import { BashArity } from "@/permission/arity"
import { Truncate } from "./truncation"
import { evaluateExecPolicy } from "@/runtime/exec-policy"
import { buildChildEnvironment } from "@/runtime/managed-process"
import { acquire } from "@/runtime/process-budget"

const MAX_METADATA_LENGTH = 30_000
// 运行期输出硬上限：bash 命令可能打出 GB 级输出（如误跑 rg --files 全量），
// 超过该值只保留截断部分 + 标记，进程仍跑完（不杀），内存有界。
const MAX_RUNTIME_OUTPUT = 2 * 1024 * 1024
// bash 命令需要但不在白名单里的常见 env（终端 / python 环境）。仅显式白名单放行，
// 与 managed-process 的 SAFE_ENV_NAMES 一起构成 bash 子进程的完整 env 集合。
const BASH_EXTRA_ENV_NAMES = ["SHELL", "TERM", "COLORTERM", "VIRTUAL_ENV", "CONDA_PREFIX", "PYTHONPATH", "GIT_EDITOR"] as const
const MAX_TIMEOUT = Tool.Timeout.LONG_RUNNING_MS
const CONFIGURED_DEFAULT_TIMEOUT = Flag.KILLSTATA_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS
const DEFAULT_TIMEOUT = Math.min(
  typeof CONFIGURED_DEFAULT_TIMEOUT === "number" && Number.isFinite(CONFIGURED_DEFAULT_TIMEOUT) && CONFIGURED_DEFAULT_TIMEOUT > 0
    ? CONFIGURED_DEFAULT_TIMEOUT
    : 2 * 60 * 1000,
  MAX_TIMEOUT,
)

export const log = Log.create({ service: "bash-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const bashLanguage = await Language.load(bashPath)
  const p = new Parser()
  p.setLanguage(bashLanguage)
  return p
})

function createShellCommandTool(id: "bash" | "shell", label: "bash" | "shell") {
  return Tool.define(id, Tool.Execution.protectedCommand, ToolModel.forTool(id), async () => {
    const shell = Shell.acceptable()
    log.info(`${label} tool using shell`, { shell, tool: id })

    return {
      description: DESCRIPTION.replaceAll("${directory}", Instance.directory)
        .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
        .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),
      parameters: z.preprocess(
        (input) => {
          if (typeof input === "string") {
                return { command: input.trim(), description: "执行终端命令" }
          }
          if (input && typeof input === "object" && !Array.isArray(input)) {
            const data = input as Record<string, unknown>
            if (typeof data.command === "string") {
              const command = data.command.trim()
              if (data.description === undefined || data.description === "") {
                return { ...data, command, description: `执行终端命令：${command}` }
              }
              return { ...data, command }
            }
          }
          return input
        },
        z.object({
          command: z
            .string()
            .trim()
            .min(1, "命令不能为空")
            .refine(
              (value) => !["command", "workdir", "description", "timeout"].includes(value),
              "必须传入真实 Shell 命令，不能传参数名",
            )
            .describe("要执行的终端命令"),
          timeout: z.number().int().min(1).max(MAX_TIMEOUT).describe(`可选超时毫秒数，最大 ${MAX_TIMEOUT} 毫秒。`).optional(),
          workdir: z
            .string()
            .describe(
              `执行命令的工作目录；默认 ${Instance.directory}。请传此字段，不要在命令中使用 cd。`,
            )
            .optional(),
          description: z
            .string()
            .describe(
              "用 5 至 10 个汉字简洁描述命令目的，例如“查看工作区状态”“安装项目依赖”。",
            ),
        }),
      ),
      async execute(params, ctx) {
        const cwd = params.workdir || Instance.directory
        if (params.timeout !== undefined && params.timeout < 0) {
          throw new Error(`timeout=${params.timeout} 无效；必须是正数毫秒。`)
        }
        const timeout = params.timeout ?? DEFAULT_TIMEOUT
        const execPolicyDecision = evaluateExecPolicy({
          sessionID: ctx.sessionID,
          toolName: id,
          command: params.command,
        })
        if (execPolicyDecision.action === "deny") {
          throw new Error(`命令被执行策略拦截：${execPolicyDecision.reason}`)
        }
        const tree = await parser().then((p) => p.parse(params.command))
        if (!tree) {
          throw new Error("无法解析命令；请检查引号、管道和命令结构。")
        }
        const directories = new Set<string>()
        if (!Instance.containsPath(cwd)) directories.add(cwd)
        const patterns = new Set<string>()
        const always = new Set<string>()

        for (const node of tree.rootNode.descendantsOfType("command")) {
          if (!node) continue
          const command = []
          for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i)
            if (!child) continue
            if (
              child.type !== "command_name" &&
              child.type !== "word" &&
              child.type !== "string" &&
              child.type !== "raw_string" &&
              child.type !== "concatenation"
            ) {
              continue
            }
            command.push(child.text)
          }

          // not an exhaustive list, but covers most common cases
          if (["cd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown"].includes(command[0])) {
            for (const arg of command.slice(1)) {
              if (arg.startsWith("-") || (command[0] === "chmod" && arg.startsWith("+"))) continue
              const resolved = await $`realpath ${arg}`
                .cwd(cwd)
                .quiet()
                .nothrow()
                .text()
                .then((x) => x.trim())
              log.info("resolved path", { arg, resolved })
              if (resolved) {
                // Git Bash on Windows returns Unix-style paths like /c/Users/...
                const normalized =
                  process.platform === "win32" && resolved.match(/^\/[a-z]\//)
                    ? resolved.replace(/^\/([a-z])\//, (_, drive) => `${drive.toUpperCase()}:\\`).replace(/\//g, "\\")
                    : resolved
                if (!Instance.containsPath(normalized)) directories.add(normalized)
              }
            }
          }

          // cd covered by above check
          if (command.length && command[0] !== "cd") {
            patterns.add(command.join(" "))
            always.add(BashArity.prefix(command).join(" ") + "*")
          }
        }

        if (directories.size > 0) {
          await ctx.ask({
            permission: "external_directory",
            patterns: Array.from(directories),
            always: Array.from(directories).map((x) => path.dirname(x) + "*"),
            metadata: { execPolicyDecision },
          })
        }

        if (patterns.size > 0 || execPolicyDecision.action === "ask") {
          await ctx.ask({
            permission: "bash",
            patterns: Array.from(patterns.size > 0 ? patterns : new Set([params.command])),
            always: Array.from(always),
            metadata: { execPolicyDecision },
          })
        }

        // 并发预算：bash 与 rg 搜索共享信号量（bash ≤1），防止模型同时触发多个
        // 大范围命令把 CPU 打满。等待中被取消 → 温和返回，不算工具失败。
        const release = await acquire("bash", { signal: ctx.abort }).catch(() => undefined)
        if (!release) {
          return {
            title: params.description,
            metadata: {
              output: "",
              exit: null as number | null,
              description: params.description,
              execPolicyDecision,
              outputTruncated: false,
            },
            output: "Command aborted while waiting for process budget.",
          }
        }
        try {
        const proc = spawn(params.command, {
          shell,
          cwd,
          // env 白名单化：不再透传完整 process.env（对齐 managed-process）。
          // 敏感变量（api key/token/secret 等）天然被白名单挡在子进程外。
          env: (() => {
            const env = buildChildEnvironment(undefined)
            for (const name of BASH_EXTRA_ENV_NAMES) {
              const value = process.env[name]
              if (value !== undefined) env[name] = value
            }
            return env
          })(),
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        })

        let output = ""
        let outputTruncated = false
        let lastProgressAt = 0

        // Initialize metadata with empty output
        ctx.metadata({
          metadata: {
            output: "",
            description: params.description,
            execPolicyDecision,
          },
        })

        const append = (chunk: Buffer) => {
          // 运行期输出上限：超过 MAX_RUNTIME_OUTPUT 后丢弃后续字节（内存有界），
          // 进程不受影响照常跑完；截断标记在返回结果里明确告知模型。
          if (!outputTruncated) {
            const text = chunk.toString()
            if (output.length + text.length > MAX_RUNTIME_OUTPUT) {
              output += text.slice(0, MAX_RUNTIME_OUTPUT - output.length)
              outputTruncated = true
            } else {
              output += text
            }
          }
          ctx.metadata({
            metadata: {
              // truncate the metadata to avoid GIANT blobs of data (has nothing to do w/ what agent can access)
              output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
              description: params.description,
              execPolicyDecision,
            },
          })
          const now = Date.now()
          if (now - lastProgressAt >= 200) {
            lastProgressAt = now
            ctx.progress?.({
              message: `命令正在输出（${output.length} 字符）`,
              title: params.description,
              metadata: { outputPreview: output.slice(-2_000), outputTruncated },
            })
          }
        }

        proc.stdout?.on("data", append)
        proc.stderr?.on("data", append)

        let timedOut = false
        let aborted = false
        let exited = false

        const kill = () => Shell.killTree(proc, { exited: () => exited })

        if (ctx.abort.aborted) {
          aborted = true
          await kill()
        }

        const abortHandler = () => {
          aborted = true
          void kill()
        }

        ctx.abort.addEventListener("abort", abortHandler, { once: true })

        const timeoutTimer = setTimeout(() => {
          timedOut = true
          void kill()
        }, timeout + 100)

        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timeoutTimer)
            ctx.abort.removeEventListener("abort", abortHandler)
          }

          proc.once("exit", () => {
            exited = true
            cleanup()
            resolve()
          })

          proc.once("error", (error) => {
            exited = true
            cleanup()
            reject(error)
          })
        })

        const resultMetadata: string[] = []

        if (outputTruncated) {
          resultMetadata.push(`runtime output truncated at ${MAX_RUNTIME_OUTPUT} bytes`)
        }

        if (timedOut) {
          resultMetadata.push(`${label} tool terminated command after exceeding timeout ${timeout} ms`)
        }

        if (aborted) {
          resultMetadata.push("User aborted the command")
        }

        if (resultMetadata.length > 0) {
          output += "\n\n<bash_metadata>\n" + resultMetadata.join("\n") + "\n</bash_metadata>"
        }

        return {
          title: params.description,
          metadata: {
            output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
            exit: proc.exitCode,
            description: params.description,
            execPolicyDecision,
            outputTruncated,
          },
          output,
        }
        } finally {
          release()
        }
      },
    }
  })
}

// TODO: we may wanna rename this tool so it works better on other shells
export const BashTool = createShellCommandTool("bash", "bash")
export const ShellTool = createShellCommandTool("shell", "shell")
