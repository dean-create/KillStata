# KillStata 问题清单与修复施工文档（refine.md）

> 生成日期：2026-07-12
> 生成方式：三路并行代码探索 + 对每一项发现的逐条人工代码核实
> **核实口径：以下 19 项问题全部对照当前工作副本代码确认——均真实存在、均未修复。**
> 用途：在开发机（另一台电脑）上照此执行。路径基准：`packages/killstata/`（另有仓库根目录项单独标注）。

---

## 已确认的产品决策

| 决策点 | 结论 |
|---|---|
| 模型策略 | DeepSeek 为主 + 保留一个自定义 OpenAI 兼容端点（可接 Qwen/Kimi/GLM），删除其余供应商死代码 |
| 统计引擎 | 面板 FE 从自研 numpy 迁移到 linearmodels PanelOLS，与 OLS/DID/IV/PSM 后端统一 |
| 长期记忆 | 本版本不做，删除空壳；保留已能用的 MEMORY.md 被动加载 |
| 总方向 | 做减法，把「导入 → QA → 预处理 → 回归 → 三线表交付」核心链路做到好用可靠 |

## 六个产品问题的结论（会话记忆/工具/命令/预处理/MCP+Skill/多模型）

| 问题 | 现状核实 | 结论 |
|---|---|---|
| 会话记忆 | 压缩/摘要/失败回退（session/compaction.ts）完整可用，是整个改造最好的部分 | **保留不动** |
| 长期记忆 | `memory/` 目录空壳：只被创建（cli/cmd/config.ts:945）和列出（runtime-config.ts:256），全仓无读写记忆条目的代码 | 删空壳，保留 MEMORY.md 被动加载（instruction.ts:14） |
| 工具调用 | 计量工具群完整；multiedit/ls 是孤儿工具；apply_patch/lsp 是编码遗留 | 保留计量工具 + read/glob/grep/bash/edit/write；删孤儿和编码遗留 |
| 斜杠命令 | 服务端 15 个命令基本都是计量向；仅 /init、/review 是编码遗留（且已 advanced 隐藏） | 只删这 2 个，TUI 原生命令全保留 |
| Skill | 28 个计量向 skill + 别名映射，改造最到位的差异化资产 | **必须保留** |
| MCP | 框架完整；Stata MCP（mcp/stata.ts + python/stata_mcp/）是卖点；git-github MCP 是编码遗留 | 保留框架 + Stata MCP，删 git-github |
| 多模型 | 运行时已硬锁 DeepSeek（provider.ts:1025-1030），却拖着 30 家供应商目录 + 18 个 SDK 依赖 + 2.9MB 快照 | 正式化为 DeepSeek + custom 兼容端点，清走尸体 |

---

## 一、已核实问题清单（19 项）

### A 类：高危 bug（用户直接受害）

#### B1 — CSV 导入无编码回退，GBK 文件一导入就崩
- **位置**：`src/tool/data-import.ts:1143-1144`（内联 Python `read_table()`）
- **核实**：✅ 存在，未修复。`if suffix == ".csv": return pd.read_csv(file_path)` 裸调用；而同函数 DTA 路径（:1168-1183）有 `None→gbk→latin1` 三档回退，`econometrics.ts:1409-1413` 也有回退——唯独主入口没有。国内 GBK/GB2312 编码 CSV 直接 `UnicodeDecodeError`。
- **修复**：新增 Python 函数 `read_csv_with_fallback(path, **kwargs)`，依次尝试 `utf-8-sig → gbk → latin1`，仅在 Unicode/codec 类错误时降级（错误判别照抄 DTA 路径 :1181 的写法）；成功后把实际编码写入 `df.attrs["_source_encoding"]` 并透传进导入报告。

#### B4 — 面板 FE 的 adjusted R² 自由度算错，R² 系统性高估
- **位置**：`src/tool/econometrics.ts:3325`（调用处）、`:3173-3178`（`adjusted_r_squared`）
- **核实**：✅ 存在。design matrix（:3157-3171）只含去均值后的 treatment/covariates/时间哑变量，实体固定效应是靠 within 变换吸收的；但 `k = design_matrix.shape[1]` 没有把被吸收的 N-1 个实体参数计入 → 分母 `n-k` 偏大 → adjusted R² 偏高。且 TS 侧把它标成 "within R²"，名实不符。
- **修复**：随阶段 2 迁移 linearmodels 一并解决，R² 直接取 `res.rsquared_within`。

#### B5 — 非聚类分支 HC1 标准误自由度同样漏算实体 FE，SE 低估、伪显著
- **位置**：`src/tool/econometrics.ts:3258`（`dof = max(len(outcome) - design_matrix.shape[1], 1)`）、`:3132`（`hc1_covariance`）
- **核实**：✅ 存在。聚类分支用 G-1 尚可接受；非聚类分支的 n-k 漏了实体 FE 个数。
- **修复**：同 B4，迁移后由 `fit(cov_type="robust")` 处理。

### B 类：静默失效 / 误导用户

#### B2 — 乱码检测读错字段，防护恒 false
- **位置**：`src/tool/data-import.ts:206-218`（`schemaLooksLikeMojibake`）
- **核实**：✅ 存在。函数读 `parsed.columns[].name/.label`，但 schema 文件实际写入结构是 `{"schema":[{name,dtype,missing_count,missing_share}]}`（写入见 :1219，`build_schema` :1128-1139，条目无 label 字段）→ `parsed.columns` 恒 undefined → 检测恒 false，`shouldReuseImportStage`（:220-222）的乱码防护形同虚设。
- **修复**：改读 `parsed.schema[].name`；补一条构造 mojibake schema JSON 的单测（断言 `{"schema":[{"name":"æµ‹è¯•"}]}` → true，正常中文 → false）。

#### B3 — 同一文件 4 处读 CSV 编码策略不一致
- **位置**：`src/tool/econometrics.ts` —— `:1409-1413` 有 utf-8-sig→gbk 回退；`load_dataframe :1686`、`read_table :2009`、`read_table :3001` 三处裸调 `pd.read_csv`
- **核实**：✅ 存在（三处裸调已逐一确认）。同一份 GBK CSV 崩不崩取决于走哪条代码路径。
- **修复**：四处统一用 B1 的回退实现。建议新建 `src/tool/python-snippets.ts` 导出 `PY_READ_CSV_FALLBACK` 常量，data-import.ts 和 econometrics.ts 拼接进各自内联脚本，杜绝复制漂移。

#### B9 — 数值过滤对字符串 value / 文本列的行为失控
- **位置**：`src/tool/data-import.ts:1257-1264`（`apply_filter` 的 gt/gte/lt/lte 分支）
- **核实**：✅ 存在。`pd.to_numeric(series, errors="coerce") > value`：value 从 JSON 传入未强制数值，字符串时 pandas 抛 TypeError；纯文本列 coerce 全 NaN → 比较全 False → 静默得空集且无告警。
- **修复**：value 强制 `float()`（失败则报参数错误）；列 coerce 后全 NaN 时 `raise ValueError` 指明「该列为文本列」并附 3 个示例原值。

#### B10 — 文本列参与回归时报误导性错误
- **位置**：`src/tool/econometrics.ts:3208-3218`
- **核实**：✅ 存在。对 dependent/treatment/covariates 做 `to_numeric(errors="coerce")` → dropna，若某文本协变量整列变 NaN，整表被清空，抛 "No usable rows remain after dropping missing model variables"，不告诉用户根因是哪列。
- **修复**：dropna 前逐列统计 coercion 新增的 NaN 数；损失 >50% 行的列，在错误/警告中点名并附样例原值（"column X looks non-numeric, sample values: [...]"）。

#### B8 — 临时 Python 脚本在 spawn 失败时泄漏
- **位置**：`src/tool/econometrics.ts:172-174`（`runInlinePython` 的 `proc.on("error")` 分支）
- **核实**：✅ 存在。error 分支直接 reject，不删临时 .py（cleanup 闭包只在 close 分支提供）；对照 `data-import.ts:416-419` 同名函数在 error 分支有 `fs.rmSync`，两份实现不一致。
- **修复**：error 分支 reject 前补 `fs.rmSync(tempScriptPath, { force: true })`。

#### B11 — QA 状态措辞 Python/TS 两套
- **位置**：`python/econometrics/data_preprocess.py:233-237`（返回 `pass/warn/fail`）vs TS gate 用 `pass/warn/block`
- **核实**：✅ 存在（:236-237 `if blocking_errors: status = "fail"` 已确认）。gate 判定靠 blocking_errors 数量，功能不受影响，但用户可能同时看到 fail 与 block 两种措辞。
- **修复**：Python 侧 `"fail"` → `"block"`；TS 消费点（全仓 grep `"fail"` 定位）加一版兼容映射（读到 fail 视为 block），下版本删兼容层。

#### B7 — 政策时点安慰剂检验是半成品
- **位置**：`src/tool/heterogeneity-runner.ts:643-648`
- **核实**：✅ 存在。`placebo.policyTimes` 只触发一条警告 "policyTimes placebo placeholders were provided but are not executed in v1"，参数被接收但从不执行；仅变量安慰剂生效。
- **修复**（做减法）：删除 policyTimes 参数与占位分支，工具描述 `heterogeneity-runner.txt` 同步更新；保留变量安慰剂。不补实现。

### C 类：prompt / 死代码 / 遗留

#### C1 — `<files>` 树注入被 `&& false` 永久禁用
- **位置**：`src/session/system.ts:295`（`project.vcs === "git" && false`）
- **核实**：✅ 存在（疑似临时调试后未清理）。
- **修复**：直接删除整个 `<files>` 块而非修复——文件树对计量 CLI 场景无用且费 token，数据感知已有 `buildDataSummary` 承担。

#### C2 — DeepSeek 无专属 prompt + 误导性常量名
- **位置**：`src/session/system.ts:12`（`import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"`）、`:258-271`（provider 路由，DeepSeek 落通用兜底分支）
- **核实**：✅ 存在。运行时唯一放行的 DeepSeek 用的是 Claude Code 血统的通用 prompt，从未针对性调优——这是"感觉不好用"的隐性原因之一。
- **修复**：新建 `src/session/prompt/deepseek.txt`（以 qwen.txt 为底稿增量改写，见阶段 4）；路由加 `model.providerID === "deepseek" || model.api.id.includes("deepseek")` 分支；常量改名 `PROMPT_GENERIC`。

#### C3 — anthropic spoof header 与 codex instructions 遗留
- **位置**：`src/session/system.ts:249-251`（`header()` 返回 `PROMPT_ANTHROPIC_SPOOF`）、`:254-256`（`instructions()` 返回 `PROMPT_CODEX`）
- **核实**：✅ 存在。
- **修复**：删 spoof 分支与 `anthropic_spoof.txt` import（文件本体在阶段 5 组 D 随死 prompt 一起删）。

#### C4 — 孤儿工具 multiedit / ls
- **位置**：`src/tool/multiedit.ts`、`src/tool/ls.ts`
- **核实**：✅ 存在。用 `Tool.define` 定义但 `registry.ts` 中 grep 无命中（已验证），永不可用；仅 config/permission 有权限名映射残留。
- **修复**：删两个 .ts 及对应 .txt；同步清 `config.ts:176、661-662` 与 `permission/next.ts:240` 的映射。

#### C5 — 长期记忆空壳
- **位置**：`src/killstata/runtime-config.ts:208`（`userMemoryRoot()`）
- **核实**：✅ 存在。全仓引用仅 4 处：定义、runtime-config.ts:256 列出、cli/cmd/config.ts:44 导入、:945 创建目录——无任何读写记忆条目的代码。
- **修复**：删 `userMemoryRoot()` 及其引用；**保留** `instruction.ts:14` 的 MEMORY.md/AGENTS.md/USER.md 被动加载机制（这是当前唯一真实可用的跨会话记忆）。

#### C6 — 供应商死重（18 个 SDK + 2.9MB 快照 + 定时刷新）
- **位置**：`src/provider/provider.ts:19-40`（静态 import 18 个非 DeepSeek SDK，已逐行确认）、`:1025-1030`（`isProviderAllowed` 硬锁 DeepSeek）、`provider/models.ts:127`（每小时 models.dev 刷新定时器）、`provider/models-fallback.snapshot.json`（2.9MB）
- **核实**：✅ 存在。
- **修复**：见阶段 3 手术步骤。

#### C7 — 编码遗留命令/工具/MCP
- **位置**：`/init` `/review`（`command/index.ts:165-183`，已确认 advanced:true）、`apply_patch` + `src/patch`、`mcp/git-github.ts`、lsp 工具入口
- **核实**：✅ 存在。
- **修复**：见阶段 5 减法清单。

#### C8 — 假 npm scripts
- **位置**：根 `package.json`（`random`/`hello`）、`packages/killstata/package.json`（`random`/`clean`/`lint`/`format`/`docs`/`deploy`）
- **核实**：✅ 存在。`lint` 实际跑的是 `bun test --coverage`，`format` 的 `bun run --prettier --write` 语法就是错的，`random` 是一串 echo。
- **修复**：直接删除这些假实现，不保留。

#### C9 — 仓库垃圾入库
- **位置**：仓库根 `temp_data_for_regression.csv`（2.5MB）+ `.summary.json`（含 `D:\SMWPD\...` Windows 绝对路径，系一次 export 调试遗留）、`analysis/` 目录（陈旧样例产物，`panel_fe_regression/coefficient_table.csv` 内含 SE=2.95e-12、t=2.19e11 的退化统计量，与现行代码路径对不上）、`RENAME_COMPLETE.md`/`BRAND_CLEANUP_COMPLETE.md`/`MODE_UPDATE_COMPLETE.md` 等一次性文档
- **核实**：✅ 存在。grep 确认代码零引用 temp_data_for_regression。
- **修复**：删除，并在 `.gitignore` 补 `temp_data_for_regression*` 等模式。

---

## 二、分阶段实施方案

> 每阶段一个分支/PR，独立可回滚。依赖顺序：`阶段0 →（阶段1、阶段2）→ 阶段3 → 阶段4 → 阶段5`（阶段 3 可与 1/2 并行）。减法放最后，让前面建立的测试网兜住删除类回归。
> 每阶段合并门槛三连：`bun run typecheck` + `bun run --cwd packages/killstata test` + `bun run --cwd packages/killstata build` 全绿。

### 环境准备（约 1 人时）
- Bun 1.3.5（`packageManager` 锁定），仓库根 `bun install`
- Python ≥ 3.10：`pandas numpy scipy statsmodels linearmodels openpyxl pyarrow`（依赖清单以 runtime-config.ts 的 required-packages 为准，linearmodels 已声明）
- `DEEPSEEK_API_KEY`；备一个 OpenAI 兼容端点供阶段 3 验证
- ⚠️ econometrics 测试内置 `supportsEconometricsRuntime()` 守卫，Python 环境不全会整体 skip——执行前确认没有被跳过，否则统计测试形同虚设

### 阶段 0：测试基线 + 黄金数据集（6-8 人时）
新增文件：
- `test/fixtures/golden/grunfeld.csv`：statsmodels Grunfeld 数据集导出（10 公司 × 20 年，列 invest/mvalue/kstock/firm/year）。选它因为 Stata `xtreg, fe` 与 linearmodels 文档/Baltagi 教材均有已发表结果可对数
- `test/fixtures/golden/grunfeld_fe_expected.json`：文献参考值 mvalue≈0.110124、kstock≈0.310065、within R²≈0.7668、N=200、entities=10；聚类 SE 在开发机用 `PanelOLS(...).fit(cov_type="clustered", cluster_entity=True)` 生成，生成命令写入 `_provenance` 字段，与文献系数交叉核对后才提交
- 编码 fixtures：`gbk.csv`（GBK+中文列名，二进制入库）、`utf8sig.csv`、`na-markers.csv`（"NA"/"—"/"缺失"/空串）、`thousands.csv`（"1,234.56"/"¥500"）、`dates.csv`、`merged-cells.xlsx`
- `test/tool/panel-fe-golden.test.ts`：仿 econometrics.test.ts 的 withInstance 模式跑 `panel_fe_regression`。**迁移前系数断言应绿**（within 点估计无偏）；SE/R² 断言先 `test.todo` 挂起，旧 numpy 输出留档进 JSON 的 `legacy_numpy` 字段，阶段 2 转正
- golden 测试显式固定 `options.time_effects` 取值，与期望值生成命令保持一致

### 阶段 1：导入层 bug 修复 + 预处理补齐（12-16 人时）
修 **B1/B2/B3/B8/B9/B11**（改法见问题清单），另补预处理（涉及 `data-import.ts`、`econometrics.ts`、`data_preprocess.py`）：
1. **中文缺失值标记**：read_csv/read_excel 加 `na_values=["NA","N/A","n/a","—","－","缺失","无","null","NULL",""]`、`keep_default_na=True`。`"."` 不入全局（防误杀合法文本），在数值 coercion 阶段将「除 `.` 外全为数值」的列按缺失处理并写报告
2. **日期解析**：导入后 post-pass，object 列采样 `pd.to_datetime(errors="coerce")`，成功率 ≥90% 且唯一值 >1 才转 datetime64；schema dtype 同步，报告记录 `parsed_date_columns`
3. **千分位/货币清洗**：object 列采样匹配 `^[¥$€]?[\d,]+(\.\d+)?%?$` 比例 ≥90% → 去符号去逗号 to_numeric；报告记录列名+前后样例
4. **合并单元格**：xlsx 分支用 openpyxl 读 `sheet.merged_cells.ranges`，非空则 warnings 列出区域数与前 5 个坐标。只检测告警，不自动填充
5. **多 sheet 列举**：`read_table` :1153 已有 sheet_names，透传进导入报告 `available_sheets` 字段
6. **逃生门**：所有启发式记入 audit + payload 选项 `options.disable_value_cleaning` 一键关闭

验证：新 fixture 用例全绿；手工 E2E 导入 gbk.csv（列名正确+报告含 source_encoding）、merged-cells.xlsx（告警出现）；用 GBK CSV 直接走一次 `ols_regression` 确认 econometrics 四处读取不再崩。

### 阶段 2：面板 FE 迁移 linearmodels（12-16 人时，修 B4/B5/B10）
1. 重写 `econometrics.ts` 的 `run_panel_fe`（:3180-3370）内联 Python：
   - `model_df.set_index([entity_var, time_var])`；`PanelOLS(dep, exog, entity_effects=True, time_effects=True（对齐现状 time dummies 行为）, drop_absorbed=True, check_rank=True)`
   - cluster → `fit(cov_type="clustered", clusters=model_df[cluster_var])`；否则 `fit(cov_type="robust")`
   - **决策策略原样保留**：重复 entity-time 行 → 自动降级 pooled OLS（改用 statsmodels `sm.OLS`+HC1，不再手写矩阵）；cluster 数 <10 → 切 robust；decision_trace 措辞不变
   - 结果映射：coefficient_table 列名不变（term/coefficient/std_error/t_stat/p_value/ci_lower/ci_upper ← `res.params/std_errors/tstats/pvalues/conf_int()`）；R² 用 `rsquared_within`（overall/between 写入 diagnostics）；`dof=res.df_resid`；`N=res.nobs`；组数取 `res.entity_info`
   - backend `"numpy_fe_cluster"` → `"linearmodels_panelols"`（:2452/:2487/:3303/:3337 四处 + 全仓 grep 确认无消费方残留）
   - **产物结构完全兼容**：results.json/diagnostics.json/coefficient_table/model_metadata/narrative/numeric_snapshot/three_line_table 字段不删不改名；QA gate 与 post-estimation gates 调用位置不动
2. **B10 根因诊断**：dropna（:3212）前逐列统计 coercion 新增 NaN 数，损失 >50% 的列点名报错并附样例值
3. `:2278-2289` 残留 PanelOLS 风格路径并入统一实现或删除——全仓只留一条 panel FE 代码路径
4. 删失效自研函数：`cluster_covariance`/`hc1_covariance`/`design_matrix_with_fixed_effects`/`adjusted_r_squared`（:3090-3178 区域，确认无他处引用后删）
5. `drop_absorbed` 触发时把被吸收变量列表写进 warnings

验证：**黄金测试 SE/R² 断言转正全绿**（系数 1e-4、聚类 SE 1e-4、within R² 1e-3、N、组数）；同样本迁移前后系数一致到 1e-6；全量测试不回归；TUI E2E 导入 grunfeld → 回归 → 三线表对数。

### 阶段 3：provider 手术——DeepSeek + custom OpenAI 兼容端点（10-14 人时）
设计：allowlist 双供应商 = `deepseek`（内置，现状不动）+ `custom`（用户在 killstata.json 的 `provider.custom` 声明 baseURL/models，npm 强制 `@ai-sdk/openai-compatible`）。

按文件步骤：
1. 新增 `src/provider/model-policy.ts`：`CUSTOM_PROVIDER_ID="custom"`、`CUSTOM_API_KEY_ENV="KILLSTATA_CUSTOM_API_KEY"`、`isAllowedProvider(id)` = deepseek || custom、`allowedProvidersMessage()`；`deepseek-policy.ts` 不动
2. `provider.ts`：
   - 删 :19-40 的 18 个非 DeepSeek SDK 静态 import（仅留 `createOpenAICompatible`）；`src/provider/sdk/`（copilot 定制）整体删除
   - BUNDLED_PROVIDERS 只留 `@ai-sdk/openai-compatible`；CUSTOM_LOADERS 非 deepseek 分支全删
   - 删 google 流归一、openai itemId 剥离、gpt-5/copilot 判定等专属逻辑
   - :1025-1030 `isProviderAllowed` 委托 `isAllowedProvider`；github-copilot-enterprise 分支删
   - 两处 config provider 循环放行 custom（env 用 CUSTOM_API_KEY_ENV、baseURL 必填缺失则 warn 忽略）
   - `enforceDeepSeekOnlyProviders` → `enforceAllowedProviders`（custom 仅在配置了 baseURL+key 时保留）
   - `getModel`：custom 直接查 provider.models（含 `/v1/models` 自动发现，`discoverProviderModels` :1214-1233 现成可复用），未命中抛 ModelNotFoundError；默认模型仍 `deepseek/deepseek-v4-flash`
   - 删动态 npm 安装路径（:1375-1391）
3. `models.ts`：删 models.dev fetch、:127 定时器、快照加载；`ModelsDev.get()` 返回 `{}`；**保留 Model/Provider zod schema**（config.ts:880 依赖）；删 `models-macro.ts`/`models-fallback.ts`/`models-fallback.snapshot.json`（2.9MB）；同步清 `cli/cmd/auth.ts:114`、`cli/cmd/models.ts:30` 的 refresh 消费点
4. `provider-catalog.ts` 裁成 deepseek+custom；`auth.ts` `api()` 放行 custom；`server.ts:439-440` 改用 isAllowedProvider；`transform.ts` 删各家专属分支（逐分支 grep providerID 后删，单独 commit，删一批跑一次 typecheck）
5. `package.json` 删 `@ai-sdk/{amazon-bedrock,anthropic,azure,google,google-vertex,openai,xai,mistral,groq,deepinfra,cerebras,cohere,gateway,togetherai,perplexity,vercel}`、`@openrouter/ai-sdk-provider`、`@gitlab/gitlab-ai-provider`；`bun install` 更新 lock（单独 commit）
6. 新增 `test/provider/model-policy.test.ts`（custom 放行、未配置隐藏、未知模型报错、DeepSeek 默认不变）

用户配置样例（写入 README）：
```json
{
  "provider": {
    "custom": {
      "name": "Qwen (DashScope)",
      "options": { "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1" },
      "models": { "qwen3-max": {} }
    }
  },
  "model": "custom/qwen3-max"
}
```

验证：三连 + E2E-1（DeepSeek 默认对话+工具调用不回归）+ E2E-2（custom 配置后 TUI 出现并可切换，完成一次 data_import）+ E2E-3（/connect 保存 custom key，auth.json 权限 600，重启生效）。

### 阶段 4：DeepSeek prompt 调优 + system.ts 清理（4-6 人时）
1. 新建 `src/session/prompt/deepseek.txt`：以 qwen.txt 为底稿**增量改写**（首版刻意高相似度，降低行为回归风险）。要点：工具调用严格 JSON 参数、不虚构文件路径/列名、先 healthcheck/import 再分析、引用 results.json 数字禁止心算改写、中文用户默认中文回复
2. `system.ts:258-271` 路由加 deepseek 分支；custom 端点落原通用分支；gpt-/gemini-/claude 分支保留（custom 可能接兼容代理，保留成本为零）
3. :12 常量 `PROMPT_ANTHROPIC_WITHOUT_TODO` → `PROMPT_GENERIC`（仍指向 qwen.txt）
4. 删 :249-251 anthropic spoof 分支与 :15 的 anthropic_spoof.txt import（C3）
5. 删 :295 `<files>` 死代码块（C1）
6. prompt 文件与路由改动**分开 commit**，便于单独 revert

验证：`test/session/system.test.ts` 按需更新断言；dump 会话 system prompt 确认 deepseek.txt 生效、无 spoof、无空 `<files>` 块；同一数据集跑「导入→QA→smart_baseline→三线表」10 轮冒烟，工具调用失败率不高于旧 prompt。

### 阶段 5：全局减法（8-12 人时，每组一个 commit，删一组跑一次三连）
删除纪律：**先删注册点/引用，再删目录本体**。

- **组 A 仓库垃圾**：`temp_data_for_regression.csv` + `.summary.json`、`analysis/` 整目录、`RENAME_COMPLETE.md`/`BRAND_CLEANUP_COMPLETE.md`/`MODE_UPDATE_COMPLETE.md`（同类一次性文档核对后一并删）、假 scripts（C8）、`.gitignore` 补模式
- **组 B 基建死代码**：`infra/` + `sst.config.ts` + `sst-env.d.ts` + 根 devDeps 的 `sst`（handler 指向不存在的 packages/function、packages/console，纯死代码）；`github/`（独立 CI Action）；`sdks/vscode`
- **组 C src 死模块**（import 关系均已 grep 验证）：
  - `src/ide`（零外部引用）+ 依赖 `bonjour-service`
  - `src/acp` + `cli/cmd/acp.ts` + `main.ts:24/85` 注册 + 依赖 `@agentclientprotocol/sdk`
  - `src/pty` + `server/routes/pty.ts` + `server.ts:26` 注册 + 依赖 `bun-pty`
  - `src/worktree` + `server/routes/experimental.ts:5` 引用
  - `src/patch` + `tool/apply_patch.ts/.txt` + `registry.ts:126` 注册 + **:182-185 GPT 系分发 apply_patch 的分支**
  - `mcp/git-github.ts` + `src/git-github-mcp-server.ts` 入口 + `cli/cmd/mcp.ts:473/495/654`、`config.ts:635` 接线
  - `/init` `/review`：`command/index.ts:165-183`
  - 记忆空壳（C5）、孤儿工具（C4）、B7 的 policyTimes
  - `cli/cmd/github.ts`、`cli/cmd/pr.ts` + 依赖 `@actions/core`、`@actions/github`、`@octokit/*`（根 devDeps 的 `@actions/artifact` 先 grep `script/` 确认无用再删）
- **组 D 死 prompt 文件**：`anthropic_spoof.txt`、`copilot-gpt-5.txt` 等——先 `grep -rn "prompt/<名>"` 确认零 import 再删
- **明确不动**：`src/question`（计量工具交互核心）、`src/snapshot`（撤销机制）、`packages/sdk`（TUI↔server API client，28 处 import）、`packages/plugin`（类型契约）、session/compaction、Skill 体系（28 个计量 skill + alias）、MCP 框架 + `mcp/stata.ts` + `python/stata_mcp/`、TUI、计量斜杠命令、**src/lsp**

grep 验收：`grep -rn "acp\|worktree\|apply_patch\|bun-pty\|bonjour\|git-github" packages/killstata/src` 无残留。

### src/lsp：本轮明确不动
LspTool 已被 `KILLSTATA_EXPERIMENTAL_LSP_TOOL` flag 关闭，不影响核心链路；但 LSP 命名空间被 edit/read/write/session/prompt/config/bootstrap 约 7 个高频文件静态 import（2902 行本体）。解耦是纯重构：无用户可见收益，回归面却覆盖所有文件操作工具。v2 单独开 PR，先把 src/lsp 收敛为 no-op stub 再删实现。

---

## 三、总验收清单

1. 导入 gbk.csv → 中文列名正确、报告含 `source_encoding: "gbk"`
2. 导入 merged-cells.xlsx → 合并单元格告警出现
3. grunfeld.csv → panel_fe_regression → 三线表与黄金 JSON 对数（系数 1e-4、聚类 SE 1e-4、within R² 1e-3、N、组数）
4. DeepSeek 默认对话 + 工具调用成功；custom 端点可切换并完成一次 data_import
5. 全仓 grep 验收无死模块残留；`bun run build` 通过
6. 完整核心链路 E2E：导入 → QA → 预处理 → 回归 → 三线表 + `/doctor` `/tools` `/skills` 命令正常

**工作量合计：53-73 人时（单人约 7-9 个工作日）**

## 四、明确不做（本版本）

多级表头解析、长期记忆功能、多供应商恢复、src/lsp 解耦、policyTimes 安慰剂实现（删参数而非补实现）。
