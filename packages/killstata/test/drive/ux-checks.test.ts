import { describe, expect, test } from "bun:test"
import { calledEstimator, filterRealErrors, hasProgressNotes, hasUnsupportedTimeClaim, isFsExplorePathWave, reportQuality, turnHasSubstance } from "./ux-checks"

describe("reportQuality", () => {
  test("完整中文结论：方法 + 数字 + 中文 + 无泄漏 → pass", () => {
    const r = reportQuality(
      "OLS 基准回归完成：创新指数对高质量发展指数的系数为 0.312，标准误 0.018，样本量 4709，R²=0.45。",
    )
    expect(r.pass).toBe(true)
    expect(r.method).toBe(true)
    expect(r.hasNumber).toBe(true)
    expect(r.isChinese).toBe(true)
    expect(r.noInternalLeak).toBe(true)
  })

  test("纯英文/无方法 → fail", () => {
    expect(reportQuality("done.").pass).toBe(false)
    expect(reportQuality("The regression finished successfully.").pass).toBe(false)
  })

  test("有方法无数字 → fail（报告没给任何可读数字）", () => {
    const r = reportQuality("OLS 回归完成了，结果不错。")
    expect(r.method).toBe(true)
    expect(r.hasNumber).toBe(false)
    expect(r.pass).toBe(false)
  })

  test("泄漏内部路径 → fail", () => {
    expect(reportQuality("OLS 完成，系数 0.3，保存在 .killstata/datasets/xxx 里。").pass).toBe(false)
  })

  test("小数/科学计数法都能识别为数字", () => {
    expect(reportQuality("系数 0.312，p 值 1.2e-5。回归").hasNumber).toBe(true)
  })
})

describe("hasProgressNotes", () => {
  test("只有首尾文本 → false（静默执行）", () => {
    expect(hasProgressNotes(["复述任务", "最终报告"])).toBe(false)
  })

  test("中间有汇报 → true", () => {
    expect(hasProgressNotes(["复述任务", "数据已导入，共 4709 行。现在跑画像。", "QA 通过。开始估计。", "最终报告"])).toBe(true)
  })

  test("不足 3 条 → false", () => {
    expect(hasProgressNotes(["只有一条"])).toBe(false)
  })

  test("模型文本沉默时，真实 runtime.tool.progress 仍算用户可见进度", () => {
    expect(hasProgressNotes(["最终报告"], ["正在导入数据", "已完成数据画像，接下来执行回归"])).toBe(true)
  })

  test("中间文本太短（无意义）→ false", () => {
    expect(hasProgressNotes(["a", "b", "c"])).toBe(false)
  })
})

describe("turnHasSubstance（多轮追问得到回答）", () => {
  test("该轮有实质回答 → true", () => {
    expect(turnHasSubstance(["好的", "这个系数的 p 值是 0.012，在 5% 水平下显著。"])).toBe(true)
  })

  test("该轮只有空话/太短 → false", () => {
    expect(turnHasSubstance(["好的", "OK"])).toBe(false)
    expect(turnHasSubstance(["👍"])).toBe(false)
  })
})

describe("hasUnsupportedTimeClaim（时间事实断言）", () => {
  test("不把其他语境的“可能”误报成猜测时间", () => {
    expect(hasUnsupportedTimeClaim("本次未加入控制变量，模型中可能存在遗漏变量。")).toBe(false)
  })

  test("只在时间语境中拦截猜测性范围", () => {
    expect(hasUnsupportedTimeClaim("年份范围可能是 2010—2020 年。")).toBe(true)
    expect(hasUnsupportedTimeClaim("时间大约 10 期？")).toBe(true)
    expect(hasUnsupportedTimeClaim("面板包含 17 个时期。")).toBe(false)
  })

  test("不把“约束/预约”等实词误报成猜测年份", () => {
    // 裸“约”触发词的真实回归：这两句都是事实陈述，没有对时间范围做任何猜测。
    expect(hasUnsupportedTimeClaim("受样本约束，时间维度覆盖 2010—2020 年。")).toBe(false)
    expect(hasUnsupportedTimeClaim("时间固定效应的约束条件在 2013 年之后仍不确定。")).toBe(false)
  })

  test("不把已核验的时间变量或研究限制误报成猜测年份", () => {
    expect(
      hasUnsupportedTimeClaim(
        "面板实证成立：277个地区×17个时期（year）的平衡面板。实体=地区，时间=year；随时间和地区变化的遗漏变量仍可能使系数有偏。",
      ),
    ).toBe(false)
  })
})

describe("calledEstimator", () => {
  test("调用过估计器 → true", () => {
    expect(calledEstimator([{ tool: "data_import" }, { tool: "ols_regression" }])).toBe(true)
  })

  test("只做数据操作 → false", () => {
    expect(calledEstimator([{ tool: "data_import" }, { tool: "data_preprocess" }, { tool: "read" }])).toBe(false)
  })
})

describe("filterRealErrors（drive 无工具错误判定）", () => {
  test("文件探索工具找错路径后成功恢复，不判为最终失败", () => {
    expect(
      isFsExplorePathWave({
        tool: "read",
        error: "找不到文件：workflow_stage_output.json\n修复建议：先用 glob/list 定位真实路径。",
      }),
    ).toBe(true)
  })

  test("已询问并成功完成估计后，缺失变量错误归入可恢复错误而非阻断场景", () => {
    const error = { tool: "data_import", error: "数据动作失败：找不到以下变量：['城镇化率']" }
    const recovery = {
      questionCount: 1,
      questionEvents: [{ prompt: "是否用城镇化率替换为城镇化水平？", options: ["城镇化水平"] }],
      toolCalls: [{ tool: "ols_regression", status: "completed", args: "{\"treatmentVar\":\"城镇化水平\"}" }],
      estimateCompleted: true,
    }
    expect(filterRealErrors([error])).toEqual([error])
    expect(filterRealErrors([error], recovery)).toEqual([])
    expect(filterRealErrors([error], { ...recovery, questionCount: 0 })).toEqual([error])
    expect(filterRealErrors([error], { ...recovery, estimateCompleted: false })).toEqual([error])
  })

  test("恢复过滤必须确认同一缺失变量被提问且替代变量进入估计", () => {
    const error = { tool: "data_import", error: "数据动作失败：找不到以下变量：['城镇化率']" }
    const recovery = {
      questionCount: 1,
      questionEvents: [{ prompt: "是否用城镇化率替换为城镇化水平？", options: ["城镇化水平"] }],
      toolCalls: [{ tool: "ols_regression", status: "completed", args: "{\"treatmentVar\":\"城镇化水平\"}" }],
      estimateCompleted: true,
    }
    expect(filterRealErrors([error], recovery)).toEqual([])
    expect(filterRealErrors([error], { ...recovery, questionEvents: [{ prompt: "是否继续？", options: [] }] })).toEqual([error])
    expect(filterRealErrors([error], { ...recovery, toolCalls: [{ tool: "ols_regression", status: "completed", args: "{\"treatmentVar\":\"城镇化率\"}" }] })).toEqual([error])
  })

  test("估计调用失败时不构成替代变量恢复证据", () => {
    const error = { tool: "data_import", error: "数据动作失败：找不到以下变量：['城镇化率']" }
    const recovery = {
      questionCount: 1,
      questionEvents: [{ prompt: "是否用城镇化率替换为城镇化水平？", options: ["城镇化水平"] }],
      toolCalls: [{ tool: "ols_regression", status: "error", args: "{\"treatmentVar\":\"城镇化水平\"}" }],
      estimateCompleted: true,
    }
    expect(filterRealErrors([error], recovery)).toEqual([error])
  })

  test("缺失变量经数据预处理成功构造后，也应归入可恢复波折", () => {
    const error = { tool: "data_import", error: "数据动作失败：找不到以下变量：['post']" }
    const recovery = {
      questionCount: 1,
      questionEvents: [{ prompt: "post变量如何构造？", options: ["基于time列构造"] }],
      toolCalls: [
        {
          tool: "data_preprocess",
          status: "completed",
          args: '{"method":"create_column","output_column":"post","right_column":"time"}',
        },
        { tool: "did_static", status: "completed", args: '{"postVar":"post"}' },
      ],
      estimateCompleted: true,
    }
    expect(filterRealErrors([error], recovery)).toEqual([])
    expect(filterRealErrors([error], { ...recovery, toolCalls: [{ tool: "data_preprocess", status: "completed", args: "{}" }] })).toEqual([error])
  })

  test("设计内防护（门禁/read 保护/unavailable/QA gate）不是失败", () => {
    expect(filterRealErrors([
      { tool: "did_static", error: "计量估计前必须先完成当前 canonical stage 的数据画像" },
      { tool: "data_import", error: "Data operation blocked by QA gate: Found 115 duplicate entity-time rows" },
      { tool: "data_import", error: "数据动作被 QA 门禁阻断：发现 115 个重复实体—时间键" },
      { tool: "data_import", error: "数据动作被 数据质量检查阻断：发现 115 个重复实体—时间键" },
      { tool: "read", error: "Refusing to read a 2.2 MB dataset as text" },
    ])).toEqual([])
  })

  test("估计已成功后重复的取消事件不覆盖最终成功", () => {
    const error = { tool: "panel_fe_regression", error: "Tool execution aborted" }
    const recovery = {
      estimateCompleted: true,
      toolCalls: [
        { tool: "panel_fe_regression", status: "completed", args: '{"entityVar":"省份_地区"}' },
        { tool: "panel_fe_regression", status: "error", args: '{"entityVar":"省份_地区"}' },
      ],
    }
    expect(filterRealErrors([error], recovery)).toEqual([])
  })

  test("删除未知方法字段后成功重跑，不判为最终工具故障", () => {
    const error = { tool: "panel_fe_regression", error: "参数包含未定义字段：modelType。请按 describe 返回的 Schema 删除该字段。" }
    const recovery = {
      estimateCompleted: true,
      toolCalls: [
        { tool: "panel_fe_regression", status: "error", args: '{"modelType":"fe"}' },
        { tool: "panel_fe_regression", status: "completed", args: '{"entityVar":"地区"}' },
      ],
    }
    expect(filterRealErrors([error], recovery)).toEqual([])
  })

  test("失效的内部分页引用被后续真实分析恢复时，不判为最终错误", () => {
    const error = { tool: "read", error: "TOOL_OUTPUT_REFERENCE_DENIED：分页输出标识不合法。" }
    const recovery = {
      assistantText: "已改用数据画像并完成面板固定效应回归，结果已交付。",
      estimateCompleted: true,
      toolCalls: [
        { tool: "data_import", status: "completed", args: '{"action":"profile","stageId":"stage_000"}' },
        { tool: "panel_fe_regression", status: "completed", args: '{"entityVar":"地区","timeVar":"年份"}' },
      ],
    }
    expect(filterRealErrors([error])).toEqual([error])
    expect(filterRealErrors([error], recovery)).toEqual([])
    expect(filterRealErrors([error], { ...recovery, toolCalls: [] })).toEqual([error])
  })

  test("模型参数写错但同一工具随后成功且估计完成时，允许该低级错误被恢复", () => {
    const error = {
      tool: "data_preprocess",
      error: "工具 data_preprocess 参数不合法：options.rules.0.values.0：不符合任何允许的参数结构",
    }
    const recovery = {
      estimateCompleted: true,
      toolCalls: [{ tool: "data_preprocess", status: "completed" }],
    }
    expect(filterRealErrors([error])).toEqual([error])
    expect(filterRealErrors([error], recovery)).toEqual([])
    expect(filterRealErrors([error], { ...recovery, estimateCompleted: false })).toEqual([error])
    expect(filterRealErrors([error], { ...recovery, toolCalls: [] })).toEqual([error])
  })

  test("OLS未知字段被下一次同规格成功调用修正后，也应归入可恢复波折", () => {
    const error = {
      tool: "ols_regression",
      error: "工具 ols_regression 参数不合法：参数：包含未定义字段（covariancerobust）\n修复建议：只修改报错字段并重新核对其格式或来源。",
    }
    const recovery = {
      estimateCompleted: true,
      toolCalls: [
        { tool: "ols_regression", status: "error", args: '{"covariancerobust":"HC1"}' },
        { tool: "ols_regression", status: "completed", args: '{"covariance":"HC1"}' },
      ],
    }

    expect(filterRealErrors([error], recovery)).toEqual([])
  })

  test("模型把数据集引用写错但同一阶段随后用有效引用完成时，允许恢复", () => {
    const error = {
      tool: "data_import",
      error: "Dataset manifest not found for datasetId=did_stale",
    }
    const recovery = {
      toolCalls: [
        { tool: "data_import", status: "error", args: '{"action":"profile","datasetId":"did_stale","stageId":"stage_001"}' },
        { tool: "data_import", status: "completed", args: '{"action":"profile","datasetId":"did_valid","stageId":"stage_000"}' },
        { tool: "data_import", status: "error", args: '{"action":"validate","datasetId":"did_stale","stageId":"stage_000"}' },
        { tool: "data_import", status: "completed", args: '{"action":"validate","datasetId":"did_valid","stageId":"stage_000"}' },
      ],
    }

    expect(filterRealErrors([error])).toEqual([error])
    expect(filterRealErrors([error], recovery)).toEqual([])
    expect(filterRealErrors([error], { ...recovery, toolCalls: recovery.toolCalls.slice(0, 2) })).toEqual([error])
  })

  test("模型把阶段ID写错但随后用同一数据集的真实阶段完成画像时，允许恢复", () => {
    const error = {
      tool: "data_import",
      error: "Stage not found: datasetId=did_stale, stageId=stage_001",
    }
    const recovery = {
      toolCalls: [
        { tool: "data_import", status: "completed", args: '{"action":"profile","datasetId":"did_valid","stageId":"stage_000"}' },
        { tool: "data_import", status: "completed", args: '{"action":"validate","datasetId":"did_valid","stageId":"stage_000"}' },
      ],
    }

    expect(filterRealErrors([error], recovery)).toEqual([])
    expect(filterRealErrors([error], { ...recovery, toolCalls: recovery.toolCalls.slice(0, 1) })).toEqual([error])
  })

  test("只需画像即可结束的任务，阶段ID纠正后有实质回答也算恢复", () => {
    const error = {
      tool: "data_import",
      error: "Stage not found: datasetId=did_stale, stageId=stage_demo",
    }
    const recovery = {
      assistantText: "已用真实 stage_000 完成画像。当前没有连续 running variable，因此 RDD 不适用，已按要求停止。",
      toolCalls: [
        { tool: "data_import", status: "completed", args: '{"action":"profile","datasetId":"did_valid","stageId":"stage_000"}' },
      ],
    }

    expect(filterRealErrors([error], recovery)).toEqual([])
    expect(filterRealErrors([error], { ...recovery, assistantText: "" })).toEqual([error])
  })

  test("未知工具后改用已注册数据工具完成任务时，允许把低级选错视为已恢复", () => {
    const error = {
      tool: "magic_causal_wizard",
      error: "Model tried to call unavailable tool 'magic_causal_wizard'.",
    }
    const recovery = {
      toolCalls: [
        { tool: "magic_causal_wizard", status: "error", args: "{}" },
        { tool: "data_import", status: "completed", args: '{"action":"import","inputPath":"did.xlsx"}' },
      ],
      assistantText: "工具未注册，已改用数据导入工具并完成数据导入。",
    }

    expect(filterRealErrors([error])).toEqual([error])
    expect(filterRealErrors([error], recovery)).toEqual([])
    expect(filterRealErrors([error], { ...recovery, toolCalls: [{ tool: "read", status: "completed", args: "{}" }] })).toEqual([error])
  })

  test("预处理参数错误后同一方法成功完成时，允许把参数波折视为已恢复", () => {
    const error = {
      tool: "data_preprocess",
      error: "工具 data_preprocess 参数不合法：options.right_value：不符合任何允许的参数结构",
    }
    const recovery = {
      toolCalls: [{
        tool: "data_preprocess",
        status: "completed",
        args: '{"method":"create_column","columns":["year"],"options":{"right_column":"time"}}',
      }],
    }

    expect(filterRealErrors([error])).toEqual([error])
    expect(filterRealErrors([error], recovery)).toEqual([])
    expect(filterRealErrors([error], { toolCalls: [{ tool: "data_preprocess", status: "error" }] })).toEqual([error])
  })

  test("导入路径错误后经 healthcheck 和真实 import 成功时，允许把低级选错视为已恢复", () => {
    const error = {
      tool: "data_import",
      error: "找不到输入文件：[临时路径已隐藏]",
    }
    const recovery = {
      toolCalls: [
        { tool: "data_import", status: "error", args: '{"action":"import","inputPath":"/bad/did.xlsx"}' },
        { tool: "data_import", status: "completed", args: '{"action":"healthcheck"}' },
        { tool: "data_import", status: "completed", args: '{"action":"import","inputPath":"did.xlsx"}' },
      ],
      assistantText: "已修正文件路径，并完成当前数据文件的导入和后续分析。",
    }

    expect(filterRealErrors([error])).toEqual([error])
    expect(filterRealErrors([error], recovery)).toEqual([])
    expect(filterRealErrors([error], { ...recovery, toolCalls: recovery.toolCalls.slice(0, 2) })).toEqual([error])
  })

  test("同一路径初次解析失败、定位后导入并完成估计时保留波折但不阻断功能", () => {
    const error = { tool: "data_import", error: "找不到输入文件：[临时路径已隐藏]" }
    const recovery = {
      toolCalls: [
        { tool: "data_import", status: "error", args: '{"action":"import","inputPath":"gf.xlsx"}' },
        { tool: "list", status: "completed" },
        { tool: "data_import", status: "completed", args: '{"action":"import","inputPath":"gf.xlsx"}' },
        { tool: "panel_fe_regression", status: "completed", args: '{"entityVar":"地区","timeVar":"年份"}' },
      ],
      estimateCompleted: true,
      assistantText: "已找到真实数据并按同一规格完成面板固定效应估计。",
    }
    expect(filterRealErrors([error], recovery)).toEqual([])
    expect(filterRealErrors([error], { ...recovery, estimateCompleted: false })).toEqual([error])
  })

  test("create_column 右值类型传错后修正为 right_column，最终 DID 设计停点不判为 Harness 错误", () => {
    const error = {
      tool: "data_preprocess",
      error: "INVALID_INPUT: Right value 'time' is not numeric for create_column comparison",
    }
    const recovery = {
      estimateCompleted: false,
      assistantText: "当前数据不满足传统 2×2 DID 的四格样本结构，已停止自动重试。",
      toolCalls: [
        { tool: "data_preprocess", status: "completed", args: '{"method":"create_column","columns":["year"],"options":{"right_column":"time"}}' },
      ],
    }

    expect(filterRealErrors([error])).toEqual([error])
    expect(filterRealErrors([error], recovery)).toEqual([])
    expect(filterRealErrors([error], { ...recovery, toolCalls: [{ tool: "data_preprocess", status: "error" }] })).toEqual([error])
  })

  test("恢复证据必须发生在失败之后，且不能用无关的预处理成功调用遮蔽错误", () => {
    const error = {
      tool: "data_preprocess",
      error: "INVALID_INPUT: Right value 'time' is not numeric for create_column comparison",
    }
    const beforeFailure = {
      estimateCompleted: false,
      toolCalls: [
        { tool: "data_preprocess", status: "completed", args: '{"method":"create_column","options":{"right_column":"time"}}' },
        { tool: "data_preprocess", status: "error", args: '{"method":"create_column","options":{"right_value":"time"}}' },
      ],
      assistantText: "仍未完成。",
    }
    const unrelatedAfterFailure = {
      estimateCompleted: false,
      toolCalls: [
        { tool: "data_preprocess", status: "error", args: '{"method":"create_column","options":{"right_value":"time"}}' },
        { tool: "data_preprocess", status: "completed", args: '{"method":"winsorize","columns":["x"]}' },
      ],
      assistantText: "仍未完成。",
    }
    expect(filterRealErrors([error], beforeFailure)).toEqual([error])
    expect(filterRealErrors([error], unrelatedAfterFailure)).toEqual([error])
  })

  test("无关工具错误包含四格措辞时不能被 DID 停点白名单吞掉", () => {
    const error = { tool: "ols_regression", error: "backend failed: 传统 DID 四个样本单元检查信息不可用" }
    expect(filterRealErrors([error])).toEqual([error])
  })

  test("DID 停点后的无关估计器取消错误仍然保留", () => {
    const error = { tool: "ols_regression", error: "Tool execution aborted" }
    const recovery = {
      assistantText: "传统 DID 四格样本结构不足，已停止自动重试并等待用户确认。",
      toolCalls: [{ tool: "did_static", status: "error" }],
    }
    expect(filterRealErrors([error], recovery)).toEqual([error])
  })

  test("传统 DID 四个样本单元不足属于研究设计停点，不判为 Harness 错误", () => {
    expect(filterRealErrors([
      { tool: "did_static", error: "传统 DID 必须同时包含处理组/对照组与政策前/政策后四个样本单元" },
    ])).toEqual([])
  })

  test("数据画像缺少阶段引用但随后用真实引用完成并明确停点时，允许恢复", () => {
    const error = {
      tool: "data_import",
      error: "数据动作 profile 需要 inputPath，或同时提供 datasetId 与 stageId。",
    }
    const recovery = {
      assistantText: "已完成数据画像。当前缺少post，按要求停止，不构造post。",
      toolCalls: [
        { tool: "data_import", status: "completed", args: '{"action":"profile","datasetId":"did_valid","stageId":"stage_000"}' },
      ],
    }

    expect(filterRealErrors([error], recovery)).toEqual([])
    expect(filterRealErrors([error], { ...recovery, assistantText: "" })).toEqual([error])
  })

  test("传统 DID 四格不足是用户决策停点，不算 Harness 内部故障", () => {
    expect(filterRealErrors([
      { tool: "did_static", error: "当前数据不满足传统 2×2 DID 的四格样本结构，已停止自动重试" },
    ])).toEqual([])
  })

  test("设计停点后的取消调用和同工具修复不阻断最终验收", () => {
    const recovery = {
      estimateCompleted: false,
      assistantText: "当前数据不满足传统 2×2 DID 所需的四格样本结构，已停止自动重试；请确认研究设计。",
      toolCalls: [
        { tool: "econometrics_recommend", status: "error", args: "{}" },
        { tool: "econometrics_recommend", status: "completed", args: "{}" },
        { tool: "data_import", status: "error", args: '{"action":"validate"}' },
        { tool: "did_static", status: "error", args: '{"postVar":"post"}' },
      ],
    }
    expect(filterRealErrors([
      { tool: "econometrics_recommend", error: "工具 econometrics_recommend 参数不合法：包含未定义字段" },
      { tool: "data_import", error: "Tool execution aborted" },
      { tool: "did_static", error: "当前数据不满足传统 2×2 DID 的四格样本结构，已停止自动重试" },
    ], recovery)).toEqual([])
    expect(filterRealErrors([
      { tool: "data_import", error: "Tool execution aborted" },
    ], { ...recovery, assistantText: "" })).toHaveLength(1)
    expect(filterRealErrors([
      { tool: "data_import", error: "Tool execution aborted\n修复建议：已停止排队调用。" },
    ], recovery)).toEqual([])
  })

  test("参数修正后再次触发研究设计门禁也算已恢复", () => {
    const recovery = {
      estimateCompleted: false,
      assistantText: "当前数据不满足传统 2×2 DID 所需的四格样本结构，已停止自动重试；请确认研究设计。",
      toolCalls: [
        { tool: "did_static", status: "error", args: '{"covariances":"HC1"}' },
        { tool: "did_static", status: "error", args: '{"covariance":"HC1"}' },
      ],
    }
    expect(filterRealErrors([
      { tool: "did_static", error: "工具 did_static 参数不合法：参数：包含未定义字段（covariances）" },
    ], recovery)).toEqual([])
    expect(filterRealErrors([
      { tool: "did_static", error: "工具 did_static 参数不合法：参数：包含未定义字段（covariances）" },
    ], { ...recovery, toolCalls: recovery.toolCalls.slice(0, 1) })).toHaveLength(1)
  })

  test("用户已要求缺少 post 就停止时，缺失列探查错误应归入设计停点", () => {
    expect(filterRealErrors([
      { tool: "data_import", error: "数据动作失败：找不到以下变量：['post']" },
    ], {
      questionCount: 0,
      estimateCompleted: false,
      toolCalls: [{ tool: "data_import" }],
      assistantText: "当前数据不存在post，按你的要求停止，不构造post、不切换方法、不继续试错。",
    })).toEqual([])
  })

  test("自然中文的“按你的指示停止”也能识别为用户要求的设计停点", () => {
    expect(filterRealErrors([
      { tool: "data_import", error: "数据动作失败：找不到以下变量：['post']" },
    ], {
      questionCount: 0,
      estimateCompleted: false,
      toolCalls: [{ tool: "data_import", args: '{"action":"profile"}' }],
      assistantText: "post 不存在。按你的指示，我不构造post、不切换方法、不继续试错，本任务到此停止。",
    })).toEqual([])
  })

  test("传统 DID 明确判定不适用且未继续估计时，缺失 post 探查属于设计停点", () => {
    expect(filterRealErrors([
      { tool: "data_import", error: "数据动作失败：找不到以下变量：['post']" },
    ], {
      questionCount: 0,
      estimateCompleted: false,
      toolCalls: [{ tool: "data_import", status: "error" }],
      assistantText: "传统 2×2 DID 不适用。post 变量在当前数据中不存在，无法构造四格样本；本轮未执行回归。",
    })).toEqual([])
  })

  test("unavailable tool 默认是真实错误，不能被全局白名单吞掉", () => {
    expect(filterRealErrors([
      { tool: "grep", error: "Model tried to call unavailable tool 'grep'" },
      { tool: "grep", error: "当前任务不存在可调用的工具 grep，框架不会重复调用或猜测替代工具。" },
    ])).toHaveLength(2)
  })

  test("文件系统探索工具（read/list/glob）的 ENOENT 是模型猜路径的无害波折", () => {
    expect(filterRealErrors([
      { tool: "read", error: "File not found: .killstata/datasets/did_x/audit/xxx.json" },
      { tool: "list", error: "No such file or directory: '.killstata/datasets/did_x/reports/main/foo'" },
      { tool: "glob", error: "ENOENT: no such file" },
    ])).toEqual([])
  })

  test("data_import/估计器/verifier 的 ENOENT 是路径解析真断，算失败（F3 回归保护）", () => {
    const real = filterRealErrors([
      { tool: "data_import", error: "File not found: .killstata/datasets/did_x/manifest.json" },
      { tool: "ols_regression", error: "No such file or directory: results.json" },
    ])
    expect(real).toHaveLength(2)
  })
})
