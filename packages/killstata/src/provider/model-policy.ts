import {
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_DEFAULT_MODEL_ID,
  DEEPSEEK_PRO_MODEL_ID,
  DEEPSEEK_PROVIDER_ID,
  isDeepSeekProvider,
} from "./deepseek-policy"

// Killstata supports built-in DeepSeek, generic OpenAI-compatible endpoints, and
// native Anthropic / Google Generative AI endpoints. Other provider IDs stay blocked.
export const CUSTOM_PROVIDER_ID = "custom"
export const CUSTOM_API_KEY_ENV = "KILLSTATA_CUSTOM_API_KEY"
export const ANTHROPIC_PROVIDER_ID = "anthropic"
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY"
export const GOOGLE_PROVIDER_ID = "google"
export const GOOGLE_API_KEY_ENV = "GOOGLE_GENERATIVE_AI_API_KEY"
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible"
export const ANTHROPIC_NPM = "@ai-sdk/anthropic"
export const GOOGLE_NPM = "@ai-sdk/google"

export function isCustomProvider(providerID: string) {
  return providerID === CUSTOM_PROVIDER_ID
}

export function isAllowedProvider(providerID: string) {
  return isDeepSeekProvider(providerID)
    || isCustomProvider(providerID)
    || providerID === ANTHROPIC_PROVIDER_ID
    || providerID === GOOGLE_PROVIDER_ID
}

export function allowedProvidersMessage(providerID?: string, modelID?: string) {
  const requested = providerID ? ` Requested: ${providerID}${modelID ? `/${modelID}` : ""}.` : ""
  return [
    `Killstata supports "${DEEPSEEK_PROVIDER_ID}" (built in: ${DEEPSEEK_DEFAULT_MODEL_ID}, ${DEEPSEEK_PRO_MODEL_ID}),`,
    `"${CUSTOM_PROVIDER_ID}" (OpenAI-compatible endpoint declared with baseURL and models), "${ANTHROPIC_PROVIDER_ID}" (native Anthropic), and "${GOOGLE_PROVIDER_ID}" (native Gemini).`,
    `Credentials come from ${DEEPSEEK_API_KEY_ENV}, ${CUSTOM_API_KEY_ENV}, ${ANTHROPIC_API_KEY_ENV}, ${GOOGLE_API_KEY_ENV}, or auth.json via /connect.${requested}`,
  ].join(" ")
}

/** 模型名失效时给出可直接行动的中文提示，但不替用户静默切换模型。 */
export function formatModelNotFoundMessage(input: {
  providerID: string
  modelID: string
  suggestions?: string[]
}) {
  const candidates = input.suggestions?.filter(Boolean) ?? []
  const hint = candidates.length
    ? `当前可用模型：${candidates.join("、")}。请检查模型配置或选择其中一个模型。`
    : "请检查模型配置和 Provider 的模型目录。"
  return `找不到模型 ${input.providerID}/${input.modelID}。${hint}`
}
