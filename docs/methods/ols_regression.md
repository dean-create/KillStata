# ols_regression

## 方法概览

普通最小二乘 / 加权最小二乘回归，估计核心解释变量的条件相关系数。
**默认不宣称因果**——工具描述明确写"结果默认是条件相关，不自动宣称因果"。

## 算法来源

- Python 算法：`python/econometrics/econometric_algorithm.py:18`
  `ordinary_least_square_regression`——原样借鉴自 Econometrics-Agent，
  支持 `nonrobust`/`HC0-3`/`HAC`/`cluster` 四类协方差，支持样本权重（WLS）。
  这个借鉴函数本身**没有**秩亏检查或多重共线性告警。
- KillStata 加固不是改这个函数本体，而是在调用它之前另外插入一层校验
  （`econometrics.ts:2623` 的 `assert_ols_design_full_rank`，`econometrics.ts:2641`
  的 `multicollinearity_warnings`），检测到问题就在调用 `ordinary_least_square_
  regression` 之前直接拒绝，不依赖 statsmodels 自己抛异常。
- TS 契约：`econometrics-method-tools.ts` 的 `OlsRegressionTool`，
  只接受 `HC1/HC2/HC3/nonrobust`（不含 `HAC`/`cluster`——那两种协方差
  目前只有旧万能入口的其他方法在用，`ols_regression` 没有暴露）。

## 适用条件与识别假设

- 条件相关解释，不是因果估计——除非用户自己论证了可忽略性假设，
  工具不会替用户做这个论证。
- 异方差：工具会在检测到强异方差时自动把 `nonrobust` 升级为 `HC1`
  （`"auto upgrades OLS inference to HC1 under strong heteroskedasticity"`
  测试锁定了这个行为）——这是"诊断失败就升级推断方式"，不是
  "诊断失败就换方法"，符合"绝不自动切换估计量"的产品原则。

## 参数契约

`datasetId`/`stageId`/`dependentVar`/`treatmentVar` 必填；`covariates` 可选；
`covariance` 枚举 `HC1|HC2|HC3|nonrobust`，默认 `HC1`。`.strict()`。
`validateColumnRoles` 拒绝结果变量与核心解释变量同列、协变量与两者重复。

## 后端校验清单

- 设计矩阵精确秩亏阻断（`assert_ols_design_full_rank`）。
- 条件数、VIF 超阈值时发多重共线性告警（不阻断，只提示）。
- 异方差检测（Breusch-Pagan/White）触发时自动升级到 HC1 稳健标准误。

## 对标级别与来源

**A 级**：`test/tool/iv-golden.test.ts` 第 117 行
`expect(olsCoef).toBeCloseTo(EXPECTED.ols_educ_coefficient, 4)`——
用真实调用 `OlsRegressionTool`，对标 Card (1995) 已发表数据集上教育回报的
OLS 系数（约 7%），同时验证 `effective_covariance` 确实是 HC1。
覆盖在 IV 的 golden 文件里，因为论文本身就是拿 OLS 和 IV 对照着报告的
（这也是这份 golden 数据的真正来源，不是为 OLS 单独建的基准）。

## 已知局限

- 没有独立的 `ols-golden.test.ts`；A 级覆盖依赖 IV 的 golden 文件，
  如果那个文件被删除或重构，OLS 的 A 级验证会跟着消失而不易被发现——
  建议后续要么保留现状但在两个文件间加交叉引用注释，要么拆一份独立文件。
- `HAC`/`cluster` 协方差在借鉴函数里存在，但当前 `ols_regression` 工具
  没有暴露这两个选项；时间序列或需要聚类推断的场景目前只能通过
  `panel_fe_regression`（面板聚类）或 `hdfe_regression`（HC1/CRV1/CRV3）
  绕道，纯截面数据的聚类需求暂不支持。

## 测试覆盖

- `test/tool/econometrics.test.ts`：异方差自动升级到 HC1。
- `test/tool/iv-golden.test.ts`：Card 1995 A 级对标（见上）。
- 模型调用回放：`test/fixtures/replay/ols_regression/`，6 条
  （含 1 条协方差词表跨工具混淆——模型把 IV 的 `robust` 搬到 OLS 上）。
