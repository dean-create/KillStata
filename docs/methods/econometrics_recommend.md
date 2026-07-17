# econometrics_recommend

## 方法概览

只分析数据结构、变量类型和可行的基础计量方法，**不运行回归、不产出因果结论**。
是"推荐与执行分离"链路的第一环：模型看到画像和建议后，必须由用户确认，
再显式调用一个具体的估计器工具——本工具本身不会替用户做决定，也不会自动执行。

## 算法来源

- 数据结构判定与建议逻辑：`packages/killstata/src/tool/econometrics-smart.ts`
  的 `buildSmartDatasetProfile` / `recommendEconometricsPlan`，KillStata 原创
  （不是 Econometrics-Agent 借鉴代码），基于变量名正则提示 + 唯一值计数 +
  个体时间维度计数的规则系统。
- 执行入口：`econometrics-method-tools.ts` 的 `EconometricsRecommendTool`
  内部仍调用旧万能入口的 `auto_recommend` 方法（`econometrics.ts`），
  该方法把 Python 侧的列画像（`profile_column` 等）和上述 TS 规则系统结果
  一起写成 `profile.json` / `recommendation.json` / 中文叙述稿三个产物。

## 适用条件与识别假设

无（本工具不产出估计量，没有识别假设需要满足）。

## 参数契约

`datasetId`/`stageId` 必填；`dependentVar`/`treatmentVar`/`entityVar`/`timeVar`
全部可选（模型可能在还不知道任何变量角色时就先调用它）。`.strict()`，
不接受旧万能入口的 `methodName`/`options` 等字段。

## 后端校验清单

- 依赖 `assertDatasetStageReadyForEstimation` 之外的画像前置条件更宽松
  （诊断性质，不要求已过 QA 门）。
- 面板结构判定需要 `avgPeriodsPerEntity > 1.1` 且个体数、时间数均 > 1，
  防止把"每个体只出现一次、只是恰好有重复时间戳"的数据误判为面板。
- 工具变量候选列只依据列名正则（`iv`/`z`/`instrument`/工具变量）提示，
  **明确标注"必须由用户或研究设计确认"**，不自动升级为 IV 设定
  （见 `recommendEconometricsPlan` 里 "must be confirmed by the user or
  research design" 的固定告警文案，`econometrics-smart.test.ts` 有专门测试
  锁定这一行为不被回归）。

## 对标级别与来源

不适用——本工具不产出可对标的估计量。

## 已知局限

- 面板/时间序列/截面的判定是启发式规则，不是统计检验；边界情形
  （例如"个体重复但只有 1.05 期"）可能判定不稳定，规则本身没有测试覆盖
  判定阈值的敏感性。
- 历史上有一个真实崩溃：`profile_column` 对布尔 dtype 列直接做数值减法，
  触发 `numpy boolean subtract` 错误（2026-07-15 一次真实会话记录）。
  现在 `integer_like()` 已在做减法前用 `is_bool_dtype` 短路，
  `econometrics-smart.test.ts` 的 `"auto_recommend handles boolean dtype
  before numeric subtraction"` 用例锁定了这个修复，但该用例只做静态文本
  顺序断言（检查源码里 guard 出现在减法之前），不是动态跑一个真实布尔列
  数据集去验证——建议后续补一个动态版本。

## 测试覆盖

- `test/tool/econometrics-smart.test.ts`：规则系统单测（面板识别、
  工具变量列名不自动转正）+ 1 个真实 Python 子进程集成测试。
- 模型调用回放：`test/fixtures/replay/econometrics_recommend/`，6 条
  （含 1 条取自真实会话的种子）。
