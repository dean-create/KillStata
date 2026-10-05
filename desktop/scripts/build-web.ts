import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { build, loadEnv } from "vite"

export const WEB_BUILD_ENV = {
  VITE_ENGINE_URL: "/api",
  VITE_ENGINE_PROTOCOL_VERSION: "v2",
  VITE_KILLSTATA_MODE: "frontend",
  VITE_KILLSTATA_WEB: "1",
} as const

type BuildWebOptions = {
  projectRoot?: string
  outputDirectory?: string
}

export async function buildWebDistribution(options: BuildWebOptions = {}) {
  const projectRoot = options.projectRoot ?? path.resolve(import.meta.dir, "..")
  const outputDirectory = options.outputDirectory ?? path.join(projectRoot, "dist-web")
  const configuredEnvironment = loadEnv("web", projectRoot, "VITE_")
  if (Object.keys(configuredEnvironment).some((key) => /(?:_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key))) {
    throw new Error("Web 构建环境禁止注入凭据变量")
  }

  await build({
    root: projectRoot,
    configFile: path.join(projectRoot, "vite.config.ts"),
    mode: "web",
    envPrefix: [],
    define: {
      ...Object.fromEntries(Object.entries(WEB_BUILD_ENV).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)])),
      "import.meta.env.VITE_ENGINE_TOKEN": "undefined",
    },
    build: { outDir: outputDirectory, emptyOutDir: true },
  })

  const assetsDirectory = path.join(outputDirectory, "assets")
  const assets = existsSync(assetsDirectory) ? readdirSync(assetsDirectory) : []
  if (!existsSync(path.join(outputDirectory, "index.html")) || !assets.some((asset) => asset.endsWith(".js")) || !assets.some((asset) => asset.endsWith(".css"))) {
    throw new Error("Web 构建产物缺少 index.html 或 JS/CSS 资源")
  }
  return { outputDirectory }
}

if (import.meta.main) {
  const outputDirectory = process.argv[2] ? path.resolve(process.argv[2]) : undefined
  const result = await buildWebDistribution({ outputDirectory })
  console.log(`KillStata Web 资源已生成：${result.outputDirectory}`)
}
