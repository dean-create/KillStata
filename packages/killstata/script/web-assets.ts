import fs from "node:fs"
import path from "node:path"

export function copyWebAssets(sourceDirectory: string, packageDirectory: string) {
  const assetsDirectory = path.join(sourceDirectory, "assets")
  const assets = fs.existsSync(assetsDirectory) ? fs.readdirSync(assetsDirectory) : []
  if (!fs.existsSync(path.join(sourceDirectory, "index.html")) || !assets.some((asset) => asset.endsWith(".js")) || !assets.some((asset) => asset.endsWith(".css"))) {
    throw new Error("Web 构建产物缺少 index.html 或 JS/CSS 资源")
  }

  const destination = path.join(packageDirectory, "dist-web")
  fs.rmSync(destination, { recursive: true, force: true })
  fs.cpSync(sourceDirectory, destination, { recursive: true })
  return destination
}
