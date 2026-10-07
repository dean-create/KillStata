/**
 * UX 断言纯函数：衡量"模型和用户交互得好不好"——最终报告质量、进度提示、提问质量。
 *
 * 与工具断言（无 error、estimate 完成、不死锁）互补：工具断言保证"系统没坏"，
 * UX 断言保证"用户看得懂、被照顾到"。刻意宽松——只断言"有数字/有方法/是中文"，
 * 不断言具体数值、不校验解读对错（grounding 正确性由"数字只读"铁律兜底），
 * 避免模型风格差异导致误报。
 */

import { isWorkflowEstimateTool } from "@/runtime/tool-catalog"

/** 方法名关键词（报告里出现任一即算"说明了用什么方法"） */
const METHOD_KEYWORDS = [
  "OLS",
  "面板",
  "固定效应",
  "双重差分",
  "DID",
  "IV",
  "工具变量",
  "两阶段",
  "事件研究",
  "logit",
  "probit",
  "分位数",
  "倾向得分",
  "PSM",
  "回归",
  "RDD",
  "断点",
] as const

/** 数字正则：系数、样本量、p 值、R² 等任意数值形态 */
const NUMBER_RE = /(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)/

/** 内部工作区泄漏标记（.killstata 用户不可感知约束） */
const INTERNAL_LEAK_RE = /\.killstata|datasetId|stageId|workflowRunId|parquet\b/

/**
 * 报告质量：最终回复是否"像一份能看懂的结论"。
 * - 说了方法（出现方法名关键词）
 * - 有数字（系数/样本量/显著性等任意数值）
 * - 中文（中文字符占比 > 阈值）
 * - 不泄漏内部工作区（.killstata / datasetId / 绝对路径）
 */
export function reportQuality(text: string): {
  pass: boolean
  method: boolean
  hasNumber: boolean
  isChinese: boolean
  noInternalLeak: boolean
} {
  const method = METHOD_KEYWORDS.some((keyword) => text.includes(keyword))
  const hasNumber = NUMBER_RE.test(text)
  const cjkChars = (text.match(/[一-鿿]/g) ?? []).length
  const totalChars = text.replace(/\s/g, "").length || 1
  const isChinese = cjkChars / totalChars > 0.2
  const noInternalLeak = !INTERNAL_LEAK_RE.test(text)
  return { pass: method && hasNumber && isChinese && noInternalLeak, method, hasNumber, isChinese, noInternalLeak }
}

/**
 * 进度提示：中途（非首条非末条）有 assistant 文本说明模型边跑边汇报。
 * 首条通常是复述任务，末条是最终报告；只有中间也有文本才算"有进度提示"。
 */
export function hasProgressNotes(texts: string[], toolProgress: string[] = []): boolean {
  if (toolProgress.some((text) => text.trim().length >= 12)) return true
  if (texts.length < 3) return false
  const middle = texts.slice(1, -1)
  return middle.some((text) => text.trim().length > 20)
}

/** 某轮是否有实质回应（≥20 字符非空文本）：多轮场景"追问得到回答"的基本体验。
 * 刻意宽松——不断言回答内容正确性（grounding 由"数字只读"铁律兜底），
 * 只断言模型没哑火/没只回"好的"这类空话。 */
export function turnHasSubstance(texts: string[]): boolean {
  return texts.some((text) => text.trim().length >= 20)
}

/**
 * 只检测与时间语境相邻的猜测性表述；不能把“可能存在遗漏变量”这类研究限制
 * 误报成猜测年份。该函数供场景断言复用，避免每个场景各写一套宽泛正则。
 */
export function hasUnsupportedTimeClaim(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    if (!/(?:时间|时期|年份|year)/i.test(line)) return false

    // 只拦截对时间数量/范围的无证据猜测。诸如“时间=year”或“随时间变化的遗漏
    // 变量仍可能存在”是已核验的变量名/研究限制，不应被当成猜测性日期。
    const concreteTimeClaim = /(?:\d{4}\s*(?:年)?(?:\s*[-—~至到]\s*\d{2,4}\s*年?)?|\d+\s*(?:个)?(?:时期|期|年)|若干期|未知|不确定)/i
    // “约”必须带数量才算模糊限定词：裸“约”会命中“约束/预约/制约”等实词，
    // 把“受样本约束，时间维度覆盖 2010—2020 年”这类事实陈述误报成猜测年份。
    return [...line.matchAll(/(?:左右|大?约(?=\s*[\d一二三四五六七八九十两几])|可能|[？?])/gi)].some((match) => {
      const start = Math.max(0, (match.index ?? 0) - 30)
      const end = Math.min(line.length, (match.index ?? 0) + 30)
      return concreteTimeClaim.test(line.slice(start, end))
    })
  })
}

/** 工具名是否估计器（不越权断言用）。复用 runtime 的准入派生列表——硬编码一份会漏掉
 * 新准入的估计器或改名后不同步（2026-08-11 simplify 审查：ESTIMATOR_TOOL_IDS 手写
 * 列表与 tool-catalog 重复）。签名收 `{ tool }` 对象数组，调用点不必先 `.map(t => t.tool)`。 */

export function calledEstimator(tools: Array<{ tool: string }>): boolean {
  return tools.some((tool) => isWorkflowEstimateTool(tool.tool))
}

// ── 工具错误判定（drive 硬 pass 的"无工具错误"）──────────────────────

/**
 * 设计内防护错误：门禁/守卫在正常工作，不是系统 bug，drive 不判失败。
 * 对应场景：
 *   - 门禁拒绝（"计量估计前必须先…"）：模型跳过 profile/QA 被 gate 拦，修复后继续
 *   - read 保护（"Refusing to read a … dataset as text"）：第十三轮加的保护
 *   - REPAIR_* 守卫：修复循环契约守卫
 *   - QA gate blocked：重复键/质检阻断是门禁在拦，模型需修复后重跑
 *
 * 与 src/runtime/failure-reflection.ts 的错误分类是**耦合的两套词表**（语义不同：
 * 那边做修复路由，这边做 hard-pass 过滤，但底层是同一批 gate 文案）——改动任一
 * 门禁文案时两处都要同步，否则 drive 的通过判定与修复指引会静默分叉（2026-08-12
 * simplify review 提示）。
 */
const DESIGNED_GUARD_ERRORS = [
  "计量估计前必须",
  "数据预处理前必须",
  "必须先完成当前 canonical stage",
  "Refusing to read",
  "REPAIR_INPUT_UNCHANGED",
  "REPAIR_TOOL_MISMATCH",
  "REPAIR_WORKFLOW_MUTATION_DENIED",
  "Data operation blocked by QA gate",
  "数据动作被 QA 门禁阻断",
  "数据动作被 数据质量检查阻断",
  "文件路径不能为空",
  "没有安全的分位数分箱能力",
] as const

/**
 * ENOENT / File not found 是第五/六轮 artifact 路径基准分裂 bug 的错误签名
 *（"File not found: .killstata/datasets/xxx/audit/…"），**不能整体豁免**——否则路径
 * 回归会被全绿放行（2026-08-11 review F3）。只豁免**文件系统探索工具**（read/list/
 * glob——模型收尾猜产物子路径的无害波折）；data_import/估计器/verifier 的 ENOENT
 * 一律算失败（它们报 ENOENT 说明产物解析真的断了）。
 */
const FS_EXPLORE_TOOLS = new Set(["read", "list", "glob"])

export function isFsExplorePathWave(error: { tool: string; error: string }): boolean {
  return (
    FS_EXPLORE_TOOLS.has(error.tool) &&
    /ENOENT|No such file or directory|File not found|找不到文件|文件不存在|路径不存在/.test(error.error)
  )
}

/**
 * 过滤掉设计内防护 + 无害波折后的"真实错误"。drive 的"无工具错误"判定用它，
 * 对**所有**场景一致生效（不按估计是否完成分叉——分叉会让追问场景走无白名单
 * 分支，与估计场景判定标准不一致，2026-08-11 review F5）。
 */
export function filterRealErrors(
  toolErrors: Array<{ tool: string; error: string }>,
  recovery?: {
    questionCount?: number
    questionEvents?: Array<{ prompt: string; options: string[] }>
    toolCalls?: Array<{ tool: string; args?: string; status?: string }>
    estimateCompleted?: boolean
    assistantText?: string
  },
): Array<{ tool: string; error: string }> {
  const isFourCellDesignError = (error: { tool: string; error: string }) =>
    error.tool === "did_static" && /传统\s*(?:2[×x*]2\s*)?DID[^。\n]*(?:四个样本单元|四格样本结构)/i.test(error.error)
  const hasFourCellDesignStop =
    toolErrors.some(isFourCellDesignError) ||
    /传统\s*(?:2[×x*]2\s*)?DID[^。\n]*(?:四个样本单元|四格样本结构)/i.test(recovery?.assistantText ?? "")

  // 真实 runner 会把失败调用和后续调用按时间顺序记录在同一 turn。没有失败调用
  // 的旧单测 fixture 仍按历史语义兼容；一旦存在失败调用，恢复证据必须发生在它之后。
  const hasLaterSuccessfulCall = (
    tool: string,
    predicate: (call: { tool: string; args?: string; status?: string }) => boolean,
  ) => {
    const calls = recovery?.toolCalls ?? []
    const failureIndex = calls.findIndex((call) => call.tool === tool && call.status === "error")
    return calls.some((call, index) => predicate(call) && (failureIndex < 0 || index > failureIndex))
  }

  const recoveredMissingVariable = (error: string) => {
    const match = error.match(/找不到以下变量：\s*\[([^\]]*)\]/)
    if (!match || (recovery?.questionCount ?? 0) <= 0 || recovery?.estimateCompleted !== true) return false
    const missing = match[1]!
      .split(",")
      .map((item) => item.replace(/[\s'"`]/g, ""))
      .filter(Boolean)
    if (!missing.length) return false
    const questions = recovery.questionEvents ?? []
    const askedAboutMissing = questions.some((question) => {
      const text = `${question.prompt} ${question.options.join(" ")}`
      return missing.some((name) => text.includes(name))
    })
    if (!askedAboutMissing) return false
    const calls = recovery.toolCalls ?? []
    // 必须是**成功**的估计调用才算替代变量真的进入估计：失败的估计调用即使不含缺失
    // 变量也只是又一次波折，不构成恢复证据（与下面 createdByPreprocess 分支同一口径）。
    const replacedByEstimator = hasLaterSuccessfulCall("data_import", (call) =>
      isWorkflowEstimateTool(call.tool) &&
      call.status === "completed" &&
      typeof call.args === "string" &&
      missing.every((name) => !call.args!.includes(name)),
    )
    if (replacedByEstimator) return true

    // 另一类合法恢复：变量原本不存在，但模型在用户确认后通过受管预处理创建了
    // 同名列，后续估计器也已成功。必须同时满足“创建了同一列”和“估计完成”，不能
    // 仅凭任意一次 data_preprocess 成功就把错误过滤掉。
    const createdByPreprocess = hasLaterSuccessfulCall("data_import", (call) =>
      call.tool === "data_preprocess" &&
      call.status === "completed" &&
      typeof call.args === "string" &&
      missing.every((name) => call.args!.includes(name)),
    )
    return createdByPreprocess && (
      calls.some((call) => isWorkflowEstimateTool(call.tool) && call.status === "completed") ||
      hasFourCellDesignStop
    )
  }

  const missingVariableDesignStop = (error: string) => {
    if (!recovery) return false
    if ((recovery?.questionCount ?? 0) > 0 || recovery?.estimateCompleted === true) return false
    const match = error.match(/找不到以下变量：\s*\[([^\]]*)\]/)
    const assistantText = recovery?.assistantText ?? ""
    if (!match || !assistantText) return false
    const missing = match[1]!
      .split(",")
      .map((item) => item.replace(/[\s'"`]/g, ""))
      .filter(Boolean)
    if (!missing.length || !missing.every((name) => assistantText.includes(name))) return false
    const explicitStop = /(?:按(?:你|用户)?的?(?:要求|指示)|按要求|遵循要求)[^。\n]{0,40}(?:停止|不构造|不切换|不再继续)|(?:停止|不再继续)[^。\n]{0,40}(?:构造|切换|试错|分析)|到此停止/.test(assistantText)
    const designConclusionStop =
      missing.length === 1 && missing[0].toLowerCase() === "post" &&
      /传统\s*(?:2[×x*]2\s*)?DID[^。\n]{0,100}(?:不适用|不满足|无法构造)/i.test(assistantText) &&
      /(?:未执行|没有执行|未生成|本轮没有回归|不做回归)/.test(assistantText)
    if (!explicitStop && !designConclusionStop) return false
    const calls = recovery.toolCalls ?? []
    return !calls.some((call) => isWorkflowEstimateTool(call.tool) || call.tool === "data_preprocess")
  }

  const recoveredSchemaError = (error: { tool: string; error: string }) => {
    if (!recovery || recovery.estimateCompleted !== true) return false
    if (!/(参数不合法|参数契约错误|未知字段|参数包含未定义字段)/.test(error.error)) return false
    return hasLaterSuccessfulCall(error.tool, (call) => call.tool === error.tool && call.status === "completed")
  }

  const recoveredSchemaErrorAtDesignStop = (error: { tool: string; error: string }) => {
    if (!recovery || !hasFourCellDesignStop || !/(参数不合法|参数契约错误|未知字段|参数包含未定义字段)/.test(error.error)) return false
    if (isWorkflowEstimateTool(error.tool) && error.tool !== "did_static") return false
    const unknownField = error.error.match(/(?:未定义字段|未知字段)[（(]([^）)]+)[）)]/)?.[1]?.trim()
    return (recovery.toolCalls ?? []).some((call, index) => {
      if (call.tool !== error.tool || !call.args) return false
      const failureIndex = (recovery.toolCalls ?? []).findIndex((item) => item.tool === error.tool && item.status === "error")
      if (failureIndex >= 0 && index <= failureIndex) return false
      if (call.status === "completed") return true
      // 若修正后的同工具调用本身又被研究设计门禁拒绝，也算已经完成了
      // “修正参数→重新执行→得到设计反馈”闭环；必须能从原错误中解析出字段，
      // 并确认后续参数不再包含该字段，避免把任意第二次失败误判为恢复。
      return call.status === "error" && Boolean(unknownField) && !call.args.includes(unknownField!)
    })
  }

  const recoveredAbortedAfterDesignStop = (error: { tool: string; error: string }) => {
    if (!recovery || !hasFourCellDesignStop || !/^Tool execution aborted\b/i.test(error.error.trim())) return false
    if (isWorkflowEstimateTool(error.tool)) return false
    return (recovery.assistantText?.trim().length ?? 0) >= 20
  }

  const recoveredDuplicateEstimateAbort = (error: { tool: string; error: string }) => {
    if (!recovery || !isWorkflowEstimateTool(error.tool) || !/^Tool execution aborted\b/i.test(error.error.trim())) return false
    if (recovery.estimateCompleted !== true) return false
    const calls = recovery.toolCalls ?? []
    const failureIndex = calls.findIndex((call) => call.tool === error.tool && call.status === "error")
    if (failureIndex < 0) return false
    const failedCall = calls[failureIndex]
    // 同一参数已经成功后，模型又对同一估计发起了重复调用；这类取消不应覆盖
    // 已经交付的结果，但不同参数的后续取消仍必须保留为真实错误。
    return calls.some((call, index) =>
      index < failureIndex &&
      call.tool === error.tool &&
      call.status === "completed" &&
      call.args === failedCall?.args,
    )
  }

  const recoveredUnknownTool = (error: { tool: string; error: string }) => {
    if (!recovery || !/(unavailable tool|no such tool|not available in this request|未注册的工具|工具未注册)/i.test(error.error)) {
      return false
    }
    const calls = recovery.toolCalls ?? []
    const laterSuccessfulTool = hasLaterSuccessfulCall(error.tool, (call) =>
        call.tool !== error.tool &&
        call.status === "completed" &&
        (isWorkflowEstimateTool(call.tool) ||
          ["data_import", "data_preprocess", "econometrics_recommend", "composite_evaluation"].includes(call.tool)),
    )
    const substantiveRecoveryText = (recovery.assistantText?.trim().length ?? 0) >= 20
    // 未知工具没有执行副作用；只有后续确实走到另一个成功工具，且对用户说明了
    // 已改用/已恢复，才能把它视为一次可接受的低级选错。单独有任意成功调用
    // 不足以证明原任务恢复，避免把错误工具后随便读一个文件误判为闭环。
    const explainsRecovery = /(?:改用|重新选择|重新规划|已恢复|已完成(?:数据)?导入|按工具反馈)/i.test(
      recovery.assistantText ?? "",
    )
    return laterSuccessfulTool && substantiveRecoveryText && explainsRecovery
  }

  const recoveredOutputReferenceError = (error: { tool: string; error: string }) => {
    if (!recovery || error.tool !== "read" || !/TOOL_OUTPUT_REFERENCE_DENIED/.test(error.error)) return false
    if (recovery.estimateCompleted !== true) return false
    const laterSuccessfulTool = hasLaterSuccessfulCall(error.tool, (call) =>
        call.tool !== "read" &&
        call.status === "completed" &&
        (isWorkflowEstimateTool(call.tool) || ["data_import", "data_preprocess", "econometrics_recommend"].includes(call.tool)),
    )
    // 失效引用是只读工具的可恢复契约错误；只有后续真实分析/数据检查成功且有用户可见
    // 收尾，才把它视为一次可接受的低级误用。没有后续证据仍必须进入失败报告。
    return laterSuccessfulTool && (recovery.assistantText?.trim().length ?? 0) >= 20
  }

  const recoveredDataPreprocessError = (error: { tool: string; error: string }) => {
    if (error.tool !== "data_preprocess" || !/(参数不合法|数据预处理前必须|需要至少指定一列|Right value .* is not numeric|右值.*数值)/.test(error.error)) return false
    // drive 场景明确知道这是估计任务且尚未完成时，不能把“预处理成功”冒充整条
    // 分析链恢复；独立的预处理单测可能不提供 estimateCompleted，此时按工具自身
    // 的成功结果判断即可。四格设计停点是唯一允许估计未完成的明确终点。
    if (recovery && "estimateCompleted" in recovery && recovery.estimateCompleted !== true && !hasFourCellDesignStop) return false
    return hasLaterSuccessfulCall(error.tool, (call) => {
      if (call.tool !== "data_preprocess" || call.status !== "completed") return false
      // create_column 的 right_value 类型错误只能由同一变换改成 right_column 修复；
      // winsorize/filter 等无关成功不能证明这次失败已经恢复。
      if (/Right value .* is not numeric|right_value/.test(error.error)) {
        return typeof call.args === "string" && /create_column/.test(call.args) && /right_column/.test(call.args)
      }
      return true
    })
  }

  const recoveredDatasetReference = (error: { tool: string; error: string }) => {
    if (!recovery || error.tool !== "data_import") return false
    const match = error.error.match(/Dataset manifest not found for datasetId=([^\s]+)/i) ??
      error.error.match(/Stage not found: datasetId=([^\s,]+), stageId=([^\s]+)/i)
    const staleID = match?.[1]
    const staleStageID = match?.[2]
    if (!staleID) return false

    const failureIndex = (recovery.toolCalls ?? []).findIndex((call) =>
      call.tool === error.tool && call.status === "error" &&
      typeof call.args === "string" && call.args.includes(staleID) &&
      (!staleStageID || call.args.includes(staleStageID)),
    )
    const parsedCalls = (recovery.toolCalls ?? [])
      .map((call, index) => ({ call, index }))
      .filter(({ call, index }) => call.tool === "data_import" && call.status === "completed" && typeof call.args === "string" && (failureIndex < 0 || index > failureIndex))
      .flatMap(({ call }) => {
        try {
          const args = JSON.parse(call.args!) as Record<string, unknown>
          return [args]
        } catch {
          return []
        }
      })
    const validProfile = parsedCalls.find(
      (args) =>
        typeof args.datasetId === "string" &&
        typeof args.stageId === "string" &&
        args.action === "profile" &&
        (args.datasetId !== staleID || Boolean(staleStageID && args.stageId !== staleStageID)),
    )
    if (!validProfile) return false
    if (parsedCalls.some(
      (args) =>
        args.datasetId === validProfile.datasetId &&
        args.stageId === validProfile.stageId &&
        ["validate", "frequency", "correlation"].includes(String(args.action)),
    )) return true
    // 有些任务（RDD适用性、变量清单等）画像本身就是完整交付，不需要再跑
    // validate/frequency；只要已经用真实引用完成 profile，并给出实质用户回答，
    // 阶段引用错误就是已恢复的低级波折，而不是最终 Harness 故障。
    return (recovery.assistantText?.trim().length ?? 0) >= 20
  }

  const recoveredDataImportStageInput = (error: { tool: string; error: string }) => {
    if (!recovery || error.tool !== "data_import") return false
    if (!/数据动作\s+(?:profile|validate|frequency|correlation)\s+需要 inputPath/.test(error.error)) return false
    if (!recovery.assistantText?.trim()) return false
    return (recovery.toolCalls ?? []).some((call, index) => {
      if (call.tool !== "data_import" || call.status !== "completed" || typeof call.args !== "string") return false
      const failureIndex = (recovery.toolCalls ?? []).findIndex((item) => item.tool === error.tool && item.status === "error")
      if (failureIndex >= 0 && index <= failureIndex) return false
      try {
        const args = JSON.parse(call.args) as Record<string, unknown>
        return ["profile", "validate", "frequency", "correlation"].includes(String(args.action)) &&
          typeof args.datasetId === "string" && typeof args.stageId === "string"
      } catch {
        return false
      }
    })
  }

  const recoveredDataImportInputPath = (error: { tool: string; error: string }) => {
    if (error.tool !== "data_import" || !/找不到输入文件|input file.*not found|file not found/i.test(error.error)) return false
    const calls = recovery?.toolCalls ?? []
    const failureIndex = calls.findIndex((call) => call.tool === "data_import" && call.status === "error")
    if (failureIndex < 0) return false
    let failedInputPath: string | undefined
    try {
      const args = JSON.parse(calls[failureIndex]?.args ?? "{}") as Record<string, unknown>
      if (args.action !== "import" || typeof args.inputPath !== "string") return false
      failedInputPath = args.inputPath
    } catch {
      return false
    }
    const repaired = calls.slice(failureIndex + 1).some((call, offset) => {
      if (call.tool !== "data_import" || call.status !== "completed" || typeof call.args !== "string") return false
      try {
        const args = JSON.parse(call.args) as Record<string, unknown>
        if (args.action !== "import" || typeof args.inputPath !== "string") return false
        if (args.inputPath !== failedInputPath) return true
        // 同名附件在隔离工作区定位前可能先失败；只有重新导入后同规格估计也完成，
        // 才把这次路径解析波折判为已恢复，绝不因一次重复调用就假定修好。
        return recovery?.estimateCompleted === true && calls.some((later, laterIndex) =>
          laterIndex > failureIndex + 1 + offset && isWorkflowEstimateTool(later.tool) && later.status === "completed",
        )
      } catch {
        return false
      }
    })
    return repaired && (recovery?.assistantText?.trim().length ?? 0) >= 20
  }

  return toolErrors.filter(
    (e) =>
      !DESIGNED_GUARD_ERRORS.some((marker) => e.error.includes(marker)) &&
      !isFsExplorePathWave(e) &&
      !isFourCellDesignError(e) &&
      !recoveredSchemaError(e) &&
      !recoveredSchemaErrorAtDesignStop(e) &&
      !recoveredAbortedAfterDesignStop(e) &&
      !recoveredDuplicateEstimateAbort(e) &&
      !recoveredUnknownTool(e) &&
      !recoveredOutputReferenceError(e) &&
      !recoveredDataPreprocessError(e) &&
      !recoveredDatasetReference(e) &&
      !recoveredDataImportStageInput(e) &&
      !recoveredDataImportInputPath(e) &&
      !(
        e.tool === "data_import" &&
        /数据动作失败：找不到以下变量/.test(e.error) &&
        (recoveredMissingVariable(e.error) || missingVariableDesignStop(e.error))
      ),
  )
}
