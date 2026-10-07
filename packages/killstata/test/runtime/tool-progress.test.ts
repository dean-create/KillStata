import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { RuntimeEvents } from "@/runtime/events"
import { publishToolProgress } from "@/session/prompt/tools"

describe("工具增量进度协议", () => {
  test("发布有界中文进度，不携带完整大输出", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-tool-progress-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const received: Array<Record<string, unknown>> = []
          const unsubscribe = Bus.subscribe(RuntimeEvents.ToolProgress, (event) => received.push(event.properties))
          try {
            publishToolProgress({
              sessionID: "session-progress",
              callID: "call-progress",
              toolName: "data_import",
              message: "正在执行数据导入后端",
              metadata: { outputPreview: "x".repeat(20_000) },
            })
            await Bun.sleep(0)
            expect(received).toHaveLength(1)
            expect(received[0]?.message).toBe("正在执行数据导入后端")
            expect(JSON.stringify(received[0]).length).toBeLessThan(5_000)
          } finally {
            unsubscribe()
          }
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
