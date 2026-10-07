import { describe, expect, test } from "bun:test"
import { containsEngineInternalData, userFacingAnalysisErrorText, sanitizeAnalysisAssistantText } from "@/runtime/analysis-text-sanitizer"
import { isAnalysisTurn } from "@/runtime/analysis-user-view"
import { readToolAnalysisView } from "@/tool/analysis-user-view"

function analysisTurn(tool = "data_import") {
  return [{ tool, state: { status: "completed", metadata: {} } }]
}

describe("analysis error → user-facing text", () => {
  test("QA gate block on duplicate entity-time rows becomes a specific, actionable message (not 请检查参数)", () => {
    // 真实 bug（2026-07-18）：data_import(qa) 因 115 条重复实体键被 QA 门拦截，原始错误是
    // "Data operation blocked by QA gate: ... Found 115 duplicate entity-time rows"，
    // 却因未被识别而落到 TUI 兜底，显示"请检查任务参数"——把可解释的数据问题甩成无意义提示。
    const raw =
      "Data operation blocked by QA gate: QA gate blocked by 1 blocking issue(s): Found 115 duplicate entity-time rows\nReflection log: /some/private/path"
    const friendly = userFacingAnalysisErrorText(raw)
    expect(friendly).toContain("115")
    expect(friendly).toContain("共享")
    expect(friendly).toContain("不等于完整数据行重复")
    expect(friendly).toContain("复合实体 ID")
    expect(friendly).not.toContain("需要先去重")
    expect(friendly).not.toContain("参数")
    expect(friendly).not.toContain("QA gate")
    expect(friendly).not.toContain("Reflection log")
  })

  // 2026-08-12 gf.xlsx 事故回归锁：一旦 QA 已验证出重复能被某列消解，用户可见文案必须
  // 明确说"不是数据重复""不会删除任何行"，绝不能停留在旧的模糊措辞（那会让模型/用户
  // 误以为需要决定"删不删除"，实际上这些是合法的独立观测）。
  test("verified-resolvable duplicate rows tell the user it is not a duplicate and nothing will be deleted", () => {
    const raw =
      "Data operation blocked by QA gate: QA gate blocked by 1 blocking issue(s): " +
      "Found 115 duplicate entity-time rows under '地区'x'年份'. Verified: combining '地区' with column '省份' " +
      "resolves all duplicates (yields 421 unique entities, 0 duplicates). This is not a true duplicate-record issue."
    const friendly = userFacingAnalysisErrorText(raw)
    expect(friendly).toContain("115")
    expect(friendly).toContain("不是数据重复")
    expect(friendly).toContain("不会删除任何行")
    expect(friendly).toContain("省份")
    expect(friendly).toContain("地区")
  })

  test("a QA gate block without a recognized reason still explains it is a data-quality issue", () => {
    const friendly = userFacingAnalysisErrorText(
      "Data operation blocked by QA gate: QA gate blocked by 2 blocking issue(s): something",
    )
    expect(friendly).toContain("数据质检")
    expect(friendly).not.toContain("参数")
  })

  test("unavailable tool 明确停止，invalid args 才允许最小修复", () => {
    const unavailable = userFacingAnalysisErrorText(
      "Model tried to call unavailable tool 'data_import'. Available tools: read, glob",
    )
    expect(unavailable).toBeDefined()
    // 不得暴露"工具调用""可执行路径"这类内部黑话
    expect(unavailable).not.toContain("可执行路径")
    expect(unavailable).not.toContain("unavailable tool")
    expect(unavailable).toContain("已停止")
    expect(unavailable).not.toContain("自动换一种方式")

    const invalidArgs = userFacingAnalysisErrorText("The arguments provided to the tool are invalid: expected string")
    expect(invalidArgs).toBeDefined()
    expect(invalidArgs).not.toContain("可执行路径")
    expect(invalidArgs).toContain("修正")

    const hiddenSystemTool = userFacingAnalysisErrorText("当前任务不存在可调用的工具 read，框架不会重复调用或猜测替代工具。")
    expect(hiddenSystemTool).toContain("已停止")
    expect(hiddenSystemTool).not.toContain("read")
  })

  test("中文的规范 Parquet 读取错误也会转成用户可读提示", () => {
    const friendly = userFacingAnalysisErrorText("不能将规范 Parquet 数据阶段按文本读取：.killstata/datasets/d1/stages/s1.parquet")

    expect(friendly).toContain("内部 Parquet 工作层")
  })

  test("result-contract failures become a safe stop message without exposing adapter details", () => {
    const friendly = userFacingAnalysisErrorText(
      "RESULT_LINEAGE_MISMATCH: metadata.result.datasetId expected dataset_1 but received dataset_2",
    )
    expect(friendly).toContain("完整性校验")
    expect(friendly).toContain("没有把它当作成功结果")
    expect(friendly).not.toContain("RESULT_LINEAGE_MISMATCH")
    expect(friendly).not.toContain("dataset_2")
  })

  test("provider balance exhaustion becomes an explicit no-retry message", () => {
    const friendly = userFacingAnalysisErrorText("Insufficient Balance")
    expect(friendly).toContain("额度不足")
    expect(friendly).toContain("已停止重试")
    expect(friendly).not.toContain("Insufficient Balance")
  })

  test("传统 DID 四格不足的错误兜底必须说明研究设计停点", () => {
    const friendly = userFacingAnalysisErrorText("传统 DID 必须同时包含处理组/对照组与政策前/政策后四个样本单元")
    expect(friendly).toContain("传统 2×2 DID")
    expect(friendly).toContain("四格样本结构")
    expect(friendly).toContain("确认研究设计")
  })

  test("unrelated plain text is not hijacked by the error mapper", () => {
    expect(userFacingAnalysisErrorText("一切正常，结果已生成")).toBeUndefined()
  })
})

describe("模型文本里的 .killstata 内部结构对用户隐身", () => {
  test("Provider 把隐藏思考混入普通文本时，只保留用户可见回答", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "<think>这里是模型的内部推理，不应展示给用户。</think>\n\n当前缺少相对时期变量，请确认研究设计后再继续。",
      tools: analysisTurn("did2s"),
    })

    expect(result.text).not.toContain("内部推理")
    expect(result.text).not.toContain("<think>")
    expect(result.text).toContain("缺少相对时期变量")
    expect(result.sanitized).toBe(true)
  })

  test("分析轮模型回复内嵌的 .killstata 路径被替换为中性描述，统计数字保留", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "回归已完成。结果保存在 packages/killstata/.killstata/datasets/ds_abc/econometrics/ols/ols_result.json，系数 0.31，p=0.04。",
      tools: analysisTurn(),
    })
    expect(result.sanitized).toBe(true)
    expect(result.text).not.toContain(".killstata")
    expect(result.text).not.toContain("ds_abc")
    expect(result.text).not.toContain("ols_result.json")
    expect(result.text).toContain("0.31")
    expect(result.text).toContain("p=0.04")
  })

  test("普通对话（非分析轮）里出现 .killstata 同样被清理", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "分析已完成，日志在 .killstata/log/run.log，其余正常。",
      tools: [],
    })
    expect(result.sanitized).toBe(true)
    expect(result.text).not.toContain(".killstata")
    expect(result.text).not.toContain("run.log")
    expect(result.text).toContain("分析已完成")
  })

  test("运行时临时目录只保留文件名，不泄漏机器路径", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "数据已导入 /var/folders/l9/example/killstata-drive-did-direct-abc/did.xlsx。",
      tools: [],
      latestUserText: "把回归结果导出成 CSV 文件",
    })

    expect(result.text).toContain("did.xlsx")
    expect(result.text).not.toContain("/var/folders/")
    expect(result.text).not.toContain("killstata-drive-did-direct-abc")
  })

  test("路径净化不能留下单独的斜杠空壳", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "数据已导入： / ，4709行×34列。",
      tools: analysisTurn(),
    })

    expect(result.text).not.toMatch(/：\s*\/\s*[，。]/)
    expect(result.text).toContain("数据已导入，")
  })

  test("兼容模型泄漏的 Minimax 工具协议，不把协议文本展示给用户", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "先检查数据。\n]<]minimax[><tool_call>]<]minimax[><invoke name=\"数据导入\">]<]minimax[><action>profile</action>]<]minimax[></invoke>]<]minimax[></tool_call>\n已完成数据画像。",
      tools: [],
    })

    expect(result.text).toContain("先检查数据")
    expect(result.text).toContain("已完成数据画像")
    expect(result.text).not.toContain("minimax")
    expect(result.text).not.toContain("tool_call")
  })

  test("不展示模型复述的伪造数据阶段引用", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "按错误反馈，did_deadbeef/阶段不存在，改用真实文件路径。\n数据导入与画像已完成。",
      tools: [],
    })

    expect(result.text).toContain("数据导入与画像已完成")
    expect(result.text).not.toContain("did_deadbeef")
    expect(result.text).not.toContain("阶段不存在")
  })

  test("隐藏数据集和阶段ID后不留下反引号空壳", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "数据集：``，``，4709行×34列。",
      tools: analysisTurn("did_static"),
    })

    expect(result.text).not.toContain("数据集：``，``")
    expect(result.text).not.toContain("``")
    expect(result.text).toContain("4709行×34列")
  })

  test("隐藏数据集名称后不留下“当前空代码块”句式", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "当前 `` 中没有 relativeTimeVar；请先提供相对时期变量。",
      tools: analysisTurn("did2s"),
    })

    expect(result.text).toContain("当前数据中没有 relativeTimeVar")
    expect(result.text).not.toContain("当前 `` 中没有")
  })

  test("隐藏数据集和阶段ID的斜杠占位符也应完整移除", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "**数据集**：`gf_4a19d15e` / stage `stage_000`\n**规模**：9545 行 × 11 列",
      tools: analysisTurn("data_import"),
    })

    expect(result.text).not.toMatch(/数据集.*stage|``|`gf_/i)
    expect(result.text).toContain("9545 行 × 11 列")
  })

  test("隐藏路径后不能留下“把 的”空语法", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "如把  的 4709×34 数据表导出为 CSV，可以继续处理。",
      tools: analysisTurn("data_import"),
    })

    expect(result.text).not.toMatch(/把\s+的/)
    expect(result.text).toContain("把规范化数据集的 4709×34 数据表")
  })

  test("用户文本不能暴露内部编排工具名", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "data-readiness已确认面板键；econometrics_recommend给出建议，tool_search加载ols_regression方法。",
      tools: analysisTurn("ols_regression"),
    })

    expect(result.text).not.toMatch(/data-readiness|econometrics_recommend|tool_search/)
    expect(result.text).toContain("数据就绪检查")
    expect(result.text).toContain("计量方法推荐")
    expect(result.text).toContain("OLS回归")
  })

  test("状态追问不能暴露 verifier、pending 等内部工作流字段", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "工作流核验已完成（verifier=warn，无非阻断性核验意见，可信产物8个）。当前唯一标记为 pending 的是“结果报告”清单项，即正式的带依据报告文件尚未生成；这不影响上述已交付的估计结果。",
      tools: analysisTurn("did_static"),
    })

    expect(result.text).not.toMatch(/工作流核验|verifier=|可信产物|\bpending\b/)
    expect(result.text).toContain("结果核验已完成")
    expect(result.text).toContain("估计结果已生成")
  })

  test("Pipeline verifier 的 pending 说明改写成用户可理解的结果状态", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "Pipeline verifier 报告‘结果报告’步骤 pending，且内部产物路径无法定位（系统级问题）。但这不影响已核验的估计结果。",
      tools: analysisTurn("panel_fe_regression"),
      latestUserText: "请解释回归结果",
    })
    expect(result.text).toContain("结果已生成")
    expect(result.text).not.toMatch(/Pipeline|verifier|pending|内部产物路径/)
  })

  test("只含用户数据的正常回复不被误伤", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "数据已导入，共 1240 行，变量有 age、income、treatment。",
      tools: analysisTurn(),
    })
    expect(result.sanitized).toBe(false)
    expect(result.text).toContain("1240")
    expect(result.text).toContain("treatment")
  })

  test("模型的有序解读列表从2开始时归一为连续列表", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "OLS回归已完成。\n\n**结果解读**\n\n2. R²接近1。\n3. 因果解释需谨慎。",
      tools: analysisTurn("ols_regression"),
    })

    expect(result.text).toContain("1. R²接近1")
    expect(result.text).toContain("2. 因果解释需谨慎")
    expect(result.text).not.toContain("3. 因果解释需谨慎")
  })

  test("模型跳过列表编号时归一为连续列表", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "OLS回归已完成。\n\n## 局限\n\n1. 未控制其他因素。\n3. 不能作因果解释。",
      tools: analysisTurn("ols_regression"),
    })

    expect(result.text).toContain("1. 未控制其他因素")
    expect(result.text).toContain("2. 不能作因果解释")
    expect(result.text).not.toContain("3. 不能作因果解释")
  })

  test("清理空标点并隐藏内部报告阶段名称", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "数据已导入：4709行×34列，。工作流 reporting项待生成。",
      tools: analysisTurn("did_static"),
    })

    expect(result.text).not.toContain("，。")
    expect(result.text).not.toContain("reporting")
    expect(result.text).toContain("正式报告尚未整理")
  })

  test("回归报告将英文标准误缩写转成中文并删除空的比较小节", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "**比较**\n\n**局限**\n- Panel FE 系数=0.85（SE=0.01，p<0.01）。",
      tools: analysisTurn("panel_fe_regression"),
    })

    expect(result.text).not.toContain("**比较**")
    expect(result.text).not.toMatch(/\bSE\b/)
    expect(result.text).toContain("标准误=0.01")
  })

  test("不向用户承诺当前未加载的双重机器学习能力", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "如需因果推断，可进一步考虑双重机器学习（DML）。",
      tools: analysisTurn("ols_regression"),
    })

    expect(result.text).not.toMatch(/双重机器学习|\bDML\b/i)
    expect(result.text).toContain("未加载的方法")
  })

  test("咨询轮不展示伪工具调用，也不把未执行计划说成已开始", () => {
    const result = sanitizeAnalysisAssistantText({
      text: [
        "这个结果有局限。",
        "**我来做稳健性检验**，至少跑三个：",
        "<tool_call>",
        "<function=read>",
        "<parameter=filePath>",
        "tool-output:result",
        "</parameter>",
        "</function>",
        "</tool_call>",
      ].join("\n"),
      latestUserText: "这个结果靠谱吗？有没有稳健性检验？",
      tools: [],
    })

    expect(result.text).not.toMatch(/<tool_call>|<function=|<parameter=/i)
    expect(result.text).not.toContain("我来做稳健性检验")
    expect(result.text).toContain("尚未执行")
  })

  test("咨询轮不把让我先跑稳健性检验说成已经开始", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "目前的结果确实需要仔细评估。让我先跑几个关键的稳健性检验：",
      latestUserText: "这个结果靠谱吗？有没有稳健性检验？",
      tools: [],
    })

    expect(result.text).not.toContain("让我先跑")
    expect(result.text).toContain("本轮尚未执行")
    expect(result.text).toContain("请先选择具体方案")
  })

  test("存在上一轮结果但当前咨询轮没有工具时，仍不能把稳健性计划说成已开始", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "结果目前证据较弱。我先做几项稳健性检验和诊断：",
      latestUserText: "这个结果靠谱吗？有没有稳健性检验？",
      tools: [{
        tool: "ols_regression",
        state: {
          status: "completed",
          metadata: {
            analysisView: {
              kind: "econometrics",
              step: "ols_regression",
              results: [{ label: "x 系数", value: "0.5" }],
            },
          },
        },
      }],
      currentTurnTools: [],
    })

    expect(result.text).not.toContain("我先做几项稳健性检验")
    expect(result.text).toContain("本轮尚未执行")
  })

  test("异常值只能说明未阻断执行，不能被说成不影响回归结果", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "数据质量检查发现异常值，但不影响本次回归运行。",
      tools: analysisTurn("ols_regression"),
    })

    expect(result.text).not.toContain("不影响本次回归运行")
    expect(result.text).toContain("未阻断本次回归执行")
    expect(result.text).toContain("影响尚未评估")
  })

  test("未纳入模型的异常值也不能被断言为不影响多个回归", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "数据质量提醒：异常值列未使用，因此不影响上述两个回归。",
      tools: analysisTurn("ols_regression"),
    })

    expect(result.text).not.toContain("不影响上述两个回归")
    expect(result.text).toContain("未改变本次模型变量的直接计算")
    expect(result.text).toContain("影响尚未评估")
  })

  test("异常值不能被包装成正常分布并断言不影响本次结论", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "部分列存在潜在异常值（|z|>3.5），属于正常分布特征，不影响本次结论。",
      tools: analysisTurn("panel_fe_regression"),
    })

    expect(result.text).not.toContain("正常分布特征")
    expect(result.text).not.toContain("不影响本次结论")
    expect(result.text).toContain("异常值对估计结果的影响尚未评估")
  })

  test("缩尾或对数变换不能直接证明极端值影响已经降低", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "因变量和核心解释变量已通过缩尾+对数处理降低极端值影响。",
      tools: analysisTurn("panel_fe_regression"),
    })

    expect(result.text).not.toContain("降低极端值影响")
    expect(result.text).toContain("异常值对估计结果的影响尚未评估")
  })

  test("结论章节没有正文而直接进入下一步时删除空标题", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "OLS回归已完成。\n\n## 结论与局限\n\n下一步如需要，可继续做稳健性检验。",
      tools: analysisTurn("ols_regression"),
    })

    expect(result.text).not.toContain("## 结论与局限")
    expect(result.text).toContain("下一步如需要")
  })

  test("已有唯一面板键证据时，不把面板误称为重复截面", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "数据画像显示时间结构存在重复截面特征，本次按面板固定效应执行。",
      tools: [
        {
          tool: "data_import",
          state: {
            status: "completed",
            metadata: { verifiedPanelKeys: "地区×year" },
          },
        },
        ...analysisTurn("panel_fe_regression"),
      ],
    })

    expect(result.text).not.toContain("重复截面")
    expect(result.text).toContain("面板数据")
    expect(result.text).toContain("地区×year")
  })

  test("任意分析章节没有正文而直接接下一个标题时删除空章节", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "## 解读\n\n## 局限\n- 结果只能作为条件相关关系。",
      tools: analysisTurn("ols_regression"),
    })

    expect(result.text).not.toContain("## 解读")
    expect(result.text).toContain("## 局限")
  })

  test("粗体分析小节没有正文而直接进入下一步时删除空标题", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "**相对基准的变化**\n\n需要的话我可以继续加控制变量。",
      tools: analysisTurn("ols_regression"),
    })

    expect(result.text).not.toContain("相对基准的变化")
    expect(result.text).toContain("需要的话我可以继续")
  })

  test("面板键只能使用数据就绪快照中的真实时间列，不把约定名 year 当成事实", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "OLS已完成。数据含地区×year个体—时间结构，也包含year标识，本次未吸收year固定效应；数据中存在year、省份、地区等列。",
      tools: [
        {
          tool: "data_import",
          state: {
            status: "completed",
            metadata: {
              verifiedPanelKeys: "地区×年份",
              analysisView: {
                kind: "data_import",
              },
            },
          },
        },
      ],
    })

    expect(result.text).not.toMatch(/地区\s*[×x*]\s*year\b/i)
    expect(result.text).toContain("地区×年份")
    expect(result.text).not.toMatch(/\byear\s*(?:标识|固定效应)/i)
    expect(result.text).toContain("年份标识")
    expect(result.text).toContain("存在年份、省份")
  })

  test("面板结构展示不重复拼接同一个时间列", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "面板结构：地区×年份 × 年份。",
      tools: [
        {
          tool: "data_import",
          state: {
            status: "completed",
            metadata: { verifiedPanelKeys: "地区×年份" },
          },
        },
      ],
    })

    expect(result.text).toContain("面板结构：地区×年份")
    expect(result.text).not.toContain("地区×年份 × 年份")
  })
})

describe("已核验的复合面板键事实必须进入最终用户说明", () => {
  test("模型漏写不删行时由分析文本兜底补上", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "双向固定效应面板回归已完成。样本量 9683，组内 R²=0.75。",
      tools: [
        {
          tool: "panel_fe_regression",
          state: {
            status: "completed",
            metadata: {
              analysisView: {
                kind: "regression",
                step: "panel_fe_regression",
                warnings: [
                  "Found 115 duplicate entity-time rows under '地区'x'年份'. Verified: combining '地区' with column '省份' resolves all duplicates (yields 421 unique entities, 0 duplicates).",
                ],
              },
            },
          },
        },
      ],
    })

    expect(result.text).toContain("不会删除任何行")
    expect(result.text).toContain("复合实体")
  })
})

describe("回归核验事实必须覆盖模型收尾时的误删", () => {
  test("分位数回归缺少正文路径时补齐每个分位点及各自的 p 值", () => {
    const tools = [{
      tool: "econometrics_execute",
      state: {
        status: "completed",
        metadata: {
          analysisView: {
            kind: "econometrics",
            step: "quantile_regression",
            results: [
              { label: "did τ=0.25 系数", value: "-0.0245" },
              { label: "did τ=0.25 p 值", value: "0.145" },
              { label: "did τ=0.5 系数", value: "-0.0242" },
              { label: "did τ=0.5 p 值", value: "0.071" },
              { label: "did τ=0.75 系数", value: "-0.0094" },
              { label: "did τ=0.75 p 值", value: "0.337" },
            ],
          },
        },
      },
    }]
    expect(isAnalysisTurn(tools)).toBe(true)
    expect(readToolAnalysisView(tools[0].state.metadata)?.step).toBe("quantile_regression")
    expect(readToolAnalysisView(tools[0].state.metadata)?.results).toHaveLength(6)
    const result = sanitizeAnalysisAssistantText({
      text: "已按指定的 2021 横截面完成分位数回归，解释变量路径如下。",
      tools,
    })

    expect(result.text).toContain("did τ=0.25 系数=-0.0245")
    expect(result.text).toContain("did τ=0.25 p 值=0.145")
    expect(result.text).toContain("did τ=0.5 系数=-0.0242")
    expect(result.text).toContain("did τ=0.5 p 值=0.071")
    expect(result.text).toContain("did τ=0.75 系数=-0.0094")
    expect(result.text).toContain("did τ=0.75 p 值=0.337")
    expect(result.text.match(/已核验的分位数回归结果：/g)).toHaveLength(3)
    expect(result.text).not.toContain("quantile_regression")
  })

  test("稳健回归正文遗漏的影响点诊断仍从核验结果补齐", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "稳健回归已完成。did 系数=-0.0202，p 值=0.074。",
      tools: [{
        tool: "econometrics_execute",
        state: {
          status: "completed",
          metadata: {
            analysisView: {
              kind: "econometrics",
              step: "robust_regression",
              results: [
                { label: "did 系数", value: "-0.0202" },
                { label: "p 值", value: "0.074" },
                { label: "稳健标准误", value: "0.0113" },
                { label: "M 估计函数", value: "Huber" },
                { label: "残差尺度", value: "0.0214" },
                { label: "低权重观测", value: "6（2.2%）" },
              ],
            },
          },
        },
      }],
    })

    expect(result.text).toContain("补充")
    expect(result.text).toContain("M 估计函数=Huber")
    expect(result.text).toContain("残差尺度=0.0214")
    expect(result.text).toContain("低权重观测=6（2.2%）")
  })

  test("模型的方向/显著性被核验器误删时，用户仍能看到可信核心结果", () => {
    const result = sanitizeAnalysisAssistantText({
      text: [
        "OLS基准回归已完成。",
        "- 该方向或显著性表述与已核验结果不一致，已省略。",
        "- 未核验的统计量：coefficient、p_value。",
      ].join("\n"),
      tools: [
        {
          tool: "ols_regression",
          state: {
            status: "completed",
            metadata: {
              analysisView: {
                kind: "econometrics",
                step: "ols_regression",
                results: [
                  { label: "高质量发展指数 系数", value: "0.8502" },
                  { label: "p 值", value: "<0.001" },
                ],
              },
            },
          },
        },
      ],
    })

    expect(result.text).toContain("高质量发展指数 系数")
    expect(result.text).toContain("0.8502")
    expect(result.text).toContain("<0.001")
    expect(result.text).not.toContain("该方向或显著性表述与已核验结果不一致")
    expect(result.text).not.toContain("未核验的统计量")
    expect((result.text.match(/已核验的核心回归结果：/g) ?? []).length).toBe(1)
  })

  test("系数项数不能被误当成核心回归系数", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "回归已完成，但正文没有写出核心系数。",
      tools: [
        {
          tool: "panel_fe_regression",
          state: {
            status: "completed",
            metadata: {
              analysisView: {
                kind: "econometrics",
                step: "panel_fe_regression",
                results: [
                  { label: "系数项", value: "4" },
                  { label: "绿色信贷 系数", value: "1.35" },
                  { label: "p 值", value: "<0.001" },
                ],
              },
            },
          },
        },
      ],
    })

    expect(result.text).toContain("绿色信贷 系数=1.35")
    expect(result.text).not.toContain("核心回归结果：系数项=4")
  })

  test("同一请求的多个回归方法都必须有对应的可信结果", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "OLS和双向固定效应都已完成。两个模型的系数接近。",
      tools: [
        {
          tool: "ols_regression",
          state: {
            status: "completed",
            metadata: {
              analysisView: {
                kind: "econometrics",
                step: "ols_regression",
                results: [
                  { label: "高质量发展指数 系数", value: "0.8502" },
                  { label: "p 值", value: "<0.001" },
                ],
              },
            },
          },
        },
        {
          tool: "panel_fe_regression",
          state: {
            status: "completed",
            metadata: {
              analysisView: {
                kind: "econometrics",
                step: "panel_fe_regression",
                results: [
                  { label: "高质量发展指数 系数", value: "0.8560" },
                  { label: "p 值", value: "<0.001" },
                ],
              },
            },
          },
        },
      ],
    })

    expect(result.text).toContain("已核验的OLS回归结果：高质量发展指数 系数=0.8502")
    expect(result.text).toContain("已核验的面板固定效应回归结果：高质量发展指数 系数=0.8560")
    expect(result.text).not.toContain("未核验的精确统计数值已省略")
    expect(result.text).not.toContain("该方向或显著性表述与已核验结果不一致")
  })

  test("多方法报告漏写某个估计器的样本和拟合指标时，从该方法的结构化结果补齐", () => {
    const result = sanitizeAnalysisAssistantText({
      text: [
        "已核验的OLS回归结果：高质量发展指数 系数=0.8502，p 值=0.0001。",
        "已核验的面板固定效应回归结果：高质量发展指数 系数=0.8555，p 值=0.0001。",
        "## 说明与局限\n两个模型均已完成。",
      ].join("\n\n"),
      tools: [{
        tool: "panel_fe_regression",
        state: {
          status: "completed",
          metadata: {
            analysisView: {
              kind: "econometrics",
              step: "panel_fe_regression",
              results: [
                { label: "高质量发展指数 系数", value: "0.8555" },
                { label: "p 值", value: "0.0001" },
                { label: "标准误", value: "0.0618" },
                { label: "N", value: "4709" },
                { label: "组内 R²", value: "0.3251" },
              ],
            },
          },
        },
      }],
    })

    expect(result.text).toContain("面板固定效应回归补充")
    expect(result.text).toContain("标准误=0.0618")
    expect(result.text).toContain("N=4709")
    expect(result.text).toContain("组内 R²=0.3251")
  })

  test("方法对比中的裸数字不能冒充第二个模型的系数", () => {
    const result = sanitizeAnalysisAssistantText({
      text: [
        "OLS结果：高质量发展指数 系数=0.8502，p 值=0.0001；N=4709。",
        "面板固定效应已完成，组内R²=0.9576。",
        "两个设定下高质量发展指数的系数几乎一致（0.8502 vs 0.8555）。",
      ].join("\n\n"),
      tools: [
        {
          tool: "ols_regression",
          state: {
            status: "completed",
            metadata: {
              analysisView: {
                kind: "econometrics",
                step: "ols_regression",
                results: [{ label: "高质量发展指数 系数", value: "0.8502" }, { label: "p 值", value: "0.0001" }],
              },
            },
          },
        },
        {
          tool: "panel_fe_regression",
          state: {
            status: "completed",
            metadata: {
              analysisView: {
                kind: "econometrics",
                step: "panel_fe_regression",
                results: [
                  { label: "高质量发展指数 系数", value: "0.8555" },
                  { label: "标准误", value: "0.0080" },
                  { label: "p 值", value: "0.0000" },
                  { label: "组内 R²", value: "0.9576" },
                  { label: "N", value: "4709" },
                ],
              },
            },
          },
        },
      ],
    })

    expect(result.text).toContain("已核验的面板固定效应回归结果：高质量发展指数 系数=0.8555")
    expect(result.text).toContain("标准误=0.0080")
    expect(result.text).toContain("N=4709")
  })

  test("组内R²只能解释为整体模型拟合度，不能归因给单个变量", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "组内R²约0.325，说明该变量解释了约三分之一的组内变异。",
      tools: [{
        tool: "panel_fe_regression",
        state: {
          status: "completed",
          input: { treatmentVar: "绿色信贷", entityVar: "地区", timeVar: "年份" },
          metadata: {
            analysisView: {
              kind: "econometrics",
              step: "panel_fe_regression",
              results: [{ label: "绿色信贷 系数", value: "1.3500" }, { label: "组内R²", value: "0.3251" }],
            },
          },
        },
      }],
    })

    expect(result.text).not.toContain("该变量解释了")
    expect(result.text).toContain("模型整体解释了")
  })

  test("已成功但规格错误的第一次估计不能被报告成被拒绝且没有结果", () => {
    const panel = (entityVar: string, timeVar: string) => ({
      tool: "panel_fe_regression",
      state: {
        status: "completed",
        input: { entityVar, timeVar },
        metadata: {
          analysisView: {
            kind: "econometrics",
            step: "panel_fe_regression",
            results: [{ label: "绿色信贷 系数", value: "1.3500" }],
          },
        },
      },
    })
    const result = sanitizeAnalysisAssistantText({
      text: "第一次尝试时实体/时间传反，被系统拒绝，未产生结果；这次按正确设定完成。",
      tools: [panel("年份", "地区"), panel("地区", "年份")],
    })

    expect(result.text).not.toContain("未产生结果")
    expect(result.text).toContain("规格错误")
    expect(result.text).toContain("更正后的设定")
  })

  test("短进度消息不重复注入完整回归摘要", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "OLS已完成，接下来运行双向固定效应。",
      tools: [{
        tool: "ols_regression",
        state: {
          status: "completed",
          metadata: {
            analysisView: {
              kind: "econometrics",
              step: "ols_regression",
              results: [{ label: "高质量发展指数 系数", value: "0.8502" }, { label: "p 值", value: "0.0000" }],
            },
          },
        },
      }],
    })

    expect(result.text).toBe("OLS已完成，接下来运行双向固定效应。")
    expect(result.text).not.toContain("已核验的核心回归结果")
  })

  test("分析文本净化重复运行必须幂等，不重复追加已核验摘要", () => {
    const tools = [{
      tool: "panel_fe_regression",
      state: {
        status: "completed",
        metadata: {
          analysisView: {
            kind: "econometrics",
            step: "panel_fe_regression",
            results: [
              { label: "高质量发展指数 系数", value: "0.8555" },
              { label: "标准误", value: "0.0080" },
              { label: "p 值", value: "0.0000" },
              { label: "组内 R²", value: "0.9576" },
              { label: "N", value: "4709" },
            ],
          },
        },
      },
    }]
    const first = sanitizeAnalysisAssistantText({
      text: "面板固定效应回归已完成，高质量发展指数系数为0.8555。",
      tools,
    })
    const second = sanitizeAnalysisAssistantText({
      text: first.text,
      tools,
    })

    expect(second.text).toBe(first.text)
    expect((second.text.match(/已核验的面板固定效应回归补充/g) ?? []).length).toBeLessThanOrEqual(1)
  })

  test("同一方法已有完整核验摘要时删除重复的p值补充行", () => {
    const result = sanitizeAnalysisAssistantText({
      text: [
        "已核验的面板固定效应回归结果：高质量发展指数 系数=0.8555，p 值=0.0000；标准误=0.0080，组内 R²=0.9576，N=4709。",
        "已核验的面板固定效应回归补充：p 值=0.0000。",
        "两个模型均已完成。",
      ].join("\n\n"),
      tools: [{
        tool: "panel_fe_regression",
        state: {
          status: "completed",
          metadata: {
            analysisView: {
              kind: "econometrics",
              step: "panel_fe_regression",
              results: [{ label: "高质量发展指数 系数", value: "0.8555" }, { label: "p 值", value: "0.0000" }],
            },
          },
        },
      }],
    })

    expect(result.text).toContain("已核验的面板固定效应回归结果")
    expect(result.text).not.toContain("已核验的面板固定效应回归补充：p 值=0.0000")
  })

  test("模型报告末尾的空Markdown标题被移除，不伪造缺失的结论正文", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "两个模型均已完成。\n\n## 核心结论\n",
      tools: [{
        tool: "ols_regression",
        state: {
          status: "completed",
          metadata: {
            analysisView: {
              kind: "econometrics",
              step: "ols_regression",
              results: [{ label: "高质量发展指数 系数", value: "0.8502" }],
            },
          },
        },
      }],
    })

    expect(result.text).toContain("两个模型均已完成")
    expect(result.text).not.toMatch(/## 核心结论\s*$/)
  })

  test("异常列未纳入模型时不把它改写成不会影响估计", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "数据质量检查有警告：这些列未进入本次模型，不影响本次估计结果，但后续仍需评估遗漏变量。",
      tools: [{
        tool: "ols_regression",
        state: {
          status: "completed",
          metadata: {
            analysisView: {
              kind: "econometrics",
              step: "ols_regression",
              results: [{ label: "高质量发展指数 系数", value: "0.8502" }],
            },
          },
        },
      }],
    })

    expect(result.text).not.toContain("不影响本次估计结果")
    expect(result.text).toContain("未改变本次模型变量的直接计算")
    expect(result.text).toContain("遗漏变量影响仍未评估")
    expect(result.text).not.toContain("评估。，")
  })

  test("极端值警告只说明没有阻断执行，不能声称没有影响估计结果", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "数据质量检查提示部分变量存在潜在极端值（|z|>3.5），未影响估计。",
      tools: [{
        tool: "ols_regression",
        state: {
          status: "completed",
          metadata: {
            analysisView: {
              kind: "econometrics",
              step: "ols_regression",
              results: [{ label: "高质量发展指数 系数", value: "0.8502" }],
            },
          },
        },
      }],
    })

    expect(result.text).not.toContain("未影响估计")
    expect(result.text).toContain("未评估")
  })

  test("异常值涉及核心变量时，不能把质检警告写成不影响本次回归", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "数据质量检查有异常值警告（高质量发展指数、创新指数 |z|>3.5），但不影响本回归的核心变量。",
      tools: [{
        tool: "ols_regression",
        state: {
          status: "completed",
          metadata: {
            analysisView: {
              kind: "econometrics",
              step: "ols_regression",
              results: [{ label: "高质量发展指数 系数", value: "0.8502" }],
            },
          },
        },
      }],
    })

    expect(result.text).not.toContain("不影响本回归的核心变量")
    expect(result.text).toContain("异常值对估计结果的影响尚未评估")
  })

  test("工具窗口尚未挂到文本片段时，也不能让异常值无影响表述绕过净化", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "数据质量检查有异常值警告（高质量发展指数、创新指数 |z|>3.5），但不影响本回归的核心变量。",
      tools: [],
    })

    expect(result.text).not.toContain("不影响本回归的核心变量")
    expect(result.text).toContain("异常值对估计结果的影响尚未评估")
  })

  test("稳健回归的降权比例不能直接被写成结果可靠", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "仅0.9%的观测被明显降权，说明极端值对估计的干扰很小，结果可靠。",
      tools: [{
        tool: "robust_regression",
        state: {
          status: "completed",
          metadata: {
            analysisView: {
              kind: "econometrics",
              step: "robust_regression",
              results: [{ label: "降权观测", value: "0.9%" }],
            },
          },
        },
      }],
    })

    expect(result.text).not.toMatch(/(?:说明|表明)[^。\n]*结果可靠/)
    expect(result.text).toContain("不能单独证明异常值影响有限")
  })

  test("稳健回归不能用影响有限或结果稳健替代敏感性比较", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "极端值降权观测仅占0.9%，说明数据虽有异常值但影响有限。本次 Huber M 估计已通过迭代降权处理，结果稳健。",
      tools: [{
        tool: "robust_regression",
        state: {
          status: "completed",
          metadata: {
            analysisView: {
              kind: "econometrics",
              step: "robust_regression",
              results: [{ label: "降权观测", value: "0.9%" }],
            },
          },
        },
      }],
    })

    expect(result.text).not.toMatch(/说明数据虽有异常值但影响有限/)
    expect(result.text).not.toMatch(/结果稳健。/)
    expect(result.text).toContain("仍需与 OLS 或其他设定比较")
  })

  test("工具窗口尚未挂到稳健回归正文时，也不能放行降权后的过度结论", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "极端值降权观测仅占0.9%，说明数据虽有异常值但影响有限。本次 Huber M 估计已通过迭代降权处理，结果稳健。",
      tools: [],
    })

    expect(result.text).not.toMatch(/说明数据虽有异常值但影响有限/)
    expect(result.text).not.toMatch(/结果稳健。/)
    expect(result.text).toContain("仍需与 OLS 或其他设定比较")
  })

  test("稳健回归不能把少量降权观测直接解释为未主导估计", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "仅0.9%的观测被明显降权，说明极端值未主导估计。",
      tools: [],
    })

    expect(result.text).not.toMatch(/(?:说明|表明)[^。\n]*极端值未主导估计/)
    expect(result.text).toContain("不能单独证明极端值未主导估计")
  })

  test("未进入本次回归不等于不影响本模型估计", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "这些变量未进入本次回归，不影响本模型估计，但后续仍需评估。",
      tools: [{
        tool: "ols_regression",
        state: {
          status: "completed",
          metadata: {
            analysisView: {
              kind: "econometrics",
              step: "ols_regression",
              results: [{ label: "高质量发展指数 系数", value: "0.8502" }],
            },
          },
        },
      }],
    })

    expect(result.text).not.toContain("不影响本模型估计")
    expect(result.text).toContain("遗漏变量影响仍未评估")
  })

  test("QA不能把time缺失解释成有意设计，也不能把极端值解释成真实差异", () => {
    const result = sanitizeAnalysisAssistantText({
      text: [
        "time列缺失3043行，这很可能是政策冲击或处理前时期有意设计。",
        "这些多是规模类指标，出现高z值很可能反映城市间真实规模差异。",
      ].join("\n"),
      tools: [{ tool: "data_import", state: { status: "completed", metadata: {} } }],
    })

    expect(result.text).not.toMatch(/很可能|大概率|有意设计|真实规模差异/)
    expect(result.text).toContain("未由本次质检确定")
    expect(result.text).toContain("不能仅凭统计异常推断其现实来源")
  })

  test("QA不能把time缺失归因于政策冲击，也不能把极端值归因于真实经济差异", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "time列缺失较严重，可能与政策冲击时间定义有关。极端值可能是真实经济差异，不一定是录入错误。",
      tools: [{ tool: "data_import", state: { status: "completed", metadata: {} } }],
    })

    expect(result.text).not.toMatch(/可能与政策冲击|可能是真实经济差异|不一定是录入错误/)
    expect(result.text).toContain("缺失原因和研究含义未由本次质检确定")
    expect(result.text).toContain("不能仅凭统计异常推断其现实来源")
  })

  test("QA不能把异常值可能反映的现实差异或录入误差当成结论", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "这些异常值可能反映直辖市/超大省份的真实规模差异，也可能包含极端录入误差，需结合研究设计判断。",
      tools: [{ tool: "data_import", state: { status: "completed", metadata: {} } }],
    })

    expect(result.text).toContain("不能仅凭统计异常推断其现实来源")
    expect(result.text).not.toMatch(/可能反映.*真实规模差异|可能包含.*录入误差/)
  })

  test("QA不能把结构性极端值直接认定为真实差异", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "这些是面板数据中常见的结构性极端值，通常属于真实差异而非录入错误。",
      tools: [{ tool: "data_import", state: { status: "completed", metadata: {} } }],
    })

    expect(result.text).toContain("不能仅凭统计异常推断其现实来源")
    expect(result.text).not.toContain("通常属于真实差异而非录入错误")
  })

  test("面板方法建议只能使用已核验的面板键，并隐藏内部结构标签", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "数据结构识别为重复截面（repeated_cross_section）。下一步改用面板固定效应（省份×年份）后重跑。",
      tools: [{
        tool: "data_import",
        state: {
          status: "completed",
          metadata: {
            verifiedPanelKeys: "地区×年份",
            analysisView: { kind: "data_import" },
          },
        },
      }],
    })

    expect(result.text).not.toContain("repeated_cross_section")
    expect(result.text).not.toContain("省份×年份")
    expect(result.text).toContain("地区×年份")
  })

  test("模型已经写出可信回归数字时也要移除内部核验占位文案", () => {
    const result = sanitizeAnalysisAssistantText({
      text: [
        "OLS已完成。",
        "- 城镇化水平系数=0.1675，p<0.001。",
        "- 未核验的精确统计数值已省略。",
        "部分统计表述无法与结果产物直接对应，已不纳入本次结论。",
        "部分统计数值无法与已核验产物对应，已省略。",
      ].join("\n"),
      tools: [
        {
          tool: "ols_regression",
          state: {
            status: "completed",
            metadata: {
              analysisView: {
                kind: "econometrics",
                step: "ols_regression",
                results: [{ label: "城镇化水平 系数", value: "0.1675" }],
              },
            },
          },
        },
      ],
    })

    expect(result.text).toContain("城镇化水平系数=0.1675")
    expect(result.text).not.toContain("未核验的精确统计数值已省略")
    expect(result.text).not.toContain("部分统计表述无法与结果产物直接对应")
    expect(result.text).not.toContain("部分统计数值无法与已核验产物对应")
  })

  test("模型漏写回归核心系数时，不能等用户追问才补齐", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "核心结果：截距=0.0000（p=0.932）；R²=0.9895。",
      tools: [
        {
          tool: "ols_regression",
          state: {
            status: "completed",
            metadata: {
              analysisView: {
                kind: "econometrics",
                step: "ols_regression",
                results: [
                  { label: "高质量发展指数 系数", value: "0.8502" },
                  { label: "p 值", value: "<0.001" },
                ],
              },
            },
          },
        },
      ],
    })

    expect(result.text).toContain("高质量发展指数 系数=0.8502")
  })

  test("补充的可信核心结果应位于报告主体之前，而不是落成长尾注", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "OLS 已完成。\n\n**解读与局限**：当前结果只能说明统计相关性。",
      tools: [
        {
          tool: "ols_regression",
          state: {
            status: "completed",
            metadata: {
              analysisView: {
                kind: "econometrics",
                step: "ols_regression",
                results: [
                  { label: "城镇化水平 系数", value: "0.1675" },
                  { label: "p 值", value: "<0.001" },
                ],
              },
            },
          },
        },
      ],
    })

    expect(result.text.indexOf("已核验的核心回归结果")).toBeLessThan(result.text.indexOf("解读与局限"))
  })

  test("面板回归最终说明不能省略已执行的实体与时间变量", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "面板固定效应回归已完成。控制地区和时间不变因素后，核心变量显著。",
      tools: [{
        tool: "panel_fe_regression",
        state: {
          status: "completed",
          input: {
            entityVar: "地区",
            timeVar: "年份",
            dependentVar: "绿色金融指数",
            treatmentVar: "绿色信贷",
          },
          metadata: {
            analysisView: {
              kind: "econometrics",
              step: "panel_fe_regression",
              results: [{ label: "绿色信贷 系数", value: "1.3500" }],
            },
          },
        },
      }],
    })

    expect(result.text).toContain("实体=地区")
    expect(result.text).toContain("时间=年份")
  })

  test("无项目符号的内部方向占位文案同样必须移除", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "OLS已完成。\n该方向或显著性表述与已核验结果不一致，已省略。",
      tools: [
        {
          tool: "ols_regression",
          state: {
            status: "completed",
            metadata: {
              analysisView: {
                kind: "econometrics",
                step: "ols_regression",
                results: [{ label: "x 系数", value: "0.52" }],
              },
            },
          },
        },
      ],
    })

    expect(result.text).not.toContain("方向或显著性表述与已核验结果不一致")
    expect(result.text).toContain("x 系数=0.52")
  })

  test("不能把QA异常值来源或缺失处理说成已经确定", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "数据质量检查完成：异常值为结构性分布而非录入错误。异常值不代表会影响后续估计。市场化水平缺失1行，按列表删除即可。",
      tools: [{ tool: "data_import", state: { status: "completed", metadata: { analysisView: { kind: "data_import" } } } }],
    })

    expect(result.text).toContain("不能仅凭此判断是结构性差异还是录入错误")
    expect(result.text).not.toContain("不代表会影响后续估计")
    expect(result.text).toContain("对估计结果的影响尚未评估")
    expect(result.text).toContain("是否删除、填补或保留需结合模型设定确认")
    expect(result.text).not.toContain("按列表删除即可")
    expect(result.text).not.toContain("未核验的精确统计数值已省略")
  })

  test("取消后的状态回答不泄漏会话ID或内部阶段字段", () => {
    const result = sanitizeAnalysisAssistantText({
      text: [
        "当前会话状态：没有任何活动的数据阶段或工作流状态。",
        "- 会话ID：ses_abc",
        "- 规范化数据阶段（canonicalDataStage）：无",
        "- 工作流状态（workflowState）：无",
        "也就是说，之前的分析已取消，尚未导入任何数据。",
      ].join("\n"),
      tools: [],
      latestUserText: "刚才的分析我取消了。请只告诉我当前会话状态。",
    })

    expect(result.text).toContain("当前会话已取消")
    expect(result.text).not.toContain("ses_abc")
    expect(result.text).not.toContain("canonicalDataStage")
    expect(result.text).not.toContain("workflowState")
  })

  test("压缩恢复后的数据集和阶段内部ID不出现在用户文本", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "当前数据集did_a8de0611，活跃阶段stage_000；OLS结果已恢复。",
      tools: [],
    })

    expect(result.text).not.toContain("did_a8de0611")
    expect(result.text).not.toContain("stage_000")
    expect(result.text).toContain("OLS结果已恢复")
  })

  test("压缩恢复状态不泄漏内联字段名", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "数据集：did.xlsx，datasetId=did_a8de0611，活跃stage=stage_000；covariates=空；covariance=HC1。",
      tools: [],
    })

    expect(result.text).not.toContain("datasetId")
    expect(result.text).not.toContain("活跃stage")
    expect(result.text).not.toContain("covariates")
    expect(result.text).not.toContain("covariance")
    expect(result.text).toContain("未加入控制变量")
    expect(result.text).toContain("HC1稳健标准误")
  })

  test("PSM报告不泄漏内部预处理聚合字段", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "倾向得分匹配已完成（preTreatmentAggregation=not_applicable），ATT=0.0018。",
      tools: analysisTurn("psm_matching"),
    })

    expect(result.text).not.toContain("preTreatmentAggregation")
    expect(result.text).not.toContain("not_applicable")
    expect(result.text).toContain("倾向得分匹配已完成")
    expect(result.text).toContain("ATT=0.0018")
  })

  test("内部ID识别不误伤合法变量名和用户文件名", () => {
    const text = "did_exposure是处理变量，dataset_abcdefgh.csv是用户文件，task_variable是任务变量。"
    expect(containsEngineInternalData(text)).toBe(false)
    expect(sanitizeAnalysisAssistantText({ text, tools: [] }).text).toBe(text)
  })

  test("压缩恢复中的workflow和checkpoint字段也必须隐藏", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "workflowRunId=workflow_123456789abc，checkpointId=chk_123456789abc，stageId=stage_000。",
      tools: [],
    })

    expect(result.text).not.toContain("workflowRunId")
    expect(result.text).not.toContain("checkpointId")
    expect(result.text).not.toContain("stageId")
    expect(result.text).not.toContain("workflow_123456789abc")
    expect(result.text).not.toContain("chk_123456789abc")
  })

  test("TUI使用的内部数据检测也能识别裸workflow和checkpoint标识", () => {
    expect(containsEngineInternalData("workflowRunId=workflow_123456789abc checkpointId=chk_123456789abc")).toBe(true)
  })

  test("统计结论中的‘可以忽略’不应被当成缺失值处理", () => {
    const text = "该变量的系数在经济意义上可以忽略。"
    expect(sanitizeAnalysisAssistantText({ text, tools: [] }).text).toBe(text)
  })

  test("缺失值语境中的‘可忽略’才转换为需要确认的处理决策", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "市场化水平缺失1行，比例很低可以忽略。",
      tools: [],
    })
    expect(result.text).toContain("是否删除、填补或保留需结合模型设定确认")
  })

  test("只有已完成且面向用户的回归结果才能触发结果补充", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "回归处理中。",
      tools: [
        {
          tool: "ols_regression",
          state: {
            status: "running",
            metadata: {
              analysisView: {
                kind: "econometrics",
                step: "ols_regression",
                results: [{ label: "x 系数", value: "0.52", visibility: "internal_only" }],
              },
            },
          },
        },
      ],
    })

    expect(result.text).not.toContain("核心回归结果")
    expect(result.text).not.toContain("0.52")
  })

  test("internal_only回归指标不能被TUI状态文本补出", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "回归已完成。",
      tools: [{
        tool: "ols_regression",
        state: {
          status: "completed",
          metadata: {
            analysisView: {
              kind: "econometrics",
              step: "ols_regression",
              results: [{ label: "x 系数", value: "0.52", visibility: "internal_only" }],
            },
          },
        },
      }],
    })
    expect(result.text).not.toContain("0.52")
  })

  test("清理编号列表形式的未核验占位文案", () => {
    const result = sanitizeAnalysisAssistantText({
      text: [
        "### 诊断与局限",
        "1. 未核验的精确统计数值已省略。",
        "2、未核验的统计量：coefficient、p_value。",
        "3) 未核验的精确统计数值已省略。",
        "- 当前结果只能说明统计相关性。",
      ].join("\n"),
      tools: analysisTurn("ols_regression"),
    })

    expect(result.text).toContain("当前结果只能说明统计相关性")
    expect(result.text).not.toContain("未核验的精确统计数值已省略")
    expect(result.text).not.toContain("未核验的统计量")
  })

  test("隐藏内部核验状态并修复路径净化留下的空语法", () => {
    const result = sanitizeAnalysisAssistantText({
      text: [
        "数据已导入（4709行×34列）（，）",
        "post列构造完成，生成（35列），并通过质检。",
        "工作流显示估计节点已完成，verifier状态为warn（非阻断，只有一条\"无法读取某证据文件\"的提示），无失败。",
        "内部清单里“结果报告”一项仍标记为pending，指正式产物化报告尚未生成；这不影响已在上一步交付的对话结果。",
      ].join("\n"),
      tools: analysisTurn("did_static"),
    })

    expect(result.text).not.toMatch(/（\s*[，,]\s*）/)
    expect(result.text).toContain("生成了35列")
    expect(result.text).not.toMatch(/工作流显示|verifier|内部清单|pending/)
    expect(result.text).toContain("结果已生成")
  })

  test("路径净化后不留下空的“数据集/阶段”字段，也不展示空质量章节", () => {
    const result = sanitizeAnalysisAssistantText({
      text: [
        "导入完成：数据集 did_abc12345，阶段 stage_000，4709行×34列。",
        "具体核验结果（数据集 ，工作表“Data_可读”）。",
        "导入成功：数据集 ，，4709行×34列。",
        "- 数据集：，",
        "post列已按year>=2013生成（）。",
        "post构造完成，生成新阶段 。",
        "## 数据质量提示",
        "",
        "下一步可继续查看结果。",
      ].join("\n"),
      tools: analysisTurn("ols_regression"),
    })

    expect(result.text).toContain("导入完成：4709行×34列")
    expect(result.text).not.toContain("数据集 ，阶段")
    expect(result.text).not.toContain("数据集 ，工作表")
    expect(result.text).not.toContain("数据集 ，，")
    expect(result.text).not.toContain("数据集：，")
    expect(result.text).not.toContain("（）")
    expect(result.text).toContain("生成了新的数据阶段")
    expect(result.text).not.toContain("## 数据质量提示")
    expect(result.text).toContain("下一步可继续查看结果")
  })

  test("模型恢复轮的空字段和空项目符号不展示给用户", () => {
    const result = sanitizeAnalysisAssistantText({
      text: [
        "**数据集**:   ",
        "**导入状态**: ✅ 成功",
        "-",
        "- ",
        "- 规模: 4709 行 × 34 列",
      ].join("\n"),
      tools: analysisTurn(),
    })

    expect(result.text).not.toMatch(/数据集\s*[:：]\s*$/m)
    expect(result.text).not.toMatch(/^\s*[-*+]\s*$/m)
    expect(result.text).toContain("导入状态")
    expect(result.text).toContain("规模: 4709 行 × 34 列")
  })

  test("分析收尾不复述内部工具调用清单，也不留下脱敏后的空反引号", () => {
    const result = sanitizeAnalysisAssistantText({
      text: [
        "**工具调用事实：**",
        "1. `数据导入(profile,  → 失败（数据集不存在）→ 改用真实路径导入",
        "2. `数据导入(import, inputPath=did.xlsx)` → 成功，返回 ` `",
        "**数据画像结果：**",
        "- 文件：did.xlsx",
        "- 规模：4709 行 × 34 列",
        "本轮未执行任何回归。",
      ].join("\n"),
      tools: analysisTurn(),
    })

    expect(result.text).not.toContain("工具调用事实")
    expect(result.text).not.toContain("数据导入(profile")
    expect(result.text).not.toContain("``")
    expect(result.text).not.toContain("工作流状态")
    expect(result.text).not.toContain("- ，")
    expect(result.text).toContain("数据画像结果")
    expect(result.text).toContain("本轮未执行任何回归")
  })

  test("数据集与阶段 ID 脱敏后不留下斜杠空壳", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "已回到第一份 did 数据集（ / ），不重新导入。",
      tools: analysisTurn("ols_regression"),
    })

    expect(result.text).toBe("已回到第一份 did 数据集，不重新导入。")
  })

  test("隐藏斜杠连接的内部字段并补充遗漏变量限制", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "OLS已完成。导入成功（datasetId/stageId 已在会话中留存）。本次未加入任何控制变量。",
      tools: analysisTurn("ols_regression"),
    })

    expect(result.text).not.toMatch(/datasetId\s*\/\s*stageId/i)
    expect(result.text).toContain("遗漏变量影响未被本模型评估")
  })

  test("已核验面板键存在时，不把面板数据错误展示为重复截面", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "方法：合并OLS（数据结构为重复截面，数据含省份、year）。下一步可考虑省份固定效应和年份固定效应。",
      tools: [{
        tool: "data_import",
        state: {
          status: "completed",
          metadata: {
            verifiedPanelKeys: "地区×year",
            analysisView: {
              kind: "data_import",
              step: "data_import(import)",
              panelCandidates: [{ entityVars: ["地区"], timeVar: "year" }],
            },
          },
        },
      }],
    })

    expect(result.text).not.toContain("重复截面")
    expect(result.text).toContain("面板数据")
    expect(result.text).toContain("地区×year")
  })

  test("OLS报告不使用含糊的横截面或合并面板结构表述", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "横截面/合并面板结构下为均值效应估计，不宣称因果识别。",
      tools: [{
        tool: "data_import",
        state: {
          status: "completed",
          metadata: { verifiedPanelKeys: "地区×year" },
        },
      }, ...analysisTurn("ols_regression")],
    })

    expect(result.text).not.toContain("横截面/合并面板结构")
    expect(result.text).toContain("OLS未吸收已核验的面板固定效应")
    expect(result.text).toContain("地区×year")
  })

  test("真实OLS报告的面板变体、病句和共线性表述统一净化", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "数据概览：4709行 × 34列，重复截面结构（个体=省份，时间=year）。数据质量：异常值影响尚未评估执行。核心变量无线性依赖。此为横截面/合并面板回归。",
      tools: [{
        tool: "data_import",
        state: {
          status: "completed",
          metadata: { verifiedPanelKeys: "地区×year" },
        },
      }, ...analysisTurn("ols_regression")],
    })

    expect(result.text).not.toContain("重复截面结构")
    expect(result.text).not.toContain("横截面/合并面板回归")
    expect(result.text).not.toContain("尚未评估执行")
    expect(result.text).not.toContain("无线性依赖")
    expect(result.text).toContain("面板数据")
    expect(result.text).toContain("合并面板OLS")
    expect(result.text).toContain("影响尚未评估")
    expect(result.text).toContain("未发现完全线性依赖")
  })

  test("OLS识别局限中的横截面/合并面板基准表述也要明确面板事实", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "识别局限：仍为横截面/合并面板基准均值模型，未控制遗漏变量。",
      tools: [{
        tool: "data_import",
        state: { status: "completed", metadata: { verifiedPanelKeys: "地区×year" } },
      }, ...analysisTurn("ols_regression")],
    })

    expect(result.text).not.toContain("横截面/合并面板基准均值模型")
    expect(result.text).toContain("合并面板OLS")
    expect(result.text).toContain("地区×year")
  })

  test("用户确认变量替换后，最终模型设定必须展示实际使用的列名", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "核心解释变量：城镇化率\n城镇化率的系数为 0.1675。",
      tools: [{
        tool: "ols_regression",
        state: {
          status: "completed",
          input: { treatmentVar: "城镇化率" },
          metadata: {
            analysisView: {
              kind: "econometrics",
              step: "ols_regression",
              results: [{ label: "城镇化水平 系数", value: "0.1675" }],
            },
          },
        },
      }],
    })

    expect(result.text).toContain("核心解释变量：城镇化水平")
    expect(result.text).not.toContain("核心解释变量：城镇化率")
  })

  test("用户明确要求停止时，不能把停止试错写成不停止试错", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "按您的要求，不构造post、不切换方法、不停止试错。任务结束。",
      latestUserText: "如果缺少post，请告诉我不适用并停止；不要构造post、切换方法或继续试错。",
      tools: analysisTurn("did_static"),
    })

    expect(result.text).toContain("停止试错")
    expect(result.text).not.toContain("不停止试错")
  })

  test("OLS与Panel FE只能把已核验结果表述为统计关系，不能把面板事实写成条件句", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "若数据为面板结构，建议改用双向固定效应。高质量发展指数对创新指数的正向效应在两种设定下高度稳健。",
      tools: [
        {
          tool: "data_import",
          state: { status: "completed", metadata: { verifiedPanelKeys: "地区×year" } },
        },
        ...analysisTurn("ols_regression"),
        {
          tool: "panel_fe_regression",
          state: {
            status: "completed",
            input: { entityVar: "地区", timeVar: "year", treatmentVar: "高质量发展指数" },
            metadata: { analysisView: { kind: "econometrics", step: "panel_fe_regression", results: [{ label: "高质量发展指数 系数", value: "0.8555" }] } },
          },
        },
      ],
    })

    expect(result.text).not.toContain("若数据为面板结构")
    expect(result.text).not.toContain("正向效应在两种设定下高度稳健")
    expect(result.text).toContain("数据已核验为面板结构")
    expect(result.text).toContain("正向统计关系")
  })

  test("没有识别设计证据时，不能把 Panel FE 写成更接近因果", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "Panel FE 吸收地区和年份固定效应，识别更接近因果；仍需平行趋势等诊断。",
      tools: [{ tool: "panel_fe_regression", state: { status: "completed", metadata: {} } }],
    })

    expect(result.text).not.toContain("识别更接近因果")
    expect(result.text).toContain("不能单独视为因果识别")
  })

  test("没有识别设计证据时，不能把 Panel FE 写成更干净的因果识别方案", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "若需更干净的因果识别，可改用面板固定效应回归。",
      tools: [{ tool: "panel_fe_regression", state: { status: "completed", metadata: {} } }],
    })

    expect(result.text).not.toContain("更干净的因果识别")
    expect(result.text).toContain("更充分地控制面板结构差异")
  })

  test("不把综合指标吸收或变量来源当作未经检验的原因", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "人口密度不显著，可能因为人口密度已被高质量发展指数等综合指标吸收，或其变异主要来自地区规模。",
      tools: analysisTurn("ols_regression"),
    })

    expect(result.text).toContain("该可能原因未由本模型检验")
    expect(result.text).not.toContain("可能因为")
  })

  test("控制变量前后系数接近不能被写成没有遗漏变量偏误", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "加入人口密度后，高质量发展指数系数保持 0.8502，未变化（控制人口密度后无遗漏变量偏误）。",
      tools: analysisTurn("ols_regression"),
    })

    expect(result.text).not.toContain("无遗漏变量偏误")
    expect(result.text).toContain("不能据此排除遗漏变量偏误")
  })

  test("p值低于阈值不能被写成高于显著性水平", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "核心变量系数为0.8502，p<0.001，远高于常规的0.001显著性水平。",
      tools: [{
        tool: "ols_regression",
        state: {
          status: "completed",
          metadata: {
            analysisView: {
              kind: "econometrics",
              step: "ols_regression",
              results: [
                { label: "核心变量 系数", value: "0.8502" },
                { label: "p 值", value: "<0.001" },
              ],
            },
          },
        },
      }],
    })

    expect(result.text).not.toContain("远高于常规的0.001显著性水平")
    expect(result.text).toContain("在1%显著性水平上显著")
  })

  test("模型只提到未控制遗漏变量时补充影响尚未评估", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "局限：未控制遗漏变量，未吸收固定效应。",
      tools: analysisTurn("ols_regression"),
    })

    expect(result.text).toContain("遗漏变量影响未被本模型评估")
  })

  test("工具确认无控制变量但模型漏写局限时补充遗漏变量披露", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "OLS回归已完成。核心解释变量显著。",
      tools: [{
        tool: "ols_regression",
        state: {
          status: "completed",
          input: { covariates: [] },
          metadata: {},
        },
      }],
    })

    expect(result.text).toContain("未纳入控制变量")
    expect(result.text).toContain("遗漏变量影响未被本模型评估")
  })

  test("遗漏变量披露应放在收尾邀请之前，而不是作为尾注追加", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "OLS回归已完成。核心解释变量显著。\n\n如需加入控制变量或进行其他稳健性检验，请告知。",
      tools: [{
        tool: "ols_regression",
        state: {
          status: "completed",
          input: { covariates: [] },
          metadata: {},
        },
      }],
    })

    const disclosureIndex = result.text.indexOf("本次未纳入控制变量")
    const invitationIndex = result.text.indexOf("如需加入控制变量")
    expect(disclosureIndex).toBeGreaterThanOrEqual(0)
    expect(invitationIndex).toBeGreaterThanOrEqual(0)
    expect(disclosureIndex).toBeLessThan(invitationIndex)
  })

  test("不重复追加已经出现的回归p值和遗漏变量限制", () => {
    const result = sanitizeAnalysisAssistantText({
      text: [
        "已核验的核心回归结果：城镇化水平 系数=0.1675，p 值=0.0000；N=4709。",
        "已核验的OLS回归补充：p 值=0.0000。",
        "本次未加入任何控制变量，也未评估遗漏变量（如经济结构）的影响。",
        "- 遗漏变量影响未被本模型评估。",
      ].join("\n"),
      tools: analysisTurn("ols_regression"),
    })

    expect(result.text).not.toContain("已核验的OLS回归补充：p 值=0.0000")
    expect((result.text.match(/遗漏变量影响未被本模型评估/g) ?? []).length).toBeLessThanOrEqual(1)
    expect(result.text).not.toMatch(/未评估遗漏变量[^\n]*\n- 遗漏变量影响未被本模型评估。/)
  })

  test("隐藏方法推荐内部拼接并删除没有内容的限制标题", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "已按修复指引完成画像（计量方法推荐 返回结构 ，推荐OLS）。\n\n**需注意的限制**\n\n如需继续，可告诉我方向。",
      tools: analysisTurn("panel_fe_regression"),
    })

    expect(result.text).not.toContain("返回结构")
    expect(result.text).toContain("计量方法推荐结果，推荐OLS")
    expect(result.text).not.toContain("**需注意的限制**")
    expect(result.text).toContain("如需继续")
  })
})

describe("PSM 估计的关键平衡诊断必须进入最终用户说明", () => {
  test("模型漏写 SMD 时补充工具已核验的诊断指标", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "倾向得分回归调整已完成。ATE=-0.0021，样本量277。",
      tools: [
        {
          tool: "psm_regression",
          state: {
            status: "completed",
            metadata: {
              analysisView: {
                kind: "econometrics",
                step: "psm_regression",
                results: [
                  { label: "ATE", value: "-0.0021" },
                  { label: "加权后最大绝对 SMD", value: "0.0432" },
                ],
                conclusion: "固定线性倾向得分回归调整已通过重叠、有效样本量和加权平衡门。",
              },
            },
          },
        },
      ],
    })

    expect(result.text).toContain("SMD")
    expect(result.text).toContain("0.0432")
  })
})

describe("导入工作表事实必须进入用户说明", () => {
  test("用户明确询问变量时从已核验导入事实补齐变量清单", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "数据已导入。",
      latestUserText: "这份数据有哪些变量、多少行？",
      tools: [{
        tool: "data_import",
        state: {
          status: "completed",
          input: { action: "import" },
          metadata: {
            analysisView: {
              kind: "data_import",
              step: "data_import(import)",
              results: [
                { label: "行数变化", value: "4709 -> 4709" },
                { label: "列数变化", value: "34 -> 34" },
              ],
              variables: ["year", "地区", "创新指数"],
            },
          },
        },
      }],
    })

    expect(result.text).toContain("变量：year、地区、创新指数")
    expect(result.text).toContain("数据规模：4709行×34列")
  })

  test("质量事实优先于模型对缺失和面板键的错误复述", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "主要是面板数据结构（年份×省份）。缺失情况：本次导入未显示有严重缺失问题。",
      latestUserText: "这份数据有哪些变量、有没有缺失？",
      tools: [{
        tool: "data_import",
        state: {
          status: "completed",
          input: { action: "import" },
          metadata: {
            analysisView: {
              kind: "data_import",
              step: "data_import(import)",
              qualityFacts: "质量检查事实：缺失：time缺失3043行、市场化水平缺失1行；重复检查：已验证地区×year唯一；异常值：检测到潜在异常值列。",
              panelCandidates: [{ entityVars: ["地区"], timeVar: "year" }],
            },
          },
        },
      }],
    })

    expect(result.text).toContain("time缺失3043行")
    expect(result.text).toContain("地区×year")
    expect(result.text).not.toContain("本次导入未显示有严重缺失问题")
    expect(result.text).not.toContain("年份×省份")
  })

  test("模型漏写数据文件名时补充实际导入文件", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "双向固定效应回归已完成，绿色信贷系数为1.3500。",
      tools: [{
        tool: "data_import",
        state: {
          status: "completed",
          input: { action: "import" },
          metadata: {
            analysisView: {
              kind: "data_import",
              step: "data_import(import)",
              foundInputFile: "gf.xlsx",
            },
          },
        },
      }],
    })

    expect(result.text).toContain("数据：gf.xlsx")
  })

  test("模型漏写工作表时补充实际选中的工作表", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "数据已导入并完成画像，共4709行、35列。",
      tools: [
        {
          tool: "data_import",
          state: {
            status: "completed",
            input: {
              action: "import",
              sheetPolicy: { mode: "named_sheet", sheetName: "Data_原始编码" },
            },
            metadata: {
              analysisView: { kind: "data_import", step: "data_import(import)" },
            },
          },
        },
      ],
    })

    expect(result.text).toContain("Data_原始编码")
  })
})

describe("跨数据集回切事实必须进入用户说明", () => {
  test("用户要求回到第一份 did 时补充复用说明", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "OLS回归已完成，样本量4709，系数为0.0230。",
      latestUserText: "回到第一份 did 数据，不要重新导入；继续跑 OLS。",
      tools: [
        {
          tool: "ols_regression",
          state: {
            status: "completed",
            input: { datasetId: "did_1", stageId: "stage_000" },
            metadata: { analysisView: { kind: "econometrics", step: "ols_regression" } },
          },
        },
      ],
    })

    expect(result.text).toContain("回到第一份 did")
    expect(result.text).toContain("未重新导入")
  })
})

// 内部血缘契约（runId / branch / 方法窗口）的报错原文含字段名和"模型"字样，
// 属于工程内部语言，绝不能原样出现在用户对话里。
describe("内部契约错误的用户可读兜底", () => {
  test("runId 契约冲突不泄露 runId 字段名与内部措辞", () => {
    const display = userFacingAnalysisErrorText("runId 与当前规范化数据阶段不一致；不得由模型创建新的运行身份。")
    expect(display).toBeDefined()
    expect(display).not.toContain("runId")
    expect(display).not.toContain("模型")
    expect(display).not.toContain("规范化数据阶段")
  })

  test("branch 契约冲突同样有中文兜底", () => {
    const display = userFacingAnalysisErrorText("branch 与当前规范化数据阶段不一致；新分支必须通过显式工作流动作创建。")
    expect(display).toBeDefined()
    expect(display).not.toContain("branch")
    expect(display).not.toContain("工作流动作")
  })

  test("方法窗口未加载不泄露内部窗口概念", () => {
    const display = userFacingAnalysisErrorText(
      '工具 econometrics_execute 无法执行方法"panel_fe_regression"：该方法不在当前活动方法窗口。',
    )
    expect(display).toBeDefined()
    expect(display).not.toContain("方法窗口")
    expect(display).not.toContain("econometrics_execute")
  })
})

describe("完全线性依赖下的下一步建议", () => {
  test("不把已核验共线分项继续推荐为控制变量", () => {
    const result = sanitizeAnalysisAssistantText({
      text: [
        "面板固定效应回归已完成。",
        "**下一步可选**",
        "- 加入控制变量（绿色投资、绿色保险等）",
        "- 稳健性检验（如异方差诊断）",
      ].join("\n"),
      tools: [
        {
          tool: "data_import",
          state: {
            status: "completed",
            metadata: {
              result: {
                readiness: {
                  exactLinearDependencies: [
                    {
                      columns: ["绿色信贷", "绿色投资", "绿色保险"],
                      relation: "绿色信贷 = 绿色投资 + 绿色保险",
                    },
                  ],
                },
              },
            },
          },
        },
      ],
    })

    expect(result.text).not.toContain("加入控制变量（绿色投资、绿色保险等）")
    expect(result.text).toContain("完全线性依赖")
    expect(result.text).toContain("先确认保留或替换哪一项")
    expect(result.text).toContain("异方差诊断")
  })

  test("共线提示只禁止完整依赖组同时进入，不把单个分项误判为不可用", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "不要同时引入绿色投资、绿色保险、绿色债券、绿色支持之一，否则会与绿色信贷形成完全共线。",
      tools: [{
        tool: "data_import",
        state: {
          status: "completed",
          metadata: {
            result: {
              readiness: {
                exactLinearDependencies: [{
                  columns: ["绿色信贷", "绿色投资", "绿色保险", "绿色债券", "绿色支持"],
                  relation: "绿色信贷 = 绿色投资 + 绿色保险 + 绿色债券 + 绿色支持",
                }],
              },
            },
          },
        },
      }],
    })

    expect(result.text).toContain("同时纳入绿色信贷与其余四个子项")
    expect(result.text).not.toContain("之一")
  })
})
