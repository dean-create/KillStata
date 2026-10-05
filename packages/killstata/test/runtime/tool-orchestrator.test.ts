import { describe, expect, mock, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { Bus } from "@/bus"
import { RuntimeEvents } from "@/runtime/events"
import {
  ToolExecutionAbortedError,
  ToolOrchestrator,
} from "@/runtime/tool-orchestrator"

async function withInstance<T>(fn: () => T | Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-tool-cancel-"))
  try {
    return await Instance.provide({ directory: root, fn })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const serial = {
  concurrencySafe: false,
  approval: "automatic" as const,
  requiresConfirmation: false,
  sideEffectLevel: "filesystem" as const,
  interruptBehavior: "continue" as const,
}

const parallel = {
  concurrencySafe: true,
  approval: "automatic" as const,
  requiresConfirmation: false,
  sideEffectLevel: "none" as const,
  interruptBehavior: "cancel" as const,
}

describe("ToolOrchestrator 读并发 / 写串行", () => {
  test("同一批只读工具真正并发启动", async () => {
    await withInstance(async () => {
      const orchestrator = new ToolOrchestrator("session-tool-parallel")
      const release = Promise.withResolvers<void>()
      const firstStarted = Promise.withResolvers<void>()
      const secondStarted = Promise.withResolvers<void>()

      const first = orchestrator.execute({
        callID: "read-1",
        toolName: "read",
        traits: parallel,
        run: async () => {
          firstStarted.resolve()
          await release.promise
          return "first"
        },
      })
      const second = orchestrator.execute({
        callID: "read-2",
        toolName: "grep",
        traits: parallel,
        run: async () => {
          secondStarted.resolve()
          await release.promise
          return "second"
        },
      })

      await Promise.all([firstStarted.promise, secondStarted.promise])
      release.resolve()
      await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"])
    })
  })

  test("写工具等待当前读批结束后再启动", async () => {
    await withInstance(async () => {
      const orchestrator = new ToolOrchestrator("session-tool-barrier")
      const order: string[] = []
      const releaseRead = Promise.withResolvers<void>()
      const readStarted = Promise.withResolvers<void>()

      const read = orchestrator.execute({
        callID: "read-1",
        toolName: "read",
        traits: parallel,
        run: async () => {
          order.push("read-start")
          readStarted.resolve()
          await releaseRead.promise
          order.push("read-end")
          return "read"
        },
      })
      const write = orchestrator.execute({
        callID: "write-1",
        toolName: "data_import",
        traits: serial,
        run: async () => {
          order.push("write-start")
          return "write"
        },
      })

      await readStarted.promise
      await Bun.sleep(0)
      expect(order).toEqual(["read-start"])
      releaseRead.resolve()
      await Promise.all([read, write])
      expect(order).toEqual(["read-start", "read-end", "write-start"])
    })
  })

  test("两个成功写任务的临界区绝不重叠", async () => {
    await withInstance(async () => {
      const orchestrator = new ToolOrchestrator("session-serial-writes")
      let active = 0
      let peak = 0
      const write = (callID: string) =>
        orchestrator.execute({
          callID,
          toolName: "write",
          traits: serial,
          run: async () => {
            active += 1
            peak = Math.max(peak, active)
            await Bun.sleep(10)
            active -= 1
            return callID
          },
        })

      await Promise.all([write("write-a"), write("write-b")])
      expect(peak).toBe(1)
    })
  })
})

describe("ToolOrchestrator cancellation", () => {
  test("前一个串行工具不响应取消时，排队工具也必须立即结束等待", async () => {
    await withInstance(async () => {
      const controller = new AbortController()
      const orchestrator = new ToolOrchestrator("session-tool-queued-cancel")
      const releaseFirst = Promise.withResolvers<void>()
      const firstStarted = Promise.withResolvers<void>()
      const first = orchestrator.execute({
        callID: "call-slow",
        toolName: "slow",
        traits: serial,
        signal: controller.signal,
        run: async () => {
          firstStarted.resolve()
          await releaseFirst.promise
          return "late"
        },
      })
      const second = orchestrator.execute({
        callID: "call-queued",
        toolName: "queued",
        traits: serial,
        signal: controller.signal,
        run: async () => "must not run",
      })

      await firstStarted.promise
      controller.abort()
      await expect(Promise.race([
        second,
        Bun.sleep(100).then(() => { throw new Error("排队工具没有及时响应取消") }),
      ])).rejects.toMatchObject({ code: "TOOL_ABORTED_BEFORE_DISPATCH" })

      releaseFirst.resolve()
      await expect(first).rejects.toMatchObject({ code: "TOOL_ABORTED" })
    })
  })

  test("does not dispatch a queued serial tool after cancellation", async () => {
    await withInstance(async () => {
      const controller = new AbortController()
      const orchestrator = new ToolOrchestrator("session-tool-cancel")
      const events: Array<{ callID: string; phase: string; reason?: string }> = []
      const unsubscribe = Bus.subscribe(RuntimeEvents.ToolLifecycle, (event) => {
        events.push({
          callID: event.properties.callID,
          phase: event.properties.phase,
          reason: event.properties.reason,
        })
      })
      const firstStarted = Promise.withResolvers<void>()
      const secondRun = mock(async () => "must not run")

      try {
        const first = orchestrator.execute({
          callID: "call-1",
          toolName: "first",
          traits: serial,
          signal: controller.signal,
          run: async () => {
            firstStarted.resolve()
            await new Promise<void>((resolve) => {
              controller.signal.addEventListener("abort", () => resolve(), { once: true })
            })
            return "first result"
          },
        })
        const second = orchestrator.execute({
          callID: "call-2",
          toolName: "second",
          traits: serial,
          signal: controller.signal,
          run: secondRun,
        })

        await firstStarted.promise
        controller.abort()
        const settled = await Promise.allSettled([first, second])

        const [firstResult, secondResult] = settled
        expect(firstResult?.status).toBe("rejected")
        expect(secondResult?.status).toBe("rejected")
        if (firstResult?.status !== "rejected" || secondResult?.status !== "rejected") {
          throw new Error("expected both tool calls to be rejected")
        }
        expect(firstResult.reason).toBeInstanceOf(ToolExecutionAbortedError)
        expect(secondResult.reason).toBeInstanceOf(ToolExecutionAbortedError)
        expect(secondResult.reason.code).toBe("TOOL_ABORTED_BEFORE_DISPATCH")
        expect(secondRun).not.toHaveBeenCalled()
        expect(events.filter((event) => event.callID === "call-2")).toEqual([
          { callID: "call-2", phase: "queued" },
          { callID: "call-2", phase: "cancelled", reason: "cancelled_before_dispatch" },
        ])
      } finally {
        unsubscribe()
      }
    })
  })

  test("marks a running tool as cancelled when its signal aborts before completion", async () => {
    await withInstance(async () => {
      const controller = new AbortController()
      const orchestrator = new ToolOrchestrator("session-tool-running-cancel")
      const phases: string[] = []
      const running = Promise.withResolvers<void>()
      const unsubscribe = Bus.subscribe(RuntimeEvents.ToolLifecycle, (event) => {
        if (event.properties.callID !== "call-1") return
        phases.push(event.properties.phase)
        if (event.properties.phase === "running") running.resolve()
      })
      try {
        const execution = orchestrator.execute({
          callID: "call-1",
          toolName: "slow",
          traits: serial,
          signal: controller.signal,
          run: async () => {
            await new Promise<void>((resolve) => {
              controller.signal.addEventListener("abort", () => resolve(), { once: true })
            })
            return "late success"
          },
        })
        await running.promise
        controller.abort()

        await expect(execution).rejects.toMatchObject({ code: "TOOL_ABORTED" })
        expect(phases).toEqual(["queued", "running", "cancelled"])
      } finally {
        unsubscribe()
      }
    })
  })
})
