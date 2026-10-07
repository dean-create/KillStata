import { expect, test } from "bun:test"
import { SessionPrompt } from "@/session/prompt"
import { isQualityInspectionOnlyRequest } from "@/session/prompt/tools"

test("a negated analysis instruction stays in conversation mode", () => {
  const detectInputIntent = (SessionPrompt as Record<string, any>).detectInputIntent

  expect(detectInputIntent?.([{ type: "text", text: "不要再分析了，先聊聊模型选择" }])).toBe("conversation")
})

test("explicit preprocessing and MCDA requests enter the admitted analysis bundle", () => {
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "把收入变量缩尾 1%" }] as any)).toBe("analysis")
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "用熵权 TOPSIS 构建综合发展指数" }] as any)).toBe("analysis")
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "你能做缩尾吗？" }] as any)).toBe("conversation")
})

test("显式调用 read/glob 时不被只读质量体检模式隐藏", () => {
  const text = "请先调用 read 工具读取不存在的文件；失败后再用 glob 或 data_import 找到数据并完成数据画像，本轮不要做回归"
  expect(isQualityInspectionOnlyRequest(text)).toBe(false)
})

test("多方法比较的疑问句仍进入 analysis，避免第二个估计器被 conversation 意图剥离", () => {
  expect(SessionPrompt.detectInputIntent([
    { type: "text", text: "probit 会不会更合适？两个都跑一下对比。" },
  ] as any, undefined, true, true)).toBe("analysis")
  expect(SessionPrompt.detectInputIntent([
    { type: "text", text: "logit 和 probit 有什么区别？先解释一下。" },
  ] as any, undefined, true, true)).toBe("conversation")
})

test("image filenames never select an analysis or ingest workflow", () => {
  const parts = [
    { type: "text", text: "看看这张图" },
    { type: "file", filename: "regression.csv.png", url: "file:///regression.csv.png", mime: "image/png" },
  ] as any

  expect(SessionPrompt.detectInputIntent(parts)).toBe("conversation")
})

test("negation follows the last workflow instruction in the sentence", () => {
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "别做回归" }] as any)).toBe("conversation")
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "不要对这份数据做回归" }] as any)).toBe("conversation")
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "先别分析 A，但直接回归 B" }] as any)).toBe("analysis")
})

test("data-preparation requests keep data_import available via the ingest intent", () => {
  // 真实 bug（2026-07-18）：用户导入 Excel 后说"先做数据质量检查"，被判成 conversation，
  // 导致 data_import 被工具门控剥离——模型想去重却报"工具调用失败/请检查任务参数"。
  // 扩展审计发现整个 data_import 动作族（qa/describe/preprocess/filter/correlation/
  // rollback/export）的自然语言都落到了 conversation，必须统一归入 ingest。
  const cases = [
    // 质检 / 清洗 / 缺失 / 描述 / 相关
    "先做数据质量检查",
    "检查数据质量",
    "去重",
    "帮我清洗数据",
    "看看有没有缺失值",
    "描述性统计",
    "先看描述统计",
    "这些重复记录怎么处理",
    "看下相关性",
    // rollback / undo —— 用户设计里 undo = 数据阶段回滚，同样被误判过
    "撤销上一步",
    "回到上一个阶段",
    "回滚",
    "撤销刚才的筛选",
    "undo",
    // export
    "把结果导出成 excel",
    "导出数据",
    "export",
    // 自然语言筛选 / 查看
    "只保留 2010 年以后的数据",
    "筛掉 2010 年前的",
    "剔除异常值",
    "数据长什么样",
    "看下数据",
    "有多少行",
    "变量都有哪些",
    "看看数据分布",
  ]
  for (const text of cases) {
    expect(SessionPrompt.detectInputIntent([{ type: "text", text }] as any), text).toBe("ingest")
  }
})

test("data-preparation vocabulary does not hijack genuine small talk or method questions", () => {
  // 反向守护：数据准备词表是锚定的（查看类必须跟数据名词），纯闲聊、寒暄、
  // "是什么/怎么样"类咨询、以及"看看这段话"这种非数据请求都必须留在 conversation。
  const conversationCases = [
    "你好",
    "你能干嘛",
    "谢谢",
    "1",
    "?",
    "嗯",
    "好的",
    "再见",
    "这个模型怎么样",
    "解释一下什么是内生性",
    "帮我看看这段话什么意思",
    "今天天气不错",
  ]
  for (const text of conversationCases) {
    expect(SessionPrompt.detectInputIntent([{ type: "text", text }] as any), text).toBe("conversation")
  }
})

test("with an active dataset, unrecognized instructions still keep data_import available (context-aware)", () => {
  // 关键词白名单无法穷尽——这些措辞任何词表都覆盖不到，但数据集已在场时用户显然在谈数据。
  // 上下文感知兜底让它们走 ingest（放行 data_import），根治"换个说法就死锁"这一类。
  const instructions = [
    "把那几个离群的弄掉",
    "上面那步再来一遍",
    "这样不对，重新弄",
    "换一列试试",
    "把它变成对数",
    "把北京去掉",
    "按这个分组再算一次",
    "怎么把北京删掉",
  ]
  for (const text of instructions) {
    // 有数据集 → ingest
    expect(SessionPrompt.detectInputIntent([{ type: "text", text }] as any, undefined, true), `active:${text}`).toBe(
      "ingest",
    )
    // 无数据集 → 保持现状（无关键词回落 conversation），证明这是纯增量、不改旧行为
    expect(SessionPrompt.detectInputIntent([{ type: "text", text }] as any, undefined, false), `idle:${text}`).toBe(
      "conversation",
    )
  }
})

test("context-aware fallback still parks small talk and concept questions in conversation", () => {
  // 即使数据集已在场，纯寒暄/致谢/单字确认、以及"什么是/为什么/靠谱吗"这类概念咨询
  // 都必须留在 conversation，不能被数据在场信号裹挟进工作流。
  const stayConversation = [
    "你好",
    "谢谢",
    "嗯",
    "好的",
    "行",
    "ok",
    "收到",
    "知道了",
    "再见",
    "1",
    "？",
    "。",
    "哈哈",
    "什么是内生性",
    "为什么要这样做",
    "这个方法靠谱吗",
    "应该用哪个模型",
    "内生性是什么意思",
  ]
  for (const text of stayConversation) {
    expect(SessionPrompt.detectInputIntent([{ type: "text", text }] as any, undefined, true), text).toBe("conversation")
  }
})

test("an in-progress analysis keeps keyword-less continuations in analysis mode (estimator deadlock fix)", () => {
  // 真实死锁复现（2026-07-18，did.xlsx / NJ 最低工资 / 绿色金融，5/5 会话全部命中）：
  // 分析已越过 QA 进入估计链后，用户下一句推进消息不含回归关键词，被降级到 ingest →
  // estimator 工具被 resolveToolAvailability 的 stage∩intent 收窄挡掉 →
  // "Model tried to call unavailable tool 'panel_fe_regression'"。
  // 第 4 参数 analysisInProgress=true 时，非闲聊/非概念咨询的延续消息必须保持 analysis。
  const continuations = [
    "怎么不动了，直接告诉我该用什么方法，然后把结果给我",
    "两个细节我都不确定，你自己判断，直接给我看结果，最好控制一下几个连锁品牌自身的差异",
    "接着往下做",
    "把北京那几个城市也加进去再跑一次",
  ]
  for (const text of continuations) {
    // 分析进行中 → analysis（解锁 estimator，让 stage 决定实际工具）
    expect(
      SessionPrompt.detectInputIntent([{ type: "text", text }] as any, undefined, true, true),
      `active:${text}`,
    ).toBe("analysis")
    // 仅数据在场、分析未推进 → 保持 ingest（旧行为，证明这是纯增量、不改数据准备语义）
    expect(
      SessionPrompt.detectInputIntent([{ type: "text", text }] as any, undefined, true, false),
      `dataset-only:${text}`,
    ).toBe("ingest")
  }
})

test("method-recommendation confirmations keep estimator tools available", () => {
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "就用你说的方法跑一下。" }] as any, undefined, true)).toBe(
    "analysis",
  )
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "按推荐的模型做一遍" }] as any, undefined, true)).toBe(
    "analysis",
  )
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "就用你说的方法跑一下。" }] as any)).toBe(
    "conversation",
  )
})

test("纯进度追问进入 status 意图，不重新打开分析工具包", () => {
  const statusQueries = [
    "跑完了吗？",
    "现在到哪一步了？",
    "当前进度怎么样？",
    "结果出来了吗",
    "还在运行吗？",
  ]
  for (const text of statusQueries) {
    expect(
      SessionPrompt.detectInputIntent([{ type: "text", text }] as any, undefined, true, true),
      text,
    ).toBe("status")
  }

  // 带有明确推进动作的句子仍然是分析请求，不能被状态词抢走。
  expect(
    SessionPrompt.detectInputIntent([{ type: "text", text: "跑完了吗？如果没有就接着跑面板固定效应" }] as any, undefined, true, true),
  ).toBe("analysis")
})

test("已有数据但工作流已结束时，纯状态追问仍保持只读意图", () => {
  expect(
    SessionPrompt.detectInputIntent([{ type: "text", text: "跑完了吗？现在到哪一步了？" }] as any, undefined, true, false),
  ).toBe("status")
})

test("in-progress analysis signal still yields to small-talk / concept / negation guards", () => {
  // 分析进行中的信号不能裹挟纯闲聊、概念咨询或否定指令——这些仍必须留在 conversation。
  const stay = ["你好", "谢谢", "什么是内生性", "这个方法靠谱吗", "别做回归了", "先别分析"]
  for (const text of stay) {
    expect(SessionPrompt.detectInputIntent([{ type: "text", text }] as any, undefined, true, true), text).toBe(
      "conversation",
    )
  }
})

test("method questions remain conversation even when they repeat analysis keywords", () => {
  expect(
    SessionPrompt.detectInputIntent([{ type: "text", text: "别做回归，告诉我回归和面板模型有什么区别" }] as any),
  ).toBe("conversation")
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "别做稳健性检验" }] as any)).toBe("conversation")
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "你觉得应该怎么进行计量分析" }] as any)).toBe(
    "conversation",
  )
  expect(
    SessionPrompt.detectInputIntent([
      { type: "text", text: "告诉我回归和面板模型有什么区别，然后帮我跑一下 OLS" },
    ] as any),
  ).toBe("analysis")
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "回归应该怎么做，然后用 OLS 跑一个" }] as any)).toBe(
    "analysis",
  )
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "先别分析，改用 DID 做一遍" }] as any)).toBe("analysis")
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "别跑 OLS" }] as any)).toBe("conversation")
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "先别分析！现在做回归" }] as any)).toBe("analysis")
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "OLS 是什么，先跑一个看看" }] as any)).toBe("analysis")
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "OLS 是什么，先做个解释" }] as any)).toBe(
    "conversation",
  )
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "这个结果靠谱吗？有没有稳健性检验？" }] as any, undefined, true, true)).toBe(
    "conversation",
  )
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "这个结果靠谱吗？请执行稳健性检验" }] as any, undefined, true, true)).toBe(
    "analysis",
  )
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "回归是什么，先做个总结" }] as any)).toBe(
    "conversation",
  )
})

test("partial negation keeps data work intent (2026-08-11 data-inspect-only)", () => {
  // 用户"看数据、不用做回归"是部分否定：主请求是查看数据，必须暴露 data_import
  //（此前被 isNegatedWorkflowRequest 误判成 conversation，模型连工具都看不到）。
  // "回归"字样可能触发 analysis（工具超集，同样暴露 data_import）——两类都算通过，
  // 只要不是 conversation（空工具包）。
  const withRegression = SessionPrompt.detectInputIntent([{ type: "text", text: "帮我看下数据有哪些变量、多少行、有没有缺失，不用做回归分析" }] as any)
  expect(["ingest", "analysis"]).toContain(withRegression)
  // "看下数据"带数据锚定词 → ingest；纯"文件/模型"无数据锚定 → 不误判
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "帮我看下这份数据的情况，不用跑模型" }] as any)).toBe("ingest")
})

test("pure negation still stays in conversation mode", () => {
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "不做回归了" }] as any)).toBe("conversation")
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "别分析了，先聊聊天" }] as any)).toBe("conversation")
})
