# 当前进度

## 17 个计量函数逐项准入（Codex，2026-07-16）

### 第 1/17 项已完成：`psm_construction`

- 新增模型可见的严格诊断工具，只接受 canonical `datasetId/stageId`、0/1 处理变量和处理前协变量；未恢复万能 `methodName/options/dataPath`。
- Python Logit 已阻断缺失、非数值、非有限、缺组、常数列、样本不足、秩亏、奇异、完全分离、未收敛和边界得分。
- 逐行得分以原子 CSV 产物保存；模型输出无文件名、绝对路径、回归系数、p 值或因果显著性措辞。
- TS 在发布前验证概率摘要、样本量、产物路径边界、文件存在性和表头；PSM 禁止调用方指定输出目录，失败删除 Harness 自有完整运行目录。
- legacy replay 与独立入口共用诊断语义，`groundingScope=diagnostic`，workflow 记录为 `describe_or_diagnostics`。
- SciPy 独立优化逐行核对 80 个得分，并独立手算共同支撑区间与占比；尚未使用 R/Stata golden。
- 最终验证：聚焦 20/20；全量 265/265、966 个断言；typecheck、Python py_compile、Linux/macOS/Windows build、diff check 全部通过。
- 两轮独立审查已清零：Critical 0、Important 0。第 2 项 `psm_visualize` 仍隐藏，尚未开始。

---

## DeepSeek Harness 加固（Codex，2026-07-16）

### 已完成

- 协议层 RED→GREEN：删除 DSML 文本解析/手工执行和 LiteLLM/Anthropic `_noop` 兼容；只允许 AI SDK 的 OpenAI 原生 `tool-call` 事件进入执行门。
- DeepSeek 继续通过 `@ai-sdk/openai-compatible` 使用固定 Base URL 和模型 ID；用户配置的 `custom` 仍只允许同一 OpenAI-compatible transport，不恢复其他厂商协议。
- 模型侧 MCP sidecar 已关闭；7 个生产估计器与 1 个推荐工具仍按 workflow/QA 阶段显式暴露。
- 所有工具结果正文与 metadata 在会话持久化前统一脱敏、有界化、去噪、折叠；超长结果改用 `tool-output:` 安全引用分页读取，不向模型暴露本机绝对路径。
- 工具失败统一分类并进入最多 2 次自动修复；修复期间锁定原计量方法，拒绝原样失败参数、跨方法切换和 workflow 变更；未知工具共享预算但不锁伪方法。
- 全局日志、反思、失败证据、超长输出和 Python 临时脚本均首次创建为 0600；失败证据使用独立 0700 UUID 目录，reflection 使用 UUID+`wx` 防并发覆盖。
- 已通知 ClaudeCode：改动位于共享工作树，可直接看到协议、Harness、结果策略与测试文件；未提交、未暂存。

### 受管进程验证

- 新增统一 `managed-process`：模型不能提供 command/cwd/timeout；内部 command 与 cwd allowlist 在 spawn 前校验。
- Python 子进程只继承运行必需环境，`DEEPSEEK_API_KEY` 等模型凭据不再下传。
- data import/PyFixest 默认 5 分钟、legacy econometrics 默认 10 分钟；超时执行 SIGTERM→SIGKILL，AbortSignal 可取消。
- killTree 失败或永久不返回时，250ms watchdog 仍会强制 settle，避免 Windows/异常进程让 Harness 无限等待。
- stdout/stderr 分开捕获并仅保留有限尾部；PyFixest 额外要求 exit code 为 0、结果文件真实存在。
- 验证：独立聚焦对抗回归 111/111；`KILLSTATA_PYTHON="$HOME/.killstata/venv/bin/python" bun test` 为 254/254、881 个断言；类型检查、Python 编译、全平台构建与 diff 检查全部通过；独立终审 Critical 0、Important 0。

---

## 传统 DID 真实数据验收（Codex，2026-07-16）

### 已完成

- 完整读取并渲染核对 `/Users/cw/Desktop/data/传统DID案例操作及代码.docx` 的 7 页内容。
- 使用只读 spreadsheet runtime 检查 `/Users/cw/Desktop/data/传统DID操作演示数据.xlsx`：`Sheet1!A1:H821`，820 行数据、8 列。
- 确认 `fte` 缺失 19 行，四个组期有效样本为 78、77、326、320，手工 DID 为 2.9139823574，与文档的 2.914 一致。
- 发现 `id=407` 在处理组与对照组各有一套前后观测，导致两组重复 `id × t`，不能直接作为面板唯一键。
- 已写测试流程：`docs/superpowers/plans/2026-07-16-traditional-did-e2e-test.md`。
- 首轮真实回放定位到能力缺口：导入正确，QA 返回正确；模型把重复横截面误当严格面板，是因为生产目录缺少传统 2×2 DID 工具。
- 已用 TDD 新增 `did_static` 强类型工具、PyFixest 后端、workflow/用户视图/提示词/实验日志接入；模型不再为传统 DID 传 `entityVar/timeVar`。
- 直接后端与真实 KillStata 端到端结果一致：控制 `bk/kfc/roys` 后 DID=2.9350196887，SE=1.5434221385，p=0.0575811010，95% CI=[-0.0946503886, 5.9646897660]，N=801。
- 模型最终中文解释正确：5% 水平不显著、10% 水平边际显著；两期数据无法仅凭本样本检验政策前平行趋势。
- 最终验证：目标 60/60、全量 217/217（726 次断言）、typecheck、Python py_compile、跨平台 build、diff check 全部通过；只读终审 Critical/Important 为 0。
- 测试证据：`test/did-e2e-20260716/VERIFICATION.md`。后续把 verifier 延迟和详情中的内部技术碎片作为独立 UX 任务处理。

## 并行任务：旧计量入口强类型化（Codex，2026-07-15）

### 已完成

- 先用真实 `ToolRegistry.tools()` 写 RED 测试，确认模型原先只看到万能 `econometrics`，看不到独立基础方法。
- 新增四个模型可见工具：`econometrics_recommend`、`ols_regression`、`panel_fe_regression`、`iv_2sls`。
- 每个工具使用严格 Zod 参数；拒绝双数据源、任意 `methodName/options`、重复变量角色；IV 必须显式给出工具变量和识别依据。
- 旧 `econometrics` 仍保留作内部兼容执行器，但已从分析意图的模型直连白名单移除。
- 四个独立工具已接入 workflow stage 分类、成功/失败 hook 和历史 rerun；推荐工具记录为数据画像阶段，三个估计器记录为 `baseline_estimate`。
- 自动推荐不再根据 `z`、`iv` 等列名切换到 2SLS；列名只产生“需由用户或研究设计确认”的候选警告。
- 面板 FE 会基于最终估计样本检查重复个体-时间键；发现重复即阻断，不再静默降级到 pooled OLS。
- 少于 10 个聚类时保留聚类标准误并明确告警，不再悄悄切换 HC1；少于 2 个聚类直接阻断。
- 系统提示和 DeepSeek 专属提示已切到“独立工具 ID + 严格参数”协议；删除万能入口、`smart_baseline` 自动救援和按方法族随意替代的宣传。
- 旧 `econometrics.txt` 已收缩为仅供历史回放的内部兼容说明，不再向模型宣传高风险方法和交付包。
- 独立计量工具现已进入 TurnAssembler 的“最终分析结果”集合；模型若漏发总结，前端仍会生成可信结果摘要，不会执行完后空白或截断。
- 独立估计器失败会回到 `estimate` 阶段，推荐工具失败会回到 `profile` 阶段，不再错误落到通用 `verify`。
- Card (1995) IV/OLS 与 Grunfeld 双向固定效应 golden 已改为直接走模型实际调用的独立工具，而不是测试内部万能入口。
- 默认分析/导入/修复工具包已移除 `bash`、`shell`、`edit`、`write`、`lsp`、`batch`、`plan_*` 和不存在的 `data_batch`；这些 coding/鬼影工具不再进入模型直连策略。
- 对抗性审查发现前端会按独立工具 ID 固定顺序选结果，导致“先 OLS、后 FE”仍展示旧 OLS；现已改为同类估计器按实际完成顺序选择最新结果。
- 所有模型可见估计器现在只接受 canonical `datasetId + stageId`；同一 stage 未完成画像与 QA 时，OLS/FE/IV/PyFixest 都会在后端入口拒绝。
- workflow run 已按 dataset/run 隔离；新增回归用例确认两个数据集即使都有 `stage_000`，也不能复用彼此的画像与 QA。
- IV 协方差契约已收口为后端真实支持的 `robust/nonrobust`，Card (1995) robust 标准误与 `linearmodels` 固化值一致。
- OLS 已在估计前阻断精确秩亏；近似共线性测试使用 condition number 小于 30、VIF 大于 10 的独立样本，确认告警确实来自 VIF，而不是被其他诊断擦边带绿。
- DSML fallback 失败已进入统一 hook/reflection/repair 生命周期；重复工具调用保护现会检查最近会话消息，能识别跨 assistant turn 的三次相同调用。原生工具门禁已前移到 `SessionProcessor.executeTool()`，拒绝时不会进入 hook、orchestrator 或实际 executor。

### 当前验证

- RED：`bun test test/runtime/econometrics-tool-exposure.test.ts`，0 通过、3 失败，失败原因均为独立工具尚未暴露。
- GREEN：同一命令 3 通过、0 失败、11 个断言。
- workflow RED→GREEN：新增 stage 行为后由 3 通过/1 失败转为 4 通过/0 失败、14 个断言。
- `bun test test/tool/econometrics-smart.test.ts`：4 通过、0 失败、9 个断言。
- 强制真实 Python 运行面板重复键测试：1 通过、0 失败；已确认返回阻断错误而非替代估计结果。
- `bun test test/session/system.test.ts`：7 通过、0 失败、24 个断言。
- lifecycle RED：新测试因缺少独立工具结果识别导出而失败；GREEN：`econometrics-tool-lifecycle.test.ts` 3 通过、0 失败、11 个断言。
- 强制真实 Python：独立 `iv_2sls`、`ols_regression`、`panel_fe_regression` 的三项 published/golden 测试全部通过；OLS 默认确认使用 HC1，FE 默认确认聚类推断。
- coding 工具暴露 RED→GREEN：目标测试由 `edit` 仍在 known catalog 失败，转为 1 通过、0 失败、11 个断言。
- 最新估计结果 RED→GREEN：测试先复现 FE 完成后仍选中 OLS，再确认改为展示 FE 的最新系数。
- canonical 隔离 RED→GREEN：先复现 dataset A 的 `stage_000` QA 错误放行 dataset B，再确认 B 在自身未完成画像/QA 时被阻断。
- 跨轮 doom-loop RED→GREEN：先复现前三次相同调用分散在旧 assistant message 时保护不触发，再确认第四次调用进入审批保护；权限拒绝用例同时断言实际 executor 调用次数为 0。
- VIF 对抗样本：condition number 约 10.19、最大 VIF 约 26.43；诊断 JSON 和用户 warning 都命中 VIF 门槛。
- 受管真实 Python 全量 `bun test`：197 通过、0 失败、633 个断言，覆盖 43 个测试文件。
- `bun run typecheck`、`bun run build`、`git diff --check`：全部通过。

### 下一步

1. 基础工具调用阶段已完成；下一阶段按方法准入标准继续补强静态 DID、PS 系列与 Sharp RDD，不直接恢复旧万能入口。
2. 对 coding-only 残留按低风险和独立批次分组，不与 ClaudeCode 的解耦改动碰撞。

---

## 当前任务：PyFixest 独立计量工具（2026-07-15）

### 已完成

- 已在 `PLAN.md` 固定首批三个独立工具边界：`hdfe_regression`、`did2s`、`did_event_study_saturated`。
- 已先写 RED 测试，确认项目原先既没有 PyFixest 固定依赖，也没有三个工具的 workflow 策略入口。
- 已把 `pyfixest==0.60.0` 加入受管 Python 环境，并让 uv 自动安装、手工修复命令和旧 pip 安装路径共用同一安装规格映射。
- 已将三个工具 ID 纳入分析工具目录和文件系统副作用策略；旧 `econometrics` 暂时保留兼容。
- 已实现共享 PyFixest Python 适配器：安全列名别名、CSV/Excel/Stata/Parquet 读取、统一系数 JSON/CSV、中文失败消息。
- `hdfe_regression` 已支持 HC1、CRV1、CRV3 和最多二维聚类；少于 30 个簇时返回中文推断警告。
- `did2s` 已校验二元处理、参考期、面板键唯一和处理状态单调性；控制变量仅由后端拼接，不接收模型公式。
- `did2s` 进一步校验相对时期必须与每个个体的实际首次处理时点一致；从未处理组使用 `-inf`，错位事件期直接阻断。
- `did_event_study_saturated` 已校验 cohort=0 的从未处理组、至少两个处理批次、真实处理时期及同一个体 cohort 恒定；结果经 `fit.aggregate()` 聚合为事件期序列。因 PyFixest 0.60.0 当前会忽略 `xfml`，该工具不暴露控制变量参数，并明确提示 beta 状态。
- 已把三个工具注册到模型工具目录、workflow stage/replay 和 TUI/导出净化层；模型可见、用户侧隐藏内部参数与 traceback。
- 已将运行时准备失败改为纯中文短提示，不再显示英文技术错误。
- 运行时不仅固定安装规格，还会核验实际 `pyfixest.__version__ === 0.60.0`；版本不符会重新安装或在显式 Python 环境中拒绝估计。
- TypeScript/Python 边界新增严格结果 schema：方法、后端、版本、样本量、非空系数、核心估计、统计量和输出路径任一异常都会失败，不再把残缺 JSON 标记为完成。
- transcript 无论是否开启详情，都不会导出分析 reasoning、内部工具 ID、原始参数或 traceback；失败只保留中文提示。
- 安全列名恢复改为单次 alias 映射与函数式 replacement，已覆盖原名 `v_0`、反斜杠、中文和空格混合列名。
- DID2S 与 saturated 的用户摘要均包含事件期 0 的估计、标准误、p 值和 95% 置信区间，完整动态序列保存在结果产物中。

### 最终验证

- 真实数值路径使用 `pyfixest==0.60.0`：HDFE 核心系数约 2.0，DID2S 与 saturated 事件期 0 约 1.5；DID 处理逆转、相对时期错位、缺少从未处理组和个体 cohort 变化均在估计前失败。
- 对抗性审查先给出 Not Ready 并定位 7 个 Important，修复后又用 CI=null 对抗输入找到最后一个边界；全部补齐后最终复审为 Ready，剩余 Critical/Important 为 0。
- `bun run typecheck`：通过。
- `bun test`：187 通过、0 失败、531 个断言，覆盖 41 个测试文件。
- `bun run build --skip-install`：Linux、macOS、Windows 全目标通过；9 个二进制均确认嵌入 PyFixest runner。
- `git diff --check`、冲突标记扫描、Python `py_compile`：全部通过。

### 下一步

1. 继续按“一个方法一个强类型工具”扩展，但下一批先做方法优先级评审，不回到万能 `methodName/options` 入口。
2. 为 HDFE 二维 CRV1/CRV3 与更复杂的 staggered DID 增加独立 R/Stata 固化 golden；当前首批工具不扩大宣传边界。

---

## 当前任务：计量基础可靠性审计（2026-07-15）

### 状态

- 方法清单、上游复制关系、数值公式、模型调用契约和测试逃逸路径已完成只读审计。
- 已把整改路线写入 `PLAN.md`；估计器源代码尚未修改，等待从“生产白名单与硬阻断”开始实施。
- 当前结论：不能把 21 个工具入口整体视为生产可靠。OLS、常规面板 FE、当前 IV2SLS 是有条件保留的基础候选，其余方法需要整改、降级或先禁用。

### 已复现的阻断问题

1. `psm_double_robust` 不是 AIPW：真 ATE=2 的确定性基准返回约 0。
2. `psm_dr_ipw_ra` 的权重和 outcome model 结构不构成标准 IPWRA/双重稳健估计。
3. `did_staggered`、`did_event_study` 的 TS 默认传入 `None`，覆盖 Python 的双向 FE 默认；真效应 2 的面板可返回严重偏误结果。
4. OLS 自动升级 HC1 后，系数表已切换但顶层 `std_error/p_value` 仍可能保留 nonrobust 值，产物互相矛盾。
5. `iv_test` 使用无效的 exclusion 检验且返回 `None`，TS 仍标记成功。
6. `rdd_fuzzy_global` 使用手工二阶段普通 SE；模拟中与正确 IV2SLS SE 有显著偏离。
7. RDD 缺 cutoff 时先偷偷使用 0 估计，之后才标 blocked，数值仍可能进入展示链。
8. `smart_baseline` 可仅凭列名自动执行 IV；无显式 entity/time 时又可能把典型面板误判成 pooled OLS。
9. PSM common-support 输出 `share_in_support`，TS 读取器不识别，零重叠样本不会被正确阻断。
10. OLS 精确共线性、面板重复键、少簇推断、ATT/ATE 标签、DSML 失败生命周期和重复调用保护均存在生产风险。

### 上游与现项目关系

- `Econometrics-Agent-main` 注册 17 个函数，并通过 `<all>` 真正暴露给 Agent，不是示例代码。
- KillStata 的 17 个同名函数中，12 个主体基本原样复制，2 个只调整绘图导入，3 个有实质修改。
- 当前 IV 主估计已经从上游错误的手工两阶段改成 `linearmodels.IV2SLS`；这是有效修正。
- 传统 staggered TWFE、事件时间 fallback、两个错误 DR 估计器、无效 `iv_test` 和 RDD 推断风险仍在真实调用链中。

### 本轮验证证据

- 默认运行：`bun test test/tool/econometrics.test.ts test/tool/econometrics-smart.test.ts test/tool/iv-golden.test.ts test/tool/panel-fe-golden.test.ts`，15 通过、0 失败，但 Python 不可用时多个测试会提前返回。
- 强制真实运行时：`KILLSTATA_PYTHON=/Users/cw/.killstata/venv/bin/python bun test test/tool/econometrics.test.ts test/tool/econometrics-smart.test.ts test/tool/iv-golden.test.ts test/tool/panel-fe-golden.test.ts`，15 通过、0 失败、57 个断言，32.70 秒。
- 这只证明现有 OLS/IV/面板 FE golden 路径能执行；当前没有 PSM、RDD、staggered/event、`iv_test`、少簇和共线性等数值 golden。

### 下一步

1. 建立生产方法白名单，先隐藏/阻断已证伪和高风险入口。
2. 将 `options.passthrough` 改成逐方法强类型 schema，并在 Python 启动前完成数据/识别前置检查。
3. 依次做牢 OLS、面板 FE、IV2SLS，再处理静态 DID、PS 系列和 Sharp RDD。
4. 让 CI 强制执行真实 Python 数值测试，并加入 Stata/R 固化夹具和模型调用回放。

---

## 上一轮：用户体验与去编码化

## 状态

- 全量测试：146 通过、0 失败（358 个断言）。
- 类型检查：通过。
- 构建：通过。
- `bun dev`：能够启动；大 Logo 正常，首屏占位文案只显示一次，无 LSP/Formatter 启动错误。

## 已确认问题

1. 自动推荐对布尔列做减法，触发 pandas/numpy `TypeError`。已修复并用原数据真实跑通。
2. 计量失败时仍会展示内部工具、文件路径和完整英文堆栈。已改为简短中文失败提示，相关测试通过。
3. DSML 解析器只覆盖无斜杠的参数闭合标签；真实的 `</...parameter>` 会被解析为空参数。已兼容两种格式并通过测试。
4. 删除默认发布产物后，实验日志单例测试仍要求 `publishDatasetLevelOutput`，测试与实现不一致。并行开发已将断言更新为当前单例行为，8 项针对性测试通过。
5. 数据 `/undo` 后 `/redo` 只恢复消息，不恢复数据阶段，语义不一致。
6. 前端把任意附件（包括图片）都显示为“正在处理数据”；分析关键词也存在否定句误触发风险。
7. 删除 write/edit 的 LSP diagnostics 后，TUI 仍读取旧 metadata，导致类型检查失败。已移除失效依赖，类型检查恢复通过。
8. 前端使用“存在任意附件”判断数据任务，图片也会误显示“正在处理数据”。已改为只把非图片附件视为数据输入，行为测试通过。
9. 分析回复的每个 reasoning 分片都会生成一行“展开分析过程”，开启详情后还可能泄露内部推理。分析模式现已完全隐藏 reasoning，仅保留中文任务进度，行为测试通过。
10. 初始输入框把固定文案和同一占位符再次拼接，导致“输入你的问题...”重复。已改为只渲染一次，针对性测试通过。
11. 否定句仍会被关键词识别为分析任务，例如“先别做回归”。现已在前端进度与后端意图入口共用否定判断，回到普通对话；前后端行为测试通过。
12. 服务端与 SDK 删除 LSP/Formatter 后，TUI 同步层仍保留旧类型、事件和接口调用，导致类型检查失败。现已删除全部 TUI 状态残留；针对性测试与类型检查通过。
13. `/undo` 后逐步 `/redo` 能恢复中间数据阶段，但最后一次 `/redo` 只恢复消息，数据停在前一阶段。现已在最终恢复消息前找到隐藏消息中的最后一个数据派生阶段，并通过新 rollback 节点恢复，血缘历史不被覆盖；5 项撤销测试通过。
14. 终审发现带普通聊天的中间 `/redo` 会覆盖数据恢复上下文。现已区分“继续撤销”和“推进重做边界”，先恢复刚重新显示区间的最后数据阶段，再记录剩余隐藏区间；相关回归测试通过。
15. Python traceback 作为 assistant 文本到达时，旧返回顺序会跳过中文 fallback。现已把内部错误中文提示设为最高优先级，完整净化链路测试通过。
16. 图片名如 `regression.csv.png` 仍能靠关键词或伪扩展名触发分析。前后端现在都只把非图片附件的名称、URL 纳入任务意图，回归测试通过。
17. 否定判断已改为按最后一个相关分句决定动作，支持“别做回归”“不要对这份数据做回归”，也允许“先别分析 A，但直接回归 B”进入分析。
18. 普通正文曾被缓存到 `text-end` 才一次性显示，且缺失 `text-end` 会丢内容。普通正文现在首个 delta 即开始流式输出，流结束会补齐未闭合文本；DSML 与 reasoning 继续缓冲以防内部协议闪现。
19. provider 在 DSML 前先发送空格或换行时，旧逻辑会误开普通文本流并把工具协议显示给用户。现会等待首个非空字符，再决定流式正文或 DSML；回归测试通过。
20. “你觉得应该怎么进行计量分析”“回归和面板模型有什么区别”曾被关键词误判为执行任务。前后端现在共用咨询判断；明确否定、方法咨询保持普通对话，明确执行仍进入分析。
21. 终审补齐了中英文方法名、标点和省略主语的组合边界：“别跑 OLS”不执行，“先别分析！现在做回归”和“OLS 是什么，先跑一个看看”会执行。
22. “OLS 是什么，先做个解释/总结”曾因泛化动词“做”误触发。继承动作已收紧为跑、执行、估计、分析、回归、检验，终审无 Critical/Important。

## 最近验证

- 原数据 `candidate_clues_492dc07a / stage_000` 的 `auto_recommend` 已成功生成 40 列画像，并推荐 `ols_regression`。
- Python Traceback 映射为简短中文失败提示的行为测试已通过。
- write/edit 与 TUI metadata 类型重新对齐，`bun run typecheck` 已通过。
- DSML 两种参数闭合格式均能解析出完整 `econometrics` 参数，3 项适配器测试通过。
- 图片附件不再触发数据处理进度；分析 reasoning 在详情模式下也不再显示，8 项展示层测试通过。
- “不要再分析”“先别做回归”不会进入分析模式或显示分析进度，前后端测试通过。
- LSP/Formatter 状态已从 TUI 同步层和状态页移除，残留扫描测试通过。
- 最终 `/redo` 会同步恢复数据阶段，不再出现“消息恢复、数据没恢复”的分裂状态。
- 终审新增的 traceback、图片伪扩展名、复杂否定、方法咨询、DSML 前置空白、redo 中间边界和普通文本流式回归测试均已转绿。
- 实验日志单例约束针对性测试 8 项通过。
- `bun test`：146 通过、0 失败、358 个断言。
- `bun run typecheck`：通过。
- `bun run build`：Linux、macOS、Windows 全目标通过。
- 带斜杠 DSML 参数闭合格式实测得到空参数对象，已复现。

## 下一步

本轮阻断问题已处理完毕。后续非阻断优化优先级：高级配置页中文化；把布尔列 auto-recommend 的源码顺序断言升级为独立真实数据夹具测试。

---

## 去编码化改造（6 阶段全部完成，2026-07-15）

把 OpenCode 为"AI 改代码库"设计的基座换成"AI 做实证分析"的基座。核心洞察：计量侧的
对应机制（stage 血缘、rollback、manifest、QA gate、实验日志）已全部存在，解耦 = 把它们
提上来当主力，把 git/LSP 那套拆掉。src 从约 66k 行降到 61k 行。

1. **项目身份**（eb07928）：不再靠 .git 判定。一刀修好 4 个真 bug——非 git 目录原先落入
   id="global"+worktree="/"，导致会话串台、权限规则静默失效、explorer 写 plan 被拒、
   配置扫到文件系统根。改为向上找 .killstata/，worktree 永远是真实目录。
2. **撤销 → 数据阶段回滚**（344bba5）：删 git 影子仓库（304 行）。/undo 改为回滚到上一个
   数据 stage（复用 data_import rollback），不依赖 git，往前长不抹历史。原先在非 git 目录
   完全失效——AI 洗错数据无法回滚。Codex 补齐了 /redo 的对称恢复。
3. **拔 LSP + formatter**（7295f5a，3396 行）：LSP 会在数据目录 spawn pyright，formatter
   会用 latexindent/ruff 偷偷改写 AI 生成的 .tex/.py。language.ts（扩展名→语言映射）
   救回为 tui/util 本地高亮资产。
4. **skill**（fbd3c2d）：删 28 个内置 skill 的硬编码别名，**保留 agent 加载/使用 skill 的
   框架**——用户会从 GitHub 下载第三方计量 skill。端到端验证过。
5. **系统提示去编码化**（af5ddef）：provider 锁定 deepseek+custom 后，codex/beast/gemini/
   anthropic 四份 prompt 是死路由，删除；provider 路由 6→2 分支；isCodex 死代码清除；
   方法学统一归 ECONOMETRICS_CONTEXT（原先 6 份决策树漂移）；Plan 模式注入、bash git 教程、
   各处编码示例全部改成计量版。新增 prompt-decoding.test.ts 防回归。
6. **注入 <data-context>**（61e77ed）：模型每轮直接知道当前数据集/活跃阶段/阶段链/已试
   几组设定，不再靠翻历史回忆（压缩后历史都没了）。数据全来自已落盘 manifest，可重建。

每阶段都有能真正抓 bug 的回归测试（撤掉修复即变红，已逐一验证）。全程 155 测试全绿、
全平台 build 通过。所有删除物进 trash/，可回滚。
# 2026-07-16 `psm_construction` 逐项准入

- 已固定边界：只做倾向得分构造与共同支撑诊断，不输出或暗示因果效应。
- 已确认接入点：`econometrics-method-tools.ts` 强类型入口、`econometric_algorithm.py` 稳定 Logit、`econometrics.ts` 产物/摘要、workflow diagnostic stage。
- RED 已确认：模型目录缺少工具、workflow 错记为 report、独立导出不存在，共 4 个失败与 1 个模块错误。
- 已完成强类型工具和 Python 稳定性实现：正常重叠安静运行；非二元、缺失、完全分离均明确阻断；逐行得分不进入 metadata，只写 CSV 产物。
- 目标验证：类型检查通过；工具暴露、workflow、真实 Python、生命周期和用户输出共 22 项通过、0 失败、103 个断言。
- 下一步：运行全量真实 Python 测试、构建、diff 检查和独立终审。

---

# 2026-07-16 传统 DID 端到端实测

- 已完成测试流程、Word 设计核对与 Excel 基准核对：820 行、8 列、`fte` 缺失 19，手工 2×2 DID 为 2.9139823574。
- 真实 KillStata 导入成功；QA 准确阻断了 `id=407` 导致的 2 组重复 `id × t`。
- 已完成 TDD RED：模型侧缺少 `DidStaticTool`，PyFixest 后端明确拒绝 `did_static`。下一步补齐独立传统 DID 工具并重跑真实任务。
- 已完成 TDD GREEN：新增强类型 `did_static(dependentVar, groupVar, postVar, covariates)`，后端安全构造交互项；后端 15/15、集成层 36/36、提示词 8/8 测试通过。
- 真实 Excel 直连后端数值已核对：无控制变量 DID=2.9139823574；加入 `bk/kfc/roys` 后 DID=2.9350196887；均使用 801 个有效样本。
- 下一步：启动真实 KillStata 对话回归，检查模型是否按 `import → econometrics_recommend → QA（不传 entity/time）→ did_static` 调用。
