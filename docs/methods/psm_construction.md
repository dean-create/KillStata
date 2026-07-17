# psm_construction

## 方法概览

估计每行样本接受处理的倾向得分（propensity score），并报告共同支撑区间与占比。
**只是诊断工具，不估计因果效应**——不输出 ATE/ATT，不做显著性结论。
是 PSM 方法家族里第一个准入的方法，其余（matching/IPW/regression/double-robust）
尚未准入，见 `PLAN.md`。

## 算法来源

- Python 算法：`python/econometrics/econometric_algorithm.py:85`
  `propensity_score_construction`——来自 Econometrics-Agent 的 Logistic
  回归倾向得分估计（`sm.Logit`），KillStata 在原函数体内直接加固
  （不是像 OLS 那样另外包一层，而是把校验写进了同一个函数）：
  - 处理变量必须严格 0/1 且两组都存在（不接受只有一组的数据）
  - 协变量不能有常数列（`nunique() <= 1` 直接拒绝）
  - 设计矩阵秩亏、观测数不够、完全分离（`PerfectSeparationError`）、
    奇异矩阵、未收敛、边界得分（得分 ≤0 或 ≥1，说明无法估计重叠区间）
    全部在返回前拦截。
- TS 契约与产物管理：`econometrics-method-tools.ts` 的
  `PropensityScoreConstructionTool`——只接受 `datasetId/stageId/treatmentVar/
  covariates`，不恢复万能入口的 `dataPath`/`options` 自由参数；
  不接受调用方指定 `outputDir`（`econometrics.ts:2016` 显式拒绝，
  产物目录由 Harness 隔离管理）。

## 适用条件与识别假设

- 处理变量必须是真正的二元处理（不是连续变量离散化的产物，需要用户确认）。
- 协变量必须是处理前变量（pre-treatment），否则会引入 post-treatment bias——
  **这一点目前没有自动检测**，依赖模型/用户在选择协变量时判断，
  工具描述里写了"处理前协变量"但没有代码层面的时间先后校验。
- 倾向得分只是重叠假设（overlap/common support）的诊断输入，
  不代表满足了可忽略性假设（unconfoundedness/CIA）——那是研究设计问题，
  不是本工具能验证的。

## 参数契约

`datasetId`/`stageId`/`treatmentVar` 必填；`covariates` 数组至少 1 个。
`.strict()`。`validateColumnRoles` 拒绝协变量与处理变量同列、协变量内部重复。

## 后端校验清单

见"算法来源"里列出的 Python 侧拦截清单；此外 TS 侧在发布前验证概率摘要、
样本量、产物路径边界、文件存在性和表头，失败时删除 Harness 自有的完整运行目录
（不留半成品文件）。

## 对标级别与来源

**B 级**：`test/tool/propensity-score-construction.test.ts` 用 SciPy
独立最大化同一个 Logit 似然（不调用 statsmodels），逐行交叉验证 80 个得分、
常数项、列顺序和逐行预测映射；另外独立手算共同支撑区间与占比。
尚未对标 R/Stata 的等价实现（无 A 级）。

## 已知局限

- 没有已发表数据集（如 LaLonde/NSW）上的 A 级验证——`PLAN.md` 已把
  LaLonde/NSW 列为 PSM 家族的 A 级候选数据集，但 `psm_construction`
  本身还没有接入。
- 协变量的"处理前"属性无法被代码验证，完全依赖使用者判断。
- 得分严格落在 (0,1) 开区间才允许通过；如果真实数据里存在很强的可分离性
  （某些协变量组合完美预测处理状态），工具会直接拒绝而不是给出一个
  不可靠的边界得分——这是设计上的保守选择，不是 bug。

## 测试覆盖

- `test/tool/propensity-score-construction.test.ts`：20 个聚焦用例
  （2026-07-16 准入时数据：目标测试 20/20，全量 265/265，966 断言）。
- 模型调用回放：`test/fixtures/replay/psm_construction/`，6 条。
