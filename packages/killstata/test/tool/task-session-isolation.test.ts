import { describe, expect, mock, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { TaskTool } from "@/tool/task"
import type { Tool } from "@/tool/tool"
import { Identifier } from "@/id/id"

describe("task 子会话隔离", () => {
  test("只把字段完全匹配的用户任务视为本次精确授权", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-task-authorization-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const task = await TaskTool.init()
          const params = {
            description: "并行检查",
            prompt: "分别检查两个数据文件",
            subagent_type: "missing-agent",
            command: "@missing-agent 分别检查两个数据文件",
          }
          const exactAsk = mock(async () => {})
          const exactContext = {
            sessionID: Identifier.ascending("session"),
            messageID: Identifier.ascending("message"),
            callID: "call-exact",
            agent: "analyst",
            abort: new AbortController().signal,
            extra: { userInitiatedTask: { ...params } },
            metadata() {},
            ask: exactAsk,
          } satisfies Tool.Context

          await expect(task.execute(params, exactContext)).rejects.toThrow("未知子 Agent 类型")
          expect(exactAsk).toHaveBeenCalledTimes(0)

          const mismatchAsk = mock(async () => {
            throw new Error("TASK_CONFIRM_REQUIRED")
          })
          const mismatchContext = {
            ...exactContext,
            callID: "call-mismatch",
            extra: {
              userInitiatedTask: {
                ...params,
                prompt: "另一个未经授权的任务",
              },
            },
            ask: mismatchAsk,
          } satisfies Tool.Context

          await expect(task.execute(params, mismatchContext)).rejects.toThrow("TASK_CONFIRM_REQUIRED")
          expect(mismatchAsk).toHaveBeenCalledTimes(1)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("拒绝续接不属于当前父会话的子会话", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-task-scope-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const owner = await Session.create({ title: "owner" })
          const caller = await Session.create({ title: "caller" })
          const foreignChild = await Session.create({ title: "foreign", parentID: owner.id })
          const task = await TaskTool.init()
          const context = {
            sessionID: caller.id,
            messageID: Identifier.ascending("message"),
            callID: "call-scope",
            agent: "analyst",
            abort: new AbortController().signal,
            metadata() {},
            async ask() {},
          } satisfies Tool.Context

          await expect(
            task.execute(
              {
                description: "隔离检查",
                prompt: "检查",
                subagent_type: "explore",
                session_id: foreignChild.id,
              },
              context,
            ),
          ).rejects.toThrow("TASK_SESSION_SCOPE_MISMATCH")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
