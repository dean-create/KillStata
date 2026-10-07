import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Memory } from "@/runtime/memory"
import { Instance } from "@/project/instance"

/**
 * Memory API 的两个最核心场景：
 *   1. 写入反思后，同一会话内能查到它
 *   2. 跨会话：session A 里的失败模式，session B 也能读到
 *
 * 第 2 点正是阶段 5 要解决的问题：reflection 目录里 272 个文件只写不读。
 * 这个测试证明 `Memory.search({kind:"reflection", toolName})` 能跨会话查回。
 */

async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-memory-"))
  try {
    return await Instance.provide({ directory: root, fn })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("Memory cross-session reflection", () => {
  test("puts and gets a memory entry", async () => {
    await withInstance(async () => {
      const id = await Memory.put({
        kind: "reflection",
        scope: "session",
        sessionID: "ses_mem_ut_1",
        content: { toolName: "panel_fe_regression", failureType: "panel_integrity_failure", rootCause: "duplicate keys" },
      })
      expect(id).toBeTruthy()
      expect(id.startsWith("reflection_")).toBe(true)

      const entry = await Memory.get(id)
      expect(entry).toBeDefined()
      expect(entry!.sessionID).toBe("ses_mem_ut_1")
    })
  })

  test("searches reflection files by toolName", async () => {
    await withInstance(async () => {
      // 写两条不同工具的 reflection，验证 search 能正确过滤
      await Memory.put({
        kind: "reflection", scope: "session", sessionID: "ses_a",
        content: { toolName: "panel_fe_regression", failureType: "panel_integrity_failure", rootCause: "dup" },
      })
      await Memory.put({
        kind: "reflection", scope: "session", sessionID: "ses_a",
        content: { toolName: "ols_regression", failureType: "schema_mismatch", rootCause: "col" },
      })
      // 会话隔离（2026-08-08）：不带 sessionID 的 search 返回空，不跨会话泄漏
      const anonymous = await Memory.search({ kind: "reflection", toolName: "panel_fe_regression", limit: 5 })
      expect(anonymous.length).toBe(0)
      // 本会话内查询命中
      const sameSession = await Memory.search({ kind: "reflection", toolName: "panel_fe_regression", sessionID: "ses_a", limit: 5 })
      expect(sameSession.length).toBe(1)
      expect(sameSession[0].kind).toBe("reflection")
    })
  })

  test("reflects cross-session: writes from ses_a are readable from ses_b", async () => {
    await withInstance(async () => {
      // 模拟跨会话写入/读取
      const id = await Memory.put({
        kind: "reflection", scope: "session", sessionID: "ses_a",
        content: { toolName: "iv_2sls", failureType: "estimation_failure", rootCause: "singular matrix" },
      })
      expect(id).toBeTruthy()
      // 同项目另一会话默认读不到（会话隔离）
      const isolated = await Memory.search({ kind: "reflection", toolName: "iv_2sls", sessionID: "ses_b", limit: 5 })
      expect(isolated.length).toBe(0)
      // 显式声明 scope:"project" 才能跨会话读到
      const crossSession = await Memory.search({ kind: "reflection", toolName: "iv_2sls", sessionID: "ses_b", scope: "project", limit: 5 })
      expect(crossSession.length).toBe(1)
      expect((crossSession[0].content as Record<string, unknown>).rootCause).toBe("singular matrix")
    })
  })
})
