import { describe, expect, test } from "bun:test"
import {
  detectExplicitVariableSubstitution,
  explicitUserVariableValue,
  detectConfirmedVariableSubstitution,
  isQualityInspectionOnlyRequest,
  confirmsPolicyConstructionAnswer,
  policyConstructionFollowUpNotice,
  needsPolicyConstructionConfirmation,
  needsRelativeTimeConstructionConfirmation,
  needsEventStudyNeverTreatedConfirmation,
  shouldAskVariableSubstitution,
  variableSubstitutionConfirmationKey,
  suggestColumnReplacement,
  isRecommendationOnlyRequest,
  allowsExplicitCompositePanelRepair,
  shouldStopAfterDid2sFrequency,
  requiresPostImportProfile,
} from "@/session/prompt/tools"

describe("工具编排的用户变量确认", () => {
  test("普通变量和缺失查看复用导入摘要，明确画像请求才追加profile", () => {
    expect(requiresPostImportProfile("帮我看下数据有哪些变量、多少行、有没有缺失")).toBe(false)
    expect(requiresPostImportProfile("导入后完成数据画像，再决定是否回归")).toBe(true)
    expect(requiresPostImportProfile("请调用profile获取当前阶段完整字段")).toBe(true)
  })

  test("显式切换 did2s 后只允许一次必要频数检查", () => {
    expect(shouldStopAfterDid2sFrequency({ userText: "请改用两阶段 DID（did2s）", frequencyChecks: 0 })).toBe(false)
    expect(shouldStopAfterDid2sFrequency({ userText: "请改用两阶段 DID（did2s）", frequencyChecks: 1 })).toBe(true)
    expect(shouldStopAfterDid2sFrequency({ userText: "做传统双重差分 DID", frequencyChecks: 4 })).toBe(false)
    expect(shouldStopAfterDid2sFrequency({ userText: "不要改成 did2s，先检查处理组和政策后分布", frequencyChecks: 1 })).toBe(false)
    expect(shouldStopAfterDid2sFrequency({ userText: "传统 DID 不适用交错处理，但先看 year 分布", frequencyChecks: 1 })).toBe(false)
    expect(shouldStopAfterDid2sFrequency({ userText: "做传统 DID，不适用交错处理，先看 year 分布", frequencyChecks: 1 })).toBe(false)
    expect(shouldStopAfterDid2sFrequency({ userText: "做个交错 DID 事件研究", frequencyChecks: 0 })).toBe(false)
    expect(shouldStopAfterDid2sFrequency({ userText: "做个交错 DID 事件研究", frequencyChecks: 1 })).toBe(true)
    expect(shouldStopAfterDid2sFrequency({ userText: "不要做交错 DID，先看 year 分布", frequencyChecks: 1 })).toBe(false)
  })

  test("用户明确写出的时间变量与模型实际参数不一致时识别为待确认替换", () => {
    expect(
      detectExplicitVariableSubstitution({
        userText: "做双向固定效应，实体=地区，时间=year。",
        field: "timeVar",
        actualValue: "年份",
      }),
    ).toEqual({ field: "timeVar", requestedValue: "year", actualValue: "年份" })
  })

  test("用户与模型使用同一变量时不触发确认", () => {
    expect(
      detectExplicitVariableSubstitution({
        userText: "实体=地区，时间=年份。",
        field: "timeVar",
        actualValue: "年份",
      }),
    ).toBeUndefined()
  })

  test("明确否定的变量赋值不视为用户指定的研究列", () => {
    expect(
      detectExplicitVariableSubstitution({
        userText: "不要使用 时间=年份。",
        field: "timeVar",
        actualValue: "year",
      }),
    ).toBeUndefined()
  })

  test("赋值后的否定也不视为用户当前指定的研究列", () => {
    for (const userText of [
      "时间=年份，但不要使用这列。",
      "时间=年份，但这列不应使用。",
    ]) {
      expect(explicitUserVariableValue({ userText, field: "timeVar" })).toBeUndefined()
    }
  })

  test("正向变量角色规格可以提取用户给定的精确列名", () => {
    expect(explicitUserVariableValue({
      userText: "做面板回归：实体=地区，时间=年份；因变量=绿色金融指数。",
      field: "timeVar",
    })).toBe("年份")
  })

  test("用户明确点名的核心解释变量被模型换成相近列名时识别为待确认替换", () => {
    const substitution = detectExplicitVariableSubstitution({
      userText: "跑OLS：被解释变量=创新指数，核心解释变量=城镇化率。",
      field: "treatmentVar",
      actualValue: "城镇化水平",
    })

    expect(substitution).toEqual({
      field: "treatmentVar",
      requestedValue: "城镇化率",
      actualValue: "城镇化水平",
    })
    expect(shouldAskVariableSubstitution({ substitution, confirmed: new Set() })).toBe(true)
  })

  test("模型的变量确认问题得到肯定回答后可记录为同一动作的已确认替换", () => {
    const substitution = detectConfirmedVariableSubstitution({
      userText: "跑OLS：被解释变量=创新指数，核心解释变量=城镇化率。",
      question: "数据中无'城镇化率'列，但有'城镇化水平'列，是否使用该列作为核心解释变量？",
      answer: "使用城镇化水平",
    })

    expect(substitution).toEqual({
      field: "treatmentVar",
      requestedValue: "城镇化率",
      actualValue: "城镇化水平",
    })
  })

  test("模型只给缺失列选项时也能记录确认，避免门禁再次提问", () => {
    expect(detectConfirmedVariableSubstitution({
      userText: "导入 did.xlsx，跑 OLS：被解释变量=创新指数，核心解释变量=城镇化率",
      question: "核心解释变量「城镇化率」在当前数据中未找到，请确认使用哪一列？",
      answer: "城镇化水平",
    })).toEqual({
      field: "treatmentVar",
      requestedValue: "城镇化率",
      actualValue: "城镇化水平",
    })
  })

  test("中文直角引号包裹的变量确认问题也能记录替换", () => {
    expect(detectConfirmedVariableSubstitution({
      userText: "跑OLS：被解释变量=创新指数，核心解释变量=城镇化率。",
      question: "核心解释变量「城镇化率」在数据中不存在，仅有「城镇化水平」。是否使用该列？",
      answer: "替换为城镇化水平",
    })).toEqual({
      field: "treatmentVar",
      requestedValue: "城镇化率",
      actualValue: "城镇化水平",
    })
  })

  test("模型只说实际列名时也能识别同一替换，避免重复提问", () => {
    expect(detectConfirmedVariableSubstitution({
      userText: "跑OLS：被解释变量=创新指数，核心解释变量=城镇化率。",
      question: "核心解释变量在数据中显示为'城镇化水平'，是否使用该列？",
      answer: "使用城镇化水平",
    })).toEqual({
      field: "treatmentVar",
      requestedValue: "城镇化率",
      actualValue: "城镇化水平",
    })
  })

  test("模型先说真实列名再说用户写法时也能识别同一替换", () => {
    expect(detectConfirmedVariableSubstitution({
      userText: "跑OLS：被解释变量=创新指数，核心解释变量=城镇化率。",
      question: "当前数据中列名为'城镇化水平'，没有'城镇化率'列。是否使用'城镇化水平'作为核心解释变量？",
      answer: "使用'城镇化水平'",
    })).toEqual({
      field: "treatmentVar",
      requestedValue: "城镇化率",
      actualValue: "城镇化水平",
    })
  })

  test("缺失列只给出无歧义或高相似候选，不猜测研究设计变量", () => {
    expect(suggestColumnReplacement("year", ["年份", "地区"])).toBe("年份")
    expect(suggestColumnReplacement("城镇化率", ["城镇化水平", "人口密度"])).toBe("城镇化水平")
    expect(suggestColumnReplacement("post", ["year", "did", "time"])).toBeUndefined()
  })

  test("只问方法推荐时收束当前模型轮，明确要求执行时重新开放工具", () => {
    expect(isRecommendationOnlyRequest("我想研究政策对创新指数的影响，但不知道该用什么计量方法。")).toBe(true)
    expect(isRecommendationOnlyRequest("推荐一个方法并直接跑回归")).toBe(false)
    expect(isRecommendationOnlyRequest("就用你说的方法跑一下")).toBe(false)
  })

  test("用户明确授权复合键修复时继续交给模型执行，否则保留决策停点", () => {
    expect(allowsExplicitCompositePanelRepair({
      userText: "地区重复时不要删除行，请用省份和地区构造复合实体键，重新质检后估计。",
      duplicateEntityTimeKey: true,
    })).toBe(true)
    expect(allowsExplicitCompositePanelRepair({
      userText: "做面板固定效应回归。",
      duplicateEntityTimeKey: true,
    })).toBe(false)
    expect(allowsExplicitCompositePanelRepair({
      userText: "不要删除行，请检查重复键。",
      duplicateEntityTimeKey: false,
    })).toBe(false)
    expect(allowsExplicitCompositePanelRepair({
      userText: "不要使用省份+地区复合实体键，先停下等我确认。",
      duplicateEntityTimeKey: true,
    })).toBe(false)
    expect(allowsExplicitCompositePanelRepair({
      userText: "省份+地区复合实体键不要使用；等待我提供其他方案。",
      duplicateEntityTimeKey: true,
    })).toBe(false)
    expect(allowsExplicitCompositePanelRepair({
      userText: "如果地区×年份重复，先问我是否用省份+地区构造复合实体键，等我确认后再继续。",
      duplicateEntityTimeKey: true,
    })).toBe(false)
    expect(allowsExplicitCompositePanelRepair({
      userText: "地区重复时不要删除行，请用省份和地区构造复合实体键。",
      duplicateEntityTimeKey: false,
    })).toBe(false)
  })

  test("同一用户动作已确认的变量替换不应在下一模型回合重复提问", () => {
    const substitution = detectExplicitVariableSubstitution({
      userText: "做双向固定效应，实体=地区，时间=year。",
      field: "timeVar",
      actualValue: "年份",
    })
    const confirmed = new Set<string>()

    expect(shouldAskVariableSubstitution({ substitution, confirmed })).toBe(true)
    confirmed.add(variableSubstitutionConfirmationKey(substitution!))
    expect(shouldAskVariableSubstitution({ substitution, confirmed })).toBe(false)
  })

  test("只读质量体检才启用内部结果读取保护，明确清洗或完整报告时不启用", () => {
    expect(isQualityInspectionOnlyRequest("帮我看下数据质量：有没有重复、缺失、异常值？给我个结论。")).toBe(true)
    expect(isQualityInspectionOnlyRequest("帮我看下 did.xlsx 有哪些变量、多少行、有没有缺失，不用做回归分析。")).toBe(true)
    expect(isQualityInspectionOnlyRequest("导入 did.xlsx，完成数据画像，本轮不要做回归。")).toBe(true)
    expect(isQualityInspectionOnlyRequest("检查异常值后做1%缩尾并重新回归")).toBe(false)
    expect(isQualityInspectionOnlyRequest("读取完整质量报告和原始明细")).toBe(false)
  })

  test("数据质量检查并请求方法推荐时同时保留只读质检与推荐意图", () => {
    const request = "导入 did.xlsx，检查数据缺失与质量问题，并推荐几个可行的计量方法。"
    expect(isQualityInspectionOnlyRequest(request)).toBe(true)
    expect(isRecommendationOnlyRequest(request)).toBe(true)
  })

  test("变量名中的质量二字不能把计量任务误判成只读质量体检", () => {
    expect(isQualityInspectionOnlyRequest("导入 did.xlsx，跑 OLS：创新指数 ~ 高质量发展指数，跑完解读系数。")).toBe(false)
    expect(isQualityInspectionOnlyRequest("用高质量发展指数解释创新指数，做普通最小二乘回归。")).toBe(false)
  })

  test("明确要求事件研究时，缺失cohort的确认条件不能把分析工具池收窄成只读质检", () => {
    expect(isQualityInspectionOnlyRequest(
      "导入 did.xlsx。time 是首次处理年份，缺失代表从未处理，did 按 cohort>0 且 year>=cohort 定义。请做交错事件研究；如果需要将缺失 cohort 编码为0，先问我，不要自动转换。",
    )).toBe(false)
    expect(isQualityInspectionOnlyRequest("导入 did.xlsx，检查数据缺失和质量，本轮不要做交错事件研究。请给我数据质量结论。")).toBe(true)
    expect(isQualityInspectionOnlyRequest("导入 did.xlsx，先检查缺失，不用做回归，之后明确做交错事件研究。")).toBe(false)
    expect(isQualityInspectionOnlyRequest("检查数据质量，不做回归而是明确做交错事件研究。")).toBe(false)
  })

  test("明确要求传统 DID 时，提及原始数据重复不能把分析工具池收窄成只读质检", () => {
    expect(isQualityInspectionOnlyRequest(
      "请按 treated 与波次 t 做传统 2×2 DID，因变量 fte；原始 sheet 号有重复，不要把它当成唯一单位。",
    )).toBe(false)
    expect(isQualityInspectionOnlyRequest(
      "使用双重差分估计处理效应，同时说明数据重复情况。",
    )).toBe(false)
  })

  test("明确请求其他已准入方法时，质量词不能把分析工具池收窄成只读质检", () => {
    const requests = [
      "导入后检查缺失和重复，再做双向固定效应。",
      "先检查缺失，再运行 WLS。",
      "检查异常值后，拟合随机效应模型。",
      "检查缺失后，比较双向固定效应模型。",
      "检查异常值后，估计面板 FE。",
      "检查缺失后，使用随机效应模型。",
      "先检查数据重复，再用高维固定效应（HDFE）。",
      "检查异常值后，请用 WLS。",
      "先检查缺失，再做 Poisson/PPML。",
      "检查缺失后，请用负二项。",
      "先检查异常值，再做 MNL。",
      "检查数据缺失后，使用 IV。",
      "检查缺失后，做双重稳健。",
      "检查缺失后，做分位数。",
      "检查缺失后，做熵权 TOPSIS 综合评价。",
    ]

    expect(requests.filter(isQualityInspectionOnlyRequest)).toEqual([])
  })

  test("事件研究never-treated零编码的后置否定优先于前置确认", () => {
    const args = {
      neverTreatedCohortValue: 0,
      cohortVar: "time",
      treatmentVar: "did",
      timeVar: "year",
    }
    const confirmed = "我确认 time 缺失表示从未处理并映射为0；did必须逐行等于time>0且year>=time。"

    expect(needsEventStudyNeverTreatedConfirmation({
      methodID: "did_event_study_saturated",
      userText: confirmed,
      args,
    })).toBe(false)
    expect(needsEventStudyNeverTreatedConfirmation({
      methodID: "did_event_study_saturated",
      userText: `${confirmed}但不要按0编码。`,
      args,
    })).toBe(true)
    expect(needsEventStudyNeverTreatedConfirmation({
      methodID: "did_event_study_saturated",
      userText: `${confirmed}但did不应满足time>0且year>=time。`,
      args,
    })).toBe(true)
    for (const contradictoryText of [
      `${confirmed}但别把time缺失映射为0。`,
      `${confirmed}但time缺失不表示从未处理。`,
    ]) {
      expect(needsEventStudyNeverTreatedConfirmation({
        methodID: "did_event_study_saturated",
        userText: contradictoryText,
        args,
      })).toBe(true)
    }
  })

  test("构造post时没有用户规则必须进入确认门禁", () => {
    const args = {
      method: "create_column",
      columns: ["year"],
      options: { operator: "gte", right_column: "time", output_column: "post" },
    }
    expect(needsPolicyConstructionConfirmation({ userText: "post不存在则先构造", args })).toBe(true)
    expect(needsPolicyConstructionConfirmation({ userText: "按year>=2013构造post", args })).toBe(false)
    expect(needsPolicyConstructionConfirmation({ userText: "构造一个新指标", args: { ...args, options: { ...args.options, output_column: "flag" } } })).toBe(false)
  })

  test("create_relative_time 必须由用户明确确认精确公式与 never-treated 编码", () => {
    const args = {
      method: "create_relative_time",
      columns: [],
      options: {
        entity_var: "地区",
        time_var: "year",
        cohort_var: "time",
        treatment_var: "did",
        output_column: "relative_time",
      },
    }

    expect(needsRelativeTimeConstructionConfirmation({
      userText: "time 是首次处理年；若 relative_time 不存在，先问我，不要自动构造。",
      args,
    })).toBe(true)
    expect(needsRelativeTimeConstructionConfirmation({ userText: "确认", args })).toBe(true)
    expect(needsRelativeTimeConstructionConfirmation({
      userText: "我确认按 year - time 为每个地区构造 relative_time，did 必须和 year>=time 一致，从未处理组设为 -inf。",
      args,
    })).toBe(false)
    expect(needsRelativeTimeConstructionConfirmation({
      userText: "我不确认按 year - time 构造 relative_time；从未处理组设为 -inf。",
      args,
    })).toBe(true)
    expect(needsRelativeTimeConstructionConfirmation({
      userText: "我确认按 year + time 构造 relative_time，did 与 cohort 一致，从未处理组设为 -inf。",
      args,
    })).toBe(true)
  })

  test("用户已明确给出 year 与 time 的逐行比较规则时不重复询问", () => {
    const args = {
      method: "create_column",
      columns: ["year"],
      options: { operator: "gte", right_column: "time", output_column: "post" },
    }
    expect(needsPolicyConstructionConfirmation({
      userText: "如果post不存在则先构造：year >= time 时 post=1",
      args,
    })).toBe(false)
  })

  test("create_relative_time 仅在用户确认精确公式和从未处理编码后允许写入", () => {
    const args = {
      method: "create_relative_time",
      columns: [],
      options: {
        entity_var: "地区",
        time_var: "year",
        cohort_var: "time",
        treatment_var: "did",
        output_column: "relative_time",
      },
    }

    expect(needsRelativeTimeConstructionConfirmation({
      userText: "time 是首次处理年；若 relative_time 不存在，先问我，不要自动构造。",
      args,
    })).toBe(true)
    expect(needsRelativeTimeConstructionConfirmation({ userText: "确认", args })).toBe(true)
    expect(needsRelativeTimeConstructionConfirmation({
      userText: "我确认按 year - time 为每个地区构造 relative_time，did 必须和 year>=time 一致，从未处理组设为 -inf。",
      args,
    })).toBe(false)
    expect(needsRelativeTimeConstructionConfirmation({
      userText: "我不确认按 year - time 为每个地区构造 relative_time；从未处理组设为 -inf。",
      args,
    })).toBe(true)
    expect(needsRelativeTimeConstructionConfirmation({
      userText: "我确认按 year + time 为每个地区构造 relative_time，did 与 cohort 一致，从未处理组设为 -inf。",
      args,
    })).toBe(true)
  })

  test("相对时期授权不得把列名子串或被否定的编码当作精确确认", () => {
    const userText = "我确认按 year - time 为每个地区构造 relative_time；did 必须和 year>=time 一致，从未处理组设为 -inf。"
    const args = {
      method: "create_relative_time",
      columns: [],
      options: {
        entity_var: "地区",
        time_var: "year",
        cohort_var: "time",
        treatment_var: "did",
        output_column: "relative_time",
      },
    }

    expect(needsRelativeTimeConstructionConfirmation({ userText, args: {
      ...args,
      options: { ...args.options, output_column: "relative" },
    } })).toBe(true)
    expect(needsRelativeTimeConstructionConfirmation({ userText, args: {
      ...args,
      options: { ...args.options, treatment_var: "id" },
    } })).toBe(true)
    expect(needsRelativeTimeConstructionConfirmation({ userText, args: {
      ...args,
      options: { ...args.options, entity_var: "地" },
    } })).toBe(true)
    expect(needsRelativeTimeConstructionConfirmation({
      userText: "我确认按 year - time 构造 relative_time；did 不应等于 year>=time，从未处理组设为 -inf。",
      args,
    })).toBe(true)
    expect(needsRelativeTimeConstructionConfirmation({
      userText: "我确认按 year - time 构造 relative_time；did 必须和 year>=time 一致，但从未处理组不要设为 -inf。",
      args,
    })).toBe(true)
    for (const candidate of [
      `${userText}但先别执行。`,
      `${userText}我撤回这项授权。`,
    ]) {
      expect(needsRelativeTimeConstructionConfirmation({ userText: candidate, args })).toBe(true)
    }
  })

  test("选择分析窗口不能代替确认具体post规则", () => {
    expect(confirmsPolicyConstructionAnswer("仅用2012—2014窗口（推荐）")).toBe(false)
    expect(confirmsPolicyConstructionAnswer("按time列逐行比较")).toBe(false)
    expect(confirmsPolicyConstructionAnswer("确认按此规则构造")).toBe(true)
    expect(confirmsPolicyConstructionAnswer("按个体时点构造（推荐）")).toBe(true)
    expect(confirmsPolicyConstructionAnswer("固定政策年2013")).toBe(true)
    expect(confirmsPolicyConstructionAnswer("year>=2013")).toBe(true)
  })

  test("确认post规则后给模型明确的下一步，不再继续盲目探查", () => {
    expect(policyConstructionFollowUpNotice("按个体时点构造（推荐）")).toContain("data_preprocess")
    expect(policyConstructionFollowUpNotice("按个体时点构造（推荐）")).toContain("不要再次用 frequency/profile 探查")
    expect(policyConstructionFollowUpNotice("我不清楚time含义")).toBe("")
  })
})
