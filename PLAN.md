# 当前并行任务：Windows-only npm 发布恢复（2026-07-18，进行中）

> 用户已决定 npm 只支持 Windows x64：只保留 `killstata-windows-x64` 与 `killstata` 两个 tarball。macOS、Linux、Windows baseline 的 npm 原生包退出正式发布；源码开发不受影响。

- 详细 TDD 计划：`docs/superpowers/plans/2026-07-18-windows-only-npm-release.md`。
- 验收：manifest 精确两包、原生包先于 launcher、typecheck、两包真实 pack、registry dry-run、diff check。
- 结果：原生包上传后 npm registry 传播超过旧的 5 次复核窗口，已把默认重试扩展为 45 次；`killstata-windows-x64@0.1.26` 已发布并核验完整性，待主包恢复发布。

---

# 已完成：npm 多平台发布链路整理（2026-07-18）

> 目标：把版本推断、全平台打包、npm 发布、GHCR 推送和 Windows 特例拆开，形成显式版本、可恢复、主包最后发布的最小链路。

- 版本必须由 `--version X.Y.Z` 显式提供，不再只看 `killstata@latest` 猜版本。
- `pack-release.ts` 只构建/打包并生成带 SHA-512 SRI 的 manifest；`release.ts` 只做预检、顺序发布和 registry 核验。
- npm 多包无事务，采用 native packages 先发、launcher `killstata` 最后发；重跑时同版本同完整性跳过，不同完整性阻断。
- npm 发布不再写临时 Token 文件，也不再顺带执行 Docker/GHCR；认证交给 npm 标准配置，GHCR 保持独立 workflow。
- 详细 TDD 计划：`docs/superpowers/plans/2026-07-18-npm-release-pipeline.md`。
- 验证结果：发布协议 15/15、全量 402/402、typecheck 与 diff check 通过；`0.1.26` dry-run 生成 12 个包且没有上传；独立复审 Critical 0、Important 0。
- 当前边界：代码整理已经完成，真实 npm publish 尚未执行；Trusted Publishing 仍需在 npm 网站配置。

---

# 当前大任务：真实论文数据 + 模型工具调用回放验收基座（2026-07-17）

> 目标：用同一个验收 case 串起 `锁定数据 → 数据画像/QA → DeepSeek 原生 tool_calls
> → JSON Schema → 生产 Harness → 真实后端 → 独立数值 oracle → 失败参数拒绝`，以后每个计量工具
> 必须通过完整证据链才能标记为准入。

## 已冻结的架构决策

- 三类数据统一入库：两份用户真实 Excel、linearmodels 7.0 自带数据、按方法审核的专用权威数据。
- 数据“自动查找”只在开发期发现候选；经来源、许可、变量语义、方法适配和 SHA-256 审核后固化。测试/CI 不临时联网换数据。
- PSM 必须使用 NSW/LaLonde；Card 只能保留 wiring/smoke，不得冒充 PSM 方法学对标。
- 现有 schema-only replay、DeepSeek-only routing 和 backend-only E2E 将统一为真实生产 Harness trace。
- 数值证据分 A/B/C/wiring；后端若本身使用 linearmodels，不能用同一库自证算法正确。
- 诊断工具按倾向得分、共同支撑、SMD、ESS、样本计数验收，不强造系数或无效标准误。
- 首个纵向 pilot 是 `panel_fe_regression + did.xlsx`，先证明基座能抓住假调用、错参数、错执行和数值漂移，再扩展到 PSM/DID/RDD。

## 七段实施顺序

1. 统一 `AcceptanceCase` schema 与数据注册表。
2. 建方法→专用数据能力映射和审核式下载/固化脚本。
3. 加生产 Harness 结构化 trace observer，不走测试旁路。
4. 建独立 oracle、设定指纹和字段级数值容差。
5. 跑 DeepSeek 真实调用 3 次稳定性回放，要求工具、变量角色和安全决策 3/3 一致。
6. 对每个工具补 Schema、血缘、变量角色、方法假设、进程边界五类失败用例。
7. 输出机器可读准入报告与方法卡，CI 分 PR/Python/Nightly 三层门禁。

详细 TDD 实施方案：`docs/superpowers/plans/2026-07-17-econometrics-paper-replay-acceptance-bench.md`。

---

# 总路线图：计量方法工具准入 v2（2026-07-16，Claude 盘点后与现行协议合并）

> 定位：不另起炉灶。Codex 现行准入协议（psm_construction 是样板）保留为基础，
> 本章补 3 个缺口、定剩余方法的处置与排序、划分双 agent 分工。
> 核心流程不变：`用户上传 excel → data_import 画像+QA → 模型理解意图 → 调强类型工具
> → 后端执行 → 结构化结果 → 模型中文解读`。模型只做两件事：生成参数、解释结果。

## 现状快照（盘点结论，全部经代码核实）

- ✅ 已准入 10 个模型可见工具：`econometrics_recommend` + 估计器 7 个
  （`ols_regression / panel_fe_regression / iv_2sls / hdfe_regression / did_static / did2s /
  did_event_study_saturated`）+ PSM 诊断 2 个（`psm_construction / psm_visualize`）
- ✅ 旁路已封：老万能 `econometrics`（21 方法）对模型不可见，仅供历史回放
- ✅ Harness 已加固（执行许可、超时、脱敏、修复预算 ≤2 次且禁止原样重试）
- ✅ 提示词已同步（system.ts 无 smart_baseline 残留；deepseek.txt 教的是新工具集）
- ✅ 最新共享工作树全量测试 357/357、1256 个断言；Python 编译、typecheck、全平台构建、
  diff check 全绿。**纪律不变：每项准入必须从绿基线开始，红着不开新项。**

## 三个缺口（现行协议之外要补的）

### 缺口 1：模型调用回放（用户准入五关的第五关，目前完全缺失）
契约再严，模型调不对也白搭。现在没有任何测试验证"真实 DeepSeek 给的参数能过契约"。
- 建 `test/fixtures/replay/<tool>/*.json`：`{ modelArgs, expect: "pass" | "reject", rejectHint? }`
- 来源：从 `~/.local/share/killstata/storage` 的真实会话提取 + 手工构造边界
- 每个工具至少 5 条：2 条真实正确调用；3 条典型模型错误——
  JSON 字符串参数（`"{\"action\":...}"`)、列角色混淆（因变量=处理变量）、编造列名
- 断言两件事：错误被拒 + **拒绝信息里含模型能照着改对的指引**（这是 repair 预算 ≤2 成立的前提）
- 回放跑在纯 TS 层（不起 Python），零成本进全量测试

### 缺口 2：数值对标权威性分级（防"自己对自己"的假验证）
现状混着三种强度：Grunfeld/Card 是文献值；psm_construction 是 SciPy 独立重算；
pyfixest 三工具是合成数据对齐 pyfixest 自身——**自己对自己只能验 wiring，验不了算法**。
- **A 级**：已发表文献值 / 教科书数据集（Grunfeld、Card 1995 范式）
- **B 级**：跨库独立实现对标（statsmodels ↔ linearmodels ↔ pyfixest ↔ R/Stata）
- **C 级**：合成数据已知参数恢复
- 底线：估计器工具至少 B 级；每个方法家族的旗舰必须 A 级。
- A 级数据集库：OLS/IV→Card 1995（已有）；面板→Grunfeld（已有）；
  DID→Card & Krueger 1994 最低工资（did_static 的 Word 手工核对可升格归档）；
  现代 DID→Cengiz et al. 2019 或 pyfixest 文档基准；PSM→LaLonde/NSW（Dehejia-Wahba 1999）；
  RDD→Lee 2008 众议院选举（rdrobust 标配）

### 缺口 3：准入卡（把"逐项核对"落成可追溯文档）
每个工具一张 `docs/methods/<tool>.md`：算法来源（借鉴自 Econometrics-Agent 哪个函数、
改了什么）、适用条件与识别假设、参数契约、后端校验清单、对标级别与来源、已知局限、
回放覆盖。准入完成的定义 = 准入卡归档。

## 剩余方法处置表（21 - 已准入 10 = 11 个待决）

| 方法 | 处置 | 理由/对标 |
|---|---|---|
| psm_visualize | **准入完成** | 诊断类；Card 数据仅作 B 级 wiring/smoke，不输出因果结论 |
| psm_matching | 准入 | LaLonde A 级；匹配后 SE 是坑（Abadie-Imbens），准入卡必须写清 |
| psm_ipw | 准入 | LaLonde A 级；极端权重截断策略要显式 |
| psm_regression | 准入 | LaLonde A 级 |
| psm_double_robust | 准入 | LaLonde A 级 |
| psm_dr_ipw_ra | **合并进 double_robust 或砍** | 与上一项是重复变体，两个入口只会让模型选错 |
| iv_test | **并入 iv_2sls 诊断输出** | 弱工具检验不该是独立工具，是 IV 结果的必附诊断 |
| did_staggered（旧 TWFE） | **不准入，砍** | TWFE 交错 DID 有已知偏误（Goodman-Bacon），已有 did2s/saturated 现代替代；准入它是害用户 |
| did_event_study(_viz)（旧） | **不准入，砍** | 同上，saturated 版已覆盖 |
| rdd_sharp | 准入 | Lee 2008 A 级；评估用 rdpy/rdrobust 替代自研带宽选择 |
| rdd_fuzzy | 准入 | 同上 |
| rdd_fuzzy_global | **准入时评估，倾向砍** | 高阶全局多项式已被方法学界明确反对（Gelman & Imbens 2019） |
| smart_baseline / baseline_regression | **砍（用户已拍板）** | 自动降级与"绝不自动换估计量"冲突；推荐与执行分离：recommend 建议 → 用户确认 → 调具体工具 |
| auto_recommend（老入口） | 砍 | 已被 econometrics_recommend 取代 |

## 双 agent 分工（避免撞车）

- **Codex**：继续按下方现行清单逐项准入（psm_matching → 其余 PSM 家族 → RDD），
  每项在现行五关上**加挂关⑥回放 + 关⑦对标分级**
- **Claude**：基础设施与补课——①回放机制建设 + 已准入 9 工具补回放；
  ②pyfixest 三工具 C→A/B 级对标补课；③smart_baseline/econometrics-smart.ts 砍除；
  ④准入卡模板 + 已准入 9 工具的准入卡回填
- 文件边界：Codex 动 `econometric_algorithm.py`/新工具文件；Claude 动 `test/fixtures/replay/`、
  `docs/methods/`、`econometrics-smart.ts` 删除、golden 测试补充。冲突面≈0。

## 工作量估计

回放基础设施+9 工具补课 6-8h；对标补课 4-6h；smart_baseline 砍除 2-3h；准入卡回填 3-4h；
PSM 家族剩余 4 项准入 12-16h；RDD 2-3 项 10-14h。其余基础设施工作量保持原估算。

---

# 当前计划：17 个计量函数逐项工具准入

## 第 1 项：`psm_construction`（2026-07-16）

- 状态：已完成；独立终审 Critical 0、Important 0。只开放倾向得分构造，未批量恢复其余方法。
- 定位：数据设计/共同支撑诊断，不是因果估计，不输出 ATE、ATT、p 值或显著性结论。
- 模型参数固定为 `datasetId + stageId + treatmentVar + covariates`；旧 `methodName/options/dataPath` 不对模型开放。
- 后端必须阻断未完成画像/QA、非 0/1 处理、缺组、缺失/非数值/常数协变量、秩亏、完全分离和未收敛。
- 逐行倾向得分采用临时文件原子写入；TS 在 manifest 登记前校验摘要、路径、文件和表头；失败删除完整隔离目录。
- 模型只收到样本量、得分范围、分组均值和共同支撑摘要；文件引用仅保留在折叠的相对 artifact metadata 中。
- workflow 记为 `describe_or_diagnostics`，不冒充 `baseline_estimate`。
- 数值交叉验证：用 SciPy 独立最大化同一 Logit 似然并逐行核对 80 个得分，同时独立手算共同支撑；本项尚未使用 R/Stata golden。
- 最终门禁：目标测试 20/20；全量测试 265/265、966 个断言；typecheck、Python py_compile、全平台 build、diff check 全部通过。
- 详细 TDD 计划：`docs/superpowers/plans/2026-07-16-psm-construction-tool.md`。
- 下一项：`psm_visualize`，已在下节完成准入。

## 第 2 项：`psm_visualize`（2026-07-17）

- 状态：已完成；独立复审 Critical 0、Important 0。模型可见入口总数增至 10。
- 参数固定为 `datasetId + stageId + treatmentVar + covariates`；禁止结果变量、原始路径、任意 options、bins 与调用方输出目录。
- 后端先构造倾向得分，再用 `[0,1]` 上 20 个公共分箱分别归一化处理组/对照组；只输出重叠与极端得分诊断，不输出 ATE、ATT、p 值或显著性。
- PNG 临时写入后原子发布；TS 校验统计一致性、路径边界、PNG 签名与尺寸。拒绝权限、Python 失败或后处理失败均删除完整隔离目录。
- Card 1995 真实数据已跑通，定位为 B 级 wiring/smoke；它不替代 PSM 因果估计的 LaLonde/NSW A 级对标。
- 最终门禁：聚焦 20/20、参数回放 81/81、全量 357/357（1256 个断言）；缺失 Python 的反向门禁确实失败；typecheck、Python py_compile、全平台 build、diff check 全部通过。
- 下一项：`psm_matching`，先用 LaLonde/NSW 固定 ATT 与匹配诊断，再决定标准误契约。

## 第 3 项：`psm_matching`（进行中，2026-07-17）

- 已冻结首版边界：只开放 canonical stage 上的 `dependentVar + treatmentVar + covariates + analysisUnitVar + preTreatmentAggregation`，固定 1:1 最近邻、允许重复使用对照组、固定 0.2 SD(logit PS) caliper，估计 `ATT（已匹配处理组）`。
- 不向模型开放匹配比例、caliper、estimand、`options` 或输出目录；普通 bootstrap 对固定邻居匹配通常无效，首版不输出 SE/p 值/置信区间或显著性。
- 准入门槛：逐项检验 caliper、并列权重、未匹配处理组的 estimand 标签、匹配后 SMD ≤ 0.10、零残留失败路径、LaLonde/NSW 对标及 ≥5 条模型回放。
- 详细 TDD 执行计划：`docs/superpowers/plans/2026-07-17-psm-matching-tool.md`。
- 已完成实现与聚焦验证：模型入口已固定为结果变量、0/1 处理变量和处理前协变量；后端固定 1:1（允许对照重复使用）、logit PS 的 0.2 SD caliper、并列最近邻等权平均，只返回已匹配处理组 ATT；不产生 SE/p 值/CI/显著性。平衡未达最大绝对 SMD 0.10 时，Harness 删除隔离目录并拒绝发布。
- 面板 PSM 硬门禁已补：`psm_matching` 与 `psm_ipw` 都要求明确分析单位和处理前聚合方式；Python 在估计前验证当前 stage 的分析单位无缺失且恰好一行一个单位。真实 `city × year` 面板即使伪称已做预处理也会在后端拒绝，不能再把重复逐期行当独立样本。
- 真实数据状态：Card 1995 通过完整工具链（ATT=0.04197110，2,053 个处理组均匹配，匹配后最大绝对 SMD=0.01321997），仅作 B 级 wiring/smoke；从 NBER 下载的 LaLonde/NSW DW 445 行数据（SHA-256 `d1bd2680…e4e072`）在完整基线协变量下得到匹配后最大绝对 SMD=0.1849，已被正确拒绝，**不能伪装成 A 级准入**。下一步是归档该夹具与独立参考实现，决定是否通过用户可见的预处理阶段获得合格样本；不得暗中放宽 0.10 阈值。

## 第 4 项：`psm_ipw`（准入完成，2026-07-17）

- 固定首版边界：只开放 canonical stage 的 `dependentVar + treatmentVar + covariates`；固定估计 ATE，不向模型开放 target、截断阈值、权重公式、协方差、`options` 或输出目录。
- 稳定性规则：复用已验证的 Logit PS；不偷偷截断极端权重——若任何得分不在 `[0.05, 0.95]`，直接拒绝并要求先处理重叠；使用组内归一化 Hájek IPW；要求处理组与对照组有效样本量均不少于 20、加权后每个协变量绝对 SMD ≤ 0.10。
- 输出边界：只返回通过重叠、ESS 与平衡门槛后的 ATE 点估计、权重范围、ESS 与加权 SMD；首版不输出 SE/p 值/CI/显著性，且失败不得发布产物。
- 已完成实现与聚焦验证：模型入口、工作流路由、事务清理和结果校验均只接受固定 Hájek ATE 契约；Python 层已覆盖归一化、极端得分不静默裁剪、低 ESS、加权失衡四类红线。完整模型工具链已跑通合成数据与 Card 1995；Card 结果 ATE=0.04153583，作为 B 级 wiring/smoke 基线，不作为 IPW 因果结论验证。
- 未完成但不阻塞首版：LaLonde/NSW A 级独立参考对标与模型意图回放仍归入 PSM 家族夹具工作；在完成前不得把 Card smoke 误写为方法学正确性的证明。
- 同一分析单位/聚合硬门禁与 `psm_matching` 共用；验证覆盖工具 schema、真实 Python 拒绝、Card 与合成横截面回归。

## 并行校准：两份真实论文 Excel 全链路测试（2026-07-17）

- 数据源只读锁定：`/Users/cw/Desktop/ks/test/did.xlsx` 与 `test_datasets.xlsx`，使用 SHA-256 防止数据悄然漂移。
- 首轮事实：DID 数据是 277 城市 × 17 年平衡面板，`did` 分三批进入且无逆转；原始 `time` 把从未处理组读成文本 `"36"`，不能直接用于现代 DID。
- 数字经济数据是 421 个“省份+地区”单位 × 23 年平衡面板；只用 `地区` 会产生 23 个重复实体—年份键，必须先验证复合实体。
- 测试分四层：Excel 导入/QA、离线意图与严格参数、真实后端 FE/稳健性/机制屏、真实 DeepSeek 工具选择；每层分别定位失败。
- 文件边界：本任务新增 `real-paper-*` 测试/脚本与根目录 `test/real-paper-chain/` 证据，不修改进行中的 `psm_matching` 实现和 LaLonde 夹具。
- 详细执行计划：`docs/superpowers/plans/2026-07-17-real-paper-chain-calibration.md`。

---

# 上一计划：DeepSeek Harness 工具执行加固

## 并行实测：传统 DID 端到端验收（2026-07-16）

- 状态：已完成；不改动 Harness 加固任务的文件边界。
- 已完成 Word 7 页核对与 Excel 只读基准：820 行、8 列、`fte` 缺失 19、有效样本 801、手工 DID 为 2.9139823574。
- 已发现输入风险：`id=407` 同时属于处理组和对照组，原始 `id × t` 非唯一；传统分组均值 DID 可算，但面板 FE/DID2S 不得直接使用该实体键。
- 已新增独立强类型 `did_static`：模型只传 `dependentVar/groupVar/postVar/covariates`，后端验证二元组别、二元时期和四个组期单元后安全构造交互项。
- 真实 KillStata 已按 `导入 → 数据画像 → QA（不误传面板键）→ did_static` 完整执行；控制后 DID 为 2.9350196887，HC1 标准误 1.5434221385，p=0.0575811010，N=801。
- 验证：目标测试 60 通过、全量测试 217 通过、类型检查、Python 编译、跨平台构建和 diff 检查全部通过；独立终审 Critical/Important 均为 0。
- 后续独立 UX 优化：缩短自动 verifier 等待时间，并继续收口详情模式下的 `Read` 路径与英文技术碎片；不影响本次 DID 估计正确性。

## 当前任务（2026-07-16）

状态：已完成；独立终审 Critical 0、Important 0。

只保留 OpenAI 兼容的原生 `tools/tool_calls` 协议，并补齐 KillStata 数据导入与计量执行的 Harness 边界：执行许可、固定 cwd、有限 stdout/stderr、超时终止、脱敏去噪、重复折叠、结构化错误和定向修复。

- 当前模型可见共 8 个计量工具：1 个推荐工具 `econometrics_recommend`，以及 7 个独立生产估计器 `ols_regression`、`panel_fe_regression`、`iv_2sls`、`hdfe_regression`、`did_static`、`did2s`、`did_event_study_saturated`。旧万能 `econometrics` 仅供历史回放，模型不可见。
- DeepSeek 只走 `@ai-sdk/openai-compatible` 的原生 OpenAI tools/tool_calls；DSML、LiteLLM/Anthropic shim 和模型侧 MCP sidecar 已退出活动链路。
- Harness 在执行前完成强类型参数、方法锁、失败参数签名、重复调用、权限、命令与 cwd 检查；子进程使用有限环境、有限 stdout/stderr、超时/取消和 250ms 终止 watchdog。
- 工具正文与 metadata 分别做脱敏、有界化和重复折叠；超长结果使用不含本机路径的 `tool-output:` 引用分页读取；日志、反思、失败证据和临时脚本首次落盘即为私有权限。
- 自动修复最多 2 次：必须保持原计量方法、不得原样重复失败参数；未知工具进入同一预算但不锁定伪方法，额度耗尽后停止并向用户报告。
- 验证：独立聚焦对抗回归 111/111；强制受管 Python 全量 254/254、881 个断言；类型检查、PyFixest Python 编译、Linux/macOS/Windows 构建与 `git diff --check` 全部通过。

详细 TDD 计划：`docs/superpowers/plans/2026-07-16-deepseek-harness-hardening.md`。

执行原则：模型只负责选择工具和生成强类型参数；Harness 只执行注册工具内部固定的 Python runner，不接受模型传命令、脚本、cwd 或超时；未经验证的方法继续隐藏。

---

---

# 历史计划索引

- 2026-07-15 计量工具调用核心链路（已完成，含 PyFixest 接入五步骤与验证记录）：`docs/plans/2026-07-15-econometrics-tool-core.md`
- 各项详细 TDD 执行记录：`docs/superpowers/plans/`
