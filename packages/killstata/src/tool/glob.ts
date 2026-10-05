import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { ToolModel } from "./model-contracts"
import DESCRIPTION from "./glob.txt"
import { Ripgrep } from "../file/ripgrep"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { displayPath } from "./analysis-display"

export const GlobTool = Tool.define("glob", Tool.Execution.readOnly, ToolModel.forTool("glob"), {
  description: DESCRIPTION,
  parameters: z.preprocess(
    (input) => {
      if (typeof input === "string") {
        return { pattern: input.trim() }
      }
      return input
    },
    z.object({
      pattern: z.string().trim().min(1, "模式不能为空").describe("用于匹配文件路径的 glob 模式"),
      path: z
        .string()
        .optional()
        .describe(
          `要检索的目录；省略时使用当前工作目录。不要传入 "undefined" 或 "null"，提供时必须是有效目录路径。`,
        ),
    }),
  ),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "glob",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
      },
    })

    let search = params.path ?? Instance.directory
    search = path.isAbsolute(search) ? search : path.resolve(Instance.directory, search)
    await assertExternalDirectory(ctx, search, { kind: "directory" })

    const limit = 100
    const files = []
    let truncated = false
    let timedOut = false
    try {
      for await (const file of Ripgrep.files({
        cwd: search,
        glob: [params.pattern],
        abort: ctx.abort,
      })) {
        if (files.length >= limit) {
          truncated = true
          break
        }
        const full = path.resolve(search, file)
        const stats = await Bun.file(full)
          .stat()
          .then((x) => x.mtime.getTime())
          .catch(() => 0)
        files.push({
          path: full,
          mtime: stats,
        })
      }
    } catch (error) {
      // 超时/中止：已收集的部分结果照常返回，明确告诉用户"没搜完"而非"没有"。
      if (Ripgrep.isRipgrepTimeoutError(error)) {
        timedOut = true
      } else {
        throw error
      }
    }
    files.sort((a, b) => b.mtime - a.mtime)

    const output = []
    if (files.length === 0 && !timedOut) output.push("No files found")
    if (files.length > 0) {
      output.push(...files.map((f) => displayPath(f.path)))
      if (truncated) {
        output.push("")
        output.push("(Results are truncated. Consider using a more specific path or pattern.)")
      }
      if (timedOut) {
        output.push("")
        output.push("(Search timed out. Narrow the search path or use a more specific pattern.)")
      }
    }

    return {
      title: displayPath(path.relative(Instance.worktree, search)),
      metadata: {
        count: files.length,
        truncated,
        timedOut,
      },
      output: output.join("\n"),
    }
  },
})
