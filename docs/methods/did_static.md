# did_static

## 方法概览

传统 2×2 双重差分。模型只传 `dependentVar/groupVar/postVar/covariates`，
后端安全构造 `groupVar × postVar` 交互项——模型不拼公式、不自己算交互列。

## 算法来源

- Python 适配器：`packages/killstata/python/pyfixest/runner.py` 的
  `run_static_did`，调用 `pyfixest.feols(formula, data=frame,
  vcov=payload["covariance"])`，公式里的交互项由后端拼接。
- 不是 Econometrics-Agent 的 `Static_Diff_in_Diff_regression`
  （`econometric_algorithm.py:592`）——那个是旧万能入口独立保留的
  另一套实现，`did_static` 走的是 PyFixest 后端，两套实现并存
  （旧的仅供历史回放，见 `PLAN.md` 的"渐进收缩旁路"记录）。

## 适用条件与识别假设

- 标准 DID 识别假设：平行趋势（如果只有两期数据，这个假设无法从
  数据本身检验，只能靠研究设计论证或额外的前期数据）。
- **已知真实数据风险**：2026-07-16 的端到端验收发现过 `id=407`
  同时属于处理组和对照组、原始 `id × t` 非唯一的真实数据案例——
  传统分组均值 DID 在这种情况下仍可计算，但面板 FE/DID2S
  **不能**直接使用同一个实体键（会被这两个工具的重复键检测拒绝）。
  这提示：`did_static` 对面板键完整性的要求比 `panel_fe_regression`/
  `did2s` 更宽松，使用者不能想当然地认为"能跑 did_static 就能跑
  did2s"。

## 参数契约

`datasetId`/`stageId`/`dependentVar`/`groupVar`/`postVar` 必填；
`covariates`（≤100，默认空）可选；`covariance` 目前**只有一个合法值**
`"HC1"`（`z.literal`，不是 `z.enum`——这是为了让模型清楚这个工具暂时
不支持别的协方差类型，而不是默默接受又默默改写）。`.strict()`。
交叉校验：因变量、处理组变量、政策后变量三者互不相同；控制变量
不能与这三者重复。

## 后端校验清单

- 三个设计列互异性检查（TS 契约层）。
- 交互项由后端安全构造，模型不传公式字符串。

## 对标级别与来源

**A 级**：2026-07-16 传统 DID 端到端验收（记录于 `PLAN.md`"并行实测"
一节）——用 Card & Krueger 风格快餐业最低工资数据集（820 行、8 列，
`fte` 缺失 19、有效样本 801），手工核对 Word 文档 7 页与只读 Excel
基准：手工分组均值 DID = 2.9139823574；通过真实 KillStata 完整链路
（导入→数据画像→QA→`did_static`）估计的控制后 DID = 2.9350196887，
HC1 标准误 1.5434221385，p=0.0575811010，N=801。这是全项目里少数
"用真实业务数据人工核对到小数点后 10 位"的验证记录，不是合成数据。

## 已知局限

- `covariance` 目前锁定 `HC1`，不支持聚类或 HAC——如果数据有明显的
  组内相关结构（例如同一地区多个门店），HC1 可能低估标准误；
  需要聚类推断时应改用 `hdfe_regression`。
- 端到端验收发现的面板键非唯一问题（`id=407`）目前只是文档记录，
  没有转化成 `did_static` 自身的自动化回归测试——如果后续对
  面板键校验逻辑做改动，这个真实案例不会被自动重新验证。

## 测试覆盖

- `test/tool/pyfixest-backend.test.ts`：合成数据的交互项系数恢复。
- `PLAN.md`"并行实测"记录的真实数据端到端验收（见上，A 级）。
- 模型调用回放：`test/fixtures/replay/did_static/`，6 条
  （含 1 条取自真实会话的 Card-Krueger 调用种子）。
