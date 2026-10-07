import z from "zod"
import { Tool } from "./tool"
import { ToolModel } from "./model-contracts"
import * as path from "path"
import DESCRIPTION from "./ls.txt"
import { Instance } from "../project/instance"
import { Ripgrep } from "../file/ripgrep"
import { assertExternalDirectory } from "./external-directory"
import { displayPath, isInternalWorkspacePath } from "./analysis-display"
import { shieldFromLongTokenRedaction } from "@/runtime/tool-result-policy"

export const IGNORE_PATTERNS = [
  "node_modules/",
  "__pycache__/",
  ".git/",
  "dist/",
  "build/",
  "target/",
  "vendor/",
  "bin/",
  "obj/",
  ".idea/",
  ".vscode/",
  ".zig-cache/",
  "zig-out",
  ".coverage",
  "coverage/",
  "vendor/",
  "tmp/",
  "temp/",
  ".cache/",
  "cache/",
  "logs/",
  ".venv/",
  "venv/",
  "env/",
]

const LIMIT = 100

export const ListTool = Tool.define("list", Tool.Execution.readOnly, ToolModel.forTool("list"), {
  description: DESCRIPTION,
  parameters: z.object({
    path: z.string().describe("要列出的目录绝对路径，不能使用相对路径").optional(),
    ignore: z.array(z.string()).describe("需要忽略的 glob 模式列表").optional(),
  }),
  async execute(params, ctx) {
    const searchPath = path.resolve(Instance.directory, params.path || ".")
    await assertExternalDirectory(ctx, searchPath, { kind: "directory" })

    await ctx.ask({
      permission: "list",
      patterns: [searchPath],
      always: ["*"],
      metadata: {
        path: searchPath,
      },
    })

    const ignoreGlobs = IGNORE_PATTERNS.map((p) => `!${p}*`).concat(params.ignore?.map((p) => `!${p}`) || [])
    const files = []
    let timedOut = false
    try {
      for await (const file of Ripgrep.files({ cwd: searchPath, glob: ignoreGlobs, abort: ctx.abort })) {
        files.push(file)
        if (files.length >= LIMIT) break
      }
    } catch (error) {
      // ripgrep 超时/中止：部分结果照常展示，明确告诉用户"没搜完"。
      if (Ripgrep.isRipgrepTimeoutError(error)) {
        timedOut = true
      } else {
        throw error
      }
    }

    // Build directory structure
    const dirs = new Set<string>()
    const filesByDir = new Map<string, string[]>()

    for (const file of files) {
      const dir = path.dirname(file)
      const parts = dir === "." ? [] : dir.split("/")

      // Add all parent directories
      for (let i = 0; i <= parts.length; i++) {
        const dirPath = i === 0 ? "." : parts.slice(0, i).join("/")
        dirs.add(dirPath)
      }

      // Add file to its directory
      if (!filesByDir.has(dir)) filesByDir.set(dir, [])
      filesByDir.get(dir)!.push(path.basename(file))
    }

    // 内部产物文件名（如 stage_000_describe_20260816-173358234_numeric_snapshot.json）
    // 常年超过 Redact.LONG_TOKEN_PATTERN 的 40 字符阈值。下游 Tool.define 统一给每个
    // 工具的 output 走 prepareToolOutput → redact()，那条管线只保护带 `.killstata/`
    // 前缀的完整路径——list 渲染子目录内容时输出的是裸文件名（不带路径前缀），
    // 被当成任意长 token 打码成 [已脱敏]，模型据此再去 read 必然 ENOENT
    //（2026-08-16 drive harness 真实数据实测复现）。在源头（列出内部工作区目录时）
    // 就给文件名打上零宽字符保护，不依赖下游脱敏管线猜哪些字符串该放行。
    const searchIsInternal = isInternalWorkspacePath(searchPath)
    const protectFileName = (name: string) => (searchIsInternal ? shieldFromLongTokenRedaction(name) : name)

    function renderDir(dirPath: string, depth: number): string {
      const indent = "  ".repeat(depth)
      let output = ""

      if (depth > 0) {
        output += `${indent}${protectFileName(path.basename(dirPath))}/\n`
      }

      const childIndent = "  ".repeat(depth + 1)
      const children = Array.from(dirs)
        .filter((d) => path.dirname(d) === dirPath && d !== dirPath)
        .sort()

      // Render subdirectories first
      for (const child of children) {
        output += renderDir(child, depth + 1)
      }

      // Render files
      const files = filesByDir.get(dirPath) || []
      for (const file of files.sort()) {
        output += `${childIndent}${protectFileName(file)}\n`
      }

      return output
    }

    // displayPath 对 .killstata 根返回空串（无文件名可暴露）；此时头部与标题回退到中性措辞，
    // 避免退化成裸 "/" 或空标题。
    const displayedRoot = displayPath(searchPath) || "工作目录"
    const output = `${displayedRoot}/\n` + renderDir(".", 0)

    return {
      title: displayPath(path.relative(Instance.worktree, searchPath)) || "工作目录",
      metadata: {
        count: files.length,
        truncated: files.length >= LIMIT,
        timedOut,
      },
      output: timedOut ? `${output}\n(Search timed out. Narrow the search path.)` : output,
    }
  },
})
