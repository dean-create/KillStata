import path from "node:path"
import { sessionEconometricsEngine } from "./econometrics-engine-client"
import { econometricsEngineRoot } from "@/killstata/runtime-config"

/**
 * 迁移期后端的统一桥接。
 *
 * 旧TS工具仍可能被历史回放或测试直接调用，但正式Session必须从这里进入独立
 * Python引擎。方法本身的参数契约和算法不在这里复制；这里只剥离旧runner的
 * transport字段，传递受控数据路径、输出目录和方法参数。
 */
export async function runEngineMethodBackend(input: {
  sessionID: string
  pythonCommand: string
  cwd: string
  methodID: string
  payload: Record<string, unknown>
  runtime?: Record<string, unknown>
  abort?: AbortSignal
  beforeExecute?: () => void
}) {
  const dataPath = input.payload.dataPath
  const outputDir = input.payload.outputDir
  if (typeof dataPath !== "string" || !dataPath.trim()) throw new Error(`${input.methodID} 缺少受控数据路径。`)
  if (typeof outputDir !== "string" || !outputDir.trim()) throw new Error(`${input.methodID} 缺少受控输出目录。`)
  const { method: _method, dataPath: _dataPath, outputDir: _outputDir, ...arguments_ } = input.payload
  const engine = sessionEconometricsEngine(input.sessionID, {
    command: input.pythonCommand,
    cwd: input.cwd,
    pythonPath: path.join(econometricsEngineRoot(), "src"),
    methodRoot: path.join(econometricsEngineRoot(), "python"),
  })
  const validation = await engine.validate(input.methodID, arguments_, {
    ...(input.runtime ? { runtime: input.runtime } : {}),
    signal: input.abort,
  })
  input.beforeExecute?.()
  const response = await engine.execute({
    method_id: input.methodID,
    data_path: dataPath,
    output_dir: outputDir,
    arguments: validation.arguments,
    ...(input.runtime ? { runtime: input.runtime } : {}),
  }, input.abort)
  if (!response.payload || typeof response.payload !== "object" || Array.isArray(response.payload)) {
    throw new Error(`${input.methodID} 引擎返回了空的结构化结果。`)
  }
  return response.payload as Record<string, unknown>
}
