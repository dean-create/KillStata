import z from "zod"
import { Tool } from "./tool"
import { ToolModel } from "./model-contracts"
import type { AnalysisSpecPreparationResult } from "@/runtime/services/analysis-spec-service"

const AnalysisPrepareInput = z.object({
  requestId: z.string().trim().min(1).describe("必须使用当前 system 运行时上下文中 AnalysisRequest 提供的 requestId；不得猜测或复用历史请求，也不要向用户展示。"),
  methodID: z.string().trim().min(1).describe("通过 tool_search 获得完整 Python Registry Schema 的原始方法 ID。"),
  arguments: z.record(z.string(), z.unknown()).describe("严格按该方法完整 JSON Schema 填写的研究参数；不要传 datasetId、stageId、data_path 或其他 Harness 血缘字段。"),
}).strict()

export const AnalysisPrepareTool = Tool.define("analysis_prepare", Tool.Execution.session, ToolModel.forTool("analysis_prepare"), {
  description:
    "登记 estimate 请求的候选规格，或在 inspect 请求中只检查候选方法是否适配；调用 Python Registry/Pydantic 校验参数，并对 Harness 选定的当前数据阶段运行只读 preflight。它不执行估计，也不代表用户确认研究语义变化。必须先登记 AnalysisRequest 并通过 tool_search 获得完整方法 Schema；只有 estimate 请求、当前数据诊断指纹匹配且 preflight ready 时才生成可执行 specId。",
  parameters: AnalysisPrepareInput,
  async execute(params, ctx) {
    const handler = ctx.extra?.prepareAnalysisSpec as
      ((input: z.infer<typeof AnalysisPrepareInput>) => Promise<AnalysisSpecPreparationResult>) | undefined
    if (!handler) {
      throw new Tool.InputValidationError("Harness 未提供分析规格准备服务；本次没有校验数据或运行估计。请保留当前用户消息，不要绕过 Harness 直接调用 Python。")
    }
    const prepared = await handler(params)
    const requiresUserDecision = !prepared.authorizedRepair && [
      "clarification_required",
      "requires_user_decision",
      "repairable",
      "incompatible",
    ].includes(prepared.status)
    const preflight = prepared.spec?.preflight
    return {
      title: prepared.status === "ready"
        ? "分析规格已通过预检"
        : prepared.status === "schema_not_sent"
          ? "请先加载完整方法 Schema"
          : prepared.status === "diagnosis_refresh_required"
          ? "需要刷新当前数据诊断"
          : prepared.status === "clarification_required"
            ? "分析规格需要澄清"
            : "当前方法尚未达到可执行条件",
      output: prepared.userSpecifiedCorrections?.length
        ? `${prepared.message}\n\n参数恢复：${prepared.userSpecifiedCorrections.map((item) => `${item.field}从误传的“${item.modelValue}”恢复为你本条消息中明确指定且数据存在的“${item.userValue}”`).join("；")}；没有改变其他变量角色或方法。`
        : prepared.message,
      metadata: {
        analysisSpecStatus: prepared.status,
        requiresUserDecision,
        repairOnly: requiresUserDecision,
        ...(preflight ? {
          preflightStatus: preflight.status,
          issues: preflight.issues,
          repairPlan: preflight.repairPlan,
        } : {}),
        ...(prepared.issueCode ? { issueCode: prepared.issueCode } : {}),
        ...(prepared.issues ? { issues: prepared.issues } : {}),
        ...(prepared.userSpecifiedCorrections
          ? { userSpecifiedParameterCorrections: prepared.userSpecifiedCorrections }
          : {}),
        ...(prepared.authorizedRepair ? { authorizedRepair: prepared.authorizedRepair } : {}),
        ...(prepared.missingFields ? { missingFields: prepared.missingFields } : {}),
        ...(prepared.spec ? {
          analysisSpec: {
            specId: prepared.spec.specId,
            revision: prepared.spec.revision,
            methodID: prepared.spec.methodID,
            status: prepared.spec.status,
          },
        } : {}),
        ...(prepared.preparedSpec ? {
          preparedSpec: {
            specId: prepared.preparedSpec.specId,
            revision: prepared.preparedSpec.revision,
            methodID: prepared.preparedSpec.methodID,
          },
        } : {}),
        estimateExecuted: false,
      },
    }
  },
})
