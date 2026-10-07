import { describe, expect, test } from "bun:test"
import { withTimeout } from "../helpers/with-timeout"

describe("drive withTimeout", () => {
  test("rejects an operation slower than the deadline and invokes timeout callback once", async () => {
    let timeoutCalls = 0
    const started = performance.now()
    const slowOperation = new Promise<string>((resolve) => {
      setTimeout(() => resolve("finished too late"), 100)
    })

    await expect(
      withTimeout(slowOperation, 20, () => {
        timeoutCalls += 1
      }),
    ).rejects.toThrow("turn timed out after 20ms")

    expect(timeoutCalls).toBe(1)
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test("returns a completed operation and clears its timer", async () => {
    let timeoutCalls = 0

    await expect(
      withTimeout(Promise.resolve("done"), 20, () => {
        timeoutCalls += 1
      }),
    ).resolves.toBe("done")

    await Bun.sleep(40)
    expect(timeoutCalls).toBe(0)
  })

  test("keeps the standard timeout error when the timeout callback throws", async () => {
    await expect(
      withTimeout(new Promise<never>(() => {}), 20, () => {
        throw new Error("cancel failed")
      }),
    ).rejects.toThrow("turn timed out after 20ms")
  })
})
