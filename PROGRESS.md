# PROGRESS

## 当前状态（2026-07-12，本机已从"只出方案"转为实际改代码）

本轮在本机（已装好 Bun 1.3.14 + Python venv 含 pandas/numpy/scipy/statsmodels/linearmodels/openpyxl/pyarrow/python-docx）按 refine.md 的顺序逐项修复并验证，**改一处、typecheck、测一处**，全部通过：

### 已完成（refine.md 阶段 0-2 全部完成 + 阶段 5 部分完成）

- **新发现并修复 4 个此前未记录的严重 bug**（静态审查未发现，靠真实跑测试才暴露）：
  - 主脚本（econometrics.ts）里 `model_coefficient_table`/`build_table_variables`/`iv_strength_diagnostic`/`parallel_trends_diagnostic`/`load_matplotlib_pyplot`/`persist_common_outputs` 六个函数只存在于一段从未被调用的死代码里，导致 **OLS/DID/IV/PSM/RDD 几乎全部方法此前都是 NameError 崩溃状态**
  - `nested_pvalue` 候选键名对不上 `econometric_algorithm.py` 实际返回的 `lm_pvalue`，导致异方差自动升级到 HC1 从未触发
  - HC1 升级路径（`get_robustcov_results`）丢失 pandas Series 索引变成裸 ndarray，`model_coefficient_table` 崩溃被静默吞掉
  - `build_model_qa` 把重复面板键误判为 `blocking_errors`，导致"自动降级 pooled OLS"逻辑永远走不到
- refine.md 19 项问题：**B1/B2/B3/B4/B5/B7/B8/B9/B10/B11 + C1/C4(部分)/C5 全部修复并有真实测试验证**（C4 复核时发现 `ls.ts` 并非死代码——`prompt.ts:1395` 直接调用它，已恢复，只删了真正零引用的 `multiedit.ts/.txt`，移入项目根 `trash/` 而非永久删除）
- **面板 FE 迁移 linearmodels PanelOLS 完成**：新建 Grunfeld 黄金数据集（`test/fixtures/golden/`）+ linearmodels 计算的期望值，黄金测试从"迁移前红"到"迁移后绿"，证明 R²/标准误的自由度 bug 真正修复；删除 4 个失效的自研 numpy 统计函数
- 全量测试套件：**39 个测试，0 失败**（含新增 9 个测试文件/用例）

### 尚未做（refine.md 阶段 3/4/剩余阶段 5，下次会话继续）

1. 阶段 3：provider 手术（DeepSeek + custom OpenAI 兼容端点，删 18 个无用 SDK 依赖 + 2.9MB 快照）
2. 阶段 4：DeepSeek 专属 prompt（新建 deepseek.txt）+ system.ts 剩余清理（anthropic spoof、PROMPT_GENERIC 改名）
3. 阶段 5 剩余：仓库垃圾清理（temp_data_for_regression.csv、analysis/ 陈旧样例）、infra/、github/、sdks/vscode、src/ide、src/acp、src/pty、src/worktree、src/patch+apply_patch、git-github MCP、/init /review 命令

### 已拍板的决策（不变）

DeepSeek 为主 + custom OpenAI 兼容端点；面板 FE 迁移 linearmodels（已完成）；长期记忆本版本不做（已删空壳）；Skill/MCP框架/Stata MCP/会话压缩保留；src/lsp 本轮不动。

## 下一步

按 refine.md 阶段 3 开始：provider.ts 手术。

## 历史索引

- 无归档。
