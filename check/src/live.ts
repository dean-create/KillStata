import { generateText, jsonSchema, tool, type ToolSet } from "../../packages/killstata/node_modules/ai"
import z from "../../packages/killstata/node_modules/zod"
import { Auth } from "../../packages/killstata/src/auth"
import { Instance } from "../../packages/killstata/src/project/instance"
import { DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_PROVIDER_ID } from "../../packages/killstata/src/provider/deepseek-policy"
import { Provider } from "../../packages/killstata/src/provider/provider"
import { ProviderTransform } from "../../packages/killstata/src/provider/transform"
import { WORKFLOW_ANALYSIS_TOOL_IDS } from "../../packages/killstata/src/runtime/tool-catalog"
import { SystemPrompt } from "../../packages/killstata/src/session/system"
import { Tool } from "../../packages/killstata/src/tool/tool"
import { ToolRegistry } from "../../packages/killstata/src/tool/registry"
import { type PanelFeCoreArgs, runFixedPanelFePilot } from "./pilot"

const ROOT = new URL("../..", import.meta.url).pathname
const MODEL_ALLOWED_TOOLS = new Set<string>([...WORKFLOW_ANALYSIS_TOOL_IDS, "data_import"])

type CapturedCall = { toolName: string; input: unknown }
type RegistryToolInfo = Awaited<ReturnType<typeof ToolRegistry.tools>>[number]

function sameArray(left: unknown, right: string[]) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index])
}

export function scorePanelFeModelCall(call: CapturedCall | undefined, expected: PanelFeCoreArgs) {
  if (!call) return { accepted: false, violations: ["missing_tool"] }
  if (call.toolName !== "panel_fe_regression") return { accepted: false, violations: ["wrong_tool"] }
  const input = call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : {}
  const violations: string[] = []
  for (const key of ["dependentVar", "treatmentVar", "entityVar", "timeVar", "clusterVar"] as const) {
    if (input[key] !== expected[key]) violations.push(`argument_mismatch:${key}`)
  }
  if (!sameArray(input.covariates, expected.covariates)) violations.push("argument_mismatch:covariates")
  return { accepted: violations.length === 0, violations }
}

async function modelVisibleTools(model: Provider.Model) {
  const infos = await ToolRegistry.tools(
    { providerID: model.providerID, modelID: model.api.id },
    undefined,
    {
      inputIntent: "analysis",
      currentStage: "baseline_estimate",
      platformCapabilities: { mcp: false, images: false, remote: false },
      modelCapabilities: { supportsTools: true, supportsImages: false },
    },
  )
  return infos.filter((info) => MODEL_ALLOWED_TOOLS.has(info.id))
}

function asAiTools(model: Provider.Model, infos: RegistryToolInfo[]) {
  const tools: ToolSet = {}
  for (const info of infos) {
    const schema = ProviderTransform.schema(
      model,
      z.toJSONSchema(info.parameters as z.ZodType, { unrepresentable: "any" }) as never,
    )
    tools[info.id] = tool({ description: info.description, inputSchema: jsonSchema(schema as never) })
  }
  return tools
}

const EXPECTED_CORE_ARGS: PanelFeCoreArgs = {
  dependentVar: "经济发展水平",
  treatmentVar: "did",
  covariates: [
    "人口密度",
    "金融发展程度",
    "城镇化水平",
    "产业结构整体升级",
    "产业结构高级化",
    "教育水平支出",
    "人力资本",
  ],
  entityVar: "city",
  timeVar: "year",
  clusterVar: "city",
}

function coreArgs(input: unknown): PanelFeCoreArgs {
  const record = input as Record<string, unknown>
  return {
    dependentVar: record.dependentVar as string,
    treatmentVar: record.treatmentVar as string,
    covariates: record.covariates as string[],
    entityVar: record.entityVar as string,
    timeVar: record.timeVar as string,
    clusterVar: record.clusterVar as string,
  }
}

export async function runLivePanelFeReplay() {
  const auth = await Auth.get(DEEPSEEK_PROVIDER_ID)
  if (!auth) {
    return { status: "PENDING_LIVE_REPLAY" as const, reason: "未配置 DeepSeek API Key" }
  }
  return Instance.provide({
    directory: ROOT,
    fn: async () => {
      const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
      const infos = await modelVisibleTools(model)
      const aiTools = asAiTools(model, infos)
      const generated = await generateText({
        model: await Provider.getLanguage(model),
        system: [
          ...SystemPrompt.provider(model),
          ...SystemPrompt.toolCatalog(Object.keys(aiTools)),
          "当前数据已经完成导入、画像与 QA，处于基准估计阶段。只可调用一次已暴露工具；缺识别条件才澄清，不能虚构列名。",
          "数据为 4709 行、277 个 city、2005-2021 年的平衡面板；did 为 0/1 分批处理。可用变量：经济发展水平、did、人口密度、金融发展程度、城镇化水平、产业结构整体升级、产业结构高级化、教育水平支出、人力资本、city、year。",
          "本次动态数据源将在执行时绑定；工具调用中的 datasetId=did_real、stageId=stage_imported 是当前已验证数据源的逻辑引用。",
        ].join("\n\n"),
        prompt:
          "请立即以经济发展水平为因变量、did 为核心解释变量，控制人口密度、金融发展程度、城镇化水平、产业结构整体升级、产业结构高级化、教育水平支出、人力资本；加入 city 和 year 双向固定效应，按 city 聚类。",
        tools: aiTools,
        toolChoice: "auto",
        temperature: 0,
        maxOutputTokens: 2500,
        maxRetries: 0,
      })
      const call = generated.toolCalls[0]
        ? { toolName: generated.toolCalls[0].toolName, input: generated.toolCalls[0].input }
        : undefined
      const route = scorePanelFeModelCall(call, EXPECTED_CORE_ARGS)
      const selected = call ? infos.find((info) => info.id === call.toolName) : undefined
      const schemaAccepted = !!(call && selected?.parameters.safeParse(Tool.normalizeToolArgs(call.input)).success)
      if (!route.accepted || !schemaAccepted) {
        return {
          status: "BLOCKED_UNSAFE_ROUTING" as const,
          provider: model.providerID,
          model: model.id,
          selectedTool: call?.toolName ?? null,
          schemaAccepted,
          violations: route.violations,
        }
      }
      const execution = await runFixedPanelFePilot(coreArgs(Tool.normalizeToolArgs(call!.input)))
      return {
        status: "PASS" as const,
        provider: model.providerID,
        model: model.id,
        selectedTool: call!.toolName,
        schemaAccepted,
        execution,
      }
    },
  })
}
