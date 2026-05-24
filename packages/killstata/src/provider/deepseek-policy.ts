export const DEEPSEEK_PROVIDER_ID = "deepseek"
export const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY"
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com"
export const DEEPSEEK_DEFAULT_MODEL_ID = "deepseek-v4-flash"
export const DEEPSEEK_PRO_MODEL_ID = "deepseek-v4-pro"
export const DEEPSEEK_MODEL_IDS = [DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_PRO_MODEL_ID] as const
export const DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS = 1_000_000
export const DEEPSEEK_V4_MAX_OUTPUT_TOKENS = 384_000

const DEEPSEEK_MODEL_ALIASES: Record<string, (typeof DEEPSEEK_MODEL_IDS)[number]> = {
  "deepseek-chat": DEEPSEEK_DEFAULT_MODEL_ID,
  "deepseek-reasoner": DEEPSEEK_DEFAULT_MODEL_ID,
  "deepseek-v4": DEEPSEEK_DEFAULT_MODEL_ID,
  "deepseek-v4flash": DEEPSEEK_DEFAULT_MODEL_ID,
  "deepseek-v4pro": DEEPSEEK_PRO_MODEL_ID,
}

export function isDeepSeekProvider(providerID: string) {
  return providerID === DEEPSEEK_PROVIDER_ID
}

export function normalizeDeepSeekModelID(modelID: string) {
  const normalized = modelID.trim().toLowerCase()
  if (DEEPSEEK_MODEL_IDS.includes(normalized as any)) return normalized as (typeof DEEPSEEK_MODEL_IDS)[number]
  return DEEPSEEK_MODEL_ALIASES[normalized]
}

export function isDeepSeekModel(input: { providerID: string; modelID: string }) {
  return isDeepSeekProvider(input.providerID) && normalizeDeepSeekModelID(input.modelID) !== undefined
}

export function deepSeekOnlyMessage(providerID?: string, modelID?: string) {
  const requested = providerID ? ` Requested: ${providerID}${modelID ? `/${modelID}` : ""}.` : ""
  return `Killstata is running in DeepSeek-only mode. Only deepseek/${DEEPSEEK_DEFAULT_MODEL_ID} and deepseek/${DEEPSEEK_PRO_MODEL_ID} are supported. Compatibility aliases deepseek-chat and deepseek-reasoner resolve to ${DEEPSEEK_DEFAULT_MODEL_ID}.${requested}`
}

export function deepSeekEnvOnlyAuthMessage(providerID?: string) {
  const requested = providerID ? ` Requested provider: ${providerID}.` : ""
  return `Killstata DeepSeek-only mode reads API credentials only from ${DEEPSEEK_API_KEY_ENV}.${requested} Set ${DEEPSEEK_API_KEY_ENV} in the environment instead of saving provider credentials.`
}
