import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const packageRoot = path.resolve(import.meta.dirname, "../..")
const platform = process.platform === "win32" ? "windows" : process.platform
const extension = process.platform === "win32" ? ".exe" : ""
const binaryPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(packageRoot, "dist", `killstata-${platform}-${process.arch}`, "bin", `killstata${extension}`)

if (!existsSync(binaryPath)) {
  throw new Error(`Native CLI binary missing for ${platform}/${process.arch}`)
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "killstata-native-web-smoke-"))
const child = spawn(binaryPath, ["web", "--port", "0", "--no-open"], {
  cwd: runtimeRoot,
  env: {
    ...process.env,
    XDG_DATA_HOME: path.join(runtimeRoot, "data"),
    XDG_CONFIG_HOME: path.join(runtimeRoot, "config"),
    XDG_CACHE_HOME: path.join(runtimeRoot, "cache"),
    XDG_STATE_HOME: path.join(runtimeRoot, "state"),
    APPDATA: path.join(runtimeRoot, "appdata"),
    LOCALAPPDATA: path.join(runtimeRoot, "local-appdata"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
})

const exited = new Promise((resolve) => {
  child.once("exit", () => resolve(true))
  child.once("error", () => resolve(true))
})
let stdout = ""
child.stdout.setEncoding("utf8")
child.stderr.resume()
child.stdout.on("data", (chunk) => { stdout += chunk })

function waitForLaunchUrl() {
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => reject(new Error("Native CLI did not print its Web launch URL")), 30_000)
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback(value)
    }
    const inspect = () => {
      if (settled) return
      const match = stdout.match(/KillStata Web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/)
      if (!match) return
      finish(resolve, match[1])
    }
    child.stdout.on("data", inspect)
    child.once("error", (error) => {
      finish(reject, error)
    })
    child.once("exit", (code) => {
      inspect()
      finish(reject, new Error(`Native CLI exited before Web startup (code ${code ?? "unknown"})`))
    })
    inspect()
  })
}

try {
  const launchUrl = await waitForLaunchUrl()
  const launchResponse = await fetch(launchUrl, { redirect: "manual" })
  assert.equal(launchResponse.status, 303, "launch token should exchange for an authenticated browser session")

  const setCookies = typeof launchResponse.headers.getSetCookie === "function"
    ? launchResponse.headers.getSetCookie()
    : [launchResponse.headers.get("set-cookie") ?? ""]
  const webCookie = setCookies.find((cookie) => cookie.startsWith("killstata_web="))?.split(";", 1)[0]
  assert.ok(webCookie, "launch response should set the HttpOnly Web session cookie")

  const pageUrl = new URL(launchResponse.headers.get("location"), launchUrl)
  const pageResponse = await fetch(pageUrl, { headers: { cookie: webCookie } })
  assert.equal(pageResponse.status, 200, "authenticated launch should serve the Web UI")
  const html = await pageResponse.text()
  assert.match(html, /<html\b/i, "Web response should contain the app document")

  const assetPaths = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)]
    .map((match) => match[1])
  assert.ok(assetPaths.some((asset) => asset.endsWith(".js")), "Web document should reference JavaScript")
  assert.ok(assetPaths.some((asset) => asset.endsWith(".css")), "Web document should reference CSS")

  for (const assetPath of assetPaths) {
    const assetResponse = await fetch(new URL(assetPath, pageUrl), { headers: { cookie: webCookie } })
    assert.equal(assetResponse.status, 200, `Web asset should load: ${assetPath.split("/").at(-1)}`)
  }

  console.log(`Native Web smoke passed for ${platform}/${process.arch}`)
} finally {
  if (child.exitCode === null && !child.killed) child.kill()
  let shutdownTimeout
  const stopped = await Promise.race([
    exited,
    new Promise((resolve) => { shutdownTimeout = setTimeout(() => resolve(false), 5_000) }),
  ])
  clearTimeout(shutdownTimeout)
  rmSync(runtimeRoot, { recursive: true, force: true })
  assert.equal(stopped, true, "native CLI Web process should stop after the smoke check")
}
