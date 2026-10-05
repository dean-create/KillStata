import { createKillstataClient, type KillstataClient } from "@killstata/sdk/v2"
import type { Event } from "@killstata/sdk/v2"
import { CoreApplication } from "./application"

export type CoreClientTransport = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  events?: { on: (handler: (event: Event) => void) => () => void }
}

function asFetch(transport: CoreClientTransport): typeof fetch {
  return transport.fetch as typeof fetch
}

/**
 * 统一 Core Client 的最小适配器。
 *
 * SDK 已经把 Session、Message、Permission、Question 和 Event API 生成出来；
 * CoreApplicationClient 只负责把 SDK 绑定到某种 transport。这样业务调用方不
 * 需要知道请求来自进程内、Worker/RPC 还是 loopback HTTP。
 */
export class CoreApplicationClient {
  readonly sdk: KillstataClient
  readonly events?: CoreClientTransport["events"]

  constructor(transport: CoreClientTransport) {
    this.events = transport.events
    this.sdk = createKillstataClient({
      baseUrl: "http://killstata.core",
      fetch: asFetch(transport),
    })
  }

  static inProcess(application: CoreApplication): CoreApplicationClient {
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      return application.fetch(request)
    }
    return new CoreApplicationClient({ fetch: fetcher })
  }
}
