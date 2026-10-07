import { describe, expect, test } from "bun:test"
import { failFastStream } from "@/runtime/services/model-gateway"

describe("ModelGateway provider stream errors", () => {
  test("onError 发生后不会继续等待一个永不结束的 fullStream", async () => {
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<string>>(() => {}),
          return: async () => ({ done: true, value: undefined as never }),
        }
      },
    }
    const providerError = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Bad Request stream error")), 1)
    })

    await expect((async () => {
      for await (const _event of failFastStream(source, providerError)) {
        // providerError 应在首个事件前结束这段迭代。
      }
    })()).rejects.toThrow("Bad Request stream error")
  })

  // 真实回归（2026-09-04）：网关曾用 { ...result, fullStream } 覆盖流，
  // 而 streamText 返回的是类实例，text/usage/finishReason 都是原型 getter。
  // 对象展开只复制自有属性，`await stream.text` 变成 undefined，
  // 会话标题与摘要静默不再生成（typecheck 查不出：TS 对接口展开会保留声明的属性）。
  test("覆盖 fullStream 后仍保留原型上的 text/usage 访问器", async () => {
    class FakeStreamResult {
      readonly _text = "标题文本"
      get text() {
        return Promise.resolve(this._text)
      }
      get usage() {
        return Promise.resolve({ inputTokens: 1, outputTokens: 2 })
      }
      get fullStream(): AsyncIterable<string> {
        return { async *[Symbol.asyncIterator]() { yield "原始流" } }
      }
    }
    const result = new FakeStreamResult()
    const replacement: AsyncIterable<string> = { async *[Symbol.asyncIterator]() { yield "替换流" } }

    const spread = { ...result, fullStream: replacement } as unknown as FakeStreamResult
    expect(await spread.text).toBeUndefined()

    const view = Object.create(result) as FakeStreamResult
    Object.defineProperty(view, "fullStream", { value: replacement, enumerable: true, configurable: true })
    expect(await view.text).toBe("标题文本")
    expect(await view.usage).toEqual({ inputTokens: 1, outputTokens: 2 })
    const seen: string[] = []
    for await (const event of view.fullStream) seen.push(event)
    expect(seen).toEqual(["替换流"])
  })
})
