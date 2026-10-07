import z from "zod"
import { Tool } from "./tool"
import { ToolModel } from "./model-contracts"
import { Ripgrep } from "../file/ripgrep"
import { Instance } from "../project/instance"
import path from "path"
import { assertExternalDirectory } from "./external-directory"
import { displayPath } from "./analysis-display"
import { Shell } from "@/shell/shell"
import { acquire } from "@/runtime/process-budget"

import DESCRIPTION from "./grep.txt"

const MAX_LINE_LENGTH = 2000
// 每文件匹配上限：阻止 rg 把全项目所有匹配行扫完再截断（CPU 100% 的根因之一）。
const MAX_MATCHES_PER_FILE = 50
// 搜索深度上限：对齐 claude-code，防止 --hidden --follow 全树遍历。
const MAX_DEPTH = 6
// 模型可见结果上限（原有展示层截断）。
const RESULT_LIMIT = 100

export const GrepTool = Tool.define("grep", Tool.Execution.readOnly, ToolModel.forTool("grep"), {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("要在文件内容中检索的正则模式"),
    path: z.string().optional().describe("要检索的目录；省略时使用当前工作目录。"),
    include: z.string().optional().describe('要纳入检索的文件模式，例如 "*.js"、"*.{ts,tsx}"'),
  }),
  async execute(params, ctx) {
    if (!params.pattern) {
      throw new Error("pattern 为必填的搜索关键词或正则表达式。")
    }

    await ctx.ask({
      permission: "grep",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
        include: params.include,
      },
    })

    let searchPath = params.path ?? Instance.directory
    searchPath = path.isAbsolute(searchPath) ? searchPath : path.resolve(Instance.directory, searchPath)
    await assertExternalDirectory(ctx, searchPath, { kind: "directory" })

    const release = await acquire("search", { signal: ctx.abort }).catch(() => undefined)
    if (!release) {
      // 用户取消（信号量等待中被 abort）：温和返回，不算工具失败。
      return { title: params.pattern, metadata: { matches: 0, truncated: false, timedOut: true }, output: "" }
    }
    try {
      const rgPath = await Ripgrep.filepath()
      const args = [
        "-nH",
        `--max-count=${MAX_MATCHES_PER_FILE}`,
        `--max-depth=${MAX_DEPTH}`,
        "--hidden",
        "--follow",
        "--no-messages",
        "--field-match-separator=|",
      ]
      if (params.include) {
        args.push("--glob", params.include)
      }
      // 默认忽略放用户 include 之后（rg glob 顺序敏感，include 覆盖 ignore）
      for (const g of Ripgrep.DEFAULT_IGNORE_GLOBS) {
        args.push(`--glob=${g}`)
      }
      args.push("--regexp", params.pattern)
      args.push(searchPath)

      // detached：让 rg 成为进程组 leader，Shell.killTree 能一次杀干净（含派生进程）。
      const proc = Bun.spawn([rgPath, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      })

      let stopped: "timeout" | "abort" | undefined
      const stop = (reason: "timeout" | "abort") => {
        if (stopped) return
        stopped = reason
        void Shell.killTree(proc).catch(() => {})
      }
      const timer = setTimeout(() => stop("timeout"), Ripgrep.defaultRgTimeoutMs())
      timer.unref?.()
      const abortHandler = () => stop("abort")
      ctx.abort?.addEventListener("abort", abortHandler, { once: true })
      if (ctx.abort?.aborted) stop("abort")

      try {
        // 流式读行：超时/中止时已收集的行仍可用（部分结果），不再一次性读完整 stdout。
        const reader = proc.stdout.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        const matches: Array<{ path: string; modTime: number; lineNum: number; lineText: string }> = []

        while (true) {
          if (stopped) break
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() || ""
          for (const line of lines) {
            if (!line) continue
            const [filePath, lineNumStr, ...lineTextParts] = line.split("|")
            if (!filePath || !lineNumStr || lineTextParts.length === 0) continue
            const lineNum = parseInt(lineNumStr, 10)
            const lineText = lineTextParts.join("|")
            matches.push({ path: filePath, lineNum, lineText, modTime: 0 })
            if (matches.length >= RESULT_LIMIT * 4) break
          }
          if (matches.length >= RESULT_LIMIT * 4) break
        }

        const errorOutput = await new Response(proc.stderr).text().catch(() => "")
        await proc.exited

        // Exit codes: 0 = matches found, 1 = no matches, 2 = errors (but may still have matches)
        // With --no-messages, we suppress error output but still get exit code 2 for broken symlinks etc.
        // 超时/中止时进程可能被 SIGKILL（137），不再按退出码判断"无匹配"。
        const hasErrors = !stopped && proc.exitCode === 2
        if (!stopped && proc.exitCode !== 0 && proc.exitCode !== 1 && proc.exitCode !== 2) {
          throw new Error(`文本搜索失败：${errorOutput}`)
        }

        // 补齐 modTime（仅对部分结果排序用；按需 stat，失败记 0）
        const enriched: typeof matches = []
        for (const match of matches) {
          const stats = await Bun.file(match.path)
            .stat()
            .then((x) => x.mtime.getTime())
            .catch(() => 0)
          enriched.push({ ...match, modTime: stats })
        }
        enriched.sort((a, b) => b.modTime - a.modTime)

        const truncated = enriched.length > RESULT_LIMIT
        const finalMatches = truncated ? enriched.slice(0, RESULT_LIMIT) : enriched
        const timedOut = stopped === "timeout"
        const aborted = stopped === "abort"

        if (finalMatches.length === 0 && !timedOut) {
          return {
            title: params.pattern,
            metadata: { matches: 0, truncated: false, timedOut: false },
            output: "No files found",
          }
        }

        const outputLines = [`Found ${finalMatches.length} matches${timedOut ? " (搜索超时，结果可能不完整)" : ""}`]

        let currentFile = ""
        for (const match of finalMatches) {
          if (currentFile !== match.path) {
            if (currentFile !== "") {
              outputLines.push("")
            }
            currentFile = match.path
            // 用户可见输出：内部工作区（.killstata）只显示文件名，不暴露目录结构
            outputLines.push(`${displayPath(match.path)}:`)
          }
          const truncatedLineText =
            match.lineText.length > MAX_LINE_LENGTH ? match.lineText.substring(0, MAX_LINE_LENGTH) + "..." : match.lineText
          outputLines.push(`  Line ${match.lineNum}: ${truncatedLineText}`)
        }

        if (truncated) {
          outputLines.push("")
          outputLines.push("(Results are truncated. Consider using a more specific path or pattern.)")
        }
        if (timedOut) {
          outputLines.push("")
          outputLines.push("(Search timed out. Narrow the search path or use a more specific pattern.)")
        }
        if (hasErrors) {
          outputLines.push("")
          outputLines.push("(Some paths were inaccessible and skipped)")
        }

        return {
          title: params.pattern,
          metadata: {
            matches: finalMatches.length,
            truncated,
            timedOut: timedOut || aborted,
          },
          output: outputLines.join("\n"),
        }
      } finally {
        clearTimeout(timer)
        ctx.abort?.removeEventListener("abort", abortHandler)
      }
    } finally {
      release()
    }
  },
})
