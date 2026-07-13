# PROGRESS

## 当前状态（2026-07-12）：refine.md 全部 19 项完成 ✅

三轮迭代，每一处改动都遵循「改一处 → typecheck → 测一处」，全部有真实测试验证。

### 第一轮：Bug 修复（B1-B11 + C1/C4/C5）

**新发现并修复 4 个 refine.md 之外的严重 bug**（静态审查看不出，靠真跑测试才暴露）：
- 主脚本 6 个函数（`model_coefficient_table` 等）只存在于一段从未被调用的死代码里，
  导致 **OLS/DID/IV/PSM/RDD 几乎所有回归方法此前都是 NameError 直接崩溃**
- `nested_pvalue` 候选键名对不上第三方库实际返回的 `lm_pvalue` → 异方差自动升级 HC1 从未触发
- HC1 升级路径丢失 pandas 索引变成裸 ndarray → 崩溃被 `except: pass` 静默吞掉
- `build_model_qa` 把重复面板键误判为 blocking_errors → 自动降级 pooled OLS 逻辑永远走不到

**面板 FE 迁移 linearmodels PanelOLS**：新建 Grunfeld 黄金数据集 + linearmodels 计算的
期望值，黄金测试从「迁移前红」到「迁移后绿」，证明 R²/标准误自由度 bug 真正修复。

### 第二轮：OpenCode 编码遗留剥离（C2/C3/C7/C8/C9）

分 5 批，每批 typecheck + 全量测试，最后 `bun run build` 全平台打包验证。
删除物移入项目根 `trash/`（非永久删除）。

- 仓库垃圾（2.5MB 调试 CSV、陈旧样例、4 份一次性文档、6 个 echo 假脚本）
- 死基建：`infra/`+`sst.config.ts`（handler 指向根本不存在的 packages/function、console、web）、
  `github/`、`sdks/vscode`、`src/ide`
- 编码遗留模块：`src/acp`、`src/pty`、`src/worktree`、`src/patch`+apply_patch、
  git-github MCP、codesearch
- 编码遗留命令：`/init` `/review` 斜杠命令、`killstata github/pr` CLI、session.init 路由
- 新建 `prompt/deepseek.txt`（补「工具调用 JSON 纪律」和「数字 grounding 纪律」），
  删 anthropic spoof，常量 `PROMPT_ANTHROPIC_WITHOUT_TODO` → `PROMPT_GENERIC`

### 第三轮：provider 收敛为 DeepSeek + custom（C6）

`provider.ts` 1557 → 961 行：
- 删 18 个非 DeepSeek 的 `@ai-sdk/*` 静态 import，只留 `@ai-sdk/openai-compatible`
- 删 `CUSTOM_LOADERS` 整个 map（420 行，9 家供应商，在 DeepSeek 锁定下已是死代码）
- 删各家专属逻辑：google 流式归一化、openai itemId 剥离、gpt5/copilot 判定、
  copilot-enterprise 合成、运行时 npm 动态安装
- `models.ts`：删 models.dev 网络拉取、每小时定时器、**2.9MB 快照**

**⚠️ 一处刻意偏离原方案**：refine.md 说让 `ModelsDev.get()` 返回 `{}`，但实测发现
`killstata config` 向导依赖这个目录列出可选 provider，返回空会让向导变成空列表、
用户无法配 API key。改为返回**内置二元目录**（deepseek + custom），向导照常工作。

新增 `provider/model-policy.ts`（allowlist + 统一错误文案）、
`test/provider/model-policy.test.ts`（custom 可用 / 缺 baseURL 被丢弃 / 不抢 DeepSeek 默认 / 可存 key）。

## 复查中发现并补修的遗漏

- `heterogeneity-runner.ts` 的 `read_table` 还有一处**裸 `pd.read_csv`**（B1/B3 当初只查了
  data-import 和 econometrics），已接入共享的 `PY_READ_CSV_FALLBACK`
- 根 `package.json` 的 description 还是 OpenCode 的 "AI-powered development tool"，已改
- （虚惊一场：`regression-table.ts` 读自产的 utf-8-sig 文件，实测 pandas 会自动剥 BOM，安全）

## 复核后确认「非死代码、明确保留」

- `ls.ts` —— 探索报告说它是孤儿工具，但 `prompt.ts:1395` **直接调用**它，差点误删
- `edit/write/bash/read/glob/grep` —— 它们不是「写代码的工具」，是 **agent 的手和脚**：
  读用户数据文件夹、检查产物、装 Python 包全靠它们，删了 agent 就瞎了
- `webfetch/websearch`（计量查文献有用，且默认关闭，保留成本为零）、`task`、
  `src/share`、`src/lsp`、`src/question`、`src/snapshot`、`packages/sdk`

## 已知遗留（不影响正确性，未在本轮扩大改动面）

`transform.ts` 和 `cli/cmd/config.ts` 中按 npm 包名字符串分派的各家专属分支
（`case "@ai-sdk/anthropic":` 等）现已永远走不到，属死分支但无害。清理它们收益低、
回归面中等，留待需要时单独处理。

## 环境备忘（本机 mac）

- Bun 装在 `~/.bun/bin/bun`，需 `export PATH="$HOME/.bun/bin:$PATH"`
- 系统 Python 3.9 无 pandas；跑计量测试需指定 `KILLSTATA_PYTHON` 指向装了
  pandas/numpy/scipy/statsmodels/linearmodels/openpyxl/pyarrow/python-docx 的 venv，
  否则 econometrics 测试会被 `supportsEconometricsRuntime()` 守卫整体跳过（假绿）
- 启动 TUI：`bun run dev`（需 `DEEPSEEK_API_KEY`）；首次用 `killstata config` 建 managed venv
- 黄金数据集：`packages/killstata/test/fixtures/golden/grunfeld.csv`
  （正确答案：value 系数 0.1167、聚类 SE 0.0113、within R² 0.7566）

## 历史索引

- 无归档。
