# 真实计量工具验收：现有工具补证计划

范围：本计划及所有实现只位于 `check/`；只读调用主项目代码，不改动生产工具、注册表或 Harness。

## 已完成

1. **Task 1：`panel_fe_regression + did.xlsx` pilot**
   - 锁定 `did.xlsx` 的哈希、工作表和面板事实。
   - 真实执行 `import → profile → QA → SessionProcessor → panel_fe_regression`。
   - 记录 Harness 生命周期，冻结 PanelOLS 的样本量、系数和标准误，并以 PyFixest 独立复算系数与样本量。
2. **Task 2：数据注册表**
   - 以方法而非方便程度锁定数据：PSM 只能使用 Dehejia-Wahba NSW，Card 不能替代。
   - 锁定 linearmodels 版本与可用数据集，锁定两个用户 Excel 的哈希与结构事实。

## 当前批次：倒推已准入工具的 A/B 证据

### Task 3：通用 Harness 回放证据（先做）

为任何现有工具收集同一份不可伪造的运行记录：

1. schema 是否接受模型参数；
2. `SessionProcessor.executeTool` 是否真正调用执行器一次；
3. Bus 生命周期是否包含 `queued → running → completed`；
4. 返回结果是否为受限的结构化数据而非原始日志；
5. 失败时是否有分类结果且不发布半成品。

验证：对现有 FE pilot 和 NSW PSM 工具使用同一执行器；单测拒绝缺生命周期、重复执行和未结构化结果。

**状态：已完成。** `src/harness.ts` 将真实 `SessionProcessor.executeTool` 的 queued/running/completed
事件、一次执行和结构化结果固化为同一合同；Panel FE 与 NSW PSM 均通过该路径。

### Task 4：证据等级注册表（先做）

建立机器可读的工具—数据—oracle 关系，不把“能跑”误标为“数值正确”。

- `A`：同一权威数据、同一设定、与论文/作者实现/权威结果逐字段数值对齐。
- `B`：同一锁定数据、与独立实现逐字段或诊断指标对齐。
- `W`：真实数据全链路 Harness 回放，只证明接线与安全门。
- `S`：真实数据上预期失败且安全拒绝，证明不会输出不可信结论。
- `PENDING`：尚未有足够独立 oracle，不能宣称准入等级。

验证：等级汇总必须拒绝“只有 W 却标 A/B”、PSM 使用 Card、或安全失败被写成通过。

**状态：已完成。** `src/evidence.ts` 会强制方法—数据映射与等级先决条件；不能将 Card 写成
PSM 证据，也不能把安全拒绝标绿。

### Task 5（前半）：NSW 的四个 PSM 现有工具

对 `construction`、`visualize`、`matching`、`IPW` 均走：真实 NSW DTA 导入 → 数据画像/QA → 模型可见 JSON Schema → Harness → 结构化结果/安全失败。

1. `psm_construction`
   - 用独立 Python `statsmodels` 重算同一 Logit 的倾向得分范围、均值和共同支撑；比较 score vector 摘要。
   - 目标：至少 B（独立数值诊断）+ W（Harness）。
2. `psm_visualize`
   - 重算共同 bin 的组内归一化直方图、样本数、共同支撑；验证生成 PNG 仅为诊断产物。
   - 目标：至少 B + W。
3. `psm_matching`
   - 用 NSW 的 `re78`、`treat` 与处理前变量运行固定 1:1 ATT。
   - 若 post-match SMD 不达标，必须记录为 `S`（真实数据安全拒绝），不得放宽阈值或伪造 ATT。
   - 只有在独立匹配实现且平衡达标时，才允许 B/A。
4. `psm_ipw`
   - 同样用 NSW 运行固定 Hájek ATE；独立重算权重、ESS、加权 SMD。
   - 若 overlap/ESS/balance 失败，记录为 `S`；成功时才补 B。

验证：每个 case 必须覆盖固定参数、错误参数拒绝、模型工具回放（模型回放可在凭据存在时运行），并将结论写入 `check/results/latest.json`。

**状态：本批已完成。** NSW 原始 `data_id` 实为样本标签，因此仅在 `check/data` 生成可追溯的
`unit_id` 派生副本；原始 DTA 和生产代码不修改。当前结果：construction=B、visualize=B、
IPW=B；matching=S（真实 NSW 上匹配后最大绝对 SMD=0.1849，超过 0.10，因此被正确拒绝）。

## 扩展门槛

在 PSM 四工具和现有 FE/OLS/IV/DID 工具的证据矩阵补齐前，**不新增** `psm_regression`、`psm_double_robust` 或 RDD 家族。每个新增方法须先有专用真实数据、独立 oracle、失败门和模型回放，才可进入生产准入候选。

## 当前执行：FE 标准误与 Card 基础回归补证

### Task 6：`panel_fe_regression` 的完整数值 oracle

**文件与边界：**

- 新建 `check/scripts/panel_fe_oracle.py`：只读 `did.xlsx`，用 `linearmodels.PanelOLS` 按生产工具同一公式、同一实体聚类规则独立计算 N、`did` 系数和标准误。
- 新建 `check/src/panel-fe-oracle.ts`：执行上述脚本、解析固定 JSON，拒绝缺字段或非有限值。
- 修改 `check/src/pilot.ts`：将 Harness 结果与 oracle 三字段逐项比较；不再把 PyFixest 的标准误差异当作通过或失败依据。
- 修改 `check/pilot.test.ts`：要求 `independentOracle` 对 N、系数、SE 都无差异。

**接口：** `runPanelFeOracle(): Promise<{ rowsUsed: number; coefficient: number; stdError: number }>`。

**验证步骤：**

1. 先在 `pilot.test.ts` 断言尚不存在的 `independentOracle.failures === []`，运行测试并确认因缺字段失败。
2. 实现独立 oracle；运行目标测试，预期通过 N、系数、SE 三项。
3. 运行全部 `check/*.test.ts`，再运行 `bun check/run.ts` 写入报告。

### Task 7：Card 的 OLS/IV 基础工具（仅在 Task 6 绿后）

锁定 Card 数据的一套明确模型，分别用 `linearmodels` 的 OLS/IV2SLS oracle 对齐 N、系数、SE，并对错误工具变量/错误角色做 Schema 与执行拒绝测试。完成后才进入 `did_static → did2s → event study`。

**状态：Task 6 已完成。** `panel_fe_oracle.py` 从锁定工作簿直接重算同一双向固定效应和 city 聚类，Harness 的 N、`did` 系数、标准误均通过逐字段对比。

**状态：Task 7 已完成。** 从 `linearmodels.datasets.card@7.0` 固化 Card CSV 与哈希，OLS（statsmodels HC1）和 IV-2SLS（linearmodels robust）均经真实 Harness 执行并在 N、教育回报系数、标准误上对齐；`educ` 不能同时作为内生变量和工具变量的 Schema 拒绝也已覆盖。
