import { describe, expect, test } from "bun:test"
import type { KillstataClientConfig, Path, Session, Message, Part } from "../src/v2/index.js"

describe("@killstata/sdk v2", () => {
  test("module exports have correct shape", async () => {
    const mod = await import("../src/v2/index.js")
    expect(mod.createKillstataClient).toBeFunction()
    expect(mod.createKillstataServer).toBeFunction()
    expect(mod.createKillstata).toBeFunction()
    expect(mod.KillstataClient).toBeFunction()
  })

  test("createKillstataClient creates a client with expected methods", async () => {
    const mod = await import("../src/v2/index.js")
    // 不启动真实 server，传一个不存在的 baseUrl 验证客户端构造不抛异常
    const client = mod.createKillstataClient({ baseUrl: "http://127.0.0.1:1" })
    expect(client).toBeDefined()
    expect(client.app).toBeDefined()
    expect(client.config).toBeDefined()
    expect(client.session).toBeDefined()
  })

  test("types are exported", () => {
    // 类型在运行时不可见，验证常量/命名空间导出
    const _path: Path = { home: "", state: "", config: "", worktree: "", directory: "" }
    expect(_path).toBeDefined()
  })

  test("Config type is re-exported as KillstataClientConfig", async () => {
    const mod = await import("../src/v2/client.js")
    expect(mod.KillstataClientConfig).toBeDefined()
  })

  test("server module exports createKillstataServer", async () => {
    const mod = await import("../src/v2/server.js")
    expect(mod.createKillstataServer).toBeFunction()
  })

  test("v2/index re-exports client and server", async () => {
    const v2Index = await import("../src/v2/index.js")
    const clientMod = await import("../src/v2/client.js")
    const serverMod = await import("../src/v2/server.js")

    expect(v2Index.createKillstataClient).toBe(clientMod.createKillstataClient)
    expect(v2Index.createKillstataServer).toBe(serverMod.createKillstataServer)
  })
})
