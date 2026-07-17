# did_event_study_saturated

## ⚠️ 已知风险：底层依赖的 beta 状态

**PyFixest 的 `SaturatedEventStudyClass` 在 PyFixest 自己的源码里被标注为
beta**：

```
warnings.warn(
    "The SaturatedEventStudyClass is currently in beta. "
    "Please report any issues you may encounter."
)
```

（`pyfixest/did/saturated_twfe.py`，PyFixest 0.60.0）。这意味着：
- KillStata 这边无论测试覆盖做到多细，都无法消除"上游库本身还在
  beta、语义可能随版本变化"这个残余风险。
- 升级 PyFixest 版本前，必须重新跑一遍本方法的全部测试，
  不能假设行为不变——`hdfe_regression`/`did_static`/`did2s` 相对更成熟，
  这一条主要针对这个方法。
- 模型对用户呈现结果时，如果用户明确问起方法成熟度，应如实告知
  这是一个仍在活跃演进的估计量，不要包装成和传统 DID 同等成熟。

## 方法概览

现代交错处理事件研究，用"cohort（首次处理时期）× 相对时期"的
完全饱和交互回归估计各处理批次各相对时期的效应，再跨批次聚合，
避免旧 TWFE 事件研究在异质处理效应下的偏误（Goodman-Bacon 问题）。

## 算法来源

- Python 适配器：`run_saturated_event_study`
  （`packages/killstata/python/pyfixest/runner.py`），调用
  `pyfixest.event_study(estimator="saturated", att=False, ...)`。
- 底层公式（读自 PyFixest 0.60.0 源码 `_saturated_event_study`）：
  `outcome ~ i(rel_time, first_treated_period, ref=-1, ref2=0) |
  unit + time`——对相对时期和处理批次做完全交互，以"相对时期=-1"
  （处理前一期）和"批次=0"（从未处理组）为双重基准，个体和时间
  固定效应吸收。这是 Sun & Abraham (2021)/Wooldridge (2021) 一脉的
  "扩展 TWFE"思路的一种实现，但 PyFixest 源码本身没有在这个函数上
  明确引用某一篇论文，本卡不做超出源码依据的归因。
- KillStata 新增后端（同 `hdfe_regression`/`did2s`）。

## 适用条件与识别假设

- 至少两个不同的处理批次（`treated_cohorts.length >= 2`），否则
  "跨批次异质性"这个卖点无从谈起，后端直接拒绝。
- 从未处理组必须显式存在且用 `cohortVar=0` 标记——没有从未处理组
  会被拒绝（`"requires the saturated event study to declare
  never-treated units as cohort zero"` 测试锁定）。
- 同一个体的首次处理时期必须唯一且不变——如果数据里同一个体的
  cohort 标记前后不一致，直接拒绝。

## 参数契约

`datasetId`/`stageId`/`dependentVar`/`cohortVar`/`entityVar`/`timeVar`
必填，四者互不相同；`clusterVar` 可选（默认=entityVar）。`.strict()`。
注意这个工具**没有** `covariates` 字段——饱和交互设计本身已经很密集，
当前契约不支持额外协变量。

## 后端校验清单

- 至少两个处理批次、从未处理组必须存在、cohort 标记稳定性、
  entity-time 键唯一性、聚类变量至少 2 个簇、cohort 值必须对应数据中
  实际存在的时间取值。

## 对标级别与来源

**B 级**（2026-07-17 从 C 级升级）：`test/tool/pyfixest-independent-
crosscheck.test.ts`，按处理批次分别单独跑饱和的"cohort×相对时期"
交互回归（LSDV + statsmodels，不导入 PyFixest），再对各批次在同一
相对时期的系数取简单平均——这正是 PyFixest `aggregate()` 在做的事，
只是用完全独立的代码路径复现。测试同时验证了两个处理批次
（cohort=4、cohort=6）确实被独立估计出不同的批次特定系数
（1.5055 和 1.4945），平均后与 PyFixest 的聚合结果一致——这直接
证明了"批次异质性不互相污染"这个核心卖点是真实生效的，不只是
文档里的说法。

## 已知局限

- 底层依赖标注为 beta（见顶部风险提示），这是本卡里唯一一个
  "即使测试全绿也不能视为成熟"的方法。
- 独立交叉验证目前只对了相对时期 0 这一个点；`aggregate()` 还会
  输出其他相对时期（-5 到 4）的系数，这些没有逐一交叉验证，
  只是间接依赖同一个公式的正确性。
- 没有协变量支持，也没有已发表数据集上的 A 级验证。

## 测试覆盖

- `test/tool/pyfixest-backend.test.ts`：批次隔离（系数项不互相污染）、
  从未处理组缺失、cohort 不稳定两个失败测试。
- `test/tool/pyfixest-independent-crosscheck.test.ts`：B 级独立交叉验证。
- 模型调用回放：`test/fixtures/replay/did_event_study_saturated/`，
  5 条（cohort 与时间变量混淆、个体与结果变量混淆、漏填 cohort 变量）。
