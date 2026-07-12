import { Global } from "../global"
import { fallbackProviders } from "./models-fallback"

export async function data() {
  const path = Bun.env.MODELS_DEV_API_JSON
  if (path) {
    const file = Bun.file(path)
    if (await file.exists()) {
      return await file.text()
    }
  }

  const cacheFile = Bun.file(`${Global.Path.cache}/models.json`)
  if (await cacheFile.exists()) {
    return await cacheFile.text()
  }

  const url = Global.Path.modelsDevUrl
  try {
    return await fetch(`${url}/api.json`).then((x) => x.text())
  } catch {
    return JSON.stringify(fallbackProviders())
  }
}
