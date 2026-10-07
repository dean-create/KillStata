import path from "path"
import { Global } from "../global"
import fs from "fs/promises"
import z from "zod"

export const OAUTH_DUMMY_KEY = "killstata-oauth-dummy-key"

export namespace Auth {
  const runtimeOverrides = new Map<string, Info>()

  function normalizeSecret(value: string) {
    const trimmed = value.trim()
    const quoted = trimmed.match(/^(['"])(.*)\1$/)
    return quoted ? quoted[2].trim() : trimmed
  }

  export const Oauth = z
    .object({
      type: z.literal("oauth"),
      refresh: z.string(),
      access: z.string(),
      expires: z.number(),
      accountId: z.string().optional(),
      enterpriseUrl: z.string().optional(),
    })
    .meta({ ref: "OAuth" })

  export const Api = z
    .object({
      type: z.literal("api"),
      key: z.string(),
    })
    .meta({ ref: "ApiAuth" })

  export const WellKnown = z
    .object({
      type: z.literal("wellknown"),
      key: z.string(),
      token: z.string(),
    })
    .meta({ ref: "WellKnownAuth" })

  export const Info = z.discriminatedUnion("type", [Oauth, Api, WellKnown]).meta({ ref: "Auth" })
  export type Info = z.infer<typeof Info>

  const filepath = path.join(Global.Path.data, "auth.json")

  export async function get(providerID: string) {
    const auth = await all()
    return auth[providerID]
  }

  export async function all(): Promise<Record<string, Info>> {
    const file = Bun.file(filepath)
    const data = await file.json().catch(() => ({}) as Record<string, unknown>)
    const result = Object.entries(data).reduce(
      (acc, [key, value]) => {
        const parsed = Info.safeParse(value)
        if (!parsed.success) return acc
        acc[key] = parsed.data
        return acc
      },
      {} as Record<string, Info>,
    )
    for (const [key, value] of runtimeOverrides) result[key] = value
    return result
  }

  /** A process-local provider credential for managed hosts; this never touches auth.json. */
  export function setRuntimeOverride(key: string, info: Info) {
    runtimeOverrides.set(key, Info.parse(info))
  }

  /** Remove the process-local override and reveal the normal persisted auth entry again. */
  export function clearRuntimeOverride(key: string) {
    runtimeOverrides.delete(key)
  }

  export async function set(key: string, info: Info) {
    const file = Bun.file(filepath)
    const data = await all()
    const normalized =
      info.type === "api"
        ? { ...info, key: normalizeSecret(info.key) }
        : info.type === "wellknown"
          ? { ...info, key: normalizeSecret(info.key), token: normalizeSecret(info.token) }
          : info
    await Bun.write(file, JSON.stringify({ ...data, [key]: normalized }, null, 2))
    await fs.chmod(file.name!, 0o600)
  }

  export async function remove(key: string) {
    const file = Bun.file(filepath)
    const data = await all()
    delete data[key]
    await Bun.write(file, JSON.stringify(data, null, 2))
    await fs.chmod(file.name!, 0o600)
  }
}
