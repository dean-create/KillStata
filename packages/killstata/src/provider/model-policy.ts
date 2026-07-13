import { DEEPSEEK_API_KEY_ENV, DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_PRO_MODEL_ID, DEEPSEEK_PROVIDER_ID, isDeepSeekProvider } from "./deepseek-policy"

// Killstata ships exactly two providers:
//   - deepseek: built in, always available, the default.
//   - custom:   an OpenAI-compatible endpoint the user declares in killstata.json
//               (baseURL + models). This is the escape hatch for Qwen / Kimi / GLM /
//               a local vLLM, without dragging every vendor SDK back into the bundle.
export const CUSTOM_PROVIDER_ID = "custom"
export const CUSTOM_API_KEY_ENV = "KILLSTATA_CUSTOM_API_KEY"
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible"

export function isCustomProvider(providerID: string) {
  return providerID === CUSTOM_PROVIDER_ID
}

export function isAllowedProvider(providerID: string) {
  return isDeepSeekProvider(providerID) || isCustomProvider(providerID)
}

export function allowedProvidersMessage(providerID?: string, modelID?: string) {
  const requested = providerID ? ` Requested: ${providerID}${modelID ? `/${modelID}` : ""}.` : ""
  return [
    `Killstata supports two providers: "${DEEPSEEK_PROVIDER_ID}" (built in: ${DEEPSEEK_DEFAULT_MODEL_ID}, ${DEEPSEEK_PRO_MODEL_ID})`,
    `and "${CUSTOM_PROVIDER_ID}" (any OpenAI-compatible endpoint you declare in killstata.json with provider.custom.options.baseURL and provider.custom.models).`,
    `Credentials come from ${DEEPSEEK_API_KEY_ENV} / ${CUSTOM_API_KEY_ENV} or from auth.json via /connect.${requested}`,
  ].join(" ")
}
