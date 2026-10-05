import { describe, expect, test, vi } from "vitest"
import { createWebUiPreferencesStore } from "./ui-preferences"

describe("connected Web shared UI preferences", () => {
  test("loads validated values and saves one key to the authenticated same-origin host", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = []
    const fetcher: typeof fetch = async (input, init) => {
      calls.push([input, init])
      if (init?.method === "PUT") return Response.json({ protocolVersion: "v2", saved: true })
      return Response.json({ protocolVersion: "v2", preferences: { theme: "dark", reasoningEffort: "high" } })
    }
    const store = createWebUiPreferencesStore(fetcher)

    await expect(store.load()).resolves.toEqual({ theme: "dark", reasoningEffort: "high" })
    await expect(store.save("reasoningEffort", "medium", { onlyIfAbsent: true })).resolves.toBe(true)

    expect(calls.map(([url]) => String(url))).toEqual(["/api/v2/ui-preferences", "/api/v2/ui-preferences"])
    expect(calls[0]?.[1]).toMatchObject({ method: "GET", credentials: "same-origin" })
    expect(calls[1]?.[1]).toMatchObject({ method: "PUT", credentials: "same-origin" })
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({ key: "reasoningEffort", value: "medium", onlyIfAbsent: true })
  })

  test("rejects an invalid preference response instead of applying it", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      protocolVersion: "v2",
      preferences: { theme: "dark", reasoningEffort: "anything-goes" },
    }))
    const store = createWebUiPreferencesStore(fetcher)
    await expect(store.load()).rejects.toThrow("界面偏好")
  })

  test("loads and writes the shared permission mode through the authenticated same-origin endpoint", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = []
    const fetcher: typeof fetch = async (input, init) => {
      calls.push([input, init])
      if (init?.method === "PUT") return Response.json({ protocolVersion: "v2", saved: true })
      return Response.json({ protocolVersion: "v2", preferences: { permissionMode: "read_only" } })
    }
    const store = createWebUiPreferencesStore(fetcher)

    await expect(store.load()).resolves.toEqual({ permissionMode: "read_only" })
    await expect(store.save("permissionMode", "full_access")).resolves.toBe(true)

    expect(calls.map(([url]) => String(url))).toEqual(["/api/v2/ui-preferences", "/api/v2/ui-preferences"])
    expect(calls[0]?.[1]).toMatchObject({ method: "GET", credentials: "same-origin" })
    expect(calls[1]?.[1]).toMatchObject({ method: "PUT", credentials: "same-origin" })
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({ key: "permissionMode", value: "full_access" })
  })
})
