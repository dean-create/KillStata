import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"

function isLoopbackHost(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
}

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless killstata server",
  handler: async (args) => {
    const opts = await resolveNetworkOptions(args)
    // 只允许无密码服务绑定在本机回环地址；一旦对局域网可见，就必须先设置访问密码。
    if (!Flag.KILLSTATA_SERVER_PASSWORD && (opts.mdns || !isLoopbackHost(opts.hostname))) {
      throw new Error("Refusing to start an unsecured remote Killstata server. Set KILLSTATA_SERVER_PASSWORD first.")
    }
    if (!Flag.KILLSTATA_SERVER_PASSWORD) {
      console.log("Warning: KILLSTATA_SERVER_PASSWORD is not set; server is limited to local loopback access.")
    }
    const server = Server.listen(opts)
    console.log(`killstata server listening on http://${server.hostname}:${server.port}`)
    await new Promise(() => {})
    await server.stop()
  },
})
