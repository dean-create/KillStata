# 计量经济学实证研究方法大全 · 接入与验收状态

> 生成日期：2026-07-26（上一版 2026-07-24）
> 对标范围：Stata 18 能完成的主流实证计量分析
> 真相源（全部经代码核实，非人工记忆）：
>
> - 方法 ID、中文别名、适用条件、输出与诊断契约 → `packages/killstata-econometrics-engine/src/killstata_econometrics_engine/registry.py`
> - Python 参数模型与自动生成的 JSON Schema → `packages/killstata-econometrics-engine/src/killstata_econometrics_engine/schemas.py`
> - 模型可见 / 已准入清单 → `packages/killstata/src/runtime/econometrics-admission.ts` 的 `ECONOMETRICS_ADMISSIONS`；它只决定当前工作流是否允许发现，不复制方法 Schema
> - 后端执行 → `packages/killstata-econometrics-engine/python/*/runner.py` 经 `runner_bridge.py` 在长驻引擎进程内执行；TypeScript只负责Harness路由、血缘、权限和结果展示
> - 数值验收 → `packages/killstata-econometrics-engine/tests/` 的冻结 fixture、SHA-256 与独立 oracle
> - 真实交互验收 → `packages/killstata/test/drive/` 的生产 Harness 场景；功能完成率和零错误稳定性分别报告
>
> 模型如何发现并调用这些方法（2026-09-10 起）：稳定的Provider工具只暴露
> `tool_search`与`econometrics_execute`；方法索引只提供发现协议，不把几十个方法Schema塞进稳定前缀。
> 模型先用`tool_search`查询Python Registry，获得候选、适用/不适用边界和完整参数Schema；下一步
> 必须用`econometrics_execute(methodID, arguments)`执行。方法引用只进入当前对话的动态后缀，不改变
> 稳定工具与系统提示词缓存。新增方法只需在Registry登记并通过真实数据验收，TypeScript无需新增方法级wrapper。
>
> 当前 Python Registry 登记 30 项能力：29 项核心方法/诊断与 `heterogeneity_runner` 扩展能力；模型是否可发现仍由 TypeScript 准入清单控制。

---

## 状态图例（四态，含义严格区分）

| 标记                      | 含义                                         | 判定标准                                                                                                                                   |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| ✅ **生产可用**           | 已接入 **且** 当前人工 allowlist 允许模型发现 | 进入 `ECONOMETRICS_ADMISSIONS`；执行契约由 Python Registry 测试，代表性数值由冻结 benchmark/oracle 测试，真实交互由 Drive 持续验证 |
| 🟠 **后端已实现，未准入** | 代码能跑，但**模型看不见**，尚未完成当前验证 | 后端有实现，但不在 `ECONOMETRICS_ADMISSIONS`；不得引用历史回放次数或旧报告冒充当前证据 |
| ⬜ **未接入**             | 尚无后端实现                                 | 无对应工具，无后端代码                                                                                                                     |
| ➖ **不适用/内嵌**        | 非独立方法，作为其他工具的诊断输出           | 例如 Hausman 检验内嵌在 `panel_random_effects`                                                                                             |

**历史 benchmark 等级说明**（仅描述参照强度，不代表当前发布已通过）：

- **A 级**：已发表文献值对标（最高门槛，目前为 `logit_regression`、`probit_regression`、`rdd_sharp`）
- **B 级**：跨库 / 独立实现 oracle 对标（不允许用产品同一个库自证）
- 表格中的 A/B 标签来自旧阶段的 benchmark 设计。当前可信门禁只认 Python 引擎目录中已迁移的冻结 oracle 测试和本轮 Drive；尚未迁移的标签不得作为完成证明。
- 模型回放是时变稳定性证据，不写入运行时清单；发布候选以当前 Provider 的 Drive 报告为准。

---

## 一览：当前已准入的动态计量方法（26 个）

| 类别     | 工具                                | 数量 |
| -------- | ----------------------------------- | ---- |
| 推荐路由 | `econometrics_recommend`            | 1    |
| 诊断     | `psm_construction`、`psm_visualize`、`iv_test` | 3    |
| 估计器   | 见下方各家族 ✅ 项                  | 22   |

> 22 个估计器与 3 个诊断当前由人工 allowlist 暴露。旧 A/B 分类仅保留为 benchmark 背景；是否达到发布门禁必须读取当前 Python 引擎测试和 Drive 报告。

---

## 1. 基础回归与横截面（Cross-section / Linear regression）

| 方法                                              | 状态        | 工具 ID               | 证据                                                           |
| ------------------------------------------------- | ----------- | --------------------- | -------------------------------------------------------------- |
| 普通最小二乘 OLS（含稳健/聚类标准误 HC1/HC2/HC3） | ✅ 生产可用 | `ols_regression`      | B 级，`card1995`，独立 statsmodels HC1 oracle                  |
| 分位数回归 Quantile Regression                    | ✅ 生产可用 | `quantile_regression` | B 级，`quantile_sim`，statsmodels QuantReg + scipy LP 交叉验证 |
| 加权最小二乘 WLS                                  | ✅ 生产可用 | `wls_regression`      | B 级，`wls_sim` 独立 oracle；新增真实 `metafor::dat.bcg` AgentLoop：研究级 log RR `yi` 对绝对纬度 `ablat`，权重为 `1/vi`（研究内采样方差倒数），HC1 系数=-0.029237、SE=0.004407、N=13；另覆盖错列名后用户确认、同会话恢复。该固定权重 WLS 不估计随机效应 `tau²`，不作因果解释。|
| 广义最小二乘 GLS / FGLS                           | ⬜ 未接入   | —                     | —                                                              |
| 稳健回归（M 估计 / Huber RLM）                    | ✅ 生产可用 | `robust_regression`   | B 级，`rlm_outliers`，独立 statsmodels RLM-Huber oracle（真值 x1≈0.8，RLM 恢复至≈0.75 优于 OLS 偏误至≈0.76，14/300 观测被降权）|
| 分位数 IV（IVQR）                                 | ⬜ 未接入   | —                     | —                                                              |
| 非线性最小二乘 NLS                                | ⬜ 未接入   | —                     | —                                                              |

**WLS 权重边界**：`weightsVar` 必须是当前数据中有来源依据、与误差方差倒数成比例的正数列。抽样概率、频数、人口规模或任意正数不能直接当作 WLS 权重；没有合适权重时应暂停并向用户说明，不得由模型自行构造。权重缺失、非有限、为零或为负时，执行前要求用户决定；runner 也会独立拒绝并且不写产物。`covariance=robust` 对应 HC1，`nonrobust` 为经典 WLS 协方差。真实 BCG 场景仅验证逆采样方差的稳定工具链；该样本存在明显研究间异质性，不能把它当作随机效应 meta-analysis 验收。

---

## 2. 内生性与工具变量（Endogeneity / IV）

| 方法                                                               | 状态                  | 工具 ID                       | 证据                                                     |
| ------------------------------------------------------------------ | --------------------- | ----------------------------- | -------------------------------------------------------- |
| 两阶段最小二乘 2SLS / IV                                           | ✅ 生产可用           | `iv_2sls`                     | B 级，`card1995`，独立 linearmodels IV2SLS robust oracle |
| 第一阶段相关性 / 内生性 / 过度识别诊断（Wald χ²、F、DWH、Sargan/Hansen J） | ✅ 生产可用（诊断） | `iv_test` | B 级，`card1995`，独立 statsmodels/NumPy 手算 oracle；稳健协方差下报告第一阶段 Wald χ²，不套用 F<10 经验分类；恰好识别时过度识别检验明确返回不适用 |
| LIML / GMM（两步、连续更新）                                       | ⬜ 未接入             | —                             | —                                                        |
| 控制函数法 Control Function                                        | ⬜ 未接入             | —                             | —                                                        |

---

## 3. 面板数据（Panel data）

| 方法                                                     | 状态        | 工具 ID                     | 证据                                                                              |
| -------------------------------------------------------- | ----------- | --------------------------- | --------------------------------------------------------------------------------- |
| 固定效应 FE（含聚类标准误）                              | ✅ 生产可用 | `panel_fe_regression`       | B 级，`did_real_panel`，独立 statsmodels LSDV cluster sandwich + PanelOLS df 修正 |
| 随机效应 RE（Swamy-Arora GLS）                           | ✅ 生产可用 | `panel_random_effects`      | B 级，`panel_re_sim`，跨库 statsmodels MixedLM REML（0.5% 相对容差）              |
| Hausman 检验（FE vs RE）                                 | ➖ 内嵌     | `panel_random_effects` 输出 | 正自由度时按检验结果提供 FE/RE 建议；无有效自由度时标记不可判定，不以 p=1 推断支持 RE |
| 高维固定效应 HDFE（多维吸收 + CRV1）                     | ✅ 生产可用 | `hdfe_regression`           | B 级，`did_real_panel` 独立 linearmodels/CRV1 校验；新增 `did.xlsx` 真实 AgentLoop：地区+年份FE、地区聚类、N=4709，财政分权度系数=-0.010882，SE=0.008222（仅条件关联） |
| 组间估计 Between / 一阶差分 FD                           | ⬜ 未接入   | —                           | —                                                                                 |
| 动态面板 GMM（Arellano-Bond / Blundell-Bond System GMM） | ⬜ 未接入   | —                           | —                                                                                 |
| Hausman-Taylor / 相关随机效应 CRE（Mundlak）             | ⬜ 未接入   | —                           | —                                                                                 |

### FE 与 HDFE 的准入和展示边界

`panel_fe_regression` 是普通面板模型的首选入口：它要求真实且唯一的
`entityVar × timeVar` 面板键，并以实体和时间维度表达双向固定效应。用户说“面板固定效应”或
“双向固定效应”且没有更高维吸收需求时，推荐优先使用它。

`hdfe_regression` 是多维分类固定效应的吸收入口：它通过 `fixedEffects` 显式吸收一个或多个
分类维度，适合高维实体、年份或其他分组效应。它在 `fixedEffects=[实体, 时间]` 时可以表达双向
固定效应，但不应在结果中被静默改名为 `panel_fe_regression`；报告必须保留真实 method ID、
固定效应列和协方差口径。两者的估计结果只有在设计、样本、缺失处理和协方差设定一致时才可比较，
不能仅凭“都含固定效应”宣称数值等价。

模型把通用占位符 `entity/time` 或 `clusterVar` 传给 HDFE 时，Harness 可以做无损参数形状适配：
使用当前已核验的真实列生成 `fixedEffects/clusterVars`；这不代表替用户选择新的固定效应维度。

---

## 4. 因果推断与政策评估（DID / Event study / RDD）

| 方法                                                                   | 状态                    | 工具 ID                         | 证据                                                                                                        |
| ---------------------------------------------------------------------- | ----------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 传统双重差分 DID / TWFE（2×2）                                         | ✅ 生产可用             | `did_static`                    | B 级，`did_real_panel`，独立 statsmodels HC1 交互项 oracle（锁定 2012 2×2 抽取）；实现落地为 PyFixest 后端（2026-08-02 统一，原 linearmodels 版已下线移入 trash） |
| 现代交错 DID：Gardner 两阶段 DID2S                                     | ✅ 生产可用             | `did2s`                         | B 级，官方 `mpdta` 2500 行，独立 NumPy Gardner 两阶段 GMM oracle                                            |
| 饱和事件研究 Saturated Event Study（Sun-Abraham 型 cohort×event）      | ✅ 生产可用             | `did_event_study_saturated`     | B 级，`mpdta`，独立 statsmodels cohort-event 交互 + CRV1 oracle                                             |
| 锐性断点回归 Sharp RDD（MSE 最优带宽 + 三角核 + 局部一次）             | ✅ **生产可用（A 级）** | `rdd_sharp`                     | **A 级**，官方 [CFT Senate 示例](https://rdpackages.github.io/references/Calonico-Cattaneo-Titiunik_2015_R.pdf)：常规估计=7.414131、稳健偏差校正估计=7.506502、h=17.754397、断点两侧有效样本=360/323；独立 statsmodels WLS 对齐；新增完整 AgentLoop 在用户确认 `NA` 缺失语义后完成 CSV 类型恢复与估计，未声称识别假设已验证 |
| 模糊断点回归 Fuzzy RDD                                                 | ✅ 生产可用             | `rdd_fuzzy`                     | B 级，MIT Angrist–Lavy `final4.dta` 真实 AgentLoop：`c_size` 在 40 处作为运行变量、`classize` 实际处理剂量、`avgmath` 结果，`schlcode` CR1 聚类；N=2055、h=9.372、模糊效应=-0.5642（稳健 95% CI [-1.5740, 0.4456]）、第一阶段跳变=-8.4478（p=0.0361）。这是原始数据上的 Fuzzy RD 再分析，不等同于作者 Table 4 的 2SLS 复刻；识别假设未验证。([MIT 数据档案](https://economics.mit.edu/people/faculty/josh-angrist/angrist-data-archive), [作者 Table 4 程序](https://economics.mit.edu/sites/default/files/inline-files/AngristLavy_Table4.do)) |
| Callaway-Sant'Anna（`att_gt` 分组-时间 ATT）                           | ⬜ 未接入               | —                               | —                                                                                                           |
| de Chaisemartin-D'Haultfœuille / Borusyak-Jaravel-Spiess（BJS 插补法） | ⬜ 未接入               | —                               | —                                                                                                           |
| 合成控制法 Synthetic Control / SDID                                    | ⬜ 未接入               | —                               | —                                                                                                           |
| 断点-DID（RD-DID）/ 中断时间序列 ITS                                   | ⬜ 未接入               | —                               | —                                                                                                           |

事件研究执行边界补充：PyFixest saturated 实现要求 `cohort=0` 表示从未处理组。若当前 cohort 列缺失，preflight 会先要求用户确认缺失确实代表从未处理；确认后只在估计计算副本映射为0，不改原始数据，并验证 `treatment == (cohort>0 && time>=cohort)`。在 `did.xlsx` 上完成了本地脚本化 AgentLoop 真实数据回放（4709行、结果及系数文件落盘）；该实现仍标记为 beta，估计成功不证明因果识别假设。

---

## 5. 匹配与倾向得分（Matching / Propensity score）

| 方法                                           | 状态                  | 工具 ID                         | 证据                                                        |
| ---------------------------------------------- | --------------------- | ------------------------------- | ----------------------------------------------------------- |
| 倾向得分构建（Logit ps + 共同支撑诊断）        | ✅ 生产可用（诊断）   | `psm_construction`              | B 级，NSW 一行一单位样本真实 AgentLoop：得分范围[0.23537,0.63797]、共同支撑覆盖99.3%、分数与结果产物回传；`did.xlsx` 面板重复单位在 preflight 停止  |
| 倾向得分可视化（分数分布 / 重叠诊断）          | ✅ 生产可用（诊断）   | `psm_visualize`                 | B 级，与 `psm_construction` 组成 NSW 真实 AgentLoop，PNG 分布图经 protocol artifact → Harness analysisView 可见；不替代匹配/加权后的平衡检查  |
| 最近邻匹配 NN Matching                         | ✅ 生产可用           | `psm_matching`                  | B 级，`nsw_dw_analysis.csv`，独立 SciPy/NumPy 最近邻 oracle + 完整 AgentLoop；ATT=2195.2183、匹配后 max |SMD|=0.047434（[NBER NSW 样本](https://users.nber.org/~rdehejia/data/.nswdata3.html)） |
| 逆概率加权 IPW（Hájek）                        | ✅ 生产可用           | `psm_ipw`                       | B 级，`nsw_dw_analysis.csv`，独立 SciPy Logit/Hájek oracle + 完整 AgentLoop；ATE=1630.8240、加权 max |SMD|=0.002348（[NBER NSW 样本](https://users.nber.org/~rdehejia/data/.nswdata3.html)） |
| 回归调整 Regression Adjustment（Y ~ 1+T+e(X)） | ✅ 生产可用           | `psm_regression`                | B 级，独立 NumPy outcome adjustment                         |
| 双重稳健 AIPW（Doubly Robust）                 | ✅ 生产可用           | `psm_double_robust`             | B 级，独立 NumPy AIPW                                       |
| 旧版 DR（IPW+RA 组合）                         | 🟠 判定不准入         | `psm_dr_ipw_ra`（遗留兼容实现） | 权重语义 bug + 被 AIPW 覆盖，见文末实测复核；保留历史兼容，不向模型注册 |
| 熵平衡 Entropy Balancing / 粗化精确匹配 CEM    | ⬜ 未接入             | —                               | —                                                           |
| 核匹配 / 半径匹配 / 卡尺匹配                   | ⬜ 未接入             | —                               | —                                                           |

> **PSM 边界说明**：PSM 构建、可视化和估计都要求真实 0/1 处理列与唯一 `analysisUnitVar`；当前数据阶段必须一行一个分析单位。地区×年份等重复面板会在 preflight 停止，并请研究者确认时期、聚合和协变量时点；系统不自动筛年份或聚合。倾向得分诊断只报告分数与共同支撑，不等于效应估计或协变量平衡检验。处理前测量时点仍由研究者确认，尚无自动时间血缘核验。NSW/LaLonde 为 B 级工具基准，A 级论文同设定表格对标仍待完成。

---

## 6. 离散选择与受限因变量（Discrete choice / Limited dependent variable）

| 方法                                        | 状态        | 工具 ID             | 证据                                                                              |
| ------------------------------------------- | ----------- | ------------------- | --------------------------------------------------------------------------------- |
| 二元 Logit                                  | ✅ 生产可用 | `logit_regression`  | A 级，`spector_benchmark`，已发表 Greene/Spector 系数（const=-13.021, PSI=2.379） |
| 二元 Probit                                 | ✅ 生产可用 | `probit_regression` | A 级，同上（const=-7.452, PSI=1.426）                                             |
| 多项 Logit（MNL）                           | ✅ 生产可用 | `multinomial_logit` | B 级，`multinomial_sim_synth` 3 类 DGP；新增官方 statsmodels `modechoice` 真实 AgentLoop：从 840 行四备选长表仅保留 `choice=1`，得到 210 个一人一行、4 类 mode；按最小类 1 为基准，验证全部三类 hinc RRR/95% CI；该选择样本经过非热门方式过采样，不推断总体方式份额。[数据说明](https://www.statsmodels.org/v0.13.5/datasets/generated/modechoice.html) |
| 多项 Probit（MNP）                          | ⬜ 未接入   | —                   | —                                                                                 |
| 有序 Logit / 有序 Probit（Ordered）         | ⬜ 未接入   | —                   | —                                                                                 |
| 条件 Logit / 混合 Logit（McFadden / Mixed） | ⬜ 未接入   | —                   | —                                                                                 |
| Tobit（删失回归）                           | ⬜ 未接入   | —                   | —                                                                                 |
| Heckman 样本选择（两步 / MLE）              | ⬜ 未接入   | —                   | —                                                                                 |
| 双栏模型 / IV-Probit                        | ⬜ 未接入   | —                   | —                                                                                 |

---

## 7. 计数数据模型（Count data）

| 方法                         | 状态        | 工具 ID              | 证据                                                                                                       |
| ---------------------------- | ----------- | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| 泊松回归 Poisson / PPML             | ✅ 生产可用 | `poisson_regression` | 支持非负计数和连续非负结果的 PPML；负值结果在方法就绪检查中阻断。B 级，`count_sim_benchmark`，跨库 pyfixest 0.60.0 `fepois` 6 位对齐（treat=0.449241） |
| 负二项回归 Negative Binomial | ✅ 生产可用（需确认计数结果与过度离散） | `negbin_regression` | 仅非负整数计数；连续非整数结果改用 PPML 必须由研究者确认，二元结果不按计数拟合。B 级：既有独立 `count_overdispersed_benchmark`；新增官方 COUNT `badhealth` 真实 AgentLoop（1127 行，`numvisit` 就诊次数，0计数保留），稳健 alpha=1.002524、`badh` IRR=3.026278（95% CI [2.427971, 3.772022]）；见[CRAN COUNT 手册](https://cran.r-project.org/web/packages/COUNT/COUNT.pdf)。 |
| 零膨胀 ZIP / ZINB            | ⬜ 未接入   | —                    | —                                                                                                          |
| 广义泊松 / 截断计数模型      | ⬜ 未接入   | —                    | —                                                                                                          |

---

## 8. 时间序列（Time series）——整体未接入

| 方法                                   | 状态      |
| -------------------------------------- | --------- |
| ARIMA / SARIMA / ARIMAX                | ⬜ 未接入 |
| VAR / SVAR / 脉冲响应 IRF / 方差分解   | ⬜ 未接入 |
| VECM / 协整（Johansen、Engle-Granger） | ⬜ 未接入 |
| 单位根检验（ADF、PP、KPSS、DF-GLS）    | ⬜ 未接入 |
| GARCH / ARCH 族波动率建模              | ⬜ 未接入 |
| 局部投影 Local Projection IRF          | ⬜ 未接入 |

---

## 9. 生存分析（Survival / Duration）——整体未接入

| 方法                                    | 状态      |
| --------------------------------------- | --------- |
| Kaplan-Meier / 生命表                   | ⬜ 未接入 |
| Cox 比例风险模型                        | ⬜ 未接入 |
| 参数生存模型（Weibull、指数、对数正态） | ⬜ 未接入 |
| 竞争风险 / 分层 Cox                     | ⬜ 未接入 |

---

## 10. 非参 / 半参 / 机器学习计量——整体未接入

| 方法                                  | 状态                                      |
| ------------------------------------- | ----------------------------------------- |
| 核密度 / 局部多项式回归（独立使用）   | ⬜ 未接入（局部线性仅内嵌于 `rdd_sharp`） |
| 双重机器学习 Double/Debiased ML       | ⬜ 未接入                                 |
| 因果森林 Causal Forest / GRF          | ⬜ 未接入                                 |
| Lasso / Post-Lasso / 弹性网（含推断） | ⬜ 未接入                                 |
| 空间计量（SAR、SEM、SDM、空间面板）   | ⬜ 未接入                                 |

---

## 数据预处理与 MCDA（Data preprocessing & Multi-criteria decision）

> 数据预处理不属于因果/计量估计器；模型可见方法以 `data-method-admission.ts` 为准，执行契约与数值验证归 Python 引擎测试。
>
> `data_preprocess` 工具现已替代原 `data_import` 的 `preprocess`/`filter` 两个 action，是唯一的数据处理入口；`composite_evaluation` 承担 MCDA。具体方法由 Python Registry 与运行时 allowlist 共同决定。
>
> - 预处理（26）：`dropna`、`drop_missing`、`fillna`、`fill_constant`、`fill_mean`、`fill_median`、`forward_fill`、`backward_fill`、`linear_interpolate`、`group_linear_interpolate`、`regression_impute`、`log_transform`、`standardize`、`winsorize`、`create_dummies`、`combine_columns`、`create_column`（条件列创建：根据比较表达式生成 0/1 指示列；政策指示变量的阈值规则必须由用户确认，工具不得默认按 `year >= time` 逐行构造 `post`）、`create_relative_time`（仅在用户明确确认 entity/time/cohort/treatment 语义及相对时期规则后，按 `time - cohort` 生成 DID2S 相对时期；未处理单位编码为 `-inf`，并校验处理指示一致）、`coerce_numeric`（只转指定列；missing_tokens 必须由用户或数据源确认，未声明的非数值文本报错，原始阶段和观测行保留）、`filter`（条件筛选）、以及 5 个诊断工具（`profile`、`correlation`、`validate`、`healthcheck`、`rollback` 仍由 `data_import` 提供）
> - MCDA（2）：熵权综合指数（`entropy_weight`）、TOPSIS（`topsis`）；AHP 尚未接入。
>
> TOPSIS 调用必须显式指定 `weightSource=equal`、`manual` 或 `entropy`；系统不会在省略时自动采用等权。手工权重必须是有限的非负数、逐项覆盖所有指标且总和为 1。
>
> `data_import` 只负责导入、画像、分布、相关、质检、导出和回退，不再承担预处理算法。

---

## 汇总统计

| 状态                                | 数量         | 明细                                                                                                       |
| ----------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| ✅ 模型可见（人工 allowlist）       | **25**         | 22 估计器 + 3 诊断（`psm_construction`、`psm_visualize`、`iv_test`），另有推荐路由 `econometrics_recommend` 与内嵌 Hausman |
| 🟠 后端已实现但未准入（模型不可见） | **1**        | `psm_dr_ipw_ra`——实测有权重语义 bug 且被已准入的 `psm_double_robust`(AIPW) 覆盖，**判定不准入**            |
| ⬜ 未接入                           | 多数高级方法 | 时间序列、生存分析、动态面板、现代 DID 家族其余成员、合成控制、有序离散选择、机器学习计量、空间计量等 |

这里的 A/B 是历史 benchmark 分类，不再由运行时清单承诺。当前已迁入新引擎独立 oracle 门禁的代表方法为 `iv_test`、`rdd_sharp`、`did2s` 与 `psm_matching`；其余方法依赖各自现有 golden/执行测试，后续按风险逐步迁移。

---

## 关键判定原则（为何"能跑"≠"生产可用"）

> 数据清洗与 MCDA 的可见性来自当前源码 allowlist；数值正确性必须由 Python 引擎测试新鲜证明。

# 计量引擎迁移记录（2026-09-09）

当前计量能力正在迁移到 `packages/killstata-econometrics-engine`。Python Registry 统一维护方法 ID、中文别名、参数契约、适用条件、输出和诊断要求；TypeScript 只保留 `tool_search` 与 `econometrics_execute` 两个模型入口，以及数据血缘、权限、工作流和用户展示。

迁移阶段的执行边界：搜索只返回 Registry 的延迟方法引用，完整定义追加到当前消息，不回写稳定 Provider 工具前缀；执行请求由 TypeScript 注入规范化数据阶段路径和受控输出目录，Python 引擎串行处理 JSONL 并返回结构化中文错误。计量方法、数据画像/导入、方法推荐和异质性扩展均已通过 Registry 协议路径；Python profile 的非有限数会在 JSONL 边界转换为 `null`，规范化 Parquet 的 nullable 数值会在 OLS 前显式转换为 NumPy `float64`。异质性扩展已在 `did.xlsx`、`gf.xlsx` 和 `test_datasets.xlsx` 上完成计算/安全拒绝专项，尚未因此自动提升新的准入方法。

项目铁律：**后端实现与模型可见性是两件事**。一个方法要成为 ✅ 生产可用，必须同时满足：

1. **固定权威数据**：SHA-256 锁定的真实论文/官方数据集，测试期不临时联网换数据；
2. **独立数值 oracle**：绝不用产品自身依赖库自证（后端用 linearmodels，就必须用 statsmodels/NumPy/已发表值另算一遍）；
3. **生产 Harness 执行**：走真实工具链 → canonical stage 门禁 → 受管 Python，不走测试旁路；
4. **五类失败参数拒绝**：Schema、血缘、变量角色、方法假设、进程边界越界都能被拒；
5. **当前 Provider Drive**：验证工具选择、恢复、研究语义和 UX；同时报告功能完成率与零错误稳定性，不拿历史回放替代当前结果。

任一环缺失，方法就停在 🟠（后端能跑但模型看不见），**绝不因"后端可执行"提前对模型开放**。

### 2026-07-26 对三个 🟠 项的实测复核

| 方法               | 实测结论                                                                                                                                                     | 处置       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `rdd_fuzzy`        | 旧证据误引 sharp-only 的 `rd_senate` 已纠正；MIT Angrist–Lavy `final4.dta` 上已完成 CR1 聚类、第一阶段和真实 AgentLoop（B 级）；后续可补 A 级文献值对标 | 准入证据已更新 |
| `iv_test`          | 旧后端 `IV_2SLS_IV_setting_test` **没有 return 语句**，只 print，`test_results` 永远为空；测"排除限制"的做法也不是 Sargan/Hansen J                            | **重写后准入** |
| `psm_dr_ipw_ra`    | 把 `sqrt(IPW)` 当 WLS 权重传（statsmodels 的 weights 语义是 ∝1/σ²，不该开方），NSW 上 ATE=1652.41 与 sqrt 权重 WLS 逐位相同；教科书 `teffects ipwra`=1617.18，差 35.2；且功能被已准入的 AIPW（1619.05）覆盖 | **不准入** |

---

## 下一步优先级建议（基于当前缺口）

1. **补齐已有家族的近邻成员**（复用现成 fixture 与 Harness，成本最低）：
   - ~~`iv_test` 弱工具/内生性检验~~ → **2026-07-26 已重写并准入**（B 级）；
   - `rdd_fuzzy` 模糊断点 → 已准入（B 级），可继续补 A 级文献值对标升级；
2. **现代 DID 家族**：Callaway-Sant'Anna `att_gt`（pyfixest/官方 R 值对标）——补齐交错处理的主流缺口；
3. **离散选择扩展**：有序/多项 Logit、Tobit、Heckman——覆盖微观实证高频需求；
4. **时间序列基座**：单位根 + ARIMA + VAR 作为独立家族起步。

> 每一项落地仍须走完上文五步证据链，宁缺毋滥。
