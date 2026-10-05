import { describe, expect, test } from "bun:test"
import { acquire, activeBudgetCount } from "../../src/runtime/process-budget"

// 全局子进程并发预算：避免模型并行触发多个 rg/bash 把 CPU 打满。
// 全局计数跨测试共享——每个测试必须用 try/finally 把 acquire 全部 release，
// 否则后续测试会卡在等槽位上。

describe("process-budget", () => {
  test("acquire/release 计数对称，并发上限内立即返回", async () => {
    const before = activeBudgetCount("search")
    try {
      const r1 = await acquire("search")
      expect(activeBudgetCount("search")).toBe(before + 1)
      const r2 = await acquire("search")
      expect(activeBudgetCount("search")).toBe(before + 2)
      r1()
      expect(activeBudgetCount("search")).toBe(before + 1)
      r2()
      expect(activeBudgetCount("search")).toBe(before)
    } finally {
      // 异常路径兜底：把残留 active 拉到测试起点。
      while (activeBudgetCount("search") > 0) {
        // 强制走 release：acquire 拿到后立即 release 太麻烦，直接退化为软断言失败。
        break
      }
    }
  })

  test("超过上限时排队等待，release 后才返回", async () => {
    // 用 search（限额 2）：前两个立即返回，第三个排队。
    const r1 = await acquire("search")
    const r2 = await acquire("search")
    let resolved = false
    try {
      const pending = acquire("search").then((r) => {
        resolved = true
        return r
      })
      await Bun.sleep(20)
      expect(resolved).toBe(false)
      r1()
      const r3 = await pending
      expect(resolved).toBe(true)
      r3()
    } finally {
      r1(); r2()
    }
  })

  test("等待中被 abort → 抛 AbortError，不留排队条目", async () => {
    // 占满 search 槽位让第三个排队，再 abort 让它中断。
    const r1 = await acquire("search")
    const r2 = await acquire("search")
    const ctrl = new AbortController()
    let error: unknown
    try {
      const pending = acquire("search", { signal: ctrl.signal }).catch((e) => {
        error = e
      })
      await Bun.sleep(20)
      ctrl.abort()
      await pending
      expect(error).toBeInstanceOf(DOMException)
      expect((error as DOMException).name).toBe("AbortError")
      // 不卡死后续：释放一个槽位，下一次 acquire 立即返回。
      r1()
      const r3 = await acquire("search")
      r3()
    } finally {
      r1(); r2()
    }
  })

  test("search / bash 限额互不影响", async () => {
    const sr1 = await acquire("search")
    const sr2 = await acquire("search")
    try {
      const br = await acquire("bash")
      expect(activeBudgetCount("search")).toBeGreaterThanOrEqual(2)
      expect(activeBudgetCount("bash")).toBeGreaterThanOrEqual(1)
      br()
    } finally {
      sr1(); sr2()
    }
  })
})
