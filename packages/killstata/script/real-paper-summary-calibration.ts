import fs from "fs"
import path from "path"
import { generateText } from "ai"
import { Auth } from "@/auth"
import { Instance } from "@/project/instance"
import { DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_PROVIDER_ID } from "@/provider/deepseek-policy"
import { Provider } from "@/provider/provider"
import { SystemPrompt } from "@/session/system"

type SummaryCase = {
  id: string
  task: string
  facts: Record<string, string>
  interpretationGuardrail: string
  requiredPhraseGroups: string[][]
  forbiddenPhrases: string[]
}

const ROOT = path.resolve(import.meta.dir, "..", "..", "..")
const BACKEND_RESULTS_PATH = path.join(ROOT, "test", "real-paper-chain", "backend-results.json")
const REPORT_PATH = path.join(ROOT, "test", "real-paper-chain", "deepseek-summary-results.json")

function fixed(value: number) {
  return value.toFixed(4)
}

function pValue(value: number) {
  return value === 0 ? "<0.0001" : fixed(value)
}

export function loadSummaryCases(): SummaryCase[] {
  const backend = JSON.parse(fs.readFileSync(BACKEND_RESULTS_PATH, "utf-8")) as {
    panelFe: { results: Array<{ kind: string; outcome: string; coefficient: number; stdError: number; pValue: number; rowsUsed: number }> }
    digitalPanelFe: { coefficient: number; stdError: number; pValue: number; rowsUsed: number }
  }
  const baseline = backend.panelFe.results.find((item) => item.kind === "baseline")!
  const mechanism = backend.panelFe.results.find((item) => item.outcome === "创新指数")!
  return [
    {
      id: "did-baseline-grounded-summary",
      task: "用一段中文总结这次城市和年份双向固定效应基准回归。结论必须克制。",
      facts: {
        核心系数: fixed(baseline.coefficient),
        聚类标准误: fixed(baseline.stdError),
        p值: pValue(baseline.pValue),
        样本量: String(baseline.rowsUsed),
      },
      interpretationGuardrail: "系数方向为正，但统计上不显著；不能据此宣称因果效应。",
      requiredPhraseGroups: [["未达到常用显著性水平", "统计上不显著", "没有足够证据", "不显著"], ["不能", "不应", "无法"]],
      forbiddenPhrases: ["显著正向", "显著促进", "证明了因果"],
    },
    {
      id: "did-mechanism-grounded-summary",
      task: "用一段中文总结把创新指数作为结果变量的机制筛查。不能把单条渠道回归写成中介因果证明。",
      facts: {
        核心系数: fixed(mechanism.coefficient),
        聚类标准误: fixed(mechanism.stdError),
        p值: pValue(mechanism.pValue),
        样本量: String(mechanism.rowsUsed),
      },
      interpretationGuardrail: "这只能称为机制线索、关联证据或统计关联，不能写成中介因果证明。",
      requiredPhraseGroups: [["机制线索", "关联证据", "统计关联"], ["不能", "不足以", "不应", "无法", "不可"]],
      forbiddenPhrases: ["证明了中介", "中介效应成立", "机制已经得到验证"],
    },
    {
      id: "digital-panel-grounded-summary",
      task: "用一段中文总结复合地区键修复后的双向固定效应结果，并说明识别边界。",
      facts: {
        核心系数: fixed(backend.digitalPanelFe.coefficient),
        聚类标准误: fixed(backend.digitalPanelFe.stdError),
        p值: pValue(backend.digitalPanelFe.pValue),
        样本量: String(backend.digitalPanelFe.rowsUsed),
      },
      interpretationGuardrail: "这是控制地区和年份固定效应后的条件相关；除非另有识别设计，不能宣称因果。不得加入平行趋势、处理组或对照组假设。",
      requiredPhraseGroups: [["因果"], ["不能", "不等于", "不足以"]],
      forbiddenPhrases: ["证明了因果", "必然导致", "确定促进", "平行趋势", "处理组", "对照组"],
    },
  ]
}

export function buildGroundedFactLine(summaryCase: SummaryCase) {
  return `${Object.entries(summaryCase.facts)
    .map(([label, value]) => `${label}：${value}`)
    .join("；")}。`
}

function numberTokens(value: string): string[] {
  return value.match(/-?\d+(?:\.\d+)?/g) ?? []
}

export function scoreGroundedSummary(summaryCase: SummaryCase, responseText: string) {
  const allowedNumbers = new Set<string>(Object.values(summaryCase.facts).flatMap((value) => numberTokens(value)))
  const responseNumbers = numberTokens(responseText)
  const missingFacts = [...allowedNumbers].filter((value) => !responseNumbers.includes(value))
  const inventedNumbers = responseNumbers.filter((value) => !allowedNumbers.has(value))
  const missingPhraseGroups = summaryCase.requiredPhraseGroups.filter(
    (group) => !group.some((phrase) => responseText.includes(phrase)),
  )
  const forbiddenFound = summaryCase.forbiddenPhrases.filter((phrase) => responseText.includes(phrase))
  return {
    id: summaryCase.id,
    responseText: responseText.slice(0, 1600),
    allowedNumbers: [...allowedNumbers],
    responseNumbers,
    missingFacts,
    inventedNumbers,
    missingPhraseGroups,
    forbiddenFound,
    passed:
      responseText.trim().length > 0 &&
      missingFacts.length === 0 &&
      inventedNumbers.length === 0 &&
      missingPhraseGroups.length === 0 &&
      forbiddenFound.length === 0,
  }
}

async function runCalibration() {
  const auth = await Auth.get(DEEPSEEK_PROVIDER_ID)
  if (!auth) throw new Error("未找到 DeepSeek 凭据；请先完成 KillStata 的 DeepSeek API Key 配置。")

  return Instance.provide({
    directory: ROOT,
    fn: async () => {
      const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
      const language = await Provider.getLanguage(model)
      const results = []
      for (const summaryCase of loadSummaryCases()) {
        process.stdout.write(`[summary] ${summaryCase.id}\n`)
        const factLine = buildGroundedFactLine(summaryCase)
        const generated = await generateText({
          model: language,
          system: [
            ...SystemPrompt.provider(model),
            ...SystemPrompt.toolCatalog([]),
            "# 结构化结果总结校准\nHarness 已经生成不可变事实行。你只写紧跟其后的一至两句中文解释：不得复述或输出任何阿拉伯数字，不得自行添加识别假设，不得调用工具。",
            `任务：${summaryCase.task}`,
            `Harness 事实行（不要复述）：${factLine}`,
            `解释边界：${summaryCase.interpretationGuardrail}`,
          ].join("\n\n"),
          prompt: "请只输出不含阿拉伯数字的解释句。",
          temperature: 0,
          maxOutputTokens: 3000,
          maxRetries: 0,
        })
        const responseText = `${factLine}${generated.text.trim()}`
        results.push({
          ...scoreGroundedSummary(summaryCase, responseText),
          modelInterpretation: generated.text.slice(0, 1200),
          finishReason: generated.finishReason,
          outputTokens: generated.usage.outputTokens,
        })
      }
      const report = {
        recordedAt: new Date().toISOString(),
        provider: model.providerID,
        model: model.id,
        summary: { total: results.length, passed: results.filter((item) => item.passed).length },
        results,
      }
      fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf-8")
      process.stdout.write(`报告：${REPORT_PATH}\n${JSON.stringify(report.summary)}\n`)
      return report
    },
  })
}

if (import.meta.main) {
  runCalibration().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`DeepSeek 中文总结校准失败：${message.slice(0, 1200)}\n`)
    process.exitCode = 1
  })
}
