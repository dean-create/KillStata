import * as prompts from "@clack/prompts"
import { Auth } from "../../auth"
import { Config } from "../../config/config"
import { Instance } from "../../project/instance"
import { buildCustomProviderConfig, normalizeApiKey, normalizeBaseURL } from "../../provider/provider-catalog"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { describeRuntimePythonSource, getRuntimePythonStatus, userConfigPath, writeUserConfigPatch } from "@/killstata/runtime-config"
import { DEEPSEEK_PROVIDER_ID } from "@/provider/deepseek-policy"

type Finding = { level: "ok" | "warn" | "error"; label: string; detail: string }

function configuredModel(config: Awaited<ReturnType<typeof Config.get>>) {
  const model = config.model ?? config.small_model
  if (!model) return
  const slash = model.indexOf("/")
  if (slash <= 0 || slash >= model.length - 1) return
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
}

function logFindings(findings: Finding[]) {
  for (const finding of findings) {
    const line = `${finding.label}: ${finding.detail}`
    if (finding.level === "ok") prompts.log.success(line)
    else if (finding.level === "warn") prompts.log.warn(line)
    else prompts.log.error(line)
  }
}

async function configureProvider(existing: Awaited<ReturnType<typeof Config.get>>) {
  const choice = await prompts.select({
    message: "Choose a model provider",
    options: [
      { label: "DeepSeek", value: "deepseek", hint: "Default; only an API key is needed" },
      { label: "Custom OpenAI-compatible provider", value: "custom", hint: "Advanced setup" },
    ],
    initialValue: configuredModel(existing)?.providerID === "custom" ? "custom" : "deepseek",
  })
  if (prompts.isCancel(choice)) throw new UI.CancelledError()
  if (choice === "deepseek") {
    const key = await prompts.password({
      message: "DeepSeek API key",
      validate: (value) => (normalizeApiKey(value ?? "") ? undefined : "API key is required"),
    })
    if (prompts.isCancel(key)) throw new UI.CancelledError()
    await Auth.set(DEEPSEEK_PROVIDER_ID, { type: "api", key: normalizeApiKey(key) })
    return { providerID: DEEPSEEK_PROVIDER_ID, modelID: "deepseek-chat" }
  }

  const name = await prompts.text({ message: "Provider name", placeholder: "My provider", validate: (value) => (value?.trim() ? undefined : "Required") })
  if (prompts.isCancel(name)) throw new UI.CancelledError()
  const baseURL = await prompts.text({
    message: "Provider base URL",
    placeholder: "https://api.example.com/v1",
    validate: (value) => {
      try {
        const url = new URL(normalizeBaseURL(value ?? ""))
        return /^https?:$/.test(url.protocol) ? undefined : "Use an http or https URL"
      } catch {
        return "Enter a valid URL"
      }
    },
  })
  if (prompts.isCancel(baseURL)) throw new UI.CancelledError()
  const modelID = await prompts.text({ message: "Default model ID", placeholder: "model-name", validate: (value) => (value?.trim() ? undefined : "Required") })
  if (prompts.isCancel(modelID)) throw new UI.CancelledError()
  const key = await prompts.password({ message: `${name.trim()} API key`, validate: (value) => (normalizeApiKey(value ?? "") ? undefined : "API key is required") })
  if (prompts.isCancel(key)) throw new UI.CancelledError()
  await Auth.set("custom", { type: "api", key: normalizeApiKey(key) })
  return {
    providerID: "custom",
    modelID: modelID.trim(),
    providerConfig: buildCustomProviderConfig({ providerID: "custom", providerName: name.trim(), baseURL, modelID: modelID.trim() }),
  }
}

/** Advanced settings; normal first-run setup is handled automatically by the TUI. */
export async function runKillstataConfigWizard() {
  UI.empty()
  prompts.intro("Advanced model settings")
  const provider = await configureProvider(await Config.get())
  await writeUserConfigPatch({ $schema: "https://killstata.io/config.json", model: `${provider.providerID}/${provider.modelID}`, provider: provider.providerConfig })
  prompts.log.success(`Saved advanced settings to ${userConfigPath()}`)
  prompts.outro("Model settings updated")
}

export async function runKillstataConfigDoctor() {
  UI.empty()
  prompts.intro("KillStata diagnostics")
  const findings: Finding[] = []
  const runtime = await getRuntimePythonStatus()
  if (!runtime.ok) findings.push({ level: "warn", label: "Data analysis engine", detail: "It will be prepared automatically the first time you analyze data." })
  else if (runtime.missing.length) findings.push({ level: "warn", label: "Data analysis engine", detail: `Using ${describeRuntimePythonSource(runtime.source)}; missing: ${runtime.missing.join(", ")}. It will be repaired automatically when needed.` })
  else findings.push({ level: "ok", label: "Data analysis engine", detail: `${runtime.version ?? "ready"} (${describeRuntimePythonSource(runtime.source)})` })

  const config = await Config.get()
  const model = configuredModel(config)
  const auth = await Auth.all()
  if (model) {
    const credential = auth[model.providerID]
    findings.push({
      level: credential?.type === "api" ? "ok" : "warn",
      label: "Model credential",
      detail: credential?.type === "api" ? `${model.providerID}/${model.modelID}` : `No saved API key for ${model.providerID}. Run \`killstata config\` only to change advanced model settings.`,
    })
  } else {
    const credential = auth[DEEPSEEK_PROVIDER_ID]
    findings.push({ level: credential?.type === "api" ? "ok" : "warn", label: "Model credential", detail: credential?.type === "api" ? "DeepSeek API key saved" : "No API key saved yet. Start KillStata to add one." })
  }
  findings.push({ level: "ok", label: "Advanced config", detail: userConfigPath() })
  logFindings(findings)
  prompts.outro("Diagnostics complete")
}

const ConfigDoctorCommand = cmd({
  command: "doctor",
  describe: "check the model credential and automatic data-analysis engine",
  async handler() { await Instance.provide({ directory: process.cwd(), fn: runKillstataConfigDoctor }) },
})

export const ConfigCommand = cmd({
  command: "config",
  describe: "advanced model settings (not needed for normal setup)",
  builder: (yargs) => yargs.command(ConfigDoctorCommand),
  async handler() { await Instance.provide({ directory: process.cwd(), fn: runKillstataConfigWizard }) },
})
