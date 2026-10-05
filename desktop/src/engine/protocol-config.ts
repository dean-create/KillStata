import type { EngineProtocolVersion } from "./client"

/** v2 仅用于显式开发/联调配置；不传或传入未知值时保持现有 v1 默认路径。 */
export function resolveEngineProtocolVersion(value: unknown): EngineProtocolVersion {
  return value === "v2" ? "v2" : "v1"
}
