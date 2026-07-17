import z from "zod"
import { assertDatasetStageReadyForEstimation } from "@/runtime/workflow"
import { EconometricsTool } from "./econometrics"
import { Tool } from "./tool"

const columnName = z.string().trim().min(1, "列名不能为空")
const canonicalDataSourceFields = {
  datasetId: z.string().trim().min(1, "datasetId 不能为空"),
  stageId: z.string().trim().min(1, "stageId 不能为空"),
}

function validateColumnRoles(
  value: {
    covariates?: string[]
    [key: string]: unknown
  },
  ctx: z.RefinementCtx,
  roleKeys: string[],
) {
  const roles = roleKeys
    .map((key) => [key, value[key]] as const)
    .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string")
  const seen = new Map<string, string>()

  for (const [key, rawName] of roles) {
    const name = rawName.trim()
    const previous = seen.get(name)
    if (previous) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} 不能与 ${previous} 使用同一列`,
      })
    } else {
      seen.set(name, key)
    }
  }

  const covariates = value.covariates ?? []
  if (new Set(covariates).size !== covariates.length) {
    ctx.addIssue({ code: "custom", path: ["covariates"], message: "控制变量不能重复" })
  }
  for (const covariate of covariates) {
    const role = seen.get(covariate)
    if (role) {
      ctx.addIssue({
        code: "custom",
        path: ["covariates"],
        message: `控制变量 ${covariate} 已被用作 ${role}`,
      })
    }
  }
}

function formatValidationError(error: z.ZodError) {
  const details = error.issues.map((issue) => `${issue.path.join(".") || "参数"}：${issue.message}`).join("；")
  return `计量工具参数不合法：${details}`
}

const recommendParameters = z
  .object({
    ...canonicalDataSourceFields,
    dependentVar: columnName.optional().describe("已知的结果变量列名"),
    treatmentVar: columnName.optional().describe("已知的处理或核心解释变量列名"),
    entityVar: columnName.optional().describe("已知的面板个体列名"),
    timeVar: columnName.optional().describe("已知的时间列名"),
  })
  .strict()

const propensityScoreParameters = z
  .object({
    ...canonicalDataSourceFields,
    treatmentVar: columnName.describe("严格以 0/1 编码的处理变量列名"),
    covariates: z.array(columnName).min(1, "至少需要一个处理前协变量").describe("用于估计处理概率的处理前协变量列名"),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateColumnRoles(value, ctx, ["treatmentVar"])
  })

const psmMatchingParameters = z
  .object({
    ...canonicalDataSourceFields,
    dependentVar: columnName.describe("结果变量列名"),
    treatmentVar: columnName.describe("严格以 0/1 编码的处理变量列名"),
    covariates: z.array(columnName).min(1, "至少需要一个处理前协变量").describe("用于倾向得分和匹配后平衡检查的处理前协变量列名"),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateColumnRoles(value, ctx, ["dependentVar", "treatmentVar"])
  })

const psmIpwParameters = z
  .object({
    ...canonicalDataSourceFields,
    dependentVar: columnName.describe("结果变量列名"),
    treatmentVar: columnName.describe("严格以 0/1 编码的处理变量列名"),
    covariates: z.array(columnName).min(1, "至少需要一个处理前协变量").describe("用于倾向得分和加权平衡检查的处理前协变量列名"),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateColumnRoles(value, ctx, ["dependentVar", "treatmentVar"])
  })

const olsParameters = z
  .object({
    ...canonicalDataSourceFields,
    dependentVar: columnName.describe("结果变量列名"),
    treatmentVar: columnName.describe("核心解释变量列名"),
    covariates: z.array(columnName).optional().describe("控制变量列名；不包含结果变量或核心解释变量"),
    covariance: z.enum(["HC1", "HC2", "HC3", "nonrobust"]).default("HC1").describe("标准误类型，默认 HC1"),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateColumnRoles(value, ctx, ["dependentVar", "treatmentVar"])
  })

const panelFeParameters = z
  .object({
    ...canonicalDataSourceFields,
    dependentVar: columnName.describe("结果变量列名"),
    treatmentVar: columnName.describe("随个体和时间变化的核心解释变量列名"),
    covariates: z.array(columnName).optional().describe("控制变量列名"),
    entityVar: columnName.describe("面板个体标识列名"),
    timeVar: columnName.describe("面板时间标识列名"),
    clusterVar: columnName.optional().describe("聚类列名；省略时按 entityVar 聚类"),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateColumnRoles(value, ctx, ["dependentVar", "treatmentVar", "entityVar", "timeVar"])
    if (
      value.clusterVar &&
      [value.dependentVar, value.treatmentVar, ...(value.covariates ?? [])].includes(value.clusterVar)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["clusterVar"],
        message: "聚类列不能同时作为结果变量、核心解释变量或控制变量",
      })
    }
  })

const iv2slsParameters = z
  .object({
    ...canonicalDataSourceFields,
    dependentVar: columnName.describe("结果变量列名"),
    endogenousVar: columnName.describe("内生解释变量列名"),
    instrumentVar: columnName.describe("用户或研究设计明确给出的工具变量列名"),
    instrumentJustification: z
      .string()
      .trim()
      .min(10, "必须说明工具变量的相关性、外生性与排除限制依据")
      .describe("用户或研究设计提供的工具变量识别依据；不能根据列名猜测"),
    covariates: z.array(columnName).optional().describe("外生控制变量列名"),
    covariance: z.enum(["robust", "nonrobust"]).default("robust").describe("IV 推断的协方差类型"),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateColumnRoles(value, ctx, ["dependentVar", "endogenousVar", "instrumentVar"])
  })

async function runLegacyEconometrics(
  params: Parameters<Awaited<ReturnType<typeof EconometricsTool.init>>["execute"]>[0],
  ctx: Tool.Context,
) {
  const legacy = await EconometricsTool.init()
  return legacy.execute(params, ctx)
}

async function runPreparedEconometrics(
  params: Parameters<Awaited<ReturnType<typeof EconometricsTool.init>>["execute"]>[0] & {
    datasetId: string
    stageId: string
  },
  ctx: Tool.Context,
) {
  assertDatasetStageReadyForEstimation({
    sessionID: ctx.sessionID,
    datasetId: params.datasetId,
    stageId: params.stageId,
  })
  return runLegacyEconometrics(params, ctx)
}

export const EconometricsRecommendTool = Tool.define("econometrics_recommend", async () => ({
  description:
    "只分析当前数据的结构、变量类型和可执行的基础计量方法，不运行回归。上传 Excel 后可先调用本工具；不得把变量名当成工具变量有效性的证据。",
  parameters: recommendParameters,
  formatValidationError,
  execute: async (params, ctx) =>
    runLegacyEconometrics(
      {
        methodName: "auto_recommend",
        datasetId: params.datasetId,
        stageId: params.stageId,
        dependentVar: params.dependentVar,
        treatmentVar: params.treatmentVar,
        entityVar: params.entityVar,
        timeVar: params.timeVar,
      },
      ctx,
    ),
}))

export const PropensityScoreConstructionTool = Tool.define("psm_construction", async () => ({
  description:
    "估计每行样本接受处理的倾向得分，并检查得分范围与共同支撑。只用于研究设计诊断；不估计因果效应，不输出 ATE、ATT 或显著性结论。",
  parameters: propensityScoreParameters,
  formatValidationError,
  execute: async (params, ctx) => {
    const legacyResult = await runPreparedEconometrics(
      {
        methodName: "psm_construction",
        datasetId: params.datasetId,
        stageId: params.stageId,
        treatmentVar: params.treatmentVar,
        covariates: params.covariates,
      },
      ctx,
    )
    return {
      ...legacyResult,
      title: "倾向得分诊断",
    }
  },
}))

export const PropensityScoreVisualizationTool = Tool.define("psm_visualize", async () => ({
  description:
    "绘制处理组与对照组的倾向得分分布，检查重叠和共同支撑。只在用户要求查看分布或重叠诊断时调用；不估计因果效应，不输出 ATE、ATT 或显著性结论。",
  parameters: propensityScoreParameters,
  formatValidationError,
  execute: async (params, ctx) => {
    const legacyResult = await runPreparedEconometrics(
      {
        methodName: "psm_visualize",
        datasetId: params.datasetId,
        stageId: params.stageId,
        treatmentVar: params.treatmentVar,
        covariates: params.covariates,
      },
      ctx,
    )
    return {
      ...legacyResult,
      title: "倾向得分分布诊断",
    }
  },
}))

export const PsmMatchingTool = Tool.define("psm_matching", async () => ({
  description:
    "运行固定规则的 1:1 倾向得分最近邻匹配，估计已匹配处理组的 ATT。仅在用户明确要求匹配且已确认处理变量、结果变量和处理前协变量时调用；工具固定 caliper 与匹配规则，不接受自定义比例或阈值。只在匹配后协变量平衡达标时返回效应；不输出 p 值、置信区间或显著性结论。",
  parameters: psmMatchingParameters,
  formatValidationError,
  execute: async (params, ctx) => {
    const legacyResult = await runPreparedEconometrics(
      {
        methodName: "psm_matching",
        datasetId: params.datasetId,
        stageId: params.stageId,
        dependentVar: params.dependentVar,
        treatmentVar: params.treatmentVar,
        covariates: params.covariates,
      },
      ctx,
    )
    return {
      ...legacyResult,
      title: "倾向得分最近邻匹配",
    }
  },
}))

export const PsmIpwTool = Tool.define("psm_ipw", async () => ({
  description:
    "运行固定规则的 Hájek 逆概率加权，估计 ATE。仅在用户明确要求 IPW/逆概率加权且已确认处理变量、结果变量和处理前协变量时调用；不接受自定义目标效应、截尾、裁剪或权重公式。只有所有倾向得分处于固定重叠区间、两组有效样本量均达标且加权协变量平衡达标时才返回效应；不输出 p 值、置信区间或显著性结论。",
  parameters: psmIpwParameters,
  formatValidationError,
  execute: async (params, ctx) => {
    const legacyResult = await runPreparedEconometrics(
      {
        methodName: "psm_ipw",
        datasetId: params.datasetId,
        stageId: params.stageId,
        dependentVar: params.dependentVar,
        treatmentVar: params.treatmentVar,
        covariates: params.covariates,
      },
      ctx,
    )
    return {
      ...legacyResult,
      title: "逆概率加权（IPW）",
    }
  },
}))

export const OlsRegressionTool = Tool.define("ols_regression", async () => ({
  description:
    "运行 OLS 基础回归。仅在用户明确要求 OLS/线性回归，或数据画像支持普通线性基线时调用；结果默认是条件相关，不自动宣称因果。",
  parameters: olsParameters,
  formatValidationError,
  execute: async (params, ctx) =>
    runPreparedEconometrics(
      {
        methodName: "ols_regression",
        datasetId: params.datasetId,
        stageId: params.stageId,
        dependentVar: params.dependentVar,
        treatmentVar: params.treatmentVar,
        covariates: params.covariates,
        options: { cov_type: params.covariance },
      },
      ctx,
    ),
}))

export const PanelFeRegressionTool = Tool.define("panel_fe_regression", async () => ({
  description:
    "运行个体和时间双向固定效应回归，并按指定列或个体列聚类。entity-time 键必须唯一；不满足时直接失败，不得静默改成 pooled OLS。",
  parameters: panelFeParameters,
  formatValidationError,
  execute: async (params, ctx) =>
    runPreparedEconometrics(
      {
        methodName: "panel_fe_regression",
        datasetId: params.datasetId,
        stageId: params.stageId,
        dependentVar: params.dependentVar,
        treatmentVar: params.treatmentVar,
        covariates: params.covariates,
        entityVar: params.entityVar,
        timeVar: params.timeVar,
        clusterVar: params.clusterVar ?? params.entityVar,
        options: { auto_downgrade: false },
      },
      ctx,
    ),
}))

export const Iv2slsTool = Tool.define("iv_2sls", async () => ({
  description:
    "运行线性 IV-2SLS。只在用户或研究设计明确指定工具变量并给出识别依据时调用；不得凭 iv、z、instrument 等列名自动选择工具变量。",
  parameters: iv2slsParameters,
  formatValidationError,
  execute: async (params, ctx) =>
    runPreparedEconometrics(
      {
        methodName: "iv_2sls",
        datasetId: params.datasetId,
        stageId: params.stageId,
        dependentVar: params.dependentVar,
        treatmentVar: params.endogenousVar,
        covariates: params.covariates,
        options: {
          iv_variable: params.instrumentVar,
          instrument_justification: params.instrumentJustification,
          cov_type: params.covariance,
        },
      },
      ctx,
    ),
}))

export const ProductionEconometricsTools = [
  EconometricsRecommendTool,
  PropensityScoreConstructionTool,
  PropensityScoreVisualizationTool,
  PsmMatchingTool,
  PsmIpwTool,
  OlsRegressionTool,
  PanelFeRegressionTool,
  Iv2slsTool,
] as const
