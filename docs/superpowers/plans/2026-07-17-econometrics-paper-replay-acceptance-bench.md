# 真实论文数据与模型工具调用回放验收基座 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `test-driven-development` task-by-task and use `verification-before-completion` before marking any method admitted.

**Goal:** 建立一套可复现、可审计的计量工具准入基座，证明 DeepSeek 选对方法并生成合法参数、Harness 真正执行正确工具、KillStata 在真实论文数据上的数值与独立权威实现对齐。

**Architecture:** 用单一 `AcceptanceCase` 连接数据集注册表、数据画像、用户意图、模型工具调用、生产 Harness 执行轨迹、数值 oracle、错误参数和最终报告。在线检索只负责发现候选数据；候选通过来源、许可、方法适配和 SHA-256 审核后固化，本地测试与 CI 只使用锁定版本，不在测试运行时联网换数据。

**Tech Stack:** Bun/TypeScript、Zod/JSON Schema、DeepSeek OpenAI-compatible tools、现有 KillStata SessionProcessor/ToolRegistry/Harness、Python 受管运行时、linearmodels 7.0、PyFixest 0.60.0、按方法引入的权威参考实现与冻结输出。

## Global Constraints

- 不恢复万能 `econometrics(methodName, options)`；只验收模型实际可见的强类型工具。
- 模型只负责选择工具、生成参数、解释结构化结果；模型不得生成 Python、命令、cwd 或超时。
- 每个数据文件记录来源、许可、SHA-256、行列数、变量字典和适用方法；哈希不符立即失败。
- 同一验收用例必须走生产 `ToolRegistry → SessionProcessor → RuntimeHooks → ToolOrchestrator → tool.execute`，不得测试中直接调用后端冒充完整链路。
- 若 KillStata 后端本身使用 linearmodels，则 linearmodels 只能证明 wiring；算法正确性还需论文值或另一独立实现。
- 所有数值比较锁定样本筛选、变量变换、固定效应、权重、聚类层级、协方差类型和有限样本修正。
- 诊断型工具不强造系数/标准误；按其契约比较倾向得分、共同支撑、SMD、样本计数或绘图底层数据。
- 真实 DeepSeek 回放不得把 API Key、绝对路径、原始数据行、stdout/stderr 原文或完整思维链写入 fixture。
- 自定义两份 Excel 在公开提交前必须确认是否允许再分发；未确认时只固化 manifest、哈希和本地/CI artifact 引用。
- 与 Claude 并行开发时按文件边界分工，不覆盖 `psm_matching` 等正在修改的共享文件。

---

## 一、当前缺口

现有基础可以复用，但还没有形成真正的验收闭环：

1. `test/tool/replay-fixtures.test.ts` 只验证历史参数能否通过 Zod，没有请求 DeepSeek，也没有执行 Harness。
2. `script/real-paper-tool-routing-calibration.ts` 会真实请求 DeepSeek，但明确只捕获一次 tool call，不执行工具。
3. `test/tool/real-paper-data-chain.e2e.ts` 会执行真实 Excel 和后端，却没有证明这些参数来自同一次真实模型选择。
4. Card/Grunfeld golden、真实 Excel 结果和 DeepSeek 路由报告分散存储，无法按“工具 × 数据集 × 设定”给出统一准入结论。
5. linearmodels 数据集并非适合所有方法；PSM 没有 NSW/LaLonde 就不能拿 Card 的 smoke 代替方法学对标。

因此新基座不是再加一批测试文件，而是把现有证据统一成一条可回放证据链。

## 二、验收对象与证据等级

### 2.1 三类数据

| 类型 | 首批内容 | 用途 | 固化方式 |
|---|---|---|---|
| 用户真实论文数据 | `did.xlsx`、`test_datasets.xlsx` | 中文列名、Excel 导入、QA、复合键、FE/稳健性/机制、模型变量理解 | 原始文件或受控 artifact + SHA-256 + 数据契约 |
| linearmodels 7.0 数据 | `card`、`wage_panel`、`munnell`、`jobtraining`、`mroz`、`wage` 等 | OLS、IV、面板模型的标准数据和 wiring 基线 | 用固定版本导出 CSV/Parquet，并记录模块、版本和哈希 |
| 方法专用权威数据 | NSW/LaLonde、Card-Krueger、`mpdta`/`castle`、RD Senate 等 | PSM、DID2S/现代 DID、RDD 的方法学对标 | 权威源发现 → 许可审核 → 变量映射 → 固化文件与 oracle |

### 2.2 数值证据等级

- **A 级：** 同一论文数据、同一估计设定，与论文表格、作者复现代码、Stata/R 权威包冻结输出对齐。
- **B 级：** 同一数据、同一设定，与独立实现对齐，例如 KillStata 的 linearmodels PanelOLS 对 pyfixest/fixest。
- **C 级：** 合成数据恢复已知真值，只证明基本公式和边界，不足以单独准入生产工具。
- **Wiring：** 与自己内部使用的同一库对齐，只证明参数和结果解析没有接错，不称为算法验证。

准入底线：估计器至少一个 A/B 级真实数据 case；方法家族的旗舰工具至少一个 A 级 case；C 级和 wiring 只能补充，不能替代。

## 三、统一 AcceptanceCase 契约

**Create:** `packages/killstata/test/benchmark/acceptance-case.ts`

```ts
export type AcceptanceCase = {
  id: string
  toolId: string
  methodFamily: "ols" | "panel" | "iv" | "did" | "psm" | "rdd" | "diagnostic"
  datasetId: string
  datasetSha256: string
  profile: {
    datasetId: string
    stageId: string
    facts: string[]
    qaStatus: "pass" | "block"
  }
  userPrompt: string
  expectedRoute: {
    decision: "call" | "clarify" | "repair_data" | "reject"
    toolId?: string
    requiredArgs?: Record<string, unknown>
    forbiddenTools: string[]
  }
  fixedExecution?: {
    args: Record<string, unknown>
    timeoutMs: number
  }
  oracle?: {
    level: "A" | "B" | "C" | "wiring"
    engine: string
    engineVersion: string
    resultFile: string
    exactFields: string[]
    numericFields: Array<{ path: string; absTol: number; relTol: number }>
  }
  negativeMutations: Array<{
    id: string
    args: Record<string, unknown>
    expectedErrorCode: string
    mustNotExecute: boolean
  }>
}
```

同一个 case 同时支持两种运行：

- `fixedExecution`：不用模型，固定参数跑生产 Harness，隔离验证执行和数值。
- `expectedRoute`：用 DeepSeek 生成参数，再让同一个 Harness 真执行，验证完整链路。

## 四、数据集注册表与自动发现规则

**Create:**

- `packages/killstata/test/fixtures/econometrics-benchmarks/datasets/manifest.json`
- `packages/killstata/test/benchmark/dataset-registry.ts`
- `packages/killstata/script/sync-econometrics-benchmarks.ts`
- `packages/killstata/test/benchmark/dataset-registry.test.ts`

注册表每条数据必须包含：

```json
{
  "id": "lalonde_nsw_dw",
  "methodFamilies": ["psm"],
  "sourceType": "authoritative_external",
  "sourceUrl": "https://users.nber.org/~rdehejia/data/",
  "citation": "LaLonde (1986); Dehejia and Wahba (1999)",
  "licenseReview": "approved",
  "sha256": "locked-full-hash",
  "rows": 445,
  "columns": ["treat", "age", "educ", "black", "hisp", "married", "nodegree", "re74", "re75", "re78"],
  "capabilities": ["binary_treatment", "pretreatment_covariates", "observed_outcome", "experimental_reference"],
  "forbiddenSubstitutes": ["card1995"]
}
```

`resolveBenchmarkDataset(toolId)` 只能从兼容能力中选：

| 工具/家族 | 首选数据 | 禁止替代 |
|---|---|---|
| `ols_regression` | Card、wage、用户真实 Excel | 无结果变量/无连续解释变量的数据 |
| `panel_fe_regression` | `did.xlsx`、wage_panel、munnell | 非唯一 entity-time 数据 |
| `iv_2sls` | Card 1995、mroz/wage IV 示例 | 没有明确工具变量与排除限制的数据 |
| `did_static` | Card-Krueger 两组两期 | staggered 数据直接冒充 2×2 DID |
| `did2s` | castle/df_hom、审核后的 staggered 用户数据 | 普通 TWFE golden |
| `did_event_study_saturated` | mpdta 或对应权威 event-study fixture | 没有 cohort/never-treated 的面板 |
| PSM 家族 | NSW/LaLonde | Card 1995 |
| RDD 家族 | RD Senate/Lee 类型数据 | 没有 cutoff/running variable 的数据 |

“自动查找”分两步：

1. `sync-econometrics-benchmarks.ts --discover <toolId>` 只生成候选清单和来源信息，不进入测试库。
2. 维护者确认论文、变量含义、许可、估计设定和 SHA-256 后执行 `--approve <candidateId>`，才写入 manifest。

测试和 CI 不允许发现模式，也不允许因首选数据缺失而自动换成别的数据；缺失就失败。

## 五、生产 Harness 证据轨迹

**Create:**

- `packages/killstata/test/benchmark/harness-trace-recorder.ts`
- `packages/killstata/test/benchmark/harness-executor.ts`
- `packages/killstata/test/tool/econometrics-harness-replay.e2e.ts`

**Modify:**

- `packages/killstata/src/session/processor.ts`
- `packages/killstata/src/runtime/hooks.ts`

只新增测试可注入的结构化 observer，不绕过生产逻辑：

```ts
export type ToolExecutionTrace = {
  traceId: string
  sessionId: string
  model: { providerId: string; modelId: string }
  dataset: { datasetId: string; stageId: string; sha256: string }
  exposedToolIdsHash: string
  selectedToolId: string
  rawArgsHash: string
  normalizedArgs: Record<string, unknown>
  schemaAccepted: boolean
  permissionAccepted: boolean
  orchestratorStarted: boolean
  executorStarted: boolean
  exit: { kind: "success" | "validation" | "timeout" | "backend"; code?: string }
  resultHash?: string
  numericSummary?: Record<string, number | null>
  repairAttempt: number
}
```

必须断言：

1. tool call 由 DeepSeek 原生 OpenAI-compatible `tool_calls` 产生。
2. 参数通过该工具当前 JSON Schema，而不是旧 fixture schema。
3. `SessionProcessor.executeTool()`、权限门、ToolOrchestrator 和目标 executor 的 traceId 一致。
4. 目标工具只启动一次；拒绝用例 executor 启动次数为 0。
5. timeout、stderr、错误分类、结果截断和敏感信息过滤仍走现有 Harness。
6. 结构化结果里的 datasetId/stageId/toolId 与 trace 一致，防止串数据集或拿旧结果。

## 六、独立数值 Oracle 与比较器

**Create:**

- `packages/killstata/test/benchmark/numeric-comparator.ts`
- `packages/killstata/test/benchmark/oracle-loader.ts`
- `packages/killstata/script/generate-econometrics-oracles.py`
- `packages/killstata/test/tool/econometrics-numeric-acceptance.e2e.ts`
- `packages/killstata/test/fixtures/econometrics-benchmarks/oracles/*.json`

比较规则：

- `nobs`、匹配数量、实体数、时期数必须完全相等。
- 系数、标准误、置信区间分别配置 `absTol` 和 `relTol`，禁止全局一个模糊容差。
- 先比较估计设定指纹：样本掩码、变量列表、常数、权重、FE、聚类、协方差类型和自由度修正；指纹不同直接判“设定不一致”，不进入数值容差。
- 事件研究比较整个 event-time 向量及每期 SE，不只比较 event=0。
- PSM construction 比较逐行 propensity score、共同支撑边界和组内计数。
- PSM matching/IPW 比较 estimand、有效样本、ATT/ATE、匹配后/加权后 SMD、ESS；未实现有效推断时强制 `stdError=null` 并验证用户输出不声称显著性。
- RDD 比较 cutoff、带宽、核、阶数、有效样本、点估计和 robust bias-corrected SE；设定不同不能只对系数。

oracle 文件包含生成命令、引擎版本、数据哈希和结果哈希。日常测试只读冻结值；更新 oracle 必须显式运行生成脚本并审查 diff，不能在测试中“现算现接受”。

## 七、DeepSeek 真实调用回放

**Create:**

- `packages/killstata/test/tool/econometrics-deepseek-replay.live.e2e.ts`
- `packages/killstata/script/run-econometrics-acceptance.ts`
- `packages/killstata/test/benchmark/routing-scorer.ts`

每个工具至少包含：

- 2 条明确应调用的中文真实需求。
- 1 条变量角色容易混淆的需求。
- 1 条信息不足、应该澄清而不能执行的需求。
- 1 条数据 QA 阻断、应该修复数据的需求。
- 1 条相邻方法干扰项，例如 PSM vs 回归调整、静态 DID vs staggered DID。

评分同时检查：

- 工具 ID 是否精确命中。
- 因变量、处理变量、协变量、工具变量、entity/time/cluster/cohort 等角色是否正确。
- 可选默认参数缺省是否与工具契约一致。
- 是否选择 forbidden tool。
- 是否在 QA block 或识别信息不足时错误执行。
- schema 通过后是否真的执行并得到与 fixedExecution 相同的结果指纹。

稳定性门槛：固定模型 ID、提示词哈希和工具目录哈希；每个 case 连续运行 3 次。允许措辞变化，但工具选择、核心变量角色和安全决策必须 3/3 一致；任何一次 forbidden tool、错误数据集或越过 QA 都阻断准入。

## 八、失败参数与自动修复

**Create:** `packages/killstata/test/tool/econometrics-negative-acceptance.test.ts`

每个工具至少覆盖五类失败：

1. JSON Schema：缺字段、额外字段、错误类型。
2. 数据血缘：错误 datasetId/stageId、未完成画像或 QA。
3. 变量角色：因变量=处理变量、工具变量重复、列不存在、处理后协变量。
4. 方法假设：重复面板键、非二元 treatment、处理逆转、没有共同支撑、RDD 缺 cutoff。
5. 进程边界：超时、Python 非零退出、结果文件缺失、超长 stderr、敏感信息。

每条失败必须验证：稳定错误码、中文可修复提示、executor 是否应启动、无部分产物、修复最多两次、不得换方法或原样重试。不能只断言 `throws`。

## 九、准入报告与 CI 分层

**Create:**

- `packages/killstata/test/benchmark/report.ts`
- `test/econometrics-acceptance/latest.json`
- `test/econometrics-acceptance/README.md`
- `docs/methods/_acceptance-template.md`

每个工具生成一张机器可读和一张人可读准入卡：

```text
tool: panel_fe_regression
dataset: did.xlsx@sha256
route: PASS 3/3
schema: PASS
harness: PASS trace=<id>
numeric: PASS B-level (KillStata PanelOLS vs PyFixest)
nobs: 4709 == 4709
coefficient: ...
std_error: ...
negative_cases: 8/8 rejected correctly
status: ADMITTED
```

CI 分三层：

- PR 必跑：manifest、schema、离线 replay、失败参数、冻结 oracle 比较。
- Python 集成必跑：固定参数生产 Harness + 真实数据 + 数值比较。
- Nightly/发布门禁：真实 DeepSeek 3 次回放；需要 API Key，结果按模型 ID 和提示词哈希归档。

只有六关全部通过才是 `ADMITTED`：数据完整性、路由/角色、Schema、Harness、数值、失败拒绝。缺真实模型凭据时状态是 `PENDING_LIVE_REPLAY`，不能显示为已准入。

## 十、实施顺序

### Task 1：先做一个纵向切片

首个 pilot 选 `panel_fe_regression + did.xlsx`：现有真实数据、数据画像、QA、DeepSeek fixture 和数值结果都齐全，最适合验证基座本身。

- RED：现有路由脚本不会执行 Harness，测试应因 `executorStarted=false` 失败。
- GREEN：同一次 DeepSeek tool call 进入生产 Harness 并完成 FE。
- 数值：KillStata linearmodels PanelOLS 对 PyFixest，同一 4709 样本、city/year FE、city cluster。
- 反例：缺 `entityVar`、重复键、错误 cluster、因变量与解释变量重复、未 QA stage。
- 验收：生成首张完整准入卡，不改变 FE 算法。

### Task 2：固化数据注册表

- 纳入两份用户 Excel 的 hash contract。
- 导出 linearmodels 7.0 的相关数据并记录版本/哈希。
- 完成 NSW/LaLonde 权威来源、许可、变量字典和处理/对照样本版本审核。
- 测试方法不匹配时拒绝替代，例如 PSM 请求 Card 必须失败。

### Task 3：基础回归家族

- `ols_regression`：Card/wage + statsmodels 或论文值。
- `panel_fe_regression`：did.xlsx/wage_panel + PyFixest/fixest。
- `hdfe_regression`：did.xlsx + linearmodels/另一独立实现。
- `iv_2sls`：Card 1995 + 论文/独立 IV 实现，并核对 first-stage 诊断。

### Task 4：DID 家族

- `did_static`：Card-Krueger 两组两期，核对交互项、N、HC1 SE。
- `did2s`：castle/df_hom 与 R did2s 固化输出。
- `did_event_study_saturated`：mpdta 或审核后的多期多批次数据，比较完整动态系数序列。

### Task 5：PSM 家族

- 只使用 NSW/LaLonde 及明确版本，不以 Card smoke 作为方法学 oracle。
- 分别验收 construction、visualize、matching、IPW、回归调整和双重稳健。
- 每种 estimand、匹配规则、权重归一化、caliper、标准误策略必须写入 case；设定不同不比较。
- NSW 当前平衡门槛失败应保留为真实拒绝 case，不能为了跑通降低 SMD 门槛。

### Task 6：RDD 家族

- 使用 RD Senate/Lee 类型权威数据和 rdrobust 冻结输出。
- 先 Sharp RDD，再 Fuzzy RDD；高阶全局多项式不因有数据就自动准入。

### Task 7：全工具发布门禁

- 所有准入工具生成最新报告和 `docs/methods/<tool>.md` 证据链接。
- 执行目标测试、受管 Python 全量测试、typecheck、Python compile、build、diff check。
- 对抗审查重点检查：同库自证、数据错配、样本筛选漂移、协方差不一致、模型越过 QA、失败后偷偷换方法。

## 十一、成功标准

验收基座完成不等于所有计量方法已准入。基座本身完成的标准是：

1. `panel_fe_regression + did.xlsx` 能产生一条从 DeepSeek tool call 到数值 oracle 的完整 trace。
2. 同一 case 的固定参数执行和真实模型执行得到相同结果指纹。
3. PSM 请求无法用 Card 代替 NSW，缺专用数据时明确失败。
4. 任意修改系数、N、SE、数据哈希、变量角色或工具 ID，至少一项测试稳定变红。
5. 报告能明确区分 `ADMITTED`、`PENDING_LIVE_REPLAY`、`BLOCKED_NUMERIC_MISMATCH` 和 `BLOCKED_UNSAFE_ROUTING`。
6. 测试失败时能定位到数据、路由、Schema、Harness、数值或拒绝规则中的具体层，而不是只显示“端到端失败”。

## 十二、最容易出错的地方

- 同一 linearmodels 实现自己对自己，误称算法验证。
- 论文数据相同但样本筛选、协方差或自由度修正不同，强行比较数值。
- DeepSeek 只生成了参数，测试却写成“工具已执行”。
- 测试直接调用 tool.execute，绕过权限、重复调用、超时和清理逻辑。
- 在线下载地址内容变化但文件名不变，没有哈希锁。
- PSM、DID、RDD 复用“看起来像”的数据集，实际上识别设计不匹配。
- 为追求绿灯降低平衡/重叠/唯一键门槛，掩盖真实数据不适用。
- 把模型的中文总结当数值 oracle；数值必须来自结构化结果和独立比较器。

