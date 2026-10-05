/**
 * 会话隔离：Memory.priorReflections 必须按会话过滤。
 *
 * 现场（2026-08-08）：default-hooks / dispatch 调用 priorReflections 时不传 sessionID，
 * 新窗口工具失败时被注入上一窗口的同类失败历史——等于把上一会话的"心智模型"塞进
 * 新会话的工具结果。
 */

import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { Memory } from "@/runtime/memory"
import { projectReflectionRoot, projectStateRoot } from "@/runtime/dataset-state"

function writeReflection(sessionID: string, toolName: string, stamp: string) {
  const dir = projectReflectionRoot()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${toolName}_${stamp}.json`),
    JSON.stringify({
      toolName,
      failureType: "estimation_failure",
      rootCause: `fail-${stamp}`,
      blocking: true,
      retryStage: "estimate",
      repairAction: "repair-" + stamp,
      userVisibleExplanation: "explain-" + stamp,
      createdAt: stamp,
      sessionId: sessionID,
    }),
    "utf-8",
  )
}

describe("Memory.priorReflections 会话隔离", () => {
  test("session scope 拒收没有 sessionID 的 legacy reflection/task/workflow", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-mem-unowned-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const reflectionDir = projectReflectionRoot()
          const taskDir = path.join(projectStateRoot(), "tasks")
          const workflowDir = path.join(projectStateRoot(), "workflows")
          for (const dir of [reflectionDir, taskDir, workflowDir]) fs.mkdirSync(dir, { recursive: true })

          fs.writeFileSync(
            path.join(reflectionDir, "unowned.json"),
            JSON.stringify({
              toolName: "panel_fe_regression",
              failureType: "estimation_failure",
              createdAt: "2026-08-01T00:00:00.000Z",
            }),
          )
          fs.writeFileSync(
            path.join(taskDir, "unowned.json"),
            JSON.stringify({ taskId: "task_unowned", createdAt: "2026-08-01T00:00:00.000Z" }),
          )
          fs.writeFileSync(
            path.join(workflowDir, "unowned.json"),
            JSON.stringify({ workflowId: "workflow_unowned", createdAt: "2026-08-01T00:00:00.000Z" }),
          )

          const found = await Memory.search({
            kind: ["reflection", "task", "workflow"],
            sessionID: "ses_current",
            scope: "session",
          })
          expect(found).toEqual([])
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("显式 sessionID 只返回本会话的反思", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-mem-iso-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          writeReflection("ses_old", "panel_fe_regression", "2026-08-01T00:00:00.000Z")
          writeReflection("ses_old", "panel_fe_regression", "2026-08-02T00:00:00.000Z")
          writeReflection("ses_new", "panel_fe_regression", "2026-08-08T00:00:00.000Z")

          const mine = await Memory.priorReflections("panel_fe_regression", 5, { sessionID: "ses_new" })
          expect(mine.length).toBe(1)
          expect(mine[0]!.sessionId).toBe("ses_new")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("不传 sessionID（也未声明 project scope）必须被拒收", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-mem-iso-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          writeReflection("ses_old", "panel_fe_regression", "2026-08-01T00:00:00.000Z")
          await expect(Memory.priorReflections("panel_fe_regression", 3)).rejects.toThrow(/sessionID/)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("显式 scope: project 才允许跨会话读取", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-mem-iso-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          writeReflection("ses_old", "panel_fe_regression", "2026-08-01T00:00:00.000Z")
          writeReflection("ses_new", "panel_fe_regression", "2026-08-08T00:00:00.000Z")

          const all = await Memory.priorReflections("panel_fe_regression", 5, {
            sessionID: "ses_new",
            scope: "project",
          })
          // 跨会话视图：两个会话的都拿到（供人工诊断），且新会话的排在最前（createdAt 降序）
          expect(all.length).toBe(2)
          expect(all[0]!.sessionId).toBe("ses_new")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
