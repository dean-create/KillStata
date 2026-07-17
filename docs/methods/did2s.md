# did2s

## 方法概览

Gardner (2021) 两阶段 DID，适用于交错处理时点（staggered adoption）。
显式要求处理变量、相对时期变量、个体、时间四个角色分开声明——
不像传统 DID 那样只需要 group/post 两个 0/1 变量。

## 算法来源

- Python 适配器：`packages/killstata/python/pyfixest/runner.py` 的
  `run_did2s`，调用 `pyfixest.did2s(frame, yname=..., first_stage="~
  controls | entity + time", second_stage="~i(relative_time, ref=...)",
  treatment=..., cluster=...)`——第一阶段用尚未处理的样本回归固定效应，
  第二阶段用残差对相对时期虚拟变量回归，这是 Gardner (2021) 论文
  提出的标准两阶段流程，PyFixest 直接实现了这个算法。
- KillStata 新增后端（同 `hdfe_regression`，不是 Econometrics-Agent
  借鉴代码）。

## 适用条件与识别假设

- 交错处理设计：不同个体在不同时间点进入处理状态。
- **处理状态单调**：一旦变为 1 就不能变回 0——后端显式检测
  （`"fails closed when DID treatment reverses from one back to zero"`
  测试锁定），违反会直接报错而不是静默按第一次变化处理。
- **相对时期必须和实际首次处理时点一致**：后端会核对
  `relative_time` 是否等于 `time - first_treatment_time`，不一致直接
  拒绝（`"fails closed when DID relative time disagrees with the
  observed treatment start"` 测试锁定）——这防止模型自己算错相对时期
  却让工具悄悄用错误的对齐方式估计。
- 从未处理组的相对时期必须是 `-inf`，不能留空或用哨兵值。

## 参数契约

`datasetId`/`stageId`/`dependentVar`/`treatmentVar`/`relativeTimeVar`/
`entityVar`/`timeVar` 必填，五者互不相同；`clusterVar`（默认=entityVar）/
`covariates`（≤100）/`referencePeriod`（有限数值，默认 -1）可选。
`.strict()`。控制变量不能与五个设计变量重复。

## 后端校验清单

- 处理状态单调性检查、相对时期与实际首次处理时点一致性检查
  （见"适用条件"）、entity-time 键唯一性检查、聚类变量至少 2 个簇。
- 参考期必须真实存在于数据的相对时期取值里。

## 对标级别与来源

**B 级**（2026-07-17 从 C 级升级）：`test/tool/pyfixest-independent-
crosscheck.test.ts`，手工复现 Gardner (2021) 两阶段算法（第一步用
未处理样本对个体时间固定效应做 LSDV 回归，第二步用残差对相对时期
虚拟变量回归），事件期 0 的处理效应估计与 `pyfixest.did2s` 的结果
一致到约 0.1%——独立代码路径验证了核心两步算法，但**没有**独立
复现 Gardner 论文里针对两阶段估计的标准误修正公式，标准误本身
仍然只是"跑得通、量级合理"，不是逐位对标。

## 已知局限

- 独立交叉验证只覆盖点估计，不覆盖标准误的两阶段修正——如果
  PyFixest 的 SE 修正实现有 bug，这份交叉验证不会发现。
- 尚无已发表数据集上的 A 级验证；`PLAN.md` 把 Cengiz et al. (2019)
  或 PyFixest 文档基准列为候选，尚未接入。

## 测试覆盖

- `test/tool/pyfixest-backend.test.ts`：交错处理面板的事件期系数、
  处理状态单调性、相对时期一致性两个失败测试。
- `test/tool/pyfixest-independent-crosscheck.test.ts`：B 级独立交叉验证。
- 模型调用回放：`test/fixtures/replay/did2s/`，6 条（个体时间变量混淆、
  控制变量与相对时期重复、参考期类型错误、漏填相对时期变量）。
