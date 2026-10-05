import fs from "fs"
import path from "path"
import z from "zod"
import { Tool } from "./tool"
import { assertDatasetStageReadyForEstimation } from "@/runtime/workflow"
import { datasetRoot, reportOutputPath, resolveArtifactInput } from "./analysis-state"
import { resolveDatasetStagePath, resolveManagedProjectPath } from "./analysis-path"
import { sessionEconometricsEngine } from "@/runtime/services/econometrics-engine-client"
import { buildEngineToolResult } from "@/runtime/services/econometrics-engine-result"
import { econometricsEngineRoot, resolveRuntimePythonCommand } from "@/killstata/runtime-config"

/**
 * Registry 方法的非模型可见适配器。
 *
 * 它只用于当前 PreparedSpec 已通过 Harness 准入后的内部执行适配，不是第二套模型工具：
 * - 参数契约来自 Python Registry，TS 只接受不带方法字段含义的 JSON 对象；
 * - 数据阶段、输入路径、输出目录和会话引擎仍由 Harness 注入；
 * - 计算、方法校验和诊断全部在 Python 引擎内完成。
 *
 * 正常模型调用必须走 tool_search + analysis_prepare + econometrics_execute(specId)；该适配器不会进入
 * Provider tools，也不会把旧 TS wrapper/backend 带回运行时。
 */
export function createEngineMethodTool(methodID: string): Tool.Info {
  const registryArguments = z.record(z.string(), z.unknown()).superRefine((value, refinement) => {
    // 这不是方法 Schema 的复制，只是所有计量方法共用的角色安全门；具体字段、
    // 枚举和方法前置条件仍由 Python Registry 在 execute 边界唯一校验。
    const dependent = value.dependentVar
    const treatment = value.treatmentVar
    if (typeof dependent === "string" && dependent === treatment) {
      refinement.addIssue({ code: "custom", path: ["dependentVar"], message: "因变量不能与核心解释变量使用同一列" })
    }
    if (Array.isArray(value.covariates) && value.covariates.some((item) => item === dependent || item === treatment)) {
      refinement.addIssue({ code: "custom", path: ["covariates"], message: "控制变量不能重复承担因变量或核心解释变量角色" })
    }
  })
  return Tool.define(
    methodID,
    Tool.Execution.managedFilesystem,
    {
      namespace: methodID.includes("test") ? "econometrics_diagnostic" : "econometrics_estimator",
      useWhen: "仅供历史阶段重放或兼容调用；正常模型调用请先搜索 Python Registry。",
      doNotUseWhen: "不要把它当作模型可见的独立工具，也不要绕过 econometrics_execute 直接猜测方法参数。",
      returns: "Python Registry 统一封装的结构化结果、诊断和产物引用。",
      failureRecovery: "读取结构化错误并只修复对应字段；研究设定变化必须交还用户确认。",
      inputExamples: [{ datasetId: "dataset_demo", stageId: "stage_demo" }],
    },
    {
      description: `Registry 方法 ${methodID} 的历史重放适配入口。正常模型调用必须使用 econometrics_execute。`,
      parameters: registryArguments,
      async execute(arguments_, ctx) {
        const datasetId = typeof arguments_.datasetId === "string" ? arguments_.datasetId : undefined
        const stageId = typeof arguments_.stageId === "string" ? arguments_.stageId : undefined
        if (!datasetId || !stageId) {
          throw new Tool.InputValidationError(
            `历史阶段重放 ${methodID} 缺少 datasetId 或 stageId；不会猜测数据来源，请先恢复原数据阶段。`,
          )
        }
        assertDatasetStageReadyForEstimation({ sessionID: ctx.sessionID, datasetId, stageId })
        const artifactInput = resolveArtifactInput({ datasetId, stageId })
        if (!artifactInput.resolvedInputPath) {
          throw new Error(`历史阶段重放 ${methodID} 找不到数据阶段输入文件：${stageId}。`)
        }
        const dataPath = await resolveDatasetStagePath({
          datasetId,
          filePath: artifactInput.resolvedInputPath,
          toolName: methodID,
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
          ask: ctx.ask,
        })
        if (!fs.existsSync(dataPath)) throw new Error(`历史阶段重放 ${methodID} 找不到数据阶段输入文件：${stageId}。`)
        const outputDir = resolveManagedProjectPath({
          managedRoot: datasetRoot(datasetId),
          filePath: reportOutputPath({
            datasetId,
            action: methodID,
            stageId,
            branch: "main",
            format: "json",
            stamp: `${Date.now()}`,
          }).replace(/\.json$/, ""),
        })
        const engine = sessionEconometricsEngine(ctx.sessionID, {
          command: await resolveRuntimePythonCommand(),
          cwd: path.resolve(process.cwd()),
          pythonPath: path.join(econometricsEngineRoot(), "src"),
          methodRoot: path.join(econometricsEngineRoot(), "python"),
        })
        const description = await engine.describe(methodID)
        const runtimeFields = Array.isArray(description.runtime_injected_fields)
          ? description.runtime_injected_fields.filter((field): field is string => typeof field === "string")
          : []
        const runtime = Object.fromEntries(
          runtimeFields
            .filter((field) => arguments_[field] !== undefined)
            .map((field) => [field, arguments_[field]]),
        )
        const methodArguments = { ...arguments_ }
        delete methodArguments.datasetId
        delete methodArguments.stageId
        for (const field of runtimeFields) delete methodArguments[field]
        const response = await engine.execute({
          method_id: methodID,
          data_path: dataPath,
          output_dir: outputDir,
          arguments: methodArguments,
          runtime,
        }, ctx.abort)
        const payload = response.payload && typeof response.payload === "object" && !Array.isArray(response.payload)
          ? response.payload as Record<string, unknown>
          : {}
        const artifacts = Array.isArray(response.artifacts)
          ? response.artifacts.filter((item): item is { kind: string; path: string } =>
              Boolean(item && typeof item === "object" && typeof (item as any).kind === "string" && typeof (item as any).path === "string"),
            )
          : []
        return buildEngineToolResult({ methodID, datasetId, stageId, methodArguments, payload, artifacts })
      },
    },
  )
}
