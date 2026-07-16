# 上一阶段：计量工具调用核心链路

## 当前状态（2026-07-15）

基础阶段已经落地，模型不再直接调用 `econometrics(methodName, options)` 万能入口。当前生产链路是：

`Excel/CSV 导入 → canonical stage → 数据画像 → QA → 独立强类型估计器 → 结构化结果 → 模型中文解释`

- 模型可见的基础工具：`econometrics_recommend`、`ols_regression`、`panel_fe_regression`、`iv_2sls`。
- 模型可见的 PyFixest 工具：`hdfe_regression`、`did2s`、`did_event_study_saturated`。
- 所有估计器只接受 `datasetId + stageId`；同一 stage 未完成画像与 QA 时，后端直接拒绝。
- 旧 `econometrics` 只保留内部历史回放；AIPW/IPWRA、旧 TWFE event study、IV test、Fuzzy RDD 等未经验证方法不再暴露给模型。
- OLS 已补精确秩亏阻断与近似共线性告警；Panel FE 已禁止重复键时降级；IV 已收口为真实支持的 `robust/nonrobust` 协方差契约。
- DSML 工具失败与重复调用保护已进入统一 repair 生命周期；原生工具的重复调用门禁位于真实执行入口之前。
- 最新验证：受管真实 Python 全量 `bun test` 197 通过、0 失败、633 个断言；`bun run typecheck`、`bun run build`、`git diff --check` 全部通过。

详细执行记录：`docs/superpowers/plans/2026-07-15-econometrics-tool-safety.md`。

## 并行成果：PyFixest 独立计量工具接入

> 并行边界：Claude Code 完成 PyFixest 的 HDFE 与现代 DID 后端；Codex 完成旧 `econometrics` 的生产白名单、OLS/常规面板 FE/IV2SLS 独立工具，并把双方入口统一接入 canonical stage + QA 安全门。双方数值实现均保留，不互相覆盖。

## 本轮目标

把大模型固定在“参数生成与结果解释”这一层，把 PyFixest 固定在“确定性估计与推断”这一层。首批不继续扩张旧 `econometrics(methodName, options)` 万能入口，而是新增三个可独立发现、可独立校验、可独立执行的强类型工具：

1. `hdfe_regression`：高维固定效应线性回归，支持异方差稳健、一维/二维聚类推断。
2. `did2s`：Gardner 两阶段 DID，显式声明结果、处理、个体、时间和相对时期变量。
3. `did_event_study_saturated`：基于 PyFixest saturated estimator 的现代交错处理事件研究。

旧 `econometrics` 暂时保留作兼容入口，但不承载这三个新方法，也不把旧高风险方法包装成“已被 PyFixest 修好”。

## 调用链与边界

`模型生成结构化参数 → Zod 在 TypeScript 侧拒绝错误调用 → Python 适配器验证列与设计 → PyFixest 估计 → 标准结果 JSON → KillStata 中文结果摘要 → 模型解释`

- 模型不生成 Python 代码，不传原始 formula，不控制文件输出路径。
- 后端根据结构化字段构造公式；所有列名先映射为安全内部别名，避免空格、中文和公式注入。
- 聚类推断是 `hdfe_regression` 的明确参数，不伪装成独立计量方法；最多支持二维聚类。
- 工具失败必须返回单一中文错误；Python traceback、内部公式和工具协议不得进入用户对话。
- 每个成功结果至少记录系数、标准误、p 值、置信区间、样本量、固定效应、聚类变量、PyFixest 版本和产物路径。

## 实施步骤与验证

### 1. 固定运行时依赖与强类型契约

- 状态：已完成。
- 修改 `packages/killstata/src/killstata/runtime-config.ts`，把 `pyfixest==0.60.0` 纳入受管 Python 运行时，并区分“导入模块名”和“安装规格”。
- 新建 `packages/killstata/src/tool/pyfixest.ts`，为三个工具分别定义 Zod schema；数组、枚举、参考期、聚类维数和数据来源在 Python 启动前校验。
- 验证：先写失败测试，确认缺少依赖 pin、工具注册或错误参数时测试为红；实现后对应测试转绿。

### 2. 实现单一 Python 执行适配器

- 状态：已完成。
- 适配器只接受已验证 JSON；加载现有 dataset/stage，验证列存在、有效样本、处理变量和面板键，再构造安全公式并调用 PyFixest。
- `hdfe_regression` 调用 `pyfixest.feols`；无聚类时使用 `HC1`，有聚类时使用 `CRV1` 或 `CRV3`，二维聚类使用 `cluster_a + cluster_b`。
- `did2s` 调用 `pyfixest.did2s`；`did_event_study_saturated` 调用 `pyfixest.event_study(estimator="saturated")`。
- 验证：使用小型确定性 CSV 直接运行适配器，检查输出 schema、版本、样本量和主要系数。

### 3. 注册成三个模型可见工具

- 状态：已完成。
- 修改 `packages/killstata/src/tool/registry.ts`、`packages/killstata/src/runtime/tool-catalog.ts` 和 workflow 的显式工具分支，使三个工具进入分析权限、审批、重放和失败生命周期。
- 每个工具只暴露与该估计器相关的参数；禁止 `options.passthrough` 和静默改方法。
- 验证：工具目录能够发现三个独立 ID；非法列名、空固定效应、三维聚类、无效协方差和缺失 DID 字段在估计前失败。

### 4. 接入中文用户可见层

- 状态：已完成。
- 修改 `analysis-user-view` 与必要的 TUI 路由，把三个 ID 识别为核心分析任务；运行时显示“正在进行计量分析…”，成功只显示中文结果摘要，失败不泄露 traceback/公式/工具参数。
- 验证：可见层测试覆盖进行中、成功、Python 失败和 DSML/JSON 泄漏四类路径。

### 5. 数值 golden 与回归审查

- 状态：已完成。
- HDFE：构造双固定效应数据，对齐 PyFixest 直接调用的系数和聚类标准误。
- DID2S：构造有已知处理效应的分期处理面板，至少检查 ATT 符号、量级和输出字段。
- Saturated event study：检查参考期被正确省略、事件期系数和置信区间能够稳定序列化。
- 对抗性审查补齐：事件期聚合、DID 相对时期/批次一致性、精确 PyFixest 版本检查、后端结果 schema、特殊列名恢复、transcript 净化和 DID 实际估计摘要。
- 最终验证：`bun run typecheck` 通过；`bun test` 为 187 通过、0 失败、531 个断言；`bun run build --skip-install` 的 Linux/macOS/Windows 全目标通过，9 个发布二进制均确认嵌入 Python runner。

## 最容易出错的地方

- PyFixest 的 DID 接口、返回对象和系数命名随版本变化，因此固定版本并由真实 Python 测试约束，不凭印象解析。
- DID 的 cohort 变量不是普通 0/1 处理变量；工具契约必须区分 `treatmentVar`、`cohortVar` 和 `relativeTimeVar`。
- 二维聚类公式、参考期和 never-treated 编码不能由模型自由拼字符串。
- 新工具若只注册到 registry、没进入 workflow/tool policy/TUI，会出现“未注册工具”或执行中无进度反馈。
- 当前工作区有 Claude Code 的并行改动；只修改本轮明确文件，遇到重叠 diff 先重新读取再补丁。

---

## 既有计量基础可靠性审计约束

## 目标

先把 KillStata 做成“宁可明确拒绝，也不输出错误计量结论”的平台。基础估计器、诊断、结果字段和模型调用契约全部通过交叉验证后，才开放渐进 DID、事件研究、Fuzzy RDD 等高级方法。

## 当前审计结论

- `Econometrics-Agent-main` 上游共有 17 个注册函数；KillStata 对外声明 21 个 `methodName`，其中还包含自动推荐、别名、倾向得分构造和绘图，并非 21 个独立估计器。
- KillStata 的 17 个同名函数中，12 个主体基本原样复制，2 个仅调整绘图导入，只有 IV2SLS、渐进 DID 参数兼容和事件时间构造有实质修改。
- 当前不能把全部入口视为生产可用。已经数值复现错误 AIPW、默认关闭固定效应的渐进 DID、HC1 结果字段不一致、无效 IV 检验和错误 Fuzzy RDD 推断。
- 现有默认 Bun 测试会在 Python 运行时不可用时提前返回，可能出现“测试全绿但数值路径根本没跑”的假绿。

## 21 个入口的处置边界

| 入口 | 实际角色 | 当前处置 |
| --- | --- | --- |
| `auto_recommend` | 数据画像与候选方法推荐 | 保留画像；不得算作已完成估计，不得自动执行因果模型 |
| `smart_baseline` | 自动选择并执行基线 | 收紧为显式 OLS/面板 FE；禁止凭列名自动执行 IV |
| `ols_regression` | OLS/WLS | 基础候选；补满秩、变异、权重、缺失和推断一致性 guard 后开放 |
| `panel_fe_regression` | 面板固定效应 | 基础候选；禁止重复键时静默降级 pooled OLS，保留聚类结构 |
| `baseline_regression` | OLS/面板 FE 别名 | 跟随对应基础估计器的生产门槛，不单独形成一套逻辑 |
| `psm_construction` | 倾向得分构造 | 仅作为诊断中间步骤；补二元处理、收敛、极端得分检查 |
| `psm_visualize` | 倾向得分分布图 | 仅作为诊断；不得替代共同支撑和加权后平衡检验 |
| `psm_matching` | 最近邻匹配 | 暂停正式交付；补 caliper、并列处理、匹配后平衡和有效推断 |
| `psm_ipw` | IPW ATE/ATT | 暂停正式交付；修 estimand 标签、重叠、截尾、有效样本量和 SE/CI |
| `psm_regression` | 结果回归调整 | 暂停因果输出；重新定义适用假设与估计目标 |
| `psm_double_robust` | 声称 AIPW | 立即禁用；当前公式不是 AIPW，真 ATE=2 的基准可返回约 0 |
| `psm_dr_ipw_ra` | 声称 IPWRA | 立即禁用；当前权重与 outcome-model 结构不构成双重稳健估计 |
| `iv_2sls` | 线性 IV2SLS | 基础候选；当前核心已改用 `linearmodels.IV2SLS`，补显式识别声明和一致诊断后开放 |
| `iv_test` | 声称 IV 有效性检验 | 立即禁用；just-identified exclusion 不能如此检验，且函数返回 `None` |
| `did_static` | 静态 DID/TWFE | 实验级；改为明确 ATT、默认实体聚类，并补设计与平行趋势检查 |
| `did_staggered` | 传统 staggered TWFE | 立即禁用；默认无双向 FE，且异质效应下传统 TWFE 本身不可靠 |
| `did_event_study` | TWFE 事件研究 | 立即禁用；默认无 FE，缺省 event time 可能按行距而非真实时期构造 |
| `did_event_study_viz` | 事件研究绘图 | 随估计器禁用；估计窗口与绘图窗口必须统一后再开放 |
| `rdd_sharp` | 局部线性 Sharp RDD | 仅实验级；必须显式 cutoff，补带宽、核、每侧样本和稳健偏差修正 |
| `rdd_fuzzy` | 局部 Wald Fuzzy RDD | 立即禁用正式推断；当前没有正确 SE/CI 和弱一阶段保护 |
| `rdd_fuzzy_global` | 全局多项式手工两阶段 | 立即禁用；生成回归量的普通二阶段 SE/p 值无效 |

## 实施步骤与验证

### 1. 建立生产白名单并先封风险入口

- 状态：待确认后实施。
- 模型只看得到通过生产门槛的方法；错误 AIPW/IPWRA、`iv_test`、staggered/event DID、Fuzzy RDD 先隐藏或硬阻断。
- `smart_baseline` 不再凭 `iv`、`z`、`instrument` 等列名自动执行 IV；重复面板键不得静默切换模型。
- 验证：逐个危险 `methodName` 做端到端调用，必须在 Python 启动前失败，不生成数值快照、成功 stage 或显著性文案。

### 2. 把模型调用改成逐方法强类型契约

- 用可判别的 Zod schema 取代 `options: passthrough`；明确每种方法的必需字段、枚举、数值范围和数据来源互斥关系。
- 估计前检查：列存在、数值类型、处理变量严格为 0/1、cutoff 必填、面板键唯一、有效样本量、设计矩阵满秩、簇数和处理/对照变异。
- 统一结果契约：estimand、coefficient、SE、p、CI、N、簇数、协方差方法、丢弃样本、后端/版本、诊断和 claim ceiling 必须来自同一个最终估计样本。
- 验证：错误 key、错误类型、错误列、空协变量、重复键、非二元处理、无 cutoff、无重叠全部在估计前得到单一中文错误，且没有自动换方法。

### 3. 做牢三种基础估计器：OLS、面板 FE、IV2SLS

- OLS：区分关联与因果；补 rank/共线性、权重语义、稳健协方差以及 JSON/CSV/snapshot 推断一致性。
- 面板 FE：固定效应和聚类策略显式化；重复键 fail closed；少簇保留组内相关结构，不自动改 HC1。
- IV2SLS：工具变量必须由用户/研究设计明确给出；使用与主模型一致的第一阶段 partial F，恰好识别时明确排除限制不可检验，过度识别时才报告相应检验。
- 验证：确定性 DGP + Grunfeld/Card golden + Stata/R 独立结果夹具；系数、SE、p、CI、N 和样本筛选逐项比对，而不是只断言“运行成功”。

### 4. 再修基础因果设计：静态 DID、PS 系列、Sharp RDD

- 静态 DID：明确 2×2/多期设定、ATT 语义、实体聚类、处理时点与单调性、联合 pretrend/placebo。
- PS 系列：重写标准 AIPW/IPWRA；加入 overlap、trimming/caliper、匹配后/加权后 SMD、有效样本量和 influence-function/bootstrap 推断。
- Sharp RDD：显式 cutoff 与 assignment 一致性；数据驱动带宽、三角核、每侧有效 N、带宽敏感性、密度/协变量连续性和稳健偏差修正。
- 验证：已知真值的重复模拟同时检查偏差与置信区间覆盖率，并与独立实现交叉核验。

### 5. 让数值测试在 CI 中真正执行

- 固定并记录 Python 依赖版本，建立独立的 econometrics test job；Python 运行时缺失必须失败，禁止 `return` 式静默跳过。
- 为每个生产方法保存版本化 golden：至少包含正常、边界、错误输入和识别假设失败四类。
- 对比层级：手算 oracle → 独立 Python 后端 → Stata/R 固化夹具；CI 不要求用户安装 Stata/R，但必须验证其已审定输出。
- 验证：在干净环境中故意移除 Python 包，CI 必须红；恢复依赖后所有数值 golden 真正执行并报告断言数与运行时长。

### 6. 压测模型调用，最后才开放高级计量

- 建立模型工具调用回放集：漏参数、错类型、幻觉列名、非二元处理、无重叠、弱工具、错误 cutoff、重复面板键、重复调用和 DSML 失败。
- 每次调用必须满足：方法选择可解释、参数通过强校验、失败只进入一次统一失败生命周期、blocked 结果不展示任何结论数值、模型不得自行换方法“救显著性”。
- 只有前五步全部通过后，才实现 cohort-specific staggered DID / 现代 event study，再考虑 Fuzzy RDD、动态面板、GMM、时间序列等高级方法。
- 验证：真实模型 JSON/DSML 回放连续运行，危险调用 100% fail closed；允许调用的结果与直接后端调用逐字段一致。

## 生产准入标准

一个方法只有同时满足以下条件，才能重新暴露给模型：

1. 估计量、estimand、识别假设和协方差估计写清楚，并有独立实现对照。
2. 正常数据数值对齐；错误或不可识别数据在估计前阻断；blocked 结果绝不展示显著性。
3. 结果 JSON、表格、snapshot 和用户回答的 coefficient/SE/p/CI/N 完全一致。
4. CI 真正执行 Python 数值测试，不能因缺环境假绿。
5. 模型调用契约经过端到端回放，不会静默忽略参数、重复执行或自动切换识别策略。

## 最容易出错的地方

- 把“能拟合”误当成“有因果识别”，尤其是 OLS、IV exclusion、DID 平行趋势和 PSM 可忽略性。
- 修正 Python 公式却没同步 TS 结果字段、可见文案、workflow verifier 和模型 schema。
- 用标签证明推断已切换，但 JSON 中仍是旧标准误；当前 HC1 路径已经出现这种分裂。
- 用更宽松的 fallback 保证“总能出结果”；正确策略应是 fail closed，而不是换模型追求显著。
- 只做一次点估计 golden，不检查 SE、CI、样本筛选和错误输入。

## 下一步

等待确认后从步骤 1 开始：先建立生产白名单和硬阻断，不扩展任何高级方法。
