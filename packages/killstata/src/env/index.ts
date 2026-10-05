import { Instance } from "../project/instance"

/**
 * 环境变量注册表——所有已知 env var 在此登记。
 * 新增环境变量先在这里定义，提供中文描述和默认值，避免散落各处不可发现。
 */
export const ENV_DEFINITIONS = {
  // ── 运行时 ──
  KILLSTATA_PYTHON: { description: "自定义 Python 解释器路径", default: undefined },
  KILLSTATA_DISABLE_AUTO_RUNTIME: { description: "禁用自动 Python 运行时检测", default: "false" },
  KILLSTATA_SERVER_PASSWORD: { description: "服务器密码", secret: true },

  // ── 部署 / 客户端 ──
  KILLSTATA_CLIENT: { description: "客户端类型: app/cli/desktop", default: "cli" },
  KILLSTATA_TEST_HOME: { description: "测试环境 HOME 覆盖", default: undefined },
  KILLSTATA_MODELS_URL: { description: "模型服务 URL", default: "https://models.dev" },

  // ── 运行标记 ──
  AGENT: { description: "Agent 模式标记", default: "1" },
  KILLSTATA: { description: "KillStata 运行标记", default: "1" },

  // ── 网络 ──
  HTTP_PROXY: { description: "HTTP 代理", default: undefined },
  HTTPS_PROXY: { description: "HTTPS 代理", default: undefined },
  http_proxy: { description: "HTTP 代理（小写）", default: undefined },
  https_proxy: { description: "HTTPS 代理（小写）", default: undefined },
  GITHUB_TOKEN: { description: "GitHub token", secret: true },
  GH_TOKEN: { description: "GitHub token（别名）", secret: true },
} as const

export type EnvKey = keyof typeof ENV_DEFINITIONS

export namespace Env {
  // 惰性建 state：Instance.state 需要 Instance 上下文，模块加载期还没有。
  // 写成模块级常量会让任何仅仅 import 到本模块的链路在无上下文时直接崩。
  let _state: (() => Record<string, string | undefined>) | undefined

  function ensureEnv() {
    if (!_state) {
      _state = Instance.state(() => process.env as Record<string, string | undefined>)
    }
    return _state()
  }

  /** 已知 key 有类型提示，未知 key 回退到 process.env[key] */
  export function get<K extends EnvKey>(key: K): string | undefined
  export function get(key: string): string | undefined
  export function get(key: string): string | undefined {
    return ensureEnv()[key]
  }

  export function all() {
    return ensureEnv()
  }

  export function set(key: string, value: string) {
    ensureEnv()[key] = value
  }

  export function remove(key: string) {
    delete ensureEnv()[key]
  }
}
