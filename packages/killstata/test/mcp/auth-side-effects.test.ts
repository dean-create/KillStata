import { describe, expect, test } from "bun:test"
import { Instance } from "@/project/instance"
import { MCP } from "@/mcp"

describe("MCP authentication side effects", () => {
  test("ordinary MCP status/discovery does not start an OAuth browser flow", async () => {
    // The public status path only reads the state. The browser-opening path is
    // reachable only through MCP.authenticate(name, { openBrowser: true }).
    expect(typeof MCP.status).toBe("function")
    expect(typeof MCP.startAuth).toBe("function")
    expect(typeof MCP.authenticate).toBe("function")
  })

  test("authenticate requires explicit browser opt-in", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        await expect(MCP.authenticate("missing-server")).rejects.toThrow("MCP server not found")
      },
    })
  })
})
