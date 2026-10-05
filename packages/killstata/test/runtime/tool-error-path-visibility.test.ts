/**
 * 模型可见的工具错误必须保留项目内路径。
 *
 * 现场（2026-08-08 用户实测）：summarizeToolError 的输出会直接喂给模型
 * （query-runtime 里 `event.error = safeError`），而脱敏规则把所有 /Users/… 一律换成
 * "[本机路径已隐藏]"——模型连自己刚传进去的路径都看不见。子 agent 在日志里明说
 * "The list path was masked"，随后白耗两轮自动修复配额并开始满文件系统瞎找。
 *
 * 脱敏是为了不泄漏与项目无关的本机结构，项目内路径不在此列。
 */

import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { summarizeToolError } from "@/runtime/tool-result-policy"

describe("tool error path visibility", () => {
  test("项目内路径保留为项目相对路径，模型能据此自我修复", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-errpath-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const target = path.join(root, ".killstata", "datasets", "d", "reports", "validate.json")
          const summary = summarizeToolError(new Error(`ENOENT: no such file or directory, open '${target}'`))
          expect(summary).toContain(".killstata/datasets/d/reports/validate.json")
          expect(summary).not.toContain("本机路径已隐藏")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("项目外的家目录路径仍然脱敏", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-errpath-out-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const summary = summarizeToolError(
            new Error("ENOENT: no such file or directory, open '/Users/someone/private/secrets.txt'"),
          )
          expect(summary).toContain("本机路径已隐藏")
          expect(summary).not.toContain("private/secrets.txt")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
