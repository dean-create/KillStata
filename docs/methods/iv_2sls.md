# iv_2sls

## 方法概览

线性工具变量两阶段最小二乘。全项目对"防模型自己编工具变量"这件事
投入最大的一个方法：契约层强制要求识别依据文字说明，后端自动跑
弱工具变量诊断并在证据不足时阻断因果结论。

## 算法来源

- Python 算法：`python/econometrics/econometric_algorithm.py:473`
  `IV_2SLS_regression`——借鉴自 Econometrics-Agent，后端库已迁移到
  `linearmodels.iv.IV2SLS`（同面板 FE 的迁移决策）。
- 弱工具变量诊断：`iv_strength_diagnostic`（`econometrics.ts:3029`）是
  KillStata 新增的辅助函数，不是 Econometrics-Agent 原有代码——
  对工具变量单独跑一次第一阶段 OLS，取处理变量系数的 t² 或多工具时的
  联合 F 检验，返回 `f_stat`。**每次调用 `iv_2sls` 都会自动执行这个诊断**
  （`econometrics.ts:3313` `iv_diagnostic = iv_strength_diagnostic(...)`），
  不需要模型额外调用什么"弱工具检验"方法。
- 后处理门禁：`extractWeakIvFStat` + 一条专属规则
  （`econometrics.ts:766`）在 `first_stage_f_stat < 10` 时把结论标记为
  `block`（阻断因果结论），这个阈值对应计量经济学界公认的
  Stock-Yogo 经验法则（F > 10 视为工具变量不算"弱"）。

## 适用条件与识别假设

三个识别假设——相关性、外生性、排除限制——**必须由用户或研究设计提供**，
工具在契约层强制这一点：
- `instrumentJustification` 字段最短 10 个字符，且描述文字明确要求
  "必须说明工具变量的相关性、外生性与排除限制依据"。
- **已知局限**：这只是长度门槛，不是语义门槛——一个模型如果想应付，
  写满 10 个字符的空话也能通过契约（例如"这个变量看起来是工具变量"
  凑够字数）。契约挡不住敷衍，只挡得住完全不写。真正的把关落在
  弱工具变量 F 检验和模型自己被反复提醒"不能凭列名猜测"上。
- 相关性由弱工具变量 F 检验事后验证（F<10 阻断）；外生性和排除限制
  **没有任何自动检验**——计量经济学理论上这两条本来就不可从数据直接
  检验，只能靠研究设计论证，这不是本工具的缺陷，是这类方法本身的
  认识论边界。

## 参数契约

`datasetId`/`stageId`/`dependentVar`/`endogenousVar`/`instrumentVar`/
`instrumentJustification` 必填；`covariates` 可选；`covariance` 枚举
`robust|nonrobust`，默认 `robust`。`.strict()`。`validateColumnRoles`
拒绝结果变量、内生变量、工具变量三者相互重复。

## 后端校验清单

- 弱工具变量 F 检验自动执行，F<10 阻断因果结论（见"算法来源"）。
- `validateColumnRoles` 的角色互斥检查。
- 协方差只收 `robust`/`nonrobust`（不是 OLS 的 `HC1-3` 词表——
  这两个工具的协方差参数**故意用不同词表**，回放测试里专门有一条
  "模型把 OLS/DID 的 HC1 搬到 IV 上"的跨工具混淆用例）。

## 对标级别与来源

**A 级**：`test/tool/iv-golden.test.ts`，对标 Card (1995) 教育回报
经典论文——IV 估计约 13%，显著高于 OLS 的约 7%（论文的核心发现），
同时验证协方差类型确实是 HC1/robust 而非默认值被静默改写。

## 已知局限

- `instrumentJustification` 只做长度校验，不做语义校验（见上）。
- 旧万能入口还有一个独立的 `IV_2SLS_IV_setting_test` 函数
  （`econometric_algorithm.py:550`）专门做工具变量设定检验，
  但**没有**被包装成模型可见的独立工具——`PLAN.md` 已经决定不单独
  准入它，因为 `iv_strength_diagnostic` 已经自动覆盖了同样的核心检查
  （第一阶段强度），单独暴露反而会让模型多一个可能忘记调用的步骤。

## 测试覆盖

- `test/tool/iv-golden.test.ts`：Card 1995 A 级对标（IV 和 OLS 双重验证）。
- 模型调用回放：`test/fixtures/replay/iv_2sls/`，6 条（识别依据过短、
  角色重复、协方差跨工具混淆、识别依据完全缺失）。
