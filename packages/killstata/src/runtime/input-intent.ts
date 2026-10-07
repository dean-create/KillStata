const WORKFLOW_TARGET_SOURCE = String.raw`计量分析|数据分析|分析数据|分析|回归|估计|导入数据|处理数据|稳健性(?:检验)?|\b(?:regression|econometric|econometrics|panel_fe|auto_recommend|did|ols|2sls|iv|psm|rdd)\b`
const WORKFLOW_TARGET = new RegExp(WORKFLOW_TARGET_SOURCE, "i")
const NEGATED_WORKFLOW_REQUEST = new RegExp(
  String.raw`(?:不要(?!只)|不用|不必|不做|先别|别再|别|停止|取消)[^，。；！？!?.,;\n]{0,20}(?:${WORKFLOW_TARGET_SOURCE})`,
  "i",
)
const WORKFLOW_CONSULTATION =
  /什么是|是什么|什么意思|有什么区别|有何区别|怎么理解|如何理解|为什么|应该怎么|应该如何|怎么进行|如何进行|能做什么|可以做什么|有没有|是否有|靠谱吗|可靠吗/
const DIRECT_WORKFLOW_REQUEST =
  /(?:直接|现在|马上|立即|开始|继续|重新|再|先|改用|换成)[^，。；！？!?.,;\n]{0,12}(?:跑|做|执行|进行|估计|分析|回归|检验)|(?:请|帮我)[^，。；！？!?.,;\n]{0,12}(?:跑|做|执行|估计|分析|回归|检验)|(?:加入|添加|控制)[^，。；！？!?.,;\n]{0,8}(?:变量|固定效应)/
const INHERITED_WORKFLOW_REQUEST =
  /(?:直接|现在|马上|立即|开始|继续|重新|再|先|改用|换成|请|帮我)[^，。；！？!?.,;\n]{0,12}(?:跑|执行|估计|分析|回归|检验)/
const INHERITED_ANALYSIS_CONFIRMATION =
  /^(?:就用|按|照|根据)(?:你|您)?(?:说的?|推荐的?|建议的?|这个|该)?(?:方法|模型)?[^，。；！？!?.,;\n]{0,12}(?:跑|做|执行|估计|分析|回归|检验)(?:一下|一遍|看看)?[。！？!?]*$/

function latestWorkflowClause(text: string) {
  let latest: string | undefined
  let hasWorkflowContext = false
  for (const clause of text.split(/(?:但是|不过|然而|然后|但|[，。；！？!?.,;\n])/)) {
    if (WORKFLOW_TARGET.test(clause)) {
      hasWorkflowContext = true
      latest = clause
      continue
    }
    // “OLS 是什么，先跑一个看看”的后半句省略了方法名，但动作仍继承前文对象。
    if (hasWorkflowContext && INHERITED_WORKFLOW_REQUEST.test(clause)) latest = clause
  }
  return latest
}

export function isNegatedWorkflowRequest(text: string) {
  const latest = latestWorkflowClause(text)
  return latest ? NEGATED_WORKFLOW_REQUEST.test(latest) : false
}

export function isWorkflowConsultation(text: string) {
  const latest = latestWorkflowClause(text)
  if (!latest) return false
  return WORKFLOW_CONSULTATION.test(latest) && !DIRECT_WORKFLOW_REQUEST.test(latest)
}

/** 方法推荐后的承接句是明确执行授权，不能被数据在场兜底降级为 ingest。 */
export function isInheritedAnalysisConfirmation(text: string) {
  return INHERITED_ANALYSIS_CONFIRMATION.test(text.trim())
}

// 纯概念/咨询问句：要求"解释"而非"执行"。区别于"怎么把某列删掉"这类以动作动词收尾的
// 指令——那些不匹配"什么是/为什么/怎么理解/靠谱吗"这套解释性词汇。用于数据集已在场时的
// 上下文感知兜底，让"什么是内生性""为什么这么做""这个方法靠谱吗"即使有活跃数据也留在闲聊。
const CONCEPT_QUESTION =
  /什么是|是什么|什么意思|啥意思|有什么区别|有何区别|怎么理解|如何理解|为什么|为啥|应该(?:怎么|如何|选|用)|能做什么|可以做什么|靠谱吗|准确吗|合适吗|对不对|好不好|该(?:用|选)哪/

export function looksLikeConceptQuestion(text: string) {
  return CONCEPT_QUESTION.test(text)
}

// 纯寒暄/致谢/单字确认/误触（"1"、"？"）的闭集——寒暄是有限且稳定的类别，
// 不像数据操作词汇那样开放。数据集已在场时，只有这一类才保留在闲聊，其余指令一律放行。
const SMALL_TALK_ONLY =
  /^(?:你好|您好|哈喽|嗨|hi|hello|hey|在吗|在不在|谢谢(?:你|了|啦)?|多谢|感谢|辛苦(?:了|啦)?|thanks?|thx|嗯+|哦+|噢+|唔+|好+(?:的|哒|啊|呀|吧|滴)?|行(?:吧|啊)?|可以|没问题|收到|知道(?:了|啦)?|明白(?:了)?|懂(?:了|啦)?|ok(?:ay)?|再见|拜拜|bye|结束(?:吧|了)?|哈哈+|呵呵+|嘿嘿+|辛苦)$/iu

export function isSmallTalkOnly(text: string) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return true
  // 纯标点/符号/空白，或纯数字（误触"1"、乱敲"。"）
  if (/^[\s\p{P}\p{S}]+$/u.test(trimmed) || /^\d+$/.test(trimmed)) return true
  return SMALL_TALK_ONLY.test(trimmed)
}
