import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { SystemPrompt } from "../../src/session/system"
import { readSourceUnit } from "../helpers/read-source"
import { assemblePromptSections } from "@/runtime/services/prompt-assembly"
import { Instance } from "@/project/instance"

const model = {
  providerID: "deepseek",
  api: { id: "deepseek-v4-flash" },
} as never

function renderedPrompt(providerID: "deepseek" | "custom" = "deepseek") {
  return SystemPrompt.sections({
    model: {
      providerID,
      api: { id: providerID === "deepseek" ? "deepseek-v4-flash" : "qwen3-max" },
    } as never,
    agent: { name: "analyst" } as never,
  })
    .map((section) => section.content)
    .join("\n")
}

describe("session.system 提示词契约", () => {
  test("DeepSeek 与 Qwen 源提示词本身完整、中文且可独立审查", () => {
    const prompts = {
      deepseek: fs.readFileSync(path.join(process.cwd(), "src", "session", "prompt", "deepseek.txt"), "utf-8"),
      qwen: fs.readFileSync(path.join(process.cwd(), "src", "session", "prompt", "qwen.txt"), "utf-8"),
    }

    for (const [provider, prompt] of Object.entries(prompts)) {
      expect(prompt.length, `${provider} 提示词被过度删减`).toBeGreaterThan(2_500)
      for (const section of ["身份与目标", "何时不调用工具", "工具使用纪律", "失败处理", "实证规格与诚实报告", "用户交付", "操作约束"]) {
        expect(prompt, `${provider} 缺少章节：${section}`).toContain(section)
      }
    for (const rule of ["交互式计量分析 Agent", "始终使用中文", "不得编造", "不复述用户问题", "不展示内部推理", "不得自动换方法", "统计显著性不等于经济意义"]) {
      expect(prompt, `${provider} 缺少规则：${rule}`).toContain(rule)
    }
    expect(prompt, `${provider} 未禁止无文件时主动搜索或直接读取原始表格`).toContain("不得主动调用 glob/read")
    expect(prompt, `${provider} 未规定原始表格必须走 data_import`).toContain("原始表格只能通过 data_import")
    expect(prompt, `${provider} 未区分数据集导出与回归结果导出`).toContain("只导出数据集")
    expect(prompt, `${provider} 丢失用户明确请求代码时的受控例外`).toContain("用户明确要求代码时")
    expect(prompt, `${provider} 没有限定 analysis_prepare 的统计参数与 Harness 血缘边界`).toContain("不得包含 datasetId、stageId、data_path 或 output_dir")
    expect(prompt, `${provider} 未说明 requestId 来自当前运行时请求`).toMatch(/requestId 必须逐字使用当前 <runtime> 中.*AnalysisRequest/)
    expect(prompt, `${provider} 没有将估计路由限制为 Harness 签发的 specId`).toContain("econometrics_execute 只接受 Harness 签发的 specId")
    }

    expect(prompts.deepseek).toContain("JSON 对象")
    expect(prompts.deepseek).toContain("不能再次编码成字符串")
    expect(prompts.deepseek).toContain("action、inputPath、preserveLabels 和 sheetPolicy 只属于 data_import")
    expect(prompts.deepseek).toContain("不得把报告标题或模型名称编造成 branch")
    expect(prompts.qwen).toContain("严格遵守当前工具的 JSON Schema")
    expect(prompts.qwen).not.toContain("不能再次编码成字符串")
    for (const [provider, prompt] of Object.entries(prompts)) {
      expect(prompt, `${provider} 未限制下一步建议只能来自已注册能力`).toContain("下一步建议只能使用当前工具目录或通过tool_search从Python Registry获得")
    }
  })

  test("最终 Provider system 正向路由各自提示词且共享方法论只出现一次", () => {
    const render = (providerID: "deepseek" | "custom") => {
      const sections = SystemPrompt.sections({
        model: {
          providerID,
          api: { id: providerID === "deepseek" ? "deepseek-v4-flash" : "qwen3-max" },
        } as never,
        agent: { name: "analyst" } as never,
      })
      return assemblePromptSections(sections).providerSystem.join("\n")
    }
    const deepseek = render("deepseek")
    const qwen = render("custom")

    expect(deepseek).toContain("DeepSeek 工具参数协议")
    expect(deepseek).not.toContain("Qwen 工具调用约定")
    expect(qwen).toContain("Qwen 工具调用约定")
    expect(qwen).not.toContain("DeepSeek 工具参数协议")
    expect(deepseek.split("# 计量分析方法论")).toHaveLength(2)
    expect(qwen.split("# 计量分析方法论")).toHaveLength(2)
    expect(deepseek).not.toContain("# 对话与任务识别")
    expect(qwen).not.toContain("# 对话与任务识别")
  })

  test("全局、会话和当前轮内容有稳定分层", () => {
    const sections = SystemPrompt.sections({
      model,
      agent: { name: "analyst" } as never,
      runtime: ["数据集=wave_1"],
      custom: ["使用项目自定义规则。"],
      catalog: ["本轮可调用：data_import"],
    })

    expect(sections.find((section) => section.id === "global.provider")?.stability).toBe("global")
    expect(sections.find((section) => section.id === "global.methodology")?.stability).toBe("global")
    expect(sections.find((section) => section.id === "session.agent")?.stability).toBe("session")
    expect(sections.find((section) => section.id === "turn.runtime")?.stability).toBe("turn")
    expect(sections.find((section) => section.id === "turn.catalog")?.content).toContain("data_import")
  })

  test("对话轮保持中文且准确解释单一用户模式与自动任务识别", () => {
    const prompt = SystemPrompt.conversation().join("\n")

    expect(prompt).toContain("始终使用中文")
    expect(prompt).toContain("不得调用工具")
    expect(prompt).toContain("不得编造")
    expect(prompt).toContain("交互式计量分析 Agent")
    expect(prompt).toContain("数据文件、研究问题")
    expect(prompt).toContain("用户可见的主工作模式只有 Analyst")
    expect(prompt).toContain("自动识别")
    expect(prompt).toContain("不要声称存在需要用户手动切换的“数据模式”")
    expect(prompt).toContain("下一轮")
    expect(prompt).not.toContain("计量分析方法论")
    expect(prompt.length).toBeLessThan(2_500)
  })

  test("status 意图向模型明确这是只读进度轮，不重启分析", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-status-prompt-"))
    try {
      const runtime = await Instance.provide({
        directory: root,
        fn: async () => (await SystemPrompt.environment({
          sessionID: "ses_status_prompt_test",
          inputIntent: "status",
        })).join("\n"),
      })

      expect(runtime).toContain("本轮是只读进度查询")
      expect(runtime).toContain("不要重新导入、质检、读取外部化报告或调用计量工具")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("当前 AnalysisRequest 的 requestId 仅注入动态运行时上下文", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-analysis-request-context-"))
    const requestId = "analysis_123e4567-e89b-42d3-a456-426614174000"
    try {
      const runtime = await Instance.provide({
        directory: root,
        fn: async () => (await SystemPrompt.environment({
          sessionID: "ses_analysis_request_context",
          analysisRequestId: requestId,
        } as never)).join("\n"),
      })

      expect(runtime).toContain(`当前 AnalysisRequest requestId=${requestId}`)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("用户确认的方法切换进入当前轮运行时提示，且不允许回到旧方法", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-confirmed-method-prompt-"))
    try {
      const runtime = await Instance.provide({
        directory: root,
        fn: async () => (await SystemPrompt.environment({
          sessionID: "ses_confirmed_method_prompt",
          inputIntent: "analysis",
          confirmedToolIDs: ["did2s"],
        })).join("\n"),
      })

      expect(runtime).toContain("用户已明确选择的方法：did2s")
      expect(runtime).toContain("优先按该方法检查前置条件并执行")
      expect(runtime).toContain("不得回到此前失败的方法")
      expect(runtime).toContain("如果缺少研究设计前提，必须询问用户")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("模型请求统一从具名 section 装配", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "runtime", "services", "model-gateway.ts"), "utf-8")

    expect(source).toContain('import { assemblePromptSections } from "@/runtime/services/prompt-assembly"')
    expect(source).toContain("SystemPrompt.sections({")
    expect(source).toContain("const promptBundle = assemblePromptSections(sections)")
  })

  test("模型请求的延迟目录来自当前可搜索池，不再静态枚举全部估计器", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "runtime", "services", "model-gateway.ts"), "utf-8")
    expect(source).toContain("resolvedTools.deferredToolSummary()")
    expect(source).not.toContain("ALL_ECONOMETRICS_ESTIMATOR_TOOL_IDS")
  })

  test("模型请求把有界工具池指标写入 ledger，不记录搜索 query 正文", () => {
    const gateway = fs.readFileSync(path.join(process.cwd(), "src", "runtime", "services", "model-gateway.ts"), "utf-8")
    const tools = fs.readFileSync(path.join(process.cwd(), "src", "session", "prompt", "tools.ts"), "utf-8")
    expect(gateway).toContain('kind: "tool.pool"')
    expect(gateway).toContain("resolvedTools.toolPoolSnapshot()")
    expect(tools).toContain('message: "tool search committed"')
    expect(tools).not.toContain("metadata: { query:")
  })

  test("项目规则位于 session 层，不混入运行时层", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "session", "prompt", "dispatch.ts"), "utf-8")

    expect(source).toContain("customSystem: await SystemPrompt.custom()")
    expect(source).not.toContain("...(await SystemPrompt.custom()),")
  })

  test("计量方法论锁定专用工具、QA 和不自动换方法", () => {
    const prompt = renderedPrompt()

    expect(prompt).toContain("只调用当前工具目录暴露的 schema")
    expect(prompt).toContain("估计前先对当前stage执行")
    expect(prompt).toContain("data_import执行profile和validate")
    expect(prompt).not.toMatch(/data_import.{0,20}(?:qa|describe)/)
    expect(prompt).toContain("不得自动换方法")
    expect(prompt).toContain("专用 schema 是参数唯一真相源")
    expect(prompt).toContain("econometrics_recommend")
    expect(prompt).toContain("data_import")
    expect(prompt).toContain("环境状态不确定时")
    expect(prompt).toContain("读取诊断和模型元数据")
    expect(prompt).toContain("只改变用户要求检验的部分")
    expect(prompt).toContain("数据就绪检查")
    expect(prompt).toContain("方法与当前数据条件不一致")
    expect(prompt).toContain("不要为了让回归运行而静默删除变量")
  })

  test("纵向倾向得分、异质性和阶段准入不允许臆造", () => {
    const prompt = renderedPrompt()

    expect(prompt).toContain("重复的个体—时间记录当作独立样本")
    expect(prompt).toContain("分析单位、处理前时期或聚合规则、结果期和估计目标")
    expect(prompt).toContain("用户明确的分组变量或可复现规则")
    expect(prompt).toContain("可能尚未加载，不代表未注册或数据未就绪")
    expect(prompt).toContain("只有执行端明确报告数据前提缺失时")
    expect(prompt).toContain("heterogeneity_runner")
  })

  test("传统与交错 DID 在方法论层按方法族约束并交给 Registry 发现", () => {
    const prompt = renderedPrompt()

    expect(prompt).toContain("处理组和政策后变量")
    expect(prompt).toContain("传统两组两期DID")
    expect(prompt).toContain("交错或多批次DID")
    expect(prompt).toContain("tool_search")
    expect(prompt).toContain("不得用双向固定效应替代")
    expect(prompt).toContain("交错DID缺少首次处理时期或相对时期变量时最多做一次必要的频数检查")
  })

  test("默认交付只给可信结论，不泄漏内部工作区", () => {
    const prompt = renderedPrompt()

    expect(prompt).toContain("默认在对话中交付方法、核心估计、诊断、局限和下一步")
    expect(prompt).toContain("不粘贴代码、原始数据、完整 dataframe、完整 schema、重试日志、内部 ID 或内部工作路径")
    expect(prompt).toContain("不主动推销文档包")
    expect(prompt).toContain("异方差")
    expect(prompt).toContain("多重共线性")
    expect(prompt).toContain("不得向普通用户展示 .killstata")
    expect(prompt).toContain("不要调用 glob/list/read 猜测内部目录")
  })

  test("DeepSeek 保留 JSON 参数协议，通用 Provider 不重复该差异", () => {
    const deepseek = SystemPrompt.provider(model)[0]
    const generic = SystemPrompt.provider({
      providerID: "custom",
      api: { id: "qwen3-max" },
    } as never)[0]

    expect(deepseek).toContain("工具参数必须是 JSON 对象")
    expect(generic).not.toContain("JSON 对象再编码成字符串")
  })

  test("工具目录仅列当前暴露工具，延迟面只给命名空间汇总", () => {
    const prompt = SystemPrompt.toolCatalog(
      [
        { id: "panel_fe_regression", modelNamespace: "econometrics_estimator" },
        { id: "iv_2sls", modelNamespace: "econometrics_estimator" },
        { id: "tool_search", modelNamespace: "pipeline" },
      ],
      [{ modelNamespace: "econometrics_estimator", count: 16 }],
    ).join("\n")

    expect(prompt).toContain("计量估计：iv_2sls, panel_fe_regression")
    expect(prompt).toContain("计量估计：16 个")
    expect(prompt).toContain("先调用 tool_search")
    expect(prompt).toContain("下一轮")
    expect(prompt).not.toContain("ols_regression")
    expect(prompt).toContain("不得调用“本轮可调用”以外的工具")
  })

  test("已加载方法的动态引用只进入当前轮目录，并携带可执行 Schema", () => {
    const prompt = SystemPrompt.toolCatalog(
      [{ id: "econometrics_execute", modelNamespace: "pipeline" }],
      [],
      [{
        toolID: "ols_regression",
        modelNamespace: "econometrics_estimator",
        description: "连续结果变量的基准线性回归。",
        inputSchema: {
          type: "object",
          properties: { dependentVar: { type: "string" } },
          required: ["dependentVar"],
        },
      }],
    ).join("\n")

    // 方法加载后只进入当前会话引用，不改变稳定 Provider tools 前缀。
    expect(prompt).toContain("已加载的计量方法引用")
    expect(prompt).toContain("ols_regression")
    expect(prompt).toContain("methodID")
  })

  test("环境提示不再注入空文件块或历史模式切换", () => {
    const systemSource = fs.readFileSync(path.join(process.cwd(), "src", "session", "system.ts"), "utf-8")
    const promptSource = readSourceUnit("session/prompt")

    expect(systemSource).not.toContain("<files>")
    expect(systemSource).not.toContain("Ripgrep.tree")
    expect(promptSource).not.toContain("plan_enter")
    expect(promptSource).not.toContain("plan_exit")
    expect(promptSource).not.toContain("Explorer Workflow")
  })
})
describe("静态工具索引：只保留能力域，方法细节交给按需搜索", () => {
  const inventory = [
    { id: "ols_regression", modelNamespace: "econometrics_estimator" as const, purpose: "连续结果变量的基准线性回归。" },
    { id: "poisson_regression", modelNamespace: "econometrics_estimator" as const, purpose: "非负计数结果。" },
    { id: "data_import", modelNamespace: "data" as const, purpose: "导入原始表格并生成规范化数据集。" },
  ]

  test("方法注册表在全局提示词只提供发现协议，具体契约交给 Python Registry", () => {
    const rendered = SystemPrompt.toolInventory(inventory).join("\n")

    expect(rendered).not.toContain("ols_regression")
    expect(rendered).not.toContain("poisson_regression")
    expect(rendered).toContain("Python Registry")
    expect(rendered).toContain("tool_search")
    expect(rendered).toContain("方法引用")
    // 数据/文件类工具常驻目录，不需要通过方法搜索
    expect(rendered).not.toContain("datasetId")
    expect(rendered).not.toContain("- data_import｜")
  })

  test("注册表新增方法时，全局能力域索引的文本保持不变", () => {
    const baseline = SystemPrompt.toolInventory(inventory).join("\n")
    const expanded = SystemPrompt.toolInventory([
      ...inventory,
      ...Array.from({ length: 200 }, () => ({ id: "new_method", modelNamespace: "econometrics_estimator" as const })),
    ]).join("\n")

    expect(expanded).toBe(baseline)
    expect(expanded).not.toContain("个已注册能力")
  })

  test("清单进 global 稳定层，动态目录留在 turn 层", () => {
    const sections = SystemPrompt.sections({
      model: { providerID: "deepseek", api: { id: "deepseek-chat" } } as never,
      agent: { name: "analyst", prompt: "agent prompt" } as never,
      inventory: SystemPrompt.toolInventory(inventory),
      catalog: SystemPrompt.toolCatalog([{ id: "read", modelNamespace: "filesystem" }], []),
    })

    const inventorySection = sections.find((item) => item.id.startsWith("global.tool_inventory"))
    const catalogSection = sections.find((item) => item.id.startsWith("turn.catalog"))
    expect(inventorySection?.stability).toBe("global")
    expect(catalogSection?.stability).toBe("turn")

    // global 层保持稳定；动态方法引用留在当前会话消息中。
    const bundle = assemblePromptSections(sections)
    expect(bundle.globalSystem.join("\n")).not.toContain("ols_regression")
    expect(bundle.globalSystem.join("\n")).toContain("计量方法发现")
    // 本轮目录（turn 层）不重复索引内容
    expect(bundle.turnSystem.join("\n")).not.toContain("计量方法索引")
  })
})
