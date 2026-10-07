import { createKillstataClient, type Event } from "@killstata/sdk/v2/client"
import { CoreSessionClient, type CoreSessionClientOptions } from "./client"

export type CoreTransport = CoreSessionClientOptions

export function createCoreSessionClient(transport: CoreTransport) {
  // 传输层只处理 Request/Response；session、message、permission 和 question
  // 的业务语义统一在 CoreSessionClient。
  return new CoreSessionClient(transport)
}

export type LoopbackCoreConnection = { url: string; token: string }

/** 把浏览器请求映射到 Core host 的回环地址，并在每个请求上注入临时令牌。 */
export function createLoopbackCoreTransport(connection: LoopbackCoreConnection): CoreTransport {
  const baseURL = new URL(connection.url)
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // SDK 生成器把请求先构造成 Request 再交给 fetch；不能对 Request 调 toString()
    // （结果是 "[object Request]"），否则 Desktop 会在健康检查阶段直接报连接失败。
    const request = input instanceof Request ? input : new Request(input, init)
    const source = new URL(request.url)
    const target = new URL(`${source.pathname}${source.search}`, baseURL)
    const headers = new Headers(request.headers)
    headers.set("authorization", `Bearer ${connection.token}`)
    // WKWebView 的 fetch 不支持流式上传；转发前必须把 body 读成完整 buffer，
    // 否则任何带 body 的请求（session.create、prompt）都会抛
    // "ReadableStream uploading is not supported"。
    const body = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer()
    return fetch(target, {
      method: request.method,
      headers,
      body: body && body.byteLength > 0 ? body : undefined,
      signal: request.signal,
    })
  }

  /**
   * 事件流是否已挂上当前 Core 实例。
   *
   * Core 的 Bus 订阅表挂在 Instance 上：注入凭据会重启 Core 进程，产生新的 Instance
   * 和全新的订阅表，旧连接上的订阅随之失效。若在重连完成前提交 prompt，这一整回合的
   * 流式正文、工具步骤和 session.idle 都会发到新 Instance 的 bus 上而无人接收——
   * 表现为"一直转圈不回复"。connected 由此存在：提交前先等事件流重新就绪。
   */
  let connected = false
  let announceConnected: (() => void) | undefined
  let connectedSignal = new Promise<void>((resolve) => { announceConnected = resolve })

  const markConnected = () => {
    if (connected) return
    connected = true
    announceConnected?.()
  }

  const markDisconnected = () => {
    if (!connected) return
    connected = false
    connectedSignal = new Promise<void>((resolve) => { announceConnected = resolve })
  }

  const events = {
    on(handler: (event: Event) => void) {
      const controller = new AbortController()
      let stopped = false
      void (async () => {
        const sdk = createKillstataClient({
          baseUrl: baseURL.toString(),
          fetch: fetcher as typeof fetch,
          signal: controller.signal,
        })
        while (!stopped) {
          try {
            const result = await sdk.event.subscribe({}, { signal: controller.signal })
            for await (const event of result.stream) {
              if (stopped) break
              // 服务端建流后立刻发 server.connected，随后才 Bus.subscribeAll；
              // 收到任意事件即说明这条流已经活着。
              markConnected()
              handler(event as Event)
            }
            // 流正常结束（Core 退出/重启）同样意味着订阅已失效。
            markDisconnected()
          } catch {
            markDisconnected()
            if (stopped) break
            await new Promise((resolve) => setTimeout(resolve, 250))
          }
        }
      })()
      return () => {
        stopped = true
        controller.abort()
      }
    },
    /** 已连接时立即返回；断开期间等到重连成功（或超时后放行，不把提交永久卡住）。 */
    async whenConnected(timeoutMilliseconds = 10_000) {
      if (connected) return
      await Promise.race([
        connectedSignal,
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMilliseconds)),
      ])
    },
    /**
     * 明确作废当前连接状态。Tauri 重启 Core 是同步完成的，但 JS 侧要等 fetch 抛错
     * 才会察觉断开；重启后若不主动作废，whenConnected 会因为陈旧的 connected 标志
     * 立即放行，prompt 仍旧发在失效订阅上。
     */
    invalidate: markDisconnected,
  }

  return { fetch: fetcher, events }
}
