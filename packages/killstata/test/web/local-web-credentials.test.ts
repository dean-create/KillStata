import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createLocalWebCredentialStore } from "../../src/web/local-web-credentials"

async function withCredentialDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "killstata-web-credentials-"))
  try { await run(directory) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

function jsonRequest(pathname: string, body?: unknown, method = "POST") {
  return new Request(`http://127.0.0.1${pathname}`, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  })
}

describe("local Web credential profiles", () => {
  test("persists secrets in a private file but returns only profile summaries", async () => {
    await withCredentialDirectory(async (directory) => {
      const activeProfiles: Array<{ provider: string; apiKey: string } | undefined> = []
      const store = createLocalWebCredentialStore({
        storagePath: path.join(directory, "profiles.json"),
        activate: async (profile) => { activeProfiles.push(profile ? { provider: profile.provider, apiKey: profile.apiKey } : undefined) },
      })
      const secret = "local-web-provider-secret"

      const response = await store.handle(jsonRequest("/api/v2/credentials/profiles", {
        config: { provider: "deepseek", model: "deepseek/deepseek-v4-flash" },
        profileId: null,
        createIfMissing: true,
        apiKey: secret,
        makeDefault: true,
        displayName: "研究模型",
      }))
      const mutation = await response?.json() as { profileId: string; snapshot: { profiles: unknown[]; defaultProfileId: string } }
      const stored = await readFile(path.join(directory, "profiles.json"), "utf8")
      const fileMode = (await stat(path.join(directory, "profiles.json"))).mode & 0o777

      expect(mutation.snapshot.defaultProfileId).toBe(mutation.profileId)
      expect(stored).toContain(secret)
      expect(fileMode & 0o077).toBe(0)
      expect(JSON.stringify(mutation)).not.toContain(secret)
      expect(JSON.stringify(mutation.snapshot.profiles)).not.toContain("apiKey")
      expect(activeProfiles).toEqual([])

      const activateResponse = await store.handle(jsonRequest("/api/v2/credentials/activate", {}))
      expect(activateResponse?.status).toBe(200)
      expect(activeProfiles).toEqual([{ provider: "deepseek", apiKey: secret }])

      const list = await store.handle(new Request("http://127.0.0.1/api/v2/credentials/profiles"))
      expect(JSON.stringify(await list?.json())).not.toContain(secret)
    })
  })

  test("rejects an unsupported built-in model before persisting a profile", async () => {
    await withCredentialDirectory(async (directory) => {
      const store = createLocalWebCredentialStore({ storagePath: path.join(directory, "profiles.json") })
      const response = await store.handle(jsonRequest("/api/v2/credentials/profiles", {
        config: { provider: "deepseek", model: "deepseek/unlisted-model" },
        createIfMissing: true,
        apiKey: "secret",
        makeDefault: true,
      }))

      expect(response?.status).toBe(400)
      expect(await Bun.file(path.join(directory, "profiles.json")).exists()).toBe(false)
    })
  })

  test("discovers external models with the draft key in a header, never in the URL", async () => {
    const secret = "draft-discovery-secret"
    const requests: Array<{ url: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url, init })
      return Response.json({ data: [{ id: "model-a", display_name: "Model A" }] })
    }) as typeof fetch
    const store = createLocalWebCredentialStore({ storagePath: path.join(os.tmpdir(), `web-profile-discovery-${crypto.randomUUID()}.json`), fetcher })
    const response = await store.handle(jsonRequest("/api/v2/credentials/discover", {
      provider: "custom",
      baseUrl: "https://models.example/v1",
      apiKey: secret,
      profileId: null,
    }))
    const models = await response?.json()
    const { url, init } = requests[0]!

    expect(models).toEqual([{ id: "custom/model-a", label: "Model A" }])
    expect(String(url)).toBe("https://models.example/v1/models")
    expect(String(url)).not.toContain(secret)
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${secret}`)
  })

  test("does not send a saved key to a changed endpoint without a new draft key", async () => {
    await withCredentialDirectory(async (directory) => {
      const requests: Array<{ url: RequestInfo | URL; init?: RequestInit }> = []
      const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url, init })
        return Response.json({ data: [{ id: "model-a" }] })
      }) as typeof fetch
      const store = createLocalWebCredentialStore({ storagePath: path.join(directory, "profiles.json"), fetcher })
      const saved = await store.handle(jsonRequest("/api/v2/credentials/profiles", {
        config: { provider: "custom", model: "custom/model-a", baseUrl: "https://one.example/v1" },
        createIfMissing: true,
        apiKey: "saved-secret",
        makeDefault: true,
      }))
      const profileID = (await saved?.json()).profileId
      const response = await store.handle(jsonRequest("/api/v2/credentials/discover", {
        provider: "custom",
        baseUrl: "https://two.example/v1",
        apiKey: null,
        profileId: profileID,
      }))

      expect(response?.status).toBe(400)
      expect(requests).toHaveLength(0)
    })
  })
})
