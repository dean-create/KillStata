import * as prompts from "@clack/prompts"
import { Auth, type Auth as AuthType } from "@/auth"
import { UI } from "@/cli/ui"
import { ensureRuntimePythonReady } from "@/killstata/runtime-config"
import { DEEPSEEK_API_KEY_ENV, DEEPSEEK_PROVIDER_ID } from "@/provider/deepseek-policy"
import { CUSTOM_API_KEY_ENV, CUSTOM_PROVIDER_ID } from "@/provider/model-policy"

type SupportedAuth = Partial<Record<typeof DEEPSEEK_PROVIDER_ID | typeof CUSTOM_PROVIDER_ID, AuthType.Info | undefined>>
const SUPPORTED_PROVIDER_IDS = [DEEPSEEK_PROVIDER_ID, CUSTOM_PROVIDER_ID] as const

export function hasFirstRunCredential(input: {
  deepSeekApiKey?: string
  customApiKey?: string
  auth: SupportedAuth
}) {
  if (input.deepSeekApiKey?.trim() || input.customApiKey?.trim()) return true

  return SUPPORTED_PROVIDER_IDS.some((providerID) => {
    const credential = input.auth[providerID]
    return credential?.type === "api" && credential.key.trim().length > 0
  })
}

async function hasExistingCredential() {
  const auth = await Auth.all()
  return hasFirstRunCredential({
    deepSeekApiKey: process.env[DEEPSEEK_API_KEY_ENV],
    customApiKey: process.env[CUSTOM_API_KEY_ENV],
    auth,
  })
}

/**
 * The default product path only needs a model credential. Python, MCP, skills,
 * and filesystem locations are managed later or through advanced settings.
 */
export async function ensureFirstRunOnboarding() {
  if (await hasExistingCredential()) return false

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`KillStata needs a DeepSeek API key. Set ${DEEPSEEK_API_KEY_ENV} and run KillStata again.`)
  }

  prompts.intro("Welcome to KillStata")
  prompts.log.message("Enter your DeepSeek API key to start. You can change providers later in advanced settings.")

  const key = await prompts.password({
    message: "DeepSeek API key",
    validate: (value) => (value?.trim() ? undefined : "API key is required"),
  })
  if (prompts.isCancel(key)) throw new UI.CancelledError()

  await Auth.set(DEEPSEEK_PROVIDER_ID, {
    type: "api",
    key,
  })

  prompts.outro("Ready. Starting KillStata…")
  return true
}

export async function prepareFirstRunAnalysisRuntime() {
  const spinner = prompts.spinner()
  spinner.start("Preparing data analysis tools")
  try {
    const status = await ensureRuntimePythonReady()
    if (!status.ok || status.missing.length > 0) throw new Error(status.error ?? "Analysis tools are incomplete.")
    spinner.stop("Data analysis tools are ready")
    return true
  } catch {
    spinner.stop("Data analysis tools will finish preparing when you first analyze data", 1)
    return false
  }
}
