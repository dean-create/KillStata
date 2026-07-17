# hdfe_regression

## 方法概览

高维固定效应线性回归（HDFE），支持最多 8 个固定效应维度、最多 2 维聚类推断。
不属于 Econometrics-Agent 借鉴代码——是 KillStata 新增的独立后端
（"并行边界"：Claude Code 完成 PyFixest 的 HDFE 与现代 DID 后端）。

## 算法来源

- Python 适配器：`packages/killstata/python/pyfixest/runner.py` 的
  `run_hdfe`，调用 `pyfixest.feols(formula, data=frame, vcov=vcov)`。
- 公式由后端根据结构化字段拼接，不接受模型直传 formula 字符串；
  所有列名先映射为安全内部别名（避免空格、中文、公式注入）。

## 适用条件与识别假设

- 线性可加的固定效应模型；固定效应之间、固定效应和回归变量之间
  不能有结构性混淆无法被吸收的情形。
- 聚类推断的有效性依赖聚类数量足够大（经验法则通常要求 ≥ 30-40 个簇）；
  聚类数量少时后端会发"聚类数量较少"告警（见测试断言），但不阻断。

## 参数契约

`datasetId`/`stageId`/`dependentVar`/`treatmentVar`/`fixedEffects`（1-8 个）
必填；`covariates`（≤100 个，默认空）/`clusterVars`（≤2 个，默认空）/
`covariance`（`HC1|CRV1|CRV3`）可选。`.strict()`。
交叉校验：因变量不能出现在回归变量里；`clusterVars` 非空时协方差
必须是 `CRV1`/`CRV3`；`clusterVars` 为空时协方差不能是 `CRV1`/`CRV3`
（即聚类变量和协方差类型必须同时出现或同时不出现）。

## 后端校验清单

- `fixedEffects`/`covariates`/`clusterVars` 三个数组各自去重。
- 固定效应维度上限 8 个、聚类维度上限 2 个——这不是 PyFixest 本身的
  硬限制，是 KillStata 契约层加的上限，防止模型把每一个类别列都塞成
  固定效应。
- 无聚类时用 HC1，一维/二维聚类分别用 CRV1/CRV3。

## 对标级别与来源

**B 级**（2026-07-17 从 C 级升级）：`test/tool/pyfixest-independent-
crosscheck.test.ts`，用 LSDV（固定效应展开成哑变量）+ statsmodels 独立
重新估计同一份数据，和 PyFixest 的吸收式估计做交叉验证：
- 处理变量系数：两边一致到约 1e-5（Frisch-Waugh-Lovell 定理保证的
  精确数学等价，不是近似）。
- 聚类稳健标准误：两边相差约 9%，判断为对"参数个数 K 是否计入被
  吸收的固定效应"这一小样本自由度修正采用了不同约定——两种约定
  都有文献支持，不是任何一方的实现缺陷；测试只对标准误做数量级
  合理性检查，不追求精确相等。

## 已知局限

- 聚类标准误的精确数值和 Stata `reghdfe` 或 R `fixest` 可能存在同样
  量级的约定差异，尚未和这两个工具做过直接对比。
- 固定效应上限 8、聚类上限 2 是产品选择的保守边界，如果真实研究设计
  需要更多维度，目前只能被契约拒绝，没有绕行方案。

## 测试覆盖

- `test/tool/pyfixest-backend.test.ts`：中文/含空格列名的安全别名、
  聚类推断、秩亏与吸收列处理。
- `test/tool/pyfixest-independent-crosscheck.test.ts`：B 级独立交叉验证。
- 模型调用回放：`test/fixtures/replay/hdfe_regression/`，8 条
  （固定效应为空/超限、聚类与协方差不匹配的两个方向、重复固定效应、
  因变量误入协变量）。
