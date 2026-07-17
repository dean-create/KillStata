# KillStata 真实计量验收基座（独立检查目录）

这里的代码只读取主项目与真实数据，不修改 `packages/killstata/src`、工具注册表或 Harness 实现。

当前已经落地的首个纵向 pilot：

```text
did.xlsx 哈希/面板事实
→ import + profile + QA
→ SessionProcessor + ToolOrchestrator + panel_fe_regression
→ 冻结 PanelOLS 数值（N/系数/SE）
→ PyFixest 跨实现（N/系数）
→ 失败参数拒绝
```

## 运行

从项目根目录运行：

```bash
cd packages/killstata
KILLSTATA_PYTHON=/Users/cw/.killstata/venv/bin/python bun test ../../check/*.test.ts
cd ../..
KILLSTATA_PYTHON=/Users/cw/.killstata/venv/bin/python bun check/run.ts
```

第二条会生成 `check/results/latest.json`。默认不会消耗模型额度，报告会写 `PENDING_LIVE_REPLAY`。

真实 DeepSeek 回放：

```bash
KILLSTATA_PYTHON=/Users/cw/.killstata/venv/bin/python bun check/run.ts --live
```

`--live` 会使用现有 DeepSeek 凭据，要求模型从当前实际工具目录选择 `panel_fe_regression`，核对核心变量角色和 JSON Schema，再将模型生成的核心参数送入同一个 Harness pilot。若模型选错工具、参数错误或没有凭据，报告不会标绿。

## 当前证据边界

- `did.xlsx` 的 N、系数、SE 与冻结 PanelOLS 结果逐字段比对，属于 wiring 回归。
- 同一设定的 PyFixest 对照确认 N 与系数；目前其 cluster 小样本修正与 PanelOLS 不完全相同，标准误差异会被报告，不会伪装成独立 SE 对标通过。
- `panel_fe_oracle.py` 直接读取锁定的 `did.xlsx` 并按生产工具同一 PanelOLS/实体聚类合同复算 N、系数和标准误；该三项是当前 FE 的数值准入 oracle。
- PSM/RDD/DID2S 的 NSW、RD Senate、mpdta 等数据集已经在 `fixtures/benchmark-catalog.json` 锁定方法—数据映射；后续新增工具必须先补对应真实数据与 oracle，Card 不可替代 NSW。

## NSW PSM 补证结果

`run.ts` 现会在固定 FE pilot 后回放 NSW 的四个已暴露 PSM 工具：

- `psm_construction`：B 级。真实 DTA 的 Logit 得分与独立 SciPy 优化、共同支撑摘要对齐。
- `psm_visualize`：B 级。同一独立数值摘要对齐，并验证诊断图确为 PNG。
- `psm_ipw`：B 级。独立 SciPy Logit + Hájek 权重、ESS、加权 SMD 与工具结构化结果对齐。
- `psm_matching`：S 级安全拒绝。原始 NSW 的固定 1:1 匹配后最大绝对 SMD 为 `0.1849`，超过硬门 `0.10`，没有产生 ATT 结论。

NSW 的 `data_id` 是所有行相同的样本标签，验收脚本会在 `check/data/nsw_dw_analysis.csv` 生成确定性的
`unit_id`；它只为验证“一行一个分析单位”合同，不改原始 DTA 或主项目。

Card (1995) 的 `check/data/card1995.csv` 由 `linearmodels.datasets.card@7.0` 直接生成并锁定哈希。`ols_regression` 与 `iv_2sls` 都已通过真实 Harness 回放，并分别对齐 statsmodels HC1 与 linearmodels IV2SLS robust 的 N、教育系数和标准误。
