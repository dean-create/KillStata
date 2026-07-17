const WORKFLOW_TARGET_SOURCE =
  String.raw`计量分析|数据分析|分析数据|分析|回归|估计|导入数据|处理数据|稳健性(?:检验)?|\b(?:regression|econometric|econometrics|panel_fe|auto_recommend|did|ols|2sls|iv|psm|rdd)\b`
const WORKFLOW_TARGET = new RegExp(WORKFLOW_TARGET_SOURCE, "i")
const NEGATED_WORKFLOW_REQUEST = new RegExp(
  String.raw`(?:不要(?!只)|不用|不必|先别|别再|别|停止|取消)[^，。；！？!?.,;\n]{0,20}(?:${WORKFLOW_TARGET_SOURCE})`,
  "i",
)
const WORKFLOW_CONSULTATION =
  /什么是|是什么|什么意思|有什么区别|有何区别|怎么理解|如何理解|为什么|应该怎么|应该如何|怎么进行|如何进行|能做什么|可以做什么/
const DIRECT_WORKFLOW_REQUEST =
  /(?:直接|现在|马上|立即|开始|继续|重新|再|先|改用|换成)[^，。；！？!?.,;\n]{0,12}(?:跑|做|执行|进行|估计|分析|回归|检验)|(?:请|帮我)[^，。；！？!?.,;\n]{0,12}(?:跑|做|执行|估计|分析|回归|检验)|(?:加入|添加|控制)[^，。；！？!?.,;\n]{0,8}(?:变量|固定效应)/
const INHERITED_WORKFLOW_REQUEST =
  /(?:直接|现在|马上|立即|开始|继续|重新|再|先|改用|换成|请|帮我)[^，。；！？!?.,;\n]{0,12}(?:跑|执行|估计|分析|回归|检验)/

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
