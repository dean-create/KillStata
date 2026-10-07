// 全局子进程并发预算：rg 搜索与 bash 命令共享，防止模型并行触发多个大范围搜索把 CPU 打满。
// 对齐 claude-code 的并发上限（默认 10），但计量场景更保守：搜索 ≤2、bash ≤1。
// 注意：acquire 返回的 release 必须在 finally 里调用；abort 等待中的 acquire 会抛 AbortError，
// 由调用方吞掉（用户取消不是工具失败）。

export type ProcessBudgetKind = "search" | "bash"

const LIMITS: Record<ProcessBudgetKind, number> = { search: 2, bash: 1 }

let active: Record<ProcessBudgetKind, number> = { search: 0, bash: 0 }

type Waiter = {
  kind: ProcessBudgetKind
  resolve: () => void
  signal?: AbortSignal
  onAbort?: () => void
}
const waiters: Waiter[] = []

function pump() {
  // FIFO 先到先得；只推进当前有空位的种类，其他种类继续等。
  for (let i = 0; i < waiters.length; i++) {
    const waiter = waiters[i]
    if (active[waiter.kind] >= LIMITS[waiter.kind]) continue
    active[waiter.kind]++
    waiters.splice(i, 1)
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort)
    waiter.resolve()
    i--
  }
}

export async function acquire(kind: ProcessBudgetKind, opts?: { signal?: AbortSignal }): Promise<() => void> {
  if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError")
  if (active[kind] < LIMITS[kind]) {
    active[kind]++
    return () => release(kind)
  }
  return new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = {
      kind,
      resolve: () => resolve(() => release(kind)),
    }
    if (opts?.signal) {
      waiter.onAbort = () => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        reject(new DOMException("Aborted", "AbortError"))
      }
      opts.signal.addEventListener("abort", waiter.onAbort, { once: true })
    }
    waiters.push(waiter)
    pump()
  })
}

function release(kind: ProcessBudgetKind) {
  active[kind] = Math.max(0, active[kind] - 1)
  pump()
}

/** 当前活跃的该类子进程数（测试用）。 */
export function activeBudgetCount(kind: ProcessBudgetKind) {
  return active[kind]
}
