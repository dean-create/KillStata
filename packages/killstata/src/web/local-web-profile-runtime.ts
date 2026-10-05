import { Auth } from "../auth"
import type { LocalWebStoredProfile } from "./local-web-credentials"

export type LocalWebProfileRuntimeOptions = { restartCore?: () => Promise<void> }

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function configFor(profile: LocalWebStoredProfile) {
  const overlay: Record<string, unknown> = { model: profile.model }
  if (profile.smallModel) overlay.small_model = profile.smallModel
  if (profile.provider === "custom") {
    const modelIDs = [profile.model, profile.smallModel]
      .filter((model): model is string => Boolean(model))
      .map((model) => model.slice(profile.provider.length + 1))
    overlay.provider = {
      custom: {
        options: { baseURL: profile.baseURL },
        models: Object.fromEntries(modelIDs.map((modelID) => [modelID, {}])),
      },
    }
  } else if (profile.provider === "anthropic" || profile.provider === "google") {
    const anthropic = profile.provider === "anthropic"
    const modelIDs = [profile.model, profile.smallModel]
      .filter((model): model is string => Boolean(model))
      .map((model) => model.slice(profile.provider.length + 1))
    overlay.provider = {
      [profile.provider]: {
        name: anthropic ? "Anthropic" : "Google Gemini",
        api: profile.baseURL,
        env: [anthropic ? "ANTHROPIC_API_KEY" : "GOOGLE_GENERATIVE_AI_API_KEY"],
        models: Object.fromEntries(modelIDs.map((modelID) => [modelID, {
            id: modelID,
            name: modelID,
            provider: { npm: anthropic ? "@ai-sdk/anthropic" : "@ai-sdk/google" },
          }])),
      },
    }
  }
  return overlay
}

export function createLocalWebProfileRuntime(options: LocalWebProfileRuntimeOptions = {}) {
  const originalConfigContent = process.env.KILLSTATA_CONFIG_CONTENT
  let activeProviderID: string | undefined
  let activeProfileFingerprint: string | undefined
  let activationQueue = Promise.resolve()
  let disposed = false

  async function activateProfile(profile: LocalWebStoredProfile | undefined) {
    if (disposed) throw new Error("本机 Web 凭据运行时已经关闭。")
    const fingerprint = profile
      ? JSON.stringify([profile.id, profile.provider, profile.model, profile.baseURL, profile.smallModel, profile.apiKey])
      : "<no-active-profile>"
    if (activeProfileFingerprint === fingerprint) return
    const baseConfig = originalConfigContent ? object(JSON.parse(originalConfigContent)) : {}
    if (originalConfigContent && !baseConfig) throw new Error("KILLSTATA_CONFIG_CONTENT 必须是 JSON 对象。")
    let nextConfig: Record<string, unknown> | undefined
    if (profile) {
      const overlay = configFor(profile)
      const currentProviders = object(baseConfig?.provider) ?? {}
      const overlayProviders = object(overlay.provider)
      nextConfig = { ...baseConfig, ...overlay }
      delete nextConfig.small_model
      if (profile.smallModel) nextConfig.small_model = profile.smallModel
      if (overlayProviders) nextConfig.provider = { ...currentProviders, ...overlayProviders }
    } else if (originalConfigContent) {
      nextConfig = { ...baseConfig }
    }

    if (activeProviderID) Auth.clearRuntimeOverride(activeProviderID)
    activeProviderID = undefined
    if (profile) {
      Auth.setRuntimeOverride(profile.provider, { type: "api", key: profile.apiKey })
      activeProviderID = profile.provider
    }
    if (nextConfig) process.env.KILLSTATA_CONFIG_CONTENT = JSON.stringify(nextConfig)
    else delete process.env.KILLSTATA_CONFIG_CONTENT
    await options.restartCore?.()
    activeProfileFingerprint = fingerprint
  }

  function activate(profile: LocalWebStoredProfile | undefined) {
    const current = activationQueue.then(() => activateProfile(profile))
    activationQueue = current.then(() => undefined, () => undefined)
    return current
  }

  return {
    activate,
    dispose() {
      if (disposed) return
      disposed = true
      if (activeProviderID) Auth.clearRuntimeOverride(activeProviderID)
      activeProviderID = undefined
      if (originalConfigContent === undefined) delete process.env.KILLSTATA_CONFIG_CONTENT
      else process.env.KILLSTATA_CONFIG_CONTENT = originalConfigContent
    },
  }
}
