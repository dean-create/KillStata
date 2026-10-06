import { describe, expect, test } from "vitest"
import { createSharedWebCredentialStore, createWebCredentialStore } from "./credential-store"

describe("Web credential store", () => {
  test("keeps the same credential contract and sends credentials only to same-origin APIs", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = []
    const fetcher: typeof fetch = async (input, init) => {
      calls.push([input, init])
      if (String(input).endsWith("/profiles")) {
        return Response.json({ profiles: [], defaultProfileId: null })
      }
      return Response.json({ configured: false, provider: "deepseek", model: "deepseek/deepseek-v4-flash" })
    }
    const store = createWebCredentialStore(fetcher)

    await expect(store.hasApiKey()).resolves.toBe(false)
    await expect(store.listProfiles?.()).resolves.toEqual({ profiles: [], defaultProfileId: null })

    expect(calls.map(([input]) => String(input))).toEqual([
      "/api/v2/credentials/profiles",
      "/api/v2/credentials/profiles",
    ])
    for (const [, init] of calls) {
      expect(init?.credentials).toBe("same-origin")
    }
  })

  test("activates the saved model only when connected analysis is explicitly prepared", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = []
    const fetcher: typeof fetch = async (input, init) => {
      calls.push([input, init])
      return Response.json({ activated: true })
    }
    const store = createWebCredentialStore(fetcher)

    await store.prepareEngineForAnalysis?.()

    expect(calls).toHaveLength(1)
    expect(String(calls[0]![0])).toBe("/api/v2/credentials/activate")
    expect(calls[0]![1]?.method).toBe("POST")
    expect(calls[0]![1]?.credentials).toBe("same-origin")
  })

  test("shows shared visitors only the active host model, not saved profile metadata", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = []
    const fetcher: typeof fetch = async (input, init) => {
      calls.push([input, init])
      if (String(input).endsWith("/status")) {
        return Response.json({
          configured: true,
          provider: "custom",
          model: "custom/host-model",
          profileId: "owner-private-profile-id",
          baseURL: "https://internal-owner-endpoint.example/v1",
          smallModel: "custom/private-small-model",
        })
      }
      return Response.json({ activated: true })
    }
    const store = createSharedWebCredentialStore(fetcher)

    await expect(store.hasApiKey()).resolves.toBe(true)
    await expect(store.getStatus?.()).resolves.toEqual({
      configured: true,
      provider: "custom",
      model: "custom/host-model",
      profileId: "shared-host-profile",
    })
    await expect(store.listProfiles?.()).resolves.toEqual({
      profiles: [{
        id: "shared-host-profile",
        displayName: "分享主机模型",
        provider: "custom",
        model: "custom/host-model",
        configured: true,
        isDefault: true,
      }],
      defaultProfileId: "shared-host-profile",
    })
    await store.prepareEngineForAnalysis?.()

    expect(store.saveProfile).toBeUndefined()
    expect(store.setDefaultProfile).toBeUndefined()
    expect(store.deleteProfile).toBeUndefined()
    expect(store.discoverModels).toBeUndefined()
    expect(calls.map(([input, init]) => [String(input), init?.method ?? "GET"])).toEqual([
      ["/api/v2/credentials/status", "GET"],
      ["/api/v2/credentials/status", "GET"],
      ["/api/v2/credentials/status", "GET"],
      ["/api/v2/credentials/activate", "POST"],
    ])
  })

  test("sends a draft key in the discovery request body and never in its URL", async () => {
    const secret = "web-draft-secret"
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = []
    const fetcher: typeof fetch = async (input, init) => {
      calls.push([input, init])
      return Response.json([{ id: "custom/model-a", label: "model-a" }])
    }
    const store = createWebCredentialStore(fetcher)

    await expect(store.discoverModels?.("custom", "https://api.example/v1", secret, "profile-1"))
      .resolves.toEqual([{ id: "custom/model-a", label: "model-a" }])

    const [url, init] = calls[0]!
    expect(String(url)).not.toContain(secret)
    expect(init?.credentials).toBe("same-origin")
    expect(JSON.parse(String(init?.body))).toMatchObject({
      provider: "custom",
      baseUrl: "https://api.example/v1",
      apiKey: secret,
      profileId: "profile-1",
    })
  })
})
