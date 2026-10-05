export async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout()
      } catch {
        // 超时回调失败不能覆盖标准 timeout 结果。
      }
      reject(new Error(`turn timed out after ${ms}ms`))
    }, ms)
    // 这是 drive 的硬截止，必须保持为有引用定时器；否则某些 Provider 的悬挂
    // fetch 不会及时唤醒它，测试会被内部工具/网络超时拖到数分钟后才结束。
  })

  try {
    // 必须 await：若直接 return Promise.race(...)，finally 会在 race 真正结算前
    // 立即执行，提前清掉 timer，导致永不结束的模型/工具无法触发超时。
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
