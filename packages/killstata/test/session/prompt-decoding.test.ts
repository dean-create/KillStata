import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

// KillStata 是在 OpenCode（一个"AI 改代码库"的工具）上二次开发的，系统提示里到处是
// "codebase / pull request / refactor / file_path:line_number" 这类代码假设。
// 这个测试遍历所有**真正会注入到模型**的 prompt，禁止编码词汇爬回来。
//
// 它已被证明能抓 bug：把一个 "codebase" 塞进任意 prompt，测试立刻变红。

const SRC = path.join(process.cwd(), "src")

// provider 已锁定 deepseek + custom，这两份是仅有的、真实会命中的 provider prompt。
const LIVE_PROVIDER_PROMPTS = ["session/prompt/deepseek.txt", "session/prompt/qwen.txt"]

// 每轮都会注入到工具描述 / agent 提示里的文件。
const LIVE_AGENT_AND_TOOL_PROMPTS = [
  "agent/prompt/summary.txt",
  "agent/prompt/title.txt",
  "agent/prompt/compaction.txt",
  "agent/prompt/explore.txt",
  "tool/todowrite.txt",
  "tool/glob.txt",
  "tool/grep.txt",
]

// 这些词一旦出现在活 prompt 里，就是在向计量用户假设"你在写代码"。
const CODING_WORDS = [
  "codebase",
  "pull request",
  "source file",
  "file_path:line_number",
  "coding session",
  "Callaway", // 代码里没有 Callaway-Sant'Anna 估计量，prompt 不能承诺它
]

function read(rel: string) {
  return fs.readFileSync(path.join(SRC, rel), "utf-8")
}

describe("prompts are de-coded (no OpenCode coding assumptions)", () => {
  test("live provider prompts carry no coding vocabulary", () => {
    for (const rel of LIVE_PROVIDER_PROMPTS) {
      const text = read(rel).toLowerCase()
      for (const word of CODING_WORDS) {
        expect(text).not.toContain(word.toLowerCase())
      }
    }
  })

  test("live agent and tool prompts carry no coding vocabulary", () => {
    for (const rel of LIVE_AGENT_AND_TOOL_PROMPTS) {
      const text = read(rel).toLowerCase()
      for (const word of CODING_WORDS) {
        if (text.includes(word.toLowerCase())) {
          throw new Error(`${rel} still contains coding vocabulary: "${word}"`)
        }
      }
    }
  })

  test("dead-route provider prompts are gone (provider is locked to deepseek + custom)", () => {
    // gpt / gemini / claude 连不上，它们的 prompt 是死路由，必须已删除。
    for (const dead of ["codex_header.txt", "beast.txt", "gemini.txt", "anthropic.txt"]) {
      expect(fs.existsSync(path.join(SRC, "session", "prompt", dead))).toBe(false)
    }
  })

  test("the provider router only has two live branches", () => {
    const system = read("session/system.ts")
    // deepseek 一条、其余（custom）一条——不再有 gpt-5 / gemini / claude 分支。
    expect(system).not.toContain("PROMPT_CODEX")
    expect(system).not.toContain("PROMPT_BEAST")
    expect(system).not.toContain("PROMPT_GEMINI")
    expect(system).not.toContain("PROMPT_ANTHROPIC")
    expect(system).toContain("PROMPT_DEEPSEEK")
    expect(system).toContain("PROMPT_GENERIC")
  })

  test("isCodex dead path is removed (openai is not an allowed provider)", () => {
    expect(read("session/llm.ts")).not.toContain("isCodex")
  })

  test("the plan-mode injection is about data, not codebases", () => {
    const prompt = read("session/prompt.ts")
    // 计量版关键词必须在
    expect(prompt).toContain("设计识别策略")
    expect(prompt).toContain("identification strategy")
    // 编码版关键词必须没了
    expect(prompt).not.toContain("探索代码库")
    expect(prompt).not.toContain("explore agents IN PARALLEL")
    expect(prompt).not.toContain("files to be modified")
  })
})
