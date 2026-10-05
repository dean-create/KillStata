import { afterEach, describe, expect, test, vi } from "vitest"
import { createLoopbackCoreTransport } from "./transport"

const connection = { url: "http://127.0.0.1:4318/", token: "local-token" }

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 捕获实际交给平台 fetch 的参数；WebView 不支持流式上传，body 必须已经是完整缓冲。 */
function stubFetch() {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body instanceof ReadableStream) throw new TypeError("ReadableStream uploading is not supported")
    calls.push({ input, init })
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  })
  vi.stubGlobal("fetch", fetchMock)
  return calls
}

describe("loopback Core transport", () => {
  test("forwards a JSON body as a buffer instead of a stream", async () => {
    const calls = stubFetch()
    const transport = createLoopbackCoreTransport(connection)

    const response = await transport.fetch(
      new Request("http://killstata.core/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "研究" }),
      }),
    )

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    const sent = calls[0]!
    expect(sent.init?.body).toBeInstanceOf(ArrayBuffer)
    expect(new TextDecoder().decode(sent.init!.body as ArrayBuffer)).toBe(JSON.stringify({ title: "研究" }))
  })

  test("rewrites the SDK placeholder origin onto the real loopback host and keeps the path", async () => {
    const calls = stubFetch()
    const transport = createLoopbackCoreTransport(connection)

    await transport.fetch(new Request("http://killstata.core/session/ses_1/message?limit=100"))

    expect(String(calls[0]!.input)).toBe("http://127.0.0.1:4318/session/ses_1/message?limit=100")
  })

  test("injects the bearer token on every request", async () => {
    const calls = stubFetch()
    const transport = createLoopbackCoreTransport(connection)

    await transport.fetch(new Request("http://killstata.core/global/health"))

    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer local-token")
  })

  test("omits a body on GET so the platform fetch never sees an empty stream", async () => {
    const calls = stubFetch()
    const transport = createLoopbackCoreTransport(connection)

    await transport.fetch(new Request("http://killstata.core/global/health"))

    expect(calls[0]!.init?.body).toBeUndefined()
  })

  /**
   * Core 的 Bus 订阅表挂在 Instance 上：注入凭据重启 Core 会换掉 Instance，
   * 旧连接上的订阅随之失效。若此时因为陈旧的"已连接"状态放行提交，整回合的
   * 流式正文与 session.idle 都会发到新 Instance 的 bus 上而无人接收。
   */
  test("holds submissions until the event stream reconnects after Core restarts", async () => {
    stubFetch()
    const transport = createLoopbackCoreTransport(connection)

    // 尚未建立连接：不能立即放行。
    let readyBeforeConnect = false
    void transport.events!.whenConnected!(50).then(() => { readyBeforeConnect = true })
    await Promise.resolve()
    expect(readyBeforeConnect).toBe(false)

    // 超时兜底：连接迟迟不来也不能把提交永久卡死。
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(readyBeforeConnect).toBe(true)
  })

  test("invalidate reopens the gate so a stale connected flag cannot wave a submission through", async () => {
    stubFetch()
    const transport = createLoopbackCoreTransport(connection)

    transport.events!.invalidate!()
    let released = false
    void transport.events!.whenConnected!(40).then(() => { released = true })
    await Promise.resolve()
    expect(released).toBe(false)
  })
})
