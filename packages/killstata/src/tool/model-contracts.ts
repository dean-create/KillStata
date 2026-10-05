import type { Tool } from "./tool"

function contract(
  namespace: Tool.ModelNamespace,
  useWhen: string,
  doNotUseWhen: string,
  returns: string,
  failureRecovery: string,
  inputExamples?: readonly Record<string, unknown>[],
): Tool.ModelContract {
  return { namespace, useWhen, doNotUseWhen, returns, failureRecovery, inputExamples }
}

/**
 * 这里只维护 TypeScript 系统工具的选择契约。
 *
 * OLS、DID、IV、PSM、RDD、GLM 等计量方法不在这里定义。它们的名称、适用边界、
 * 输入/输出 Schema 和诊断要求，以及 Python 执行能力的适用说明，全部来自 Python
 * Registry 的 describe 响应；否则 TS 维护第二份契约会在字段、示例和提示词上产生漂移。
 */
const SYSTEM_MODEL_CONTRACTS = {
  question: contract(
    "interaction",
    "缺少一项会实质改变分析结论或执行范围的用户选择，并且无法从当前数据和历史中可靠推断时。",
    "能从数据、已有指令或安全默认值确定答案时不要提问；不要用它代替进度汇报。",
    "用户对一至三个短问题的结构化回答。",
    "用户未回答时保留未决项并继续不依赖该选择的工作，不要虚构答案。",
  ),
  list: contract(
    "filesystem",
    "已知目录路径，需要查看其有限层级结构以定位文件时。",
    "按名称模式找文件用 glob；按内容找文本用 grep；读取文件内容用 read。",
    "最多 100 个有界路径条目及截断提示。",
    "路径不存在或结果被截断时，缩小目录范围或改用 glob 精确搜索。",
  ),
  read: contract(
    "filesystem",
    "已知具体文件路径，需要读取文本或分段查看大文件时；修改文件前必须先读。",
    "不要用它扫描目录、搜索未知路径或读取不支持的二进制数据集。",
    "指定 offset/limit 对应的有界文本窗口和剩余内容提示。",
    "文件过大时用新的 offset 续读；路径错误时先用 glob/list 定位，不要重复原调用。",
  ),
  glob: contract(
    "search",
    "知道文件名或路径模式但不知道确切位置，需要按 glob 模式定位文件时。",
    "不要读取文件内容；需要内容匹配时用 grep，已知目录概览时用 list。",
    "按修改时间排序的最多 100 个匹配路径及截断提示。",
    "无匹配时检查 pattern 和起始 path，并逐步放宽模式；不要直接遍历整个磁盘。",
  ),
  grep: contract(
    "search",
    "需要在文本文件中按关键词或正则精准定位内容时。",
    "不要用于文件名搜索、二进制数据扫描或读取完整大文件。",
    "有界的文件路径、行号和匹配片段；超限时给出截断提示。",
    "正则错误时修正表达式；结果过多时增加 include、path 或更具体的关键词。",
  ),
  bash: contract(
    "filesystem",
    "没有专用工具能完成的本地命令、测试、构建或受控脚本执行。",
    "读写搜索已有专用工具时不要用命令替代；不要执行未经确认的破坏性或外部可见操作。",
    "命令退出状态与有界 stdout/stderr，完整超长输出保存为可继续读取的产物。",
    "先读取退出码和错误尾部，针对根因最小修复；不要原样盲目重跑。",
  ),
  shell: contract(
    "filesystem",
    "与 bash 相同，用于没有专用工具覆盖的本地命令执行兼容入口。",
    "存在 read/edit/write/glob/grep 等专用工具时不要使用；不要绕过权限确认。",
    "命令退出状态与有界输出，必要时附完整输出产物路径。",
    "依据退出码和错误信息修正单个失败步骤，不要用另一条等价命令掩盖错误。",
  ),
  edit: contract(
    "filesystem",
    "已读取目标文本，且能用精确 oldString→newString 做小范围修改时。",
    "新建文件或完整覆盖用 write；未读取文件、匹配不唯一且未确认时不要编辑。",
    "修改文件路径和替换结果摘要。",
    "匹配为零时重新读取最新内容；匹配多处时扩大上下文或明确 replaceAll。",
  ),
  write: contract(
    "filesystem",
    "创建新文件，或用户明确要求完整覆盖一个已读取文件时。",
    "局部修改优先 edit；不要覆盖未读取文件或用它批量生成无关文件。",
    "写入文件路径、字节数和完成状态。",
    "权限或路径失败时检查绝对路径与授权范围；内容问题只修正目标文件后重试。",
  ),
  task: contract(
    "subagent",
    "任务可独立分解为边界清楚的只读调查、验证或专业子任务时。",
    "不要委派当前主 Agent 已在做的相同工作，也不要让子 Agent 共享隐含上下文或替代用户决策。",
    "子 Agent 的独立结论、证据和会话标识，不自动合并代码或扩大权限。",
    "子任务失败时读取其具体证据，缩小 prompt 或补齐输入；不得无差别重复派发。",
  ),
  webfetch: contract(
    "web",
    "已有可信 HTTP/HTTPS URL，需要读取该页面的文本内容时。",
    "没有确切 URL 时先向用户确认；不要猜测 URL，也不要用于本地文件。",
    "有界的 markdown/text/html 页面内容与来源信息。",
    "访问失败时核对 URL、状态码和格式；不要改造或猜测一个新地址。",
  ),
  skill: contract(
    "pipeline",
    "存在已安装且名称明确的 Skill，需要加载其完整任务流程时。",
    "没有匹配 Skill 时直接使用现有工具；不要猜测名称或声称加载不存在的 Skill。",
    "该 Skill 的完整指令内容和可用状态。",
    "名称不存在或被拒绝时列明缺口并继续可执行部分，不要反复调用。",
  ),
  todowrite: contract(
    "pipeline",
    "中长任务需要维护可核验的步骤、优先级和状态时。",
    "简单一次性任务不要建清单；不要把尚未验证的步骤标为 completed。",
    "当前会话的完整任务清单。",
    "状态冲突时先读取现有清单并只更新受影响项，避免重建丢失历史。",
  ),
  todoread: contract(
    "pipeline",
    "需要查看当前会话已有任务及状态后再决定下一步时。",
    "没有任务清单或只是汇报单一步骤时不要调用。",
    "当前会话的有界任务清单。",
    "清单为空时按当前请求继续，不要虚构历史任务。",
  ),
  pipeline: contract(
    "pipeline",
    "查看计量工作流状态、阶段、可信产物、诊断、核验，交付已完成估计的可信结果文件，或仅重跑失败阶段时。",
    "不要用状态查询代替数据导入、预处理或估计；状态未变化时不要重复查询。",
    "所选 action 对应的结构化状态、阶段、产物、诊断、受控结果交付或恢复结果。",
    "根据返回的失败阶段和修复建议选择最小 action；restore/rerun 仅作用于明确目标。",
    [{ action: "status" }, { action: "export_artifact", stageId: "stage_demo", artifactPath: ".killstata/datasets/demo/reports/ols/coefficients.csv", outputPath: "回归结果.csv" }],
  ),
  analysis_request: contract(
    "pipeline",
    "本轮包含数据附件、明确的数据文件导入请求，或正在继续一项已有数据研究，且尚未登记本轮分析目标时。",
    "普通闲聊、没有数据任务时不要调用；同一用户消息已登记后不要重复调用；登记不等于用户授权改变变量、样本、方法或因果设定。",
    "绑定当前用户消息的 requestId、请求类型和研究目标摘要；不会读取或改写数据，也不会调用估计器。",
    "如果当前任务与源用户消息不匹配，停止并保留现有状态；请求理解有歧义时使用 question 澄清，不要伪造 message ID。",
    [{ kind: "estimate", researchGoal: "估计绿色信贷与绿色金融指数的关系", constraints: ["只解释统计关联，不作因果解释"] }],
  ),
  analysis_prepare: contract(
    "pipeline",
    "当前 AnalysisRequest 已登记为 estimate 或 inspect，且已通过 tool_search 获得完整方法 Schema；需要让 Python Registry 校验参数并检查当前数据阶段的适用条件时。inspect 仅返回可行性，不生成可执行规格。",
    "纯闲聊、仅推荐/解释请求，或尚未导入并诊断当前数据时不要调用；它不会运行估计，也不能替代用户对样本、变量含义、估计量或推断口径变化的确认。",
    "Python Registry 校验后的规格状态、字段错误或前置诊断；只有 estimate 请求、schema、当前 stage 指纹和方法 preflight 全部就绪才返回可执行 specId。",
    "字段/类型错误只修正明确报错项；缺少研究角色时向用户澄清；数据前提、诊断指纹或识别条件不满足时按诊断给出下一步，不要直接调用估计器或静默换方法。",
  ),
  tool_search: contract(
    "pipeline",
    "已从系统提示词的计量方法索引选定方法 ID，需要从 Python Registry 加载该方法引用时。",
    "目标方法已经在本轮动态引用里时不要重复搜索；不要用它解锁当前阶段禁止或未准入的方法。",
    "最多十个候选；每个候选包含 Python Registry 返回的适用边界和参数 JSON Schema。",
    "搜索后先用 analysis_prepare 校验候选规格；只有返回 PreparedSpec 且用户已授权时，才用 econometrics_execute(specId) 执行。没有命中时从返回的清单里挑一个 ID 重新搜索；不要猜测清单外的方法 ID。",
    [{ query: "ols_regression", limit: 1 }, { query: "psm", limit: 3 }],
  ),
  econometrics_execute: contract(
    "pipeline",
    "analysis_prepare 已返回当前用户 estimate 请求的可执行 specId，且用户已明确选择/确认该方法时。",
    "不要传 methodID、arguments、datasetId、stageId 或路径；不要执行 inspect 请求、未通过 preflight 的规格或用户未授权的研究设定。",
    "Python Registry 统一封装的计量结果、诊断、样本和产物引用。",
    "specId 失效时回到当前数据阶段重新准备规格；参数、样本、估计量或推断口径错误按结构化诊断处理，不盲目重试或切换无关方法。",
  ),
  experiment_log: contract(
    "report",
    "需要汇总当前数据集全部已尝试规格、成功/失败结果和结构化产物以保证可复现时。",
    "不要只记录显著结果，也不要用日志代替实际估计或核验。",
    "完整规格账本、结果引用和防选择性报告提示。",
    "缺少结果产物时先修复对应阶段；不要手工补写不存在的数字。",
  ),
  invalid: contract(
    "pipeline",
    "仅供运行时表示无法解析或违反契约的工具调用。",
    "模型不得主动选择或调用该占位工具。",
    "结构化参数错误和最小修复方向。",
    "回到原目标工具，根据 schema 修正参数；不要再次调用 invalid。",
  ),
} as const satisfies Record<string, Tool.ModelContract>

// Python 执行能力的业务描述与参数契约由 Registry 提供。Harness 仅保留其工具族，
// 以便在 Python 启动前完成工具池曝光分类；此占位描述不会覆盖 Registry 的模型可见说明。
const PYTHON_CAPABILITY_NAMESPACES = {
  data_import: "data",
  data_preprocess: "data",
  composite_evaluation: "data",
  econometrics_recommend: "econometrics_diagnostic",
  heterogeneity_runner: "econometrics_estimator",
} as const satisfies Record<string, Tool.ModelNamespace>

function pythonCapabilityContract(namespace: Tool.ModelNamespace): Tool.ModelContract {
  return contract(
    namespace,
    "具体适用条件由本轮 Python Registry describe 返回。",
    "完整工具定义不可见时不要调用；遵守 Python Registry 返回的边界。",
    "由 Python Registry 定义的结构化领域结果。",
    "按字段级错误修正输入；数据或研究语义问题交由用户确认。",
  )
}

export type BuiltinModelToolID = keyof typeof SYSTEM_MODEL_CONTRACTS

export namespace ToolModel {
  const UNKNOWN_TOOL_CONTRACT = contract(
    "pipeline",
    "工具已由运行时注册并通过统一契约进入当前工具池时。",
    "不要把未知工具 ID 当作可直接调用的计量方法；计量方法必须先通过 Python Registry describe 获取引用。",
    "工具自身声明的结构化结果和受控状态变化。",
    "根据运行时返回的结构化错误修正调用；未知计量方法回到 tool_search，不猜测参数。",
  )

  // 历史 replay wrapper 仍需要一个模型契约才能编译和展示，但它们不再从这里
  // 获取方法级字段、别名或 Schema。运行时模型目录只接受 lookup() 返回的系统工具。
  export function forTool(id: string): Tool.ModelContract {
    const systemContract = (SYSTEM_MODEL_CONTRACTS as Record<string, Tool.ModelContract>)[id]
    if (systemContract) return systemContract
    const pythonNamespace = PYTHON_CAPABILITY_NAMESPACES[id as keyof typeof PYTHON_CAPABILITY_NAMESPACES]
    return pythonNamespace ? pythonCapabilityContract(pythonNamespace) : UNKNOWN_TOOL_CONTRACT
  }

  export function lookup(id: string): Tool.ModelContract | undefined {
    return (SYSTEM_MODEL_CONTRACTS as Record<string, Tool.ModelContract>)[id]
  }
}
