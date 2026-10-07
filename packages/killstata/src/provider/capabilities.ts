import type { Provider } from "./provider"

export const EFFORT_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

export type ModelCapabilities = {
  supportsTools: boolean
  supportsReasoning: boolean
  supportsEffort: boolean
  effortLevels: EffortLevel[]
  supportsImages: boolean
  supportsPromptCache: boolean
}

export type EffectiveEffort = {
  requested: EffortLevel
  effective: EffortLevel
  downgradeReason?: string
}

export function resolveModelCapabilities(model: Provider.Model): ModelCapabilities {
  const variants = Object.keys(model.variants ?? {})
  const effortLevels = EFFORT_LEVELS.filter((level) => level === "off" || variants.includes(level))
  return {
    supportsTools: model.capabilities.toolcall,
    supportsReasoning: model.capabilities.reasoning,
    supportsEffort: model.capabilities.reasoning && effortLevels.some((level) => level !== "off"),
    effortLevels,
    supportsImages: model.capabilities.input.image,
    // Current usage accounting already exposes cache read/write; zero pricing
    // means unknown rather than proof that the provider cannot cache.
    supportsPromptCache: Boolean(model.cost?.cache),
  }
}

export function resolveEffectiveEffort(model: Provider.Model, requested: EffortLevel): EffectiveEffort {
  const capabilities = resolveModelCapabilities(model)
  if (requested === "off") return { requested, effective: requested }
  if (capabilities.effortLevels.includes(requested)) return { requested, effective: requested }

  const requestedIndex = EFFORT_LEVELS.indexOf(requested)
  const fallback = [...capabilities.effortLevels]
    .filter((level) => level !== "off" && EFFORT_LEVELS.indexOf(level) <= requestedIndex)
    .at(-1)
  if (fallback) {
    return {
      requested,
      effective: fallback,
      downgradeReason: `${model.providerID}/${model.id} does not support effort=${requested}; using effort=${fallback}`,
    }
  }
  return {
    requested,
    effective: "off",
    downgradeReason: `${model.providerID}/${model.id} does not expose a compatible reasoning effort; reasoning disabled`,
  }
}
