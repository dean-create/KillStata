import * as prompts from "@clack/prompts"
import fs from "fs"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { Instance } from "../../project/instance"
import { Auth } from "../../auth"
import { Config } from "../../config/config"
import { ModelsDev } from "../../provider/models"
import {
  buildCustomProviderConfig,
  isUserSelectableProvider,
  normalizeApiKey,
  normalizeBaseURL,
  normalizeProviderID,
  providerDisplayDescription,
  providerDisplayName,
  providerDisplayNote,
  supportsApiKeyProvider,
} from "../../provider/provider-catalog"
import { ensureSkillDirectories, userSkillsRoot } from "../../skill"
import { createBuiltInStataMcpConfig, StataEdition } from "../../mcp/stata"
import {
  checkPythonPackages,
  describeRuntimePythonSource,
  detectStataCandidates,
  ensureKillstataHomeDirectories,
  getRuntimePythonStatus,
  inferStataEdition,
  installPythonPackages,
  managedPythonExecutable,
  managedPythonVenvRoot,
  preferredLocalPythonExecutable,
  probePythonExecutable,
  probeStataPath,
  REQUIRED_PYTHON_PACKAGES,
  resolveConfiguredPythonExecutable,
  runtimePaths,
  shortenHomePath,
  userConfigPath,
  userDownloadsRoot,
  userLogsRoot,
  userMainAgentSessionsRoot,
  userMainAgentStateRoot,
  userMemoryRoot,
  userSkillRoot,
  userStateRoot,
  userSubagentRunsPath,
  userSubagentsRoot,
  userTmpRoot,
  userWorkspaceRoot,
  writeUserConfigPatch,
} from "@/killstata/runtime-config"

type Finding = {
  level: "ok" | "warn" | "error"
  label: string
  detail: string
}

type ProviderSetup = {
  providerID: string
  providerName: string
  modelID: string
  modelName: string
  usedExistingKey: boolean
  providerConfig?: NonNullable<Config.Info["provider"]>
}

type ApiKeyValidationResult = {
  discoveredModelIDs: string[]
  validated: boolean
}

const REQUIRED_PYTHON_PACKAGES_TEXT = REQUIRED_PYTHON_PACKAGES.join(", ")
const providerNameCollator = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true,
})

function providerDisplaySortKey(provider: ModelsDev.Provider) {
  return providerDisplayName(provider)
    .replace(/\s+\((china|cn)\)$/i, "")
    .replace(/^(the)\s+/i, "")
    .trim()
}

function parseConfiguredModel(model?: string) {
  if (!model) return
  const slash = model.indexOf("/")
  if (slash <= 0 || slash >= model.length - 1) return
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  }
}

function projectRoot() {
  return Instance.project.vcs ? Instance.worktree : Instance.directory
}

function joinApiPath(baseURL: string, pathname: string) {
  return `${normalizeBaseURL(baseURL)}${pathname.startsWith("/") ? pathname : `/${pathname}`}`
}

function sanitizeValidationDetail(detail: string, status?: number) {
  const htmlTitle = detail.match(/<title[^>]*>(.*?)<\/title>/is)?.[1]
  const htmlHeading = detail.match(/<h1[^>]*>(.*?)<\/h1>/is)?.[1]
  const candidate = htmlTitle || htmlHeading || detail
  const stripped = candidate
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
  return stripped || (status ? `${status} error` : "Unknown provider response")
}

function normalizeValidationError(providerName: string, detail: string, status?: number) {
  const clean = sanitizeValidationDetail(detail, status)
  const lowered = clean.toLowerCase()
  if (
    lowered.includes("incorrect api key provided") ||
    lowered.includes("apikeyerror") ||
    lowered.includes("invalid_api_key") ||
    lowered.includes("invalid api key") ||
    lowered.includes("unauthorized") ||
    lowered.includes("authentication") ||
    status === 401 ||
    status === 403
  ) {
    return `${providerName} API key is invalid or not active. Paste the full API key and try again.`
  }

  if (status === 404 || lowered.includes("404 not found")) {
    return `${providerName} API key validation endpoint returned 404 Not Found. This usually means the selected provider endpoint does not support /models verification, or the region/base URL is wrong. Check the provider region and try again.`
  }

  return `${providerName} API key validation failed: ${clean}`
}

function supportsModelsEndpointValidation(provider: ModelsDev.Provider) {
  const id = provider.id.toLowerCase()
  if (id === "minimax" || id === "minimax-cn" || id.startsWith("minimax-")) return false
  return true
}

async function validateApiKeyWithModelsEndpoint(input: {
  providerName: string
  url: string
  headers: Record<string, string>
  parseModels: (payload: any) => string[]
}) {
  const response = await fetch(input.url, {
    method: "GET",
    headers: input.headers,
    signal: AbortSignal.timeout(15_000),
  })

  const raw = await response.text()
  let payload: any = undefined
  try {
    payload = raw ? JSON.parse(raw) : undefined
  } catch {
    payload = undefined
  }

  if (!response.ok) {
    const detail =
      payload?.error?.message ||
      payload?.message ||
      payload?.error ||
      raw ||
      `${response.status} ${response.statusText}`
    throw new Error(normalizeValidationError(input.providerName, String(detail), response.status))
  }

  return input.parseModels(payload)
}

async function validateProviderApiKey(input: {
  provider: ModelsDev.Provider
  apiKey: string
  baseURL?: string
}): Promise<ApiKeyValidationResult> {
  const baseURL = input.baseURL || input.provider.api
  const providerName = providerDisplayName(input.provider)

  if (input.provider.id === "google") {
    const models = await validateApiKeyWithModelsEndpoint({
      providerName,
      url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(input.apiKey)}`,
      headers: {},
      parseModels: (payload) =>
        (payload?.models ?? [])
          .map((item: { name?: string }) => item.name?.replace(/^models\//, "").trim())
          .filter((item: string | undefined): item is string => !!item),
    })
    return { validated: true, discoveredModelIDs: models }
  }

  if ((input.provider.npm ?? "").includes("@ai-sdk/anthropic")) {
    if (!supportsModelsEndpointValidation(input.provider)) return { validated: false, discoveredModelIDs: [] }
    if (!baseURL) return { validated: false, discoveredModelIDs: [] }
    const models = await validateApiKeyWithModelsEndpoint({
      providerName,
      url: joinApiPath(baseURL, "/models"),
      headers: {
        "x-api-key": input.apiKey,
        "anthropic-version": "2023-06-01",
      },
      parseModels: (payload) =>
        (payload?.data ?? [])
          .map((item: { id?: string }) => item.id?.trim())
          .filter((item: string | undefined): item is string => !!item),
    })
    return { validated: true, discoveredModelIDs: models }
  }

  if (baseURL && (input.provider.npm ?? "").includes("@ai-sdk/openai-compatible")) {
    const models = await validateApiKeyWithModelsEndpoint({
      providerName,
      url: joinApiPath(baseURL, "/models"),
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
      },
      parseModels: (payload) =>
        (payload?.data ?? [])
          .map((item: { id?: string }) => item.id?.trim())
          .filter((item: string | undefined): item is string => !!item),
    })
    return { validated: true, discoveredModelIDs: models }
  }

  if (input.provider.id === "openai") {
    const models = await validateApiKeyWithModelsEndpoint({
      providerName,
      url: "https://api.openai.com/v1/models",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
      },
      parseModels: (payload) =>
        (payload?.data ?? [])
          .map((item: { id?: string }) => item.id?.trim())
          .filter((item: string | undefined): item is string => !!item),
    })
    return { validated: true, discoveredModelIDs: models }
  }

  if (input.provider.id === "anthropic") {
    const models = await validateApiKeyWithModelsEndpoint({
      providerName,
      url: "https://api.anthropic.com/v1/models",
      headers: {
        "x-api-key": input.apiKey,
        "anthropic-version": "2023-06-01",
      },
      parseModels: (payload) =>
        (payload?.data ?? [])
          .map((item: { id?: string }) => item.id?.trim())
          .filter((item: string | undefined): item is string => !!item),
    })
    return { validated: true, discoveredModelIDs: models }
  }

  return { validated: false, discoveredModelIDs: [] }
}

async function promptAndValidateApiKey(input: {
  provider: ModelsDev.Provider
  existingAuth?: Awaited<ReturnType<typeof Auth.get>>
  baseURL?: string
}): Promise<{ key: string; usedExistingKey: boolean; discoveredModelIDs: string[] }> {
  if (input.existingAuth?.type === "api") {
    const keepExisting = await prompts.confirm({
      message: `Use the existing ${providerDisplayName(input.provider)} API key and validate it now?`,
      initialValue: true,
    })
    if (prompts.isCancel(keepExisting)) throw new UI.CancelledError()
    if (keepExisting) {
      try {
        const result = await validateProviderApiKey({
          provider: input.provider,
          apiKey: input.existingAuth.key,
          baseURL: input.baseURL,
        })
        prompts.log.success(`${providerDisplayName(input.provider)} API key verified.`)
        return {
          key: input.existingAuth.key,
          usedExistingKey: true,
          discoveredModelIDs: result.discoveredModelIDs,
        }
      } catch (error) {
        prompts.log.warn(error instanceof Error ? error.message : String(error))
        prompts.log.warn(`The saved ${providerDisplayName(input.provider)} API key did not verify. Please paste a new one.`)
      }
    }
  }

  while (true) {
    const key = await prompts.password({
      message: `Paste your ${providerDisplayName(input.provider)} API key`,
      validate: (value) => (normalizeApiKey(value ?? "").length > 0 ? undefined : "Required"),
    })
    if (prompts.isCancel(key)) throw new UI.CancelledError()

    const normalizedKey = normalizeApiKey(key)
    try {
      const result = await validateProviderApiKey({
        provider: input.provider,
        apiKey: normalizedKey,
        baseURL: input.baseURL,
      })
      if (result.validated) {
        prompts.log.success(`${providerDisplayName(input.provider)} API key verified.`)
      } else {
        prompts.log.warn(
          `${providerDisplayName(input.provider)} API key was saved, but this provider does not support pre-model verification yet.`,
        )
      }
      return {
        key: normalizedKey,
        usedExistingKey: false,
        discoveredModelIDs: result.discoveredModelIDs,
      }
    } catch (error) {
      prompts.log.error(error instanceof Error ? error.message : String(error))
      prompts.log.warn("Try again with a valid API key.")
    }
  }
}

function resolveModelChoices(provider: ModelsDev.Provider, discoveredModelIDs: string[]) {
  const knownModels = Object.values(provider.models)
    .filter((model) => model.status !== "deprecated")
    .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))

  if (discoveredModelIDs.length === 0) {
    return knownModels.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
    }))
  }

  const unique = Array.from(new Set(discoveredModelIDs))
  return unique
    .map((modelID) => {
      const known = provider.models[modelID]
      return {
        id: modelID,
        name: known?.name ?? modelID,
      }
    })
    .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
}

function logFindings(findings: Finding[]) {
  for (const item of findings) {
    const line = `${item.label}: ${item.detail}`
    if (item.level === "ok") {
      prompts.log.success(line)
      continue
    }
    if (item.level === "warn") {
      prompts.log.warn(line)
      continue
    }
    prompts.log.error(line)
  }
}

function printPathSummary() {
  const paths = runtimePaths(projectRoot())

  prompts.log.info("User-level files live under ~/.killstata")
  prompts.log.info(`  config: ${paths.user.config}`)
  prompts.log.info(`  workspace: ${paths.user.workspace}`)
  prompts.log.info(`  managed econometrics venv: ${paths.user.managedPythonVenv}`)
  prompts.log.info(`  managed Stata MCP home: ${paths.user.stataMcpRoot}`)
  prompts.log.info(`  skills: ${paths.user.skillRoot}`)
  prompts.log.info(`  agents: ${paths.user.agents}`)
  prompts.log.info(`  main agent state: ${paths.user.mainAgentState}`)
  prompts.log.info(`  main agent sessions: ${paths.user.mainAgentSessions}`)
  prompts.log.info(`  subagents: ${paths.user.subagents}`)
  prompts.log.info(`  subagent index: ${paths.user.subagentRuns}`)
  prompts.log.info(`  logs: ${paths.user.logs}`)
  prompts.log.info(`  memory: ${paths.user.memory}`)
  prompts.log.info(`  tmp: ${paths.user.tmp}`)
  prompts.log.info(`  state: ${paths.user.state}`)
  prompts.log.info(`  downloads: ${paths.user.downloads}`)
  prompts.log.info(`  global config file: ${paths.user.config}`)
  prompts.log.info(`  legacy skills root: ${paths.user.legacySkillRoot}`)

  prompts.log.info("Runtime compatibility state lives under XDG/AppData killstata")
  prompts.log.info(`  config: ${paths.xdg.config}`)
  prompts.log.info(`  data: ${paths.xdg.data}`)
  prompts.log.info(`  storage: ${paths.xdg.storage}`)
  prompts.log.info(`  snapshot: ${paths.xdg.snapshot}`)
  prompts.log.info(`  cache: ${paths.xdg.cache}`)
  prompts.log.info(`  state: ${paths.xdg.state}`)
  prompts.log.info(`  log: ${paths.xdg.log}`)
  prompts.log.info(`  auth: ${paths.xdg.auth}`)
  prompts.log.info(`  mcp auth: ${paths.xdg.mcpAuth}`)

  prompts.log.info("Project-level analysis data stays in the current project")
  prompts.log.info(`  internal state: ${paths.project.internal}`)
  prompts.log.info(`  visible outputs: ${paths.project.outputs}`)
  prompts.log.info(`  project override config: ${paths.project.projectConfig}`)
}

async function promptPythonPath(input: { current?: string; recommended?: string }) {
  const discovered = input.current ? probePythonExecutable(input.current) : undefined
  const recommended = input.recommended ? probePythonExecutable(input.recommended) : undefined
  const options = []
  const sameResolvedPython = discovered?.ok && recommended?.ok && discovered.resolved === recommended.resolved

  if (recommended?.ok) {
    options.push({
      label: `Use recommended Python (${recommended.version ?? recommended.resolved})`,
      value: "recommended",
      hint: recommended.resolved,
    })
  }

  if (discovered?.ok && discovered.resolved !== recommended?.resolved) {
    options.push({
      label: `Use detected Python (${discovered.version ?? discovered.resolved})`,
      value: "detected",
      hint: discovered.resolved,
    })
  }

  options.push({
    label: "Enter a custom Python path",
    value: "custom",
    hint: "Use this if Python is installed but not on PATH",
  })
  options.push({
    label: "Skip Python setup for now",
    value: "skip",
    hint: "Data and econometrics features require Python plus the required packages",
  })

  const choice = await prompts.select({
    message: "Configure Python for data processing and econometrics?",
    options,
    initialValue: recommended?.ok ? "recommended" : discovered?.ok && !sameResolvedPython ? "detected" : "custom",
  })
  if (prompts.isCancel(choice)) throw new UI.CancelledError()

  if (choice === "skip") return undefined
  if (choice === "recommended" && recommended?.ok) return recommended.resolved
  if (choice === "detected" && discovered?.ok) return discovered.resolved

  const custom = await prompts.text({
    message: "Enter a Python executable path",
    placeholder:
      input.current && !discovered?.ok
        ? input.current
        : process.platform === "win32"
          ? "C:\\Python311\\python.exe"
          : "/usr/bin/python3",
    validate: (value) => {
      if (!value?.trim()) return undefined
      const probe = probePythonExecutable(value.trim())
      return probe.ok ? undefined : `Unable to run Python: ${probe.error ?? "unknown error"}`
    },
  })
  if (prompts.isCancel(custom)) throw new UI.CancelledError()
  return custom.trim() || undefined
}

async function configurePython(existing: Awaited<ReturnType<typeof Config.get>>) {
  const configured = existing.killstata?.python?.executable?.trim()
  const recommended = preferredLocalPythonExecutable()
  const fallback = configured || recommended || (await resolveConfiguredPythonExecutable())
  const selected = await promptPythonPath({
    current: fallback,
    recommended: configured ? undefined : recommended,
  })

  if (!selected) {
    prompts.log.warn("Python setup skipped.")
    prompts.log.warn("Python is required for data import, cleaning, and econometric analysis in Killstata.")
    prompts.log.warn(`Required Python packages: ${REQUIRED_PYTHON_PACKAGES_TEXT}`)
    prompts.log.warn("Install Python 3.9+ and rerun `killstata config` before using those features.")
    return undefined
  }

  const probe = probePythonExecutable(selected)
  if (!probe.ok) {
    prompts.log.error(`Python probe failed: ${probe.error ?? selected}`)
    return undefined
  }

  prompts.log.success(`Python ready: ${probe.version ?? "detected"} at ${probe.resolved}`)
  if (recommended && probe.resolved === recommended) {
    prompts.log.info("Using recommended local trae_agent Python environment.")
  }

  let packageReport
  try {
    packageReport = checkPythonPackages(probe.resolved)
  } catch (error) {
    prompts.log.warn(`Could not inspect Python packages with ${probe.resolved}: ${error instanceof Error ? error.message : String(error)}`)
    return {
      executable: probe.resolved,
      managed: false,
    }
  }

  if (packageReport.missing.length === 0) {
    prompts.log.success(`Required Python packages are already available in ${probe.resolved}`)
    return {
      executable: probe.resolved,
      managed: false,
    }
  }

  prompts.log.warn(`Missing Python packages: ${packageReport.missing.join(", ")}`)
  const installIntoSelected = await prompts.confirm({
    message: `Install the required packages into ${probe.resolved}?`,
    initialValue: true,
  })
  if (prompts.isCancel(installIntoSelected)) throw new UI.CancelledError()

  if (!installIntoSelected) {
    prompts.log.warn(`Leaving Python configured without installing dependencies. Econometrics may fail until ${packageReport.missing.join(", ")} are installed.`)
    return {
      executable: probe.resolved,
      managed: probe.resolved === managedPythonExecutable(),
    }
  }

  const spinner = prompts.spinner()
  spinner.start(`Installing required Python packages into ${probe.resolved}`)
  try {
    installPythonPackages(probe.resolved, [...REQUIRED_PYTHON_PACKAGES])
    spinner.stop(`Python packages installed into ${probe.resolved}`)
    return {
      executable: probe.resolved,
      managed: probe.resolved === managedPythonExecutable(),
    }
  } catch (error) {
    spinner.stop("Python package installation failed", 1)
    throw error
  }
}

async function promptStataPath(existingPath?: string) {
  const candidates = Array.from(new Set([...(existingPath ? [existingPath] : []), ...detectStataCandidates()]))
  const options = candidates.map((candidate) => ({
    label: candidate,
    value: candidate,
    hint: probeStataPath(candidate).exists ? "detected" : "configured",
  }))

  options.push({
    label: "Enter a custom Stata path",
    value: "__custom__",
    hint: "Directory or executable path",
  })
  options.push({
    label: "Skip Stata setup for now",
    value: "__skip__",
    hint: "Stata is optional",
  })

  const selected = await prompts.select({
    message: "Configure Stata and the built-in Stata MCP now?",
    options,
    initialValue: candidates[0] ?? "__custom__",
  })
  if (prompts.isCancel(selected)) throw new UI.CancelledError()
  if (selected === "__skip__") return undefined
  if (selected !== "__custom__") return selected

  const custom = await prompts.text({
    message: "Enter the Stata installation directory or executable path",
    placeholder: process.platform === "win32" ? "D:\\stata17" : undefined,
    validate: (value) => {
      if (!value?.trim()) return undefined
      try {
        const probe = probeStataPath(value.trim())
        return probe.exists ? undefined : `Path does not exist: ${probe.normalized}`
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
  })
  if (prompts.isCancel(custom)) throw new UI.CancelledError()
  return custom.trim() || undefined
}

async function configureStata(existing: Awaited<ReturnType<typeof Config.get>>) {
  const shouldConfigure = await prompts.confirm({
    message: "Configure Stata now?",
    initialValue: !!existing.killstata?.stata?.path || detectStataCandidates().length > 0,
  })
  if (prompts.isCancel(shouldConfigure)) throw new UI.CancelledError()
  if (!shouldConfigure) {
    prompts.log.warn("Stata setup skipped. You can still use non-Stata features.")
    return undefined
  }

  const selected = await promptStataPath(existing.killstata?.stata?.path)
  if (!selected) return undefined

  const probe = probeStataPath(selected)
  if (!probe.exists) {
    prompts.log.error(`Stata path not found: ${probe.normalized}`)
    return undefined
  }

  const edition = await prompts.select({
    message: "Select the Stata edition",
    options: [
      { label: "MP", value: "mp", hint: "Recommended default" },
      { label: "SE", value: "se", hint: "Standard Edition" },
      { label: "BE", value: "be", hint: "Basic Edition" },
    ],
    initialValue: existing.killstata?.stata?.edition ?? inferStataEdition(probe.normalized) ?? "mp",
  })
  if (prompts.isCancel(edition)) throw new UI.CancelledError()

  const parsedEdition = StataEdition.parse(edition)
  prompts.log.success(`Stata configured at ${probe.normalized} (${parsedEdition.toUpperCase()})`)

  return {
    path: probe.normalized,
    edition: parsedEdition,
    mcp: createBuiltInStataMcpConfig(probe.normalized, parsedEdition),
  }
}

async function configureWorkspace(existing: Awaited<ReturnType<typeof Config.get>>) {
  const enabled = await prompts.confirm({
    message: "Enable the global ~/.killstata/workspace for non-project code generation and scratch files?",
    initialValue: existing.killstata?.workspace?.enabled ?? true,
  })
  if (prompts.isCancel(enabled)) throw new UI.CancelledError()

  if (!enabled) {
    prompts.log.warn("Global user workspace disabled. Project-local outputs remain unchanged.")
    return {
      enabled: false,
      root: userWorkspaceRoot(),
    }
  }

  prompts.log.success(`Global workspace enabled at ${userWorkspaceRoot()}`)
  return {
    enabled: true,
    root: userWorkspaceRoot(),
  }
}

async function configureModelProvider(existing: Awaited<ReturnType<typeof Config.get>>) {
  await ModelsDev.refresh().catch(() => {})
  const configured = parseConfiguredModel(existing.model ?? existing.small_model)
  const enabled = existing.enabled_providers ? new Set(existing.enabled_providers) : undefined
  const disabled = new Set(existing.disabled_providers ?? [])
  const providerMap = await ModelsDev.get()
  const providers: ModelsDev.Provider[] = Object.values(providerMap)
    .filter((provider) => (enabled ? enabled.has(provider.id) : true) && !disabled.has(provider.id))
    .filter((provider) => provider.id !== "killstata")
    .filter((provider) => isUserSelectableProvider(provider))
    .filter((provider) => supportsApiKeyProvider(provider))
    .sort((a, b) => {
      return providerNameCollator.compare(providerDisplaySortKey(a), providerDisplaySortKey(b))
    })

  if (providers.length === 0) {
    prompts.log.warn("No API-key providers are available right now. Skipping model setup.")
    return undefined
  }

  const shouldConfigure = await prompts.confirm({
    message: "Configure a model provider now? You will choose a provider, a default model, and an API key.",
    initialValue: true,
  })
  if (prompts.isCancel(shouldConfigure)) throw new UI.CancelledError()
  if (!shouldConfigure) {
    prompts.log.warn("Model provider setup skipped. You can rerun `killstata config` later.")
    return undefined
  }

  const providerID = await prompts.select({
    message: "Choose your model provider (A-Z order)",
    options: [
      ...providers.map((provider) => ({
        label: providerDisplayName(provider),
        value: provider.id,
        hint: providerDisplayDescription(provider),
      })),
      {
        label: "Custom OpenAI-compatible provider",
        value: "__custom__",
        hint: "Use this for any API-key vendor not listed above",
      },
    ],
    initialValue: configured?.providerID && providers.some((provider) => provider.id === configured.providerID) ? configured.providerID : providers[0]!.id,
  })
  if (prompts.isCancel(providerID)) throw new UI.CancelledError()

  if (providerID === "__custom__") {
    const providerName = await prompts.text({
      message: "Name this provider",
      placeholder: "My Provider",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    })
    if (prompts.isCancel(providerName)) throw new UI.CancelledError()

    const providerSlug = normalizeProviderID(providerName)
    const customProviderID = await prompts.text({
      message: "Provider id",
      placeholder: providerSlug || "my-provider",
      initialValue: providerSlug || undefined,
      validate: (value) => (normalizeProviderID(value ?? "") ? undefined : "a-z, 0-9 and hyphens only"),
    })
    if (prompts.isCancel(customProviderID)) throw new UI.CancelledError()

    const baseURL = await prompts.text({
      message: "Provider base URL",
      placeholder: "https://api.example.com/v1",
      validate: (value) => {
        try {
          const url = new URL(normalizeBaseURL(value ?? ""))
          return /^https?:$/.test(url.protocol) ? undefined : "Use http or https"
        } catch {
          return "Enter a valid URL"
        }
      },
    })
    if (prompts.isCancel(baseURL)) throw new UI.CancelledError()

    const normalizedProviderID = normalizeProviderID(customProviderID)
    const customProvider: ModelsDev.Provider = {
      id: normalizedProviderID,
      name: providerName.trim(),
      env: [],
      api: normalizeBaseURL(baseURL),
      npm: "@ai-sdk/openai-compatible",
      models: {},
    }
    const validated = await promptAndValidateApiKey({
      provider: customProvider,
      existingAuth: await Auth.get(normalizedProviderID),
      baseURL,
    })
    await Auth.set(normalizedProviderID, {
      type: "api",
      key: validated.key,
    })
    prompts.log.success(`${providerName.trim()} API key saved.`)

    const modelChoices = resolveModelChoices(customProvider, validated.discoveredModelIDs)
    let modelID: string

    if (modelChoices.length > 0) {
      const selectedModelID = await prompts.select({
        message: `Choose the default model for ${providerName.trim()}`,
        options: modelChoices.map((model) => ({
          label: model.name,
          value: model.id,
          hint: model.id,
        })),
        initialValue: modelChoices[0]!.id,
      })
      if (prompts.isCancel(selectedModelID)) throw new UI.CancelledError()
      modelID = selectedModelID
    } else {
      const enteredModelID = await prompts.text({
        message: "Default model id",
        placeholder: "gpt-4.1-mini",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      })
      if (prompts.isCancel(enteredModelID)) throw new UI.CancelledError()
      modelID = enteredModelID.trim()
    }

    return {
      providerID: normalizedProviderID,
      providerName: providerName.trim(),
      modelID,
      modelName: modelChoices.find((item) => item.id === modelID)?.name ?? modelID,
      usedExistingKey: validated.usedExistingKey,
      providerConfig: buildCustomProviderConfig({
        providerID: normalizedProviderID,
        providerName: providerName.trim(),
        baseURL,
        modelID,
      }),
    } satisfies ProviderSetup
  }

  const provider = providers.find((item) => item.id === providerID)!
  prompts.log.info(`${providerDisplayName(provider)} in this build uses API key authentication only.`)
  const providerNote = providerDisplayNote(provider)
  if (providerNote) prompts.log.info(providerNote)
  if (provider.env?.length) {
    prompts.log.info(`You can also set ${provider.env.join(" or ")} in your environment.`)
  }

  const validated = await promptAndValidateApiKey({
    provider,
    existingAuth: await Auth.get(provider.id),
  })
  await Auth.set(provider.id, {
    type: "api",
    key: validated.key,
  })
  prompts.log.success(`${providerDisplayName(provider)} API key saved.`)

  const models = resolveModelChoices(provider, validated.discoveredModelIDs)
  if (models.length === 0) {
    prompts.log.warn(`No visible models are available for ${providerDisplayName(provider)}. Skipping model setup.`)
    return undefined
  }

  const modelID = await prompts.select({
    message: `Choose the default model for ${providerDisplayName(provider)}`,
    options: models.map((model) => ({
      label: model.name,
      value: model.id,
      hint: model.id,
    })),
    initialValue:
      configured?.providerID === provider.id && models.some((model) => model.id === configured.modelID)
        ? configured.modelID
        : models[0]!.id,
  })
  if (prompts.isCancel(modelID)) throw new UI.CancelledError()

  const model = models.find((item) => item.id === modelID)!

  prompts.log.success(`Default model set to ${providerDisplayName(provider)} / ${model.name ?? model.id}`)
  return {
    providerID: provider.id,
    providerName: providerDisplayName(provider),
    modelID: model.id,
    modelName: model.name ?? model.id,
    usedExistingKey: validated.usedExistingKey,
  } satisfies ProviderSetup
}

function printFinalSummary(input: {
  python?: {
    executable: string
    managed: boolean
  }
  workspace: {
    enabled: boolean
    root: string
  }
  stata?: {
    path: string
    edition: "mp" | "se" | "be"
  }
  provider?: ProviderSetup
}) {
  prompts.log.success(`User config written to ${userConfigPath()}`)
  prompts.log.info(`Skill directory ready: ${userSkillsRoot()}`)
  prompts.log.info(`Global workspace: ${input.workspace.enabled ? input.workspace.root : "disabled"}`)
  prompts.log.info(`Agent state root: ${userMainAgentStateRoot()}`)
  prompts.log.info(`Agent sessions root: ${userMainAgentSessionsRoot()}`)
  prompts.log.info(`Subagent index: ${userSubagentRunsPath()}`)

  if (input.provider) {
    prompts.log.info(`Model provider: ${input.provider.providerName}`)
    prompts.log.info(`Default model: ${input.provider.providerID}/${input.provider.modelID}`)
    prompts.log.info(`API key: ${input.provider.usedExistingKey ? "kept existing credential" : "saved during setup"}`)
  } else {
    prompts.log.warn("Model provider: not configured")
  }

  if (input.python) {
    prompts.log.info(
      `Python: ${input.python.executable}${input.python.managed ? ` (managed env at ${shortenHomePath(managedPythonVenvRoot())})` : ""}`,
    )
  } else {
    prompts.log.warn(`Python: not configured (required for data/econometrics; packages needed: ${REQUIRED_PYTHON_PACKAGES_TEXT})`)
  }

  if (input.stata) {
    prompts.log.info(`Stata: ${input.stata.path} (${input.stata.edition.toUpperCase()})`)
    prompts.log.info("Built-in Stata MCP: configured as mcp.stata")
  } else {
    prompts.log.warn("Stata: not configured (optional)")
  }
}

export async function runKillstataConfigWizard(input?: { intro?: string }) {
  UI.empty()
  prompts.intro(input?.intro ?? "killstata config")
  await ensureKillstataHomeDirectories()
  await ensureSkillDirectories()
  printPathSummary()

  const existing = await Config.get()
  const paths = runtimePaths(projectRoot())
  const workspace = await configureWorkspace(existing)
  const provider = await configureModelProvider(existing)
  const python = await configurePython(existing)
  const stata = await configureStata(existing)

  const patch: Config.Info = {
    $schema: "https://killstata.io/config.json",
    ...(provider
      ? {
          model: `${provider.providerID}/${provider.modelID}`,
          provider: provider.providerConfig,
        }
      : {}),
    killstata: {
      home: {
        root: paths.user.root,
      },
      workspace: {
        enabled: workspace.enabled,
        root: workspace.root,
      },
      skills: {
        root: userSkillRoot(),
      },
      agents: {
        root: paths.user.agents,
        main: {
          root: paths.user.mainAgentRoot,
          stateRoot: userMainAgentStateRoot(),
          sessionsRoot: userMainAgentSessionsRoot(),
        },
        subagents: {
          root: userSubagentsRoot(),
          runsPath: userSubagentRunsPath(),
        },
      },
      logs: {
        root: userLogsRoot(),
      },
      memory: {
        root: userMemoryRoot(),
      },
      tmp: {
        root: userTmpRoot(),
      },
      state: {
        root: userStateRoot(),
      },
      downloads: {
        root: userDownloadsRoot(),
      },
    },
  }

  if (python) {
    patch.killstata!.python = {
      executable: python.executable,
      managed: python.managed,
    }
  }
  if (stata) {
    patch.killstata!.stata = {
      path: stata.path,
      edition: stata.edition,
    }
    patch.mcp = {
      stata: stata.mcp,
    }
  }

  await writeUserConfigPatch(patch)
  printFinalSummary({
    provider,
    python,
    workspace,
    stata: stata
      ? {
          path: stata.path,
          edition: stata.edition,
        }
      : undefined,
  })
  prompts.outro("Configuration complete")
}

export async function runKillstataConfigDoctor() {
  UI.empty()
  prompts.intro("killstata config doctor")

  const config = await Config.get()
  const findings: Finding[] = []
  const paths = runtimePaths(projectRoot())
  const providers: Record<string, ModelsDev.Provider> = await ModelsDev.get().catch(() => ({}))
  const configuredModel = parseConfiguredModel(config.model ?? config.small_model)

  const pythonStatus = await getRuntimePythonStatus()
  if (!pythonStatus.ok && !pythonStatus.version && pythonStatus.source === "default") {
    findings.push({
      level: "warn",
      label: "Python",
      detail: "Not configured and not found on PATH. Install Python 3.9+ or rerun `killstata config`.",
    })
  } else {
    if (!pythonStatus.ok) {
      findings.push({
        level: "error",
        label: "Python",
        detail: `Selected ${pythonStatus.executable} from ${describeRuntimePythonSource(pythonStatus.source)} but probe failed: ${pythonStatus.error ?? "unknown error"}`,
      })
    } else {
      findings.push({
        level: "ok",
        label: "Python",
        detail: `${pythonStatus.version ?? "detected"} at ${pythonStatus.executable} (${describeRuntimePythonSource(pythonStatus.source)})`,
      })
    }

    if (pythonStatus.ok) {
      if (pythonStatus.missing.length === 0) {
        findings.push({
          level: "ok",
          label: "Python packages",
          detail: "All required econometrics packages are installed.",
        })
      } else {
        findings.push({
          level: "warn",
          label: "Python packages",
          detail: `Missing packages: ${pythonStatus.missing.join(", ")}. Install with: ${pythonStatus.installCommand}`,
        })
      }
    }
  }

  const stataPath = config.killstata?.stata?.path
  if (!stataPath) {
    findings.push({
      level: "warn",
      label: "Stata",
      detail: "Not configured. Stata MCP remains optional.",
    })
  } else {
    const probe = probeStataPath(stataPath)
    if (!probe.exists) {
      findings.push({
        level: "error",
        label: "Stata",
        detail: `Configured path does not exist: ${probe.normalized}`,
      })
    } else {
      findings.push({
        level: "ok",
        label: "Stata",
        detail: `${probe.normalized} (${(config.killstata?.stata?.edition ?? probe.edition ?? "mp").toUpperCase()})`,
      })
    }
  }

  const stataMcp = config.mcp?.["stata"]
  if (!stataMcp || typeof stataMcp !== "object" || !("type" in stataMcp)) {
    findings.push({
      level: "warn",
      label: "Stata MCP",
      detail: "mcp.stata is not configured in user or project config.",
    })
  } else if (stataMcp.type !== "local") {
    findings.push({
      level: "warn",
      label: "Stata MCP",
      detail: "mcp.stata exists but is not using the built-in local transport.",
    })
  } else {
    findings.push({
      level: "ok",
      label: "Stata MCP",
      detail: `Configured local command: ${stataMcp.command.join(" ")}`,
    })
  }

  findings.push({
    level: "ok",
    label: "User config",
    detail: userConfigPath(),
  })

  if (!configuredModel) {
    findings.push({
      level: "warn",
      label: "Default model",
      detail: "Not configured. Run `killstata config` to choose a provider and default model.",
    })
  } else {
    findings.push({
      level: "ok",
      label: "Default model",
      detail: `${configuredModel.providerID}/${configuredModel.modelID}`,
    })

    const auth = await Auth.get(configuredModel.providerID)
    const envVars = providers[configuredModel.providerID]?.env ?? []
    const hasEnvKey = envVars.some((name: string) => !!process.env[name])
    if (auth?.type === "api" || hasEnvKey) {
      findings.push({
        level: "ok",
        label: "Model credential",
        detail:
          auth?.type === "api"
            ? `Stored API key for ${configuredModel.providerID}`
            : `Environment credential detected for ${configuredModel.providerID}`,
      })
    } else {
      findings.push({
        level: "warn",
        label: "Model credential",
        detail: `No API key found for ${configuredModel.providerID}. Re-run \`killstata config\` or set the provider environment variable.`,
      })
    }
  }

  for (const check of [
    { label: "Skills root", target: paths.user.skillRoot },
    { label: "Workspace root", target: paths.user.workspace },
    { label: "Agent state root", target: paths.user.mainAgentState },
    { label: "Agent sessions root", target: paths.user.mainAgentSessions },
    { label: "Subagent index", target: paths.user.subagentRuns },
  ]) {
    const exists = fs.existsSync(check.target)
    findings.push({
      level: exists ? "ok" : "warn",
      label: check.label,
      detail: exists ? check.target : `Missing: ${check.target}. Run \`killstata config\` to initialize the user home layout.`,
    })
  }

  logFindings(findings)
  prompts.outro("Doctor check complete")
}

export async function runKillstataConfigPaths() {
  UI.empty()
  prompts.intro("killstata config paths")
  printPathSummary()
  prompts.outro("Path summary complete")
}

const ConfigDoctorCommand = cmd({
  command: "doctor",
  describe: "check Python, Stata, and MCP setup without modifying configuration",
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        await runKillstataConfigDoctor()
      },
    })
  },
})

const ConfigPathsCommand = cmd({
  command: "paths",
  describe: "show which files live in ~/.killstata, XDG/AppData, and the current project",
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        await runKillstataConfigPaths()
      },
    })
  },
})

export const ConfigCommand = cmd({
  command: "config",
  describe: "guided setup for model provider, Python, Stata, and killstata storage paths",
  builder: (yargs) => yargs.command(ConfigDoctorCommand).command(ConfigPathsCommand),
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        await runKillstataConfigWizard()
      },
    })
  },
})
