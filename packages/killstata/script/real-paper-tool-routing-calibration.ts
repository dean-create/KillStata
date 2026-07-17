import fs from "fs"
import path from "path"
import z from "zod"
import { generateText, jsonSchema, tool, type ToolSet } from "ai"
import { Auth } from "@/auth"
import { Instance } from "@/project/instance"
import { DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_PROVIDER_ID } from "@/provider/deepseek-policy"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { WORKFLOW_ANALYSIS_TOOL_IDS } from "@/runtime/tool-catalog"
import type { WorkflowStageKind } from "@/runtime/types"
import { SystemPrompt } from "@/session/system"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"

type Decision = "call" | "call_after_repair" | "clarify" | "repair_data"

export type RoutingFixture = {
  id: string
  dataset: string
  prompt: string
  decision: Decision
  expectedTool?: string
  expectedArgs?: Record<string, unknown>
  forbiddenTools: string[]
  requiredGuidance?: string[]
}

type CapturedCall = {
  toolName: string
  input: unknown
}

type RegistryToolInfo = Awaited<ReturnType<typeof ToolRegistry.tools>>[number]
export type ToolSchemaInfo = { parameters: z.ZodType }

const ROOT = path.resolve(import.meta.dir, "..", "..", "..")
const FIXTURES_ROOT = path.join(ROOT, "packages", "killstata", "test", "fixtures", "real-paper-intents")
const REPORT_PATH = path.join(ROOT, "test", "real-paper-chain", "deepseek-routing-results.json")
const MODEL_ALLOWED_TOOLS = new Set<string>([...WORKFLOW_ANALYSIS_TOOL_IDS, "data_import"])

export function loadRoutingFixtures(): RoutingFixture[] {
  return fs
    .readdirSync(FIXTURES_ROOT)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((file) => {
      const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_ROOT, file), "utf-8")) as {
        dataset: string
        cases: Array<Omit<RoutingFixture, "dataset">>
      }
      return fixture.cases.map((item) => ({ ...item, dataset: fixture.dataset }))
    })
}

function normalizeArgs(input: unknown) {
  return Tool.normalizeToolArgs(input)
}

function valueEquals(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => valueEquals(value, right[index]))
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>
    const rightRecord = right as Record<string, unknown>
    const leftKeys = Object.keys(leftRecord).sort()
    const rightKeys = Object.keys(rightRecord).sort()
    return valueEquals(leftKeys, rightKeys) && leftKeys.every((key) => valueEquals(leftRecord[key], rightRecord[key]))
  }
  return left === right
}

export function scoreCapturedRouting(input: {
  fixture: RoutingFixture
  call?: CapturedCall
  responseText?: string
  tools: Map<string, ToolSchemaInfo>
  finishReason?: string
  outputTokens?: number
}) {
  const { fixture, call, tools } = input
  const violations: string[] = []
  const normalizedInput = call ? normalizeArgs(call.input) : undefined
  const toolInfo = call ? tools.get(call.toolName) : undefined
  const schemaResult = toolInfo ? toolInfo.parameters.safeParse(normalizedInput) : undefined
  const exactTool = fixture.expectedTool ? call?.toolName === fixture.expectedTool : call === undefined
  const forbiddenSelected = Boolean(call && fixture.forbiddenTools.includes(call.toolName))
  const requiredArgsMatch = fixture.expectedArgs ? valueEquals(normalizedInput, fixture.expectedArgs) : undefined

  if (call && !toolInfo) violations.push("unknown_tool")
  if (call && toolInfo && !schemaResult?.success) violations.push("schema_invalid")
  if (fixture.expectedTool && !call) violations.push("missing_tool_call")
  if (fixture.expectedTool && call && call.toolName !== fixture.expectedTool) violations.push("wrong_tool")
  if (fixture.expectedArgs && !requiredArgsMatch) violations.push("argument_mismatch")
  if (forbiddenSelected) violations.push("forbidden_tool")
  if (!fixture.expectedTool && call && !forbiddenSelected) violations.push("unexpected_tool_call")

  const responseText = (input.responseText ?? "").slice(0, 800)
  const guidanceCoverage = (fixture.requiredGuidance ?? []).map((phrase) => ({
    phrase,
    present: responseText.includes(phrase),
  }))

  return {
    fixtureId: fixture.id,
    decision: fixture.decision,
    expectedTool: fixture.expectedTool ?? null,
    selectedTool: call?.toolName ?? null,
    args: normalizedInput ?? null,
    exactTool,
    schemaValid: schemaResult?.success ?? (call ? false : null),
    requiredArgsMatch: requiredArgsMatch ?? null,
    forbiddenSelected,
    guidanceCoverage,
    violations,
    responseText,
    finishReason: input.finishReason ?? null,
    outputTokens: input.outputTokens ?? null,
  }
}

function dataContext(fixture: RoutingFixture) {
  if (fixture.dataset.startsWith("did.xlsx")) {
    const lines = [
      "当前 canonical 数据集：datasetId=did_real，stageId=stage_imported。",
      "econometrics_recommend 数据画像已经完成，data_import QA=pass；当前处于 baseline_estimate/robustness 阶段，不要重复画像或 describe。",
      "Data_原始编码 已导入并通过 city+year QA：4709 行，277 个城市，2005-2021 共 17 年，无重复键；用户本条消息已要求执行时无需再次确认。",
      "did 是 0/1 分批处理变量；98 个城市在 2012/2013/2014 首次处理，179 个城市从未处理。",
      "原 Excel 的 time 用文本 36 表示 never-treated，导入后这些值成为缺失；time 不是相对时期。",
      "已确认基准控制变量：人口密度、金融发展程度、城镇化水平、产业结构整体升级、产业结构高级化、教育水平支出、人力资本。",
      "已验证存在且为数值列：经济发展水平、人均GDP、高质量发展指数、包容性TFP指数、创新指数、产业结构高级化2、金融发展程度。面板个体列的准确名字是 city，不是 城市。",
    ]
    if (fixture.id !== "did-fe-baseline") {
      lines.push(
        "已验证的基准估计器是 panel_fe_regression：city 与 year 双向固定效应、按 city 聚类。稳健性和机制复跑必须沿用这个估计器与设定，只改用户明确指定的变量角色。",
      )
    }
    return lines.join("\n")
  }
  if (fixture.id === "digital-profile-first") {
    return [
      "当前 canonical 数据集：datasetId=digital_real，stageId=stage_imported。",
      "数据刚导入，尚未运行 econometrics_recommend；用户明确要求先画像。",
      "已知结果列为 数字普惠金融指数，候选面板键为 地区 和 年份。",
    ].join("\n")
  }
  if (fixture.id === "digital-fe-after-composite-key") {
    return [
      "当前 canonical 数据集：datasetId=digital_repaired，stageId=stage_composite_key_qa_passed。",
      "省份_地区 派生列已经真实创建，econometrics_recommend 画像已完成，省份_地区+年份 QA=pass；当前处于 baseline_estimate 阶段，不要重复画像或 describe。",
      "已验证为数值列：数字普惠金融指数、每百人互联网用户数、计算机服务和软件从业人员占比、人均电信业务总量、每百人移动电话用户数；用户已要求执行，无需再次确认。",
    ].join("\n")
  }
  return [
    "当前 canonical 数据集：datasetId=digital_real，stageId=stage_imported。",
    "econometrics_recommend 画像已经完成；data_import QA 已明确 block。重复画像不会修复该问题。",
    "Sheet1 共 9683 行，2000-2022 共 23 年。只用 地区+年份 会有 115 行超额重复，原因是 6 个省份都有 地区=其他；不得执行估计器。",
    "省份+地区 可形成 421 个实体，但派生列 省份_地区 尚未创建；只有 repair 后的数据集 digital_repaired/stage_composite_key_qa_passed 才声明该列已通过唯一性 QA。",
  ].join("\n")
}

function calibrationStage(fixture: RoutingFixture): WorkflowStageKind {
  if (fixture.id === "digital-profile-first" || fixture.decision === "repair_data") {
    return "preprocess_or_filter"
  }
  return "baseline_estimate"
}

async function modelVisibleTools(model: Provider.Model, currentStage: WorkflowStageKind) {
  const infos = await ToolRegistry.tools(
    { providerID: model.providerID, modelID: model.api.id },
    undefined,
    {
      inputIntent: "analysis",
      currentStage,
      platformCapabilities: { mcp: false, images: false, remote: false },
      modelCapabilities: { supportsTools: true, supportsImages: false },
    },
  )
  return infos.filter((info) => MODEL_ALLOWED_TOOLS.has(info.id))
}

function toAiTools(model: Provider.Model, infos: RegistryToolInfo[]) {
  const result: ToolSet = {}
  for (const info of infos) {
    const schema = ProviderTransform.schema(
      model,
      z.toJSONSchema(info.parameters as z.ZodType, { unrepresentable: "any" }) as never,
    )
    result[info.id] = tool({
      description: info.description,
      inputSchema: jsonSchema(schema as never),
    })
  }
  return result
}

async function runCalibration() {
  const auth = await Auth.get(DEEPSEEK_PROVIDER_ID)
  if (!auth) throw new Error("未找到 DeepSeek 凭据；请先完成 KillStata 的 DeepSeek API Key 配置。")

  return Instance.provide({
    directory: ROOT,
    fn: async () => {
      const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
      const language = await Provider.getLanguage(model)
      const fixtures = loadRoutingFixtures()
      const results = []

      for (const [index, fixture] of fixtures.entries()) {
        process.stdout.write(`[${index + 1}/${fixtures.length}] ${fixture.id}\n`)
        const infos = await modelVisibleTools(model, calibrationStage(fixture))
        const toolsById = new Map(infos.map((info) => [info.id, info]))
        const aiTools = toAiTools(model, infos)
        const generated = await generateText({
          model: language,
          system: [
            ...SystemPrompt.provider(model),
            ...SystemPrompt.toolCatalog(Object.keys(aiTools)),
            "# 路由校准\n只根据已给数据事实决定是否调用工具。缺少识别前提时先用中文澄清或要求修复数据，不得为了完成测评而强行调用估计器。若调用工具，只能生成一次工具调用，不执行工具。",
            dataContext(fixture),
          ].join("\n\n"),
          prompt: fixture.prompt,
          tools: aiTools,
          // DeepSeek thinking 模式不接受 tool_choice=required；正式 KillStata 也使用 auto。
          // 校准必须复现真实选择，而不是靠协议强迫模型调用。
          toolChoice: "auto",
          temperature: 0,
          maxOutputTokens: fixture.expectedTool ? 2500 : 5000,
          maxRetries: 0,
        })
        const call = generated.toolCalls[0]
          ? { toolName: generated.toolCalls[0].toolName, input: generated.toolCalls[0].input }
          : undefined
        results.push(
          scoreCapturedRouting({
            fixture,
            call,
            responseText: generated.text,
            tools: toolsById,
            finishReason: generated.finishReason,
            outputTokens: generated.usage.outputTokens,
          }),
        )
      }

      const expectedCalls = results.filter((item) => item.expectedTool)
      const negativeDecisions = results.filter((item) => !item.expectedTool)
      const summary = {
        total: results.length,
        expectedCallTotal: expectedCalls.length,
        exactExpectedCalls: expectedCalls.filter(
          (item) => item.exactTool && item.schemaValid && item.requiredArgsMatch,
        ).length,
        negativeDecisionTotal: negativeDecisions.length,
        safeNegativeDecisions: negativeDecisions.filter((item) => !item.forbiddenSelected).length,
        schemaValidCalls: results.filter((item) => item.selectedTool && item.schemaValid).length,
        forbiddenSelections: results.filter((item) => item.forbiddenSelected).length,
        truncated: results.filter((item) => item.finishReason === "length").length,
        clean: results.filter((item) => item.violations.length === 0).length,
      }
      const report = {
        recordedAt: new Date().toISOString(),
        provider: model.providerID,
        model: model.id,
        transport: model.api.npm,
        summary,
        results,
      }
      fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf-8")
      process.stdout.write(`报告：${REPORT_PATH}\n${JSON.stringify(summary)}\n`)
      return report
    },
  })
}

if (import.meta.main) {
  runCalibration().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`DeepSeek 路由校准失败：${message.slice(0, 1200)}\n`)
    process.exitCode = 1
  })
}
