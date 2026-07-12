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

### 第二轮：OpenCode 编码遗留剥离（C2/C3/C7/C8/C9 完成）

按风险从低到高分 5 批执行，每批 typecheck + 全量测试，最后 `bun run build` 全平台打包验证。
所有删除物移入项目根 `trash/`（3.0MB），非永久删除。

- **批次A 仓库垃圾**：temp_data_for_regression.csv(2.5MB)、analysis/ 陈旧样例、4 份一次性文档、6 个 echo 假 npm scripts、补 .gitignore
- **批次B 死基建**：infra/ + sst.config.ts（handler 指向根本不存在的 packages/function、console、web）、github/、sdks/vscode、src/ide、sst 依赖
- **批次C 编码遗留模块**：src/acp、src/pty、src/worktree（只摘 worktree 端点，保留 experimental 的 /tool 和 /resource）、src/patch + apply_patch 工具、git-github MCP、codesearch 工具、@agentclientprotocol/sdk + bun-pty 依赖
- **批次D 编码遗留命令**：/init /review 斜杠命令、killstata github/pr CLI、session.init 路由（生成 AGENTS.md）、@actions/* + @octokit/* 依赖
- **批次E prompt**：新建 `prompt/deepseek.txt`（qwen.txt 为底稿增量改写，补「工具调用 JSON 纪律」和「数字 grounding 纪律」两段）、system.ts 路由加 deepseek 分支、删 anthropic spoof、误导常量 `PROMPT_ANTHROPIC_WITHOUT_TODO` → `PROMPT_GENERIC`

**复核后确认非死代码、明确保留**：`ls.ts`（prompt.ts:1395 直接调用，不是孤儿）、webfetch/websearch（计量查文献有用，且默认关闭零成本）、task、src/share、src/lsp、edit/write/bash/read/glob/grep（agent 的手和脚，删了就瞎了）。

验证结果：typecheck 通过、**41 个测试全绿**、`bun run build` 全平台打包成功。

### 尚未做（下次会话继续）

1. **C6 / refine.md 阶段 3：provider 手术**（唯一剩下的大件）
   - 现状：provider.ts 仍有 47 处 `@ai-sdk/*` import，`models-fallback.snapshot.json` 仍是 2.9MB
   - 目标：allowlist 双供应商 = deepseek（内置）+ custom（OpenAI 兼容端点，用户配 baseURL/models）
   - 连带：删 18 个 SDK 依赖、删 models.dev 拉取与每小时定时器、`instructions()`/PROMPT_CODEX 的 isCodex 分支可一并清理

### 已拍板的决策（不变）

DeepSeek 为主 + custom OpenAI 兼容端点；面板 FE 迁移 linearmodels（已完成）；长期记忆本版本不做（已删空壳）；Skill/MCP框架/Stata MCP/会话压缩保留；src/lsp 本轮不动。

## 下一步

refine.md 只剩 **C6 / 阶段 3：provider 手术**（DeepSeek + custom 双供应商 allowlist），其余全部完成。

## 历史索引

- 无归档。
