function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

export namespace Flag {
  export const KILLSTATA_AUTO_SHARE = truthy("KILLSTATA_AUTO_SHARE")
  export const KILLSTATA_GIT_BASH_PATH = process.env["KILLSTATA_GIT_BASH_PATH"]
  export const KILLSTATA_CONFIG = process.env["KILLSTATA_CONFIG"]
  export declare const KILLSTATA_CONFIG_DIR: string | undefined
  export const KILLSTATA_CONFIG_CONTENT = process.env["KILLSTATA_CONFIG_CONTENT"]
  export const KILLSTATA_DISABLE_AUTOUPDATE = truthy("KILLSTATA_DISABLE_AUTOUPDATE")
  export const KILLSTATA_DISABLE_PRUNE = truthy("KILLSTATA_DISABLE_PRUNE")
  export const KILLSTATA_DISABLE_TERMINAL_TITLE = truthy("KILLSTATA_DISABLE_TERMINAL_TITLE")
  export const KILLSTATA_PERMISSION = process.env["KILLSTATA_PERMISSION"]
  export const KILLSTATA_DISABLE_DEFAULT_PLUGINS = truthy("KILLSTATA_DISABLE_DEFAULT_PLUGINS")
  export const KILLSTATA_DISABLE_LSP_DOWNLOAD = truthy("KILLSTATA_DISABLE_LSP_DOWNLOAD")
  export const KILLSTATA_ENABLE_EXPERIMENTAL_MODELS = truthy("KILLSTATA_ENABLE_EXPERIMENTAL_MODELS")
  export const KILLSTATA_DISABLE_AUTOCOMPACT = truthy("KILLSTATA_DISABLE_AUTOCOMPACT")
  export const KILLSTATA_DISABLE_MODELS_FETCH = truthy("KILLSTATA_DISABLE_MODELS_FETCH")
  export const KILLSTATA_DISABLE_CLAUDE_CODE = truthy("KILLSTATA_DISABLE_CLAUDE_CODE")
  export const KILLSTATA_DISABLE_CLAUDE_CODE_PROMPT =
    KILLSTATA_DISABLE_CLAUDE_CODE || truthy("KILLSTATA_DISABLE_CLAUDE_CODE_PROMPT")
  export const KILLSTATA_DISABLE_CLAUDE_CODE_SKILLS =
    KILLSTATA_DISABLE_CLAUDE_CODE || truthy("KILLSTATA_DISABLE_CLAUDE_CODE_SKILLS")
  export declare const KILLSTATA_DISABLE_PROJECT_CONFIG: boolean
  export const KILLSTATA_FAKE_VCS = process.env["KILLSTATA_FAKE_VCS"]
  export const KILLSTATA_CLIENT = process.env["KILLSTATA_CLIENT"] ?? "cli"
  export const KILLSTATA_SERVER_PASSWORD = process.env["KILLSTATA_SERVER_PASSWORD"]
  export const KILLSTATA_SERVER_USERNAME = process.env["KILLSTATA_SERVER_USERNAME"]

  // Experimental
  export const KILLSTATA_EXPERIMENTAL = truthy("KILLSTATA_EXPERIMENTAL")
  export const KILLSTATA_EXPERIMENTAL_FILEWATCHER = truthy("KILLSTATA_EXPERIMENTAL_FILEWATCHER")
  export const KILLSTATA_EXPERIMENTAL_DISABLE_FILEWATCHER = truthy("KILLSTATA_EXPERIMENTAL_DISABLE_FILEWATCHER")
  export const KILLSTATA_EXPERIMENTAL_ICON_DISCOVERY =
    KILLSTATA_EXPERIMENTAL || truthy("KILLSTATA_EXPERIMENTAL_ICON_DISCOVERY")
  export const KILLSTATA_EXPERIMENTAL_DISABLE_COPY_ON_SELECT = truthy("KILLSTATA_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
  export const KILLSTATA_ENABLE_EXA =
    truthy("KILLSTATA_ENABLE_EXA") || KILLSTATA_EXPERIMENTAL || truthy("KILLSTATA_EXPERIMENTAL_EXA")
  export const KILLSTATA_EXPERIMENTAL_BASH_MAX_OUTPUT_LENGTH = number("KILLSTATA_EXPERIMENTAL_BASH_MAX_OUTPUT_LENGTH")
  export const KILLSTATA_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number("KILLSTATA_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS")
  export const KILLSTATA_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("KILLSTATA_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
  export const KILLSTATA_EXPERIMENTAL_OXFMT = KILLSTATA_EXPERIMENTAL || truthy("KILLSTATA_EXPERIMENTAL_OXFMT")
  export const KILLSTATA_EXPERIMENTAL_LSP_TY = truthy("KILLSTATA_EXPERIMENTAL_LSP_TY")
  export const KILLSTATA_EXPERIMENTAL_LSP_TOOL = KILLSTATA_EXPERIMENTAL || truthy("KILLSTATA_EXPERIMENTAL_LSP_TOOL")
  export const KILLSTATA_DISABLE_FILETIME_CHECK = truthy("KILLSTATA_DISABLE_FILETIME_CHECK")
  export const KILLSTATA_EXPERIMENTAL_PLAN_MODE = KILLSTATA_EXPERIMENTAL || truthy("KILLSTATA_EXPERIMENTAL_PLAN_MODE")

  function number(key: string) {
    const value = process.env[key]
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}

// Dynamic getter for KILLSTATA_DISABLE_PROJECT_CONFIG
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "KILLSTATA_DISABLE_PROJECT_CONFIG", {
  get() {
    return truthy("KILLSTATA_DISABLE_PROJECT_CONFIG")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for KILLSTATA_CONFIG_DIR
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "KILLSTATA_CONFIG_DIR", {
  get() {
    return process.env["KILLSTATA_CONFIG_DIR"]
  },
  enumerable: true,
  configurable: false,
})
