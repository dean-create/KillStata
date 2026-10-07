import { ModelGateway } from "@/runtime/services/model-gateway"

/**
 * 会话层兼容入口。
 *
 * 模型调用、提示词拼装、缓存与 Provider SDK 适配均由 ModelGateway 提供；保留这个
 * 命名空间只为降低既有扩展和测试的迁移成本。
 */
export namespace LLM {
  export type StreamInput = ModelGateway.StreamInput
  export type StreamOutput = ModelGateway.StreamOutput
  export const OUTPUT_TOKEN_MAX = ModelGateway.OUTPUT_TOKEN_MAX

  export function stream(input: StreamInput) {
    return ModelGateway.stream(input)
  }
}
