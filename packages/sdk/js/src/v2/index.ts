export * from "./client.js"
export * from "./server.js"

import { createKillstataClient } from "./client.js"
import { createKillstataServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createKillstata(options?: ServerOptions) {
  const server = await createKillstataServer({
    ...options,
  })

  const client = createKillstataClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
