export function lazy<T>(fn: () => T) {
  let value: T | undefined
  let loaded = false

  const result = ((): T => {
    if (loaded) return value as T
    loaded = true
    value = fn()
    return value as T
  }) as { (): T; reset(): void }

  result.reset = () => {
    loaded = false
    value = undefined
  }

  return result
}
