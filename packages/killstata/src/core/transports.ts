import { CoreApplication } from "@/core/application"
import { CoreApplicationClient } from "@/core/client"
import type { Event } from "@killstata/sdk/v2"

export type CoreClientTransport = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  events?: { on: (handler: (event: Event) => void) => () => void }
}

type WorkerRpc = {
  call: (method: "fetch", input: { url: string; method: string; headers: Record<string, string>; body?: string }) => Promise<{
    status: number
    headers: Record<string, string>
    body: string
  }>
  on: <Data>(event: string, handler: (data: Data) => void) => () => void
}

export function createWorkerCoreTransport(client: WorkerRpc): CoreClientTransport {
  return {
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const body = request.body ? await request.text() : undefined
      const result = await client.call("fetch", {
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        body,
      })
      return new Response(result.body, {
        status: result.status,
        headers: result.headers,
      })
    },
    events: {
      on: (handler) => client.on<Event>("event", handler),
    },
  }
}

export function createInProcessCoreClient(directory: string) {
  let application: CoreApplication | undefined
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    application ??= await CoreApplication.create({ directory })
    return application.fetch(new Request(input, init))
  }
  return {
    client: new CoreApplicationClient({ fetch: fetcher }),
    async dispose() {
      await application?.dispose()
      application = undefined
    },
  }
}

export function createWorkerCoreClient(client: WorkerRpc) {
  return new CoreApplicationClient(createWorkerCoreTransport(client))
}
