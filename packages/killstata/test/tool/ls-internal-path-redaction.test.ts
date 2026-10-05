/**
 * list 工具在 `.killstata` 内部目录下渲染的裸文件名不得被通用密钥脱敏误判。
 *
 * 现场（2026-08-16 drive harness 组 B 真实实测复现）：内部产物文件名（如
 * stage_000_profile_20260816-173358234_numeric_snapshot.json，59 字符）超过
 * Redact.LONG_TOKEN_PATTERN 的 40 字符阈值。Tool.define 统一给每个工具的 output
 * 走 prepareToolOutput → redact()，那条管线只保护带 `.killstata/` 前缀的完整路径
 *（2026-08-14、2026-08-16 两次事故已经加固），但 list 渲染子目录内容时输出的是
 * **裸文件名**（不带路径前缀），不含 `.killstata` 锚点，完全绕过了那份保护。
 * 模型看到 `[已脱敏].json` 后把它当真实文件名传给 read，必然 ENOENT，
 * 只能沉默卡死（drive 场景 probit-vs-logit 的真实失败序列：模型说"现在跑 probit
 * 做对比"后再未产出任何工具调用，整轮戛然而止）。
 */

import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { ListTool } from "@/tool/ls"
import { Tool } from "@/tool/tool"

function context(): Tool.Context {
  return {
    sessionID: "s",
    messageID: "m",
    callID: "c",
    agent: "analyst",
    abort: new AbortController().signal,
    metadata: async () => {},
    ask: async () => {},
  }
}

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-ls-test-"))
  try {
    return await Instance.provide({ directory: root, fn: () => fn(root) })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("list tool internal-path filename protection", () => {
  test("长内部产物文件名（≥40 字符）在 .killstata 目录下完整保留，不被脱敏", async () => {
    await withTempRoot(async (root) => {
      const longName = "stage_000_profile_20260816-173358234_numeric_snapshot.json"
      expect(longName.length).toBeGreaterThan(40) // 前提：确实会撞上 LONG_TOKEN_PATTERN

      const dir = path.join(root, ".killstata", "datasets", "did_4fa9a421", "reports", "main")
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "stage_000_profile_20260816-173357.csv"), "x")
      fs.writeFileSync(path.join(dir, longName), "{}")
      fs.writeFileSync(path.join(dir, "stage_000_validate_20260816-173356.json"), "{}")

      const tool = await ListTool.init({})
      const result = await tool.execute({ path: dir }, context())

      expect(result.output).toContain(longName)
      expect(result.output).not.toContain("已脱敏")
      const outputPolicy = (result.metadata as { outputPolicy?: { redactions?: number } }).outputPolicy
      expect(outputPolicy?.redactions).toBe(0)
    })
  })

  test("非内部目录的超长文件名仍按通用规则脱敏——保护范围不被意外放宽", async () => {
    await withTempRoot(async (root) => {
      const dir = path.join(root, "data")
      fs.mkdirSync(dir, { recursive: true })
      const suspiciousName = "non-secret-long-filename-placeholder-0123456789.csv"
      fs.writeFileSync(path.join(dir, suspiciousName), "x")

      const tool = await ListTool.init({})
      const result = await tool.execute({ path: dir }, context())

      expect(result.output).toContain("已脱敏")
      expect(result.output).not.toContain(suspiciousName)
    })
  })

  test("内部目录里的短文件名（<40 字符）不受影响，原样显示", async () => {
    await withTempRoot(async (root) => {
      const dir = path.join(root, ".killstata", "runtime")
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "short.json"), "{}")

      const tool = await ListTool.init({})
      const result = await tool.execute({ path: dir }, context())

      expect(result.output).toContain("short.json")
      expect(result.output).not.toContain("已脱敏")
    })
  })
})
