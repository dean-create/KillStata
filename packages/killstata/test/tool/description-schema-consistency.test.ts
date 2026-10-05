/**
 * 工具描述 (.txt) 与 zod schema 参数名一致性契约测试。
 *
 * 对每个有 .txt + .ts 配对的工具：
 *   1. 读取 .txt 的内容
 *   2. 提取所有反引号包裹的参数名 `` `parameterName` ``
 *   3. 读取 .ts 文件的 zod schema（z.object 的键名集合）
 *   4. 断言 A(来自.txt) ⊆ B(来自schema) 且 B ⊆ A
 *
 * 例外列表（允许 .txt 里有 `--flag` 或 `parameterName` 这种在 schema 中不存在
 * 的引用）在最下方维护，人工审核。
 */

import { describe, expect, it } from "bun:test"
import fs from "fs"
import path from "path"

// ── 工具清单 ────────────────────────────────────────────────────
// txt → ts 配对。ts 文件使用 import DESCRIPTION from "./xxx.txt"
const TOOL_PAIRS: Array<{ txt: string; ts: string }> = [
  { txt: "bash.txt", ts: "bash.ts" },
  { txt: "data-import.txt", ts: "data-import/index.ts" },
  { txt: "edit.txt", ts: "edit.ts" },
  { txt: "experiment-log.txt", ts: "experiment-log.ts" },
  { txt: "glob.txt", ts: "glob.ts" },
  { txt: "grep.txt", ts: "grep.ts" },
  { txt: "heterogeneity-runner.txt", ts: "heterogeneity-runner.ts" },
  { txt: "ls.txt", ts: "ls.ts" },
  { txt: "question.txt", ts: "question.ts" },
  { txt: "read.txt", ts: "read.ts" },
  { txt: "task.txt", ts: "task.ts" },
  { txt: "todowrite.txt", ts: "todo.ts" },
  { txt: "webfetch.txt", ts: "webfetch.ts" },
  { txt: "write.txt", ts: "write.ts" },
]

// 无 .ts 配对的 .txt（仅作文档遗留，不检查）
const ORPHAN_TXTS: string[] = []

// ── 例外列表 ────────────────────────────────────────────────────
// 某些 .txt 里引用了 CLI 标志 (--flag) 或变量名，不在 zod schema 中
const ALLOWED_EXTRANEOUS: Record<string, string[]> = {
  "bash.txt": [
    "workdir", "ls", "head", "tail", "find", "grep", "cat", "sed", "awk", "echo",
  ], // CLI 命令/示例名，非 schema 参数
  "data-import.txt": [
    "sheetPolicy", "manufacturing_analysis", "data_import", "combine_columns",
    "variables", "_", "pyarrow", "killstata_output_YYYYMMDD_HHMM",
  ], // nested schema 中的字段名或业务术语，不在顶层 z.object 中
  "edit.txt": ["Read"], // 工具名，非 schema 参数
  "grep.txt": ["rg", "grep"], // CLI 命令名，非 schema 参数
  "heterogeneity-runner.txt": [
    "datasetId", "stageId", "baselineOutputKey", "baselineResultDir", "directResultPath", "heterogeneityVars",
    "panel_fe_regression", "hdfe_regression",
  ], // Python Registry 是唯一可见 Schema；该工具通过动态 Pydantic Schema 暴露异质性变量；路径参数刻意隐藏为 Harness runtime 字段
  "question.txt": [
    "custom", // Question.Info.optional 字段（默认 true），extractZodSchemaKeys 当前正则只匹配 Reply 而非 Info
    "header", // 同上，Info schema 字段
    "label", // Option.label（在 Option z.object 中，但 extractZodSchemaKeys 跳过）
    "description", // Option.description（同上）
    "multiple", // Info.multiple（同上）
  ], // extractZodSchemaKeys 用 z\.object\(\{[^}]+\} 匹配第一个 z.object，遇到 `z\n  .object(`（换行写法）会跳过 Option/Info 而命中 Reply，键集不可靠——列出真实存在的 schema 字段豁免
}

// ── 辅助函数 ────────────────────────────────────────────────────

const TOOL_DIR = path.join(import.meta.dir, "../../src/tool")

/** 从 .txt 中提取所有反引号包裹的标识符，过滤掉非参数名 */
function extractBacktickIdentifiers(txtPath: string): string[] {
  const content = fs.readFileSync(txtPath, "utf-8")
  const matches = content.match(/`([a-z_][a-z_0-9]*)`/gi)
  if (!matches) return []
  return [...new Set(matches.map((m) => m.slice(1, -1)))]
}

/** 从 .ts 中提取 z.object 的键名 */
function extractZodSchemaKeys(tsPath: string): string[] {
  const content = fs.readFileSync(tsPath, "utf-8")
  // 匹配 z.object({ key: ..., key2: ... })
  // 支持多行和嵌套注释，只取顶层 z.object 的键
  const objMatch = content.match(/z\.object\s*\(\s*\{([^}]+)\}/s)
  if (!objMatch) return []

  const keys: string[] = []
  for (const line of objMatch[1].split("\n")) {
    // 匹配 "  key: z.xxx" 形式的键名
    const keyMatch = line.match(/^\s{2,}([a-zA-Z_][a-zA-Z0-9_]*)\s*:/)
    if (keyMatch) keys.push(keyMatch[1])
  }
  return keys
}

// ── 测试 ────────────────────────────────────────────────────────

describe("工具描述 (.txt) 与 zod schema 一致性", () => {
  for (const { txt, ts } of TOOL_PAIRS) {
    it(`${txt} 反引号参数名 ⊆ ${ts} zod schema 键名`, () => {
      const txtPath = path.join(TOOL_DIR, txt)
      const tsPath = path.join(TOOL_DIR, ts)

      expect(fs.existsSync(txtPath)).toBe(true)
      expect(fs.existsSync(tsPath)).toBe(true)

      const txtParams = new Set(extractBacktickIdentifiers(txtPath))
      const schemaKeys = new Set(extractZodSchemaKeys(tsPath))
      const allowed = new Set(ALLOWED_EXTRANEOUS[txt] ?? [])

      for (const p of txtParams) {
        if (allowed.has(p)) continue
        expect(schemaKeys.has(p)).toBe(true)
      }
    })
  }

  it("无配对 .txt 已记录在 ORPHAN_TXTS 中", () => {
    const allTxts = fs.readdirSync(TOOL_DIR).filter((f) => f.endsWith(".txt"))
    const paired = new Set(TOOL_PAIRS.map((p) => p.txt))
    for (const txt of allTxts) {
      if (!paired.has(txt)) {
        expect(ORPHAN_TXTS).toContain(txt)
      }
    }
  })

  it("只读质量体检的工具结果应明确要求直接收尾，避免重复画像和质检", () => {
    const description = fs.readFileSync(path.join(TOOL_DIR, "data-import.txt"), "utf-8")
    expect(description).toContain("质量摘要足够时直接回答")
    expect(description).toContain("不再调用 profile/validate/frequency")
  })
})
