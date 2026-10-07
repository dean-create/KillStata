/**
 * 交给 verifier 子会话的产物路径必须是**可直接读取的绝对路径**。
 *
 * 现场（2026-08-08 用户实测）：子会话拿到的是相对 projectRoot() 的引用，而它的 cwd 是
 * 启动目录（dev 下 packages/killstata），读不到；`.killstata` 又在 ripgrep 默认忽略清单里，
 * glob/grep 也搜不到。结果子 agent 为了找一个明明存在的 QA 报告，烧掉 ~35 次工具调用，
 * 最后靠读 killstata 自己的源码才推断出数据挂在 worktree 下。
 */

import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { resolveArtifactPathForRead } from "@/runtime/workflow"

describe("verifier artifact paths", () => {
  test("无 Instance 时直接使用 process.cwd 下真实存在的相对文件", () => {
    const resolved = resolveArtifactPathForRead("package.json")
    expect(resolved).toBe(path.join(process.cwd(), "package.json"))
  })

  test("directory ≠ worktree 时，相对引用解析成真实存在的绝对路径", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-envelope-"))
    try {
      Bun.spawnSync(["git", "init", "-q"], { cwd: root })
      const sub = path.join(root, "packages", "killstata")
      fs.mkdirSync(sub, { recursive: true })
      const rel = ".killstata/datasets/d/reports/validate.json"
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), "{}")

      await Instance.provide({
        directory: sub,
        fn: async () => {
          // 前提：复现的正是 dev 启动时 directory ≠ worktree 的情形
          expect(Instance.directory).not.toBe(Instance.worktree)

          const resolved = resolveArtifactPathForRead(rel)
          expect(resolved).toBeDefined()
          expect(path.isAbsolute(resolved!)).toBe(true)
          expect(fs.existsSync(resolved!)).toBe(true)
          // 关键：不能解析到 directory 基准下那个不存在的路径
          expect(resolved!.startsWith(Instance.directory)).toBe(false)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("产物确实不存在时返回 undefined，不编造路径", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-envelope-miss-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          expect(resolveArtifactPathForRead(".killstata/datasets/nope/reports/validate.json")).toBeUndefined()
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
