# panel_fe_regression

## 方法概览

个体和时间双向固定效应回归。**entity-time 键不唯一就直接失败**，
不静默退化成 pooled OLS——这是工具描述里明确写死的行为约束。

## 算法来源

- Python 算法：借鉴自 Econometrics-Agent 的面板 FE 实现，后端库是
  `linearmodels.PanelOLS`（`python/econometrics/econometric_algorithm.py:9`
  `from linearmodels import PanelOLS`）——注意这是**迁移后**的状态：
  产品决策阶段已把面板 FE 从 statsmodels 手写虚拟变量迁移到 linearmodels
  的原生 `PanelOLS`，理由是 linearmodels 对聚类推断、吸收固定效应和
  秩亏检测有专门支持，不需要自己拼虚拟变量矩阵。
- KillStata 加固：`PanelOLS(..., check_rank=True, drop_absorbed=True)`——
  秩亏和吸收列检测交给 linearmodels 自己的机制，不是外部包一层。

## 适用条件与识别假设

- 需要真正的面板结构：同一个体在多个时间点重复观测。
- **entity × time 复合键必须唯一**——重复键（同一个体同一时期出现两行）
  会被直接阻断，工具描述明确要求"不满足时直接失败，不得静默改成
  pooled OLS"；`"blocks panel FE when duplicate panel keys remain instead
  of changing estimators"` 测试锁定了这一行为。
- 双向固定效应只吸收个体和时间层面不随时间/个体变化的混淆因素，
  不处理个体特定的时变趋势——如果处理效应和个体特定趋势相关，
  双向 FE 仍然有偏，这是方法本身的限制，不是实现问题。

## 参数契约

`datasetId`/`stageId`/`dependentVar`/`treatmentVar`/`entityVar`/`timeVar` 必填；
`covariates`/`clusterVar` 可选（`clusterVar` 省略时按 `entityVar` 聚类）。
`.strict()`，不接受旧万能入口的 `options.auto_downgrade` 等透传字段。
`validateColumnRoles` 拒绝四个角色列相互重复；`clusterVar` 不能和
结果变量/核心解释变量/控制变量同列。

## 后端校验清单

- entity-time 键唯一性检查，重复直接阻断（不自动去重、不自动降级）。
- `options: { auto_downgrade: false }` 在 TS 层写死，即使 Python 侧未来
  加了自动降级逻辑，也不会被这个工具触发。
- linearmodels 的秩亏和吸收列检测（`check_rank=True`）。

## 对标级别与来源

**A 级**：`test/tool/panel-fe-golden.test.ts`，对标 Grunfeld 投资面板
（经典教科书数据集），核心系数约 0.1167，与 linearmodels 直接调用的结果
在严格容差内一致。

## 已知局限

- 只支持双向固定效应（个体+时间），不支持三重固定效应或个体特定的
  线性趋势项——如果研究设计需要这些，目前只能通过 `hdfe_regression`
  （最多 8 个固定效应维度）绕道。
- 聚类推断目前只支持单维聚类（`clusterVar` 是单一列），双向聚类
  需要用 `hdfe_regression`（`clusterVars` 最多 2 个）。

## 测试覆盖

- `test/tool/panel-fe-golden.test.ts`：Grunfeld A 级对标。
- `test/tool/econometrics.test.ts`：重复键阻断、协变量为文本时报具体列名
  而非泛泛的"无可用行"错误。
- 模型调用回放：`test/fixtures/replay/panel_fe_regression/`，5 条
  （含"漏填个体时间标识"和"旧入口 options 透传"两个高风险误用场景）。
