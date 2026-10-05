import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { SystemPrompt } from "@/session/system"
import { assemblePromptSections } from "@/runtime/services/prompt-assembly"

const model = {
  providerID: "deepseek",
  api: { id: "deepseek-v4-flash" },
} as never

const analyst = { name: "analyst" } as never

describe("中文提示词分层契约", () => {
  test("全局层用中文定义交互式计量身份、安全边界和专用工具纪律", () => {
    const sections = SystemPrompt.sections({ model, agent: analyst })
    const global = sections
      .filter((section) => section.stability === "global")
      .map((section) => section.content)
      .join("\n")

    expect(global).toContain("交互式计量分析 Agent")
    expect(global).toContain("不得编造统计量")
    expect(global).toContain("可逆性")
    expect(global).toContain("影响范围")
    expect(global).toContain("专用工具")
    expect(global).toContain("始终使用中文")
  })

  test("global、session、turn 分别保留独立前缀与哈希", () => {
    const first = assemblePromptSections([
      { id: "global.identity", stability: "global", content: "全局规则" },
      { id: "session.agent", stability: "session", content: "会话角色" },
      { id: "turn.runtime", stability: "turn", content: "数据集=A" },
    ])
    const second = assemblePromptSections([
      { id: "global.identity", stability: "global", content: "全局规则" },
      { id: "session.agent", stability: "session", content: "会话角色" },
      { id: "turn.runtime", stability: "turn", content: "数据集=B" },
    ])

    expect(first.globalSystem).toEqual(["全局规则"])
    expect(first.sessionSystem).toEqual(["会话角色"])
    expect(first.turnSystem).toEqual(["数据集=A"])
    expect(first.globalHash).toBe(second.globalHash)
    expect(first.sessionHash).toBe(second.sessionHash)
    expect(first.turnHash).not.toBe(second.turnHash)
  })

  test("对话轮固定使用中文，不虚构第二个用户模式", () => {
    const prompt = SystemPrompt.conversation().join("\n")

    expect(prompt).toContain("始终使用中文")
    expect(prompt).toContain("不得调用工具")
    expect(prompt).toContain("用户可见的主工作模式只有 Analyst")
    expect(prompt).toContain("不声称存在模式按钮")
    expect(prompt).not.toContain("计量方法论")
  })

  test("conversation 意图必须真正切换到对话提示词装配", () => {
    const gateway = fs.readFileSync(path.join(process.cwd(), "src", "runtime", "services", "model-gateway.ts"), "utf-8")
    expect(gateway).toContain("conversationOnly: input.inputIntent === \"conversation\"")
    expect(gateway).toMatch(/const resolvedTools[\s\S]*input\.inputIntent === "conversation"[\s\S]*emptyToolSet\(\)/)
  })

  test("关键 Agent 与工具提示词保留完整的专业执行语义", () => {
    const read = (file: string) => fs.readFileSync(path.join(process.cwd(), "src", file), "utf-8")

    const generated = read("agent/generate.txt")
    expect(generated).toContain("识别假设")
    expect(generated).toContain("诊断与稳健性")
    expect(generated).toContain("可复现")
    expect(generated).toContain("identifier")
    expect(generated).toContain("whenToUse")
    expect(generated).toContain("systemPrompt")

    const compaction = read("agent/prompt/compaction.txt")
    for (const term of ["用户授权", "数据集", "stage", "失败", "来源", "下一步可执行动作"]) {
      expect(compaction).toContain(term)
    }

    const explore = read("agent/prompt/explore.txt")
    for (const term of ["只读", "工作表", "编码", "样本范围", "不得猜测"]) {
      expect(explore).toContain(term)
    }

    const dataImport = read("tool/data-import.txt")
    for (const term of ["datasetId", "stageId", "sheetPolicy", "产物", "阻断"]) {
      expect(dataImport).toContain(term)
    }

    const task = read("tool/task.txt")
    for (const term of ["上下文边界", "只读", "预期交付", "不得重复"]) {
      expect(task).toContain(term)
    }
  })

  test("执行型提示明确要求动作落地，比较模型使用完整规格", () => {
    const roles = fs.readFileSync(path.join(process.cwd(), "src", "agent", "prompt", "roles.ts"), "utf-8")
    const deepseek = fs.readFileSync(path.join(process.cwd(), "src", "session", "prompt", "deepseek.txt"), "utf-8")
    const context = fs.readFileSync(path.join(process.cwd(), "src", "session", "prompt", "econometrics-context.ts"), "utf-8")

    expect(roles).toContain("必须实际发起对应 tool-call")
    expect(deepseek).toContain("一个模型规格只调用一次")
    expect(deepseek).toContain("covariates` 必须为空")
    expect(context).toContain("treatmentVar")
    expect(context).toContain("不要把数据集中的其他列自动加入模型")
    expect(context).toContain("不要在没有 tool-call 的情况下结束这一轮")
    expect(context).toContain("用户纠正模型规格后，只重跑纠正后的唯一规格")
    expect(context).toContain("错误、阻断、重试和修复只能引用本轮真实记录")
    expect(context).toContain("即使只有一个近义列，也不能静默替换用户点名的变量")
    expect(context).toContain("下一步不得擅自增加控制变量、分组变量或改变模型规格")
    expect(context).toContain("不得用当前日期补全数据年份")
    expect(context).toContain("面板键中的实体列名和时间列名必须逐字复制")
    expect(context).toContain("不得把 year 当作年份")
    expect(context).toContain("未纳入模型的变量不能表述")
    expect(context).toContain("遗漏变量影响和识别偏误未被本模型评估")
    expect(context).toContain("p值越小表示反对原假设的证据越强")
    expect(context).toContain("p<0.001只能表述为在1%显著性水平上显著")
    expect(context).toContain("合并面板 OLS")
    expect(context).toContain("不要把它称为混合截面")
    expect(context).toContain("下一步建议必须服从当前数据质量和线性依赖诊断")
    expect(context).toContain("质量/重复/缺失/异常值体检")
    expect(context).toContain("不要自动进入异常值检测或数据预处理")
    expect(context).toContain("不要向用户复述内部结构分类名")
    expect(context).toContain("只改变计量方法时复用最近已核验的数据阶段")
    expect(context).toContain("每个已完成方法都必须给出方法设定、核心系数")
    expect(context).toContain("时期数量和日期范围冲突时只报告有证据的粒度")
    expect(context).toContain("不得用")
    expect(context).toContain("左右")
    expect(context).toContain("问号补全统计事实")
  })

  test("系统提示明确区分 TypeScript Harness 与 Python 计量引擎职责", () => {
    const prompt = SystemPrompt.provider({
      providerID: "deepseek",
      api: { id: "deepseek-v4-flash" },
    } as never).join("\n")
    expect(prompt).toContain("TypeScript Harness")
    expect(prompt).toContain("Python计量引擎")
    expect(prompt).toContain("不实现或推测计量算法")
    expect(prompt).toContain("不读取Session")
  })

  test("多模型汇报提示要求单次汇总而不是复制中间摘要", () => {
    const context = fs.readFileSync(path.join(process.cwd(), "src", "session", "prompt", "econometrics-context.ts"), "utf-8")

    expect(context).toContain("最终回答只输出一份汇总报告")
    expect(context).toContain("不要把中间进度或工具摘要整段复制")
    expect(context).toContain("不同方法仍要分别保留各自的统计量")
  })

  test("所有活跃文本提示词至少含有中文行为说明", () => {
    const files = [
      "agent/generate.txt",
      "agent/prompt/compaction.txt",
      "agent/prompt/explore.txt",
      "agent/prompt/summary.txt",
      "agent/prompt/title.txt",
      "session/prompt/deepseek.txt",
      "session/prompt/max-steps.txt",
      "session/prompt/qwen.txt",
      "tool/bash.txt",
      "tool/data-import.txt",
      "tool/edit.txt",
      "tool/experiment-log.txt",
      "tool/glob.txt",
      "tool/grep.txt",
      "tool/heterogeneity-runner.txt",
      "tool/ls.txt",
      "tool/question.txt",
      "tool/read.txt",
      "tool/task.txt",
      "tool/todowrite.txt",
      "tool/webfetch.txt",
      "tool/write.txt",
    ]

    for (const file of files) {
      const content = fs.readFileSync(path.join(process.cwd(), "src", file), "utf-8")
      expect(content).toMatch(/[\u3400-\u9fff]/)
    }
  })

  test("附件、子任务和压缩恢复等合成提示不再向模型注入英文模板", () => {
    const sources = [
      "session/prompt/message.ts",
      "session/prompt/dispatch.ts",
      "session/compaction.ts",
    ]
      .map((file) => fs.readFileSync(path.join(process.cwd(), "src", file), "utf-8"))
      .join("\n")

    for (const retired of [
      "Reading MCP resource:",
      "Attached data file",
      "Called the Read tool with the following input:",
      "Summarize the task tool output above",
      "Generated locally because AI compaction failed",
      "[Compaction restore state]",
      "Generate a title for this conversation",
    ]) {
      expect(sources).not.toContain(retired)
    }
  })
})
