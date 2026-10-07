import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { readCoreProvenanceManifest, sha256File } from "./core-manifest"
import { tmpdir } from "node:os"

const desktopRoot = resolve(import.meta.dir, "..")
const macosApp = join(desktopRoot, "src-tauri", "target", "release", "bundle", "macos", "KillStata.app")
const macosBin = join(macosApp, "Contents", "MacOS")
const coreBinary = join(macosBin, "killstata-core")
const provenancePath = join(macosApp, "Contents", "Resources", "resources", "killstata-core-provenance.json")

if (!existsSync(coreBinary) || !existsSync(provenancePath)) {
  throw new Error("找不到已封装的 Core 或 provenance；请先重新运行 desktop:build")
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const provenance = await readCoreProvenanceManifest(provenancePath)
requireValue(provenance.protocolVersion === "v1", "Core provenance 协议版本不匹配")
requireValue(await sha256File(coreBinary) === provenance.binarySha256, "打包后的 Core SHA-256 与 provenance 不匹配")
requireValue(provenance.targetTriple === "aarch64-apple-darwin", "Core provenance 目标平台不匹配")

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string) {
  let lastError = ""
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const value = await read()
      if (predicate(value)) return value
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(100)
  }
  throw new Error(`${label} 未在 5 秒内就绪${lastError ? `：${lastError}` : ""}`)
}

async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, init)
  const body = await response.json() as Record<string, unknown>
  return { response, body }
}

const sandbox = await mkdtemp(join(tmpdir(), "killstata-desktop-core-"))
const token = crypto.randomUUID()
let core: ReturnType<typeof Bun.spawn> | undefined
try {
  const corePortServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
  const corePort = corePortServer.port
  corePortServer.stop(true)
  const coreURL = `http://127.0.0.1:${corePort}`
  core = Bun.spawn([coreBinary], {
    cwd: sandbox,
    env: {
      ...process.env,
      HOME: sandbox,
      KILLSTATA_CORE_DIRECTORY: sandbox,
      KILLSTATA_CORE_PORT: String(corePort),
      KILLSTATA_CORE_TOKEN: token,
    },
    stdout: "ignore",
    stderr: "ignore",
  })
  const authenticated = { headers: { authorization: `Bearer ${token}` } }
  const health = await waitFor(
    () => json(`${coreURL}/global/health`, authenticated),
    ({ response, body }) => response.ok && body.healthy === true,
    "内置 Core",
  )
  requireValue(health.body.version === provenance.coreVersion, "Core 版本与 provenance 不匹配")
  const unauthorized = await fetch(`${coreURL}/global/health`)
  requireValue(unauthorized.status === 401, "未携带令牌的请求没有被拒绝")

  const session = await json(`${coreURL}/session`, {
    method: "POST",
    headers: { ...authenticated.headers, "content-type": "application/json" },
    body: JSON.stringify({ title: "Core lifecycle", permission: [{ permission: "question", action: "deny", pattern: "*" }] }),
  })
  requireValue(session.response.ok && typeof session.body.id === "string", "Core 没有创建 session")
  const sessions = await json(`${coreURL}/session`, { headers: authenticated.headers })
  requireValue(sessions.response.ok && Array.isArray(sessions.body), "Core 没有返回 session 列表")
  console.log(JSON.stringify({ verified: true, coreVersion: health.body.version, sessionCount: (sessions.body as unknown[]).length }))
} finally {
  core?.kill()
  await Promise.allSettled([core?.exited].filter((value): value is Promise<number> => Boolean(value)))
  await rm(sandbox, { recursive: true, force: true })
}
