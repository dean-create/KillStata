# Killstata 最终输出链一致性审计报告

更新时间：2026-04-09

这份文档只回答一个问题：

`从数据处理到实证分析，再到最终给用户看的摘要、导航页、三线表、论文草稿、汇报材料，这条链现在到底稳不稳？`

结论先放前面：

- 当前主链已经能稳定跑通。
- 本轮审计中查到的阻塞级和一致性级问题，已经完成修复。
- 现在剩下的更多是边角体验风险，不是“主流程会卡死”的那类问题。

---

## 1. 审计范围

这次审计覆盖的不是单个工具，而是整条“最终输出链”：

```text
data_import
-> QA / preprocess / filter / describe
-> econometrics
-> regression_table
-> heterogeneity_runner
-> research_brief
-> paper_draft
-> slide_generator
-> analysis-state / final_outputs.json
-> runtime analysis summary
-> TUI / transcript / fallback text
```

重点查的是 4 类问题：

1. 同一条分析链里，状态有没有断
2. 结构化产物和用户看到的文案有没有对不上
3. 某个阶段虽然产出了文件，但 runtime 是否把它“看见了”
4. 内部错误、内部路径、内部元数据会不会直接漏给用户

---

## 2. 总体结论

### 2.1 当前状态

当前实现已经满足下面这些基本要求：

- 原始数据会被转换成可追踪的 canonical dataset stage
- QA 不再是可选提示，而是主链硬闸门
- econometrics、异质性、研究摘要、论文草稿、演示材料，都能进入统一结果链
- `finalOutputs`、导航页、runtime summary、TUI fallback、transcript/export 的口径已经大体对齐
- 内部错误不再直接裸露给用户

### 2.2 这轮审计后的客观判断

- 没再发现新的阻塞级 bug
- 没再发现“结果文件生成了，但最终摘要完全跟错对象”的主链问题
- 当前更像进入了“收边角和长期维护”的阶段，而不是“救火阶段”

---

## 3. 已确认并修复的问题

下面这些不是猜测，是本轮沿着源码和测试链核对后确认过的问题。

### 3.1 `data_batch` 类型系统阻塞

**问题**

`data_batch` 里的 `columnAliases` 类型推断不稳定，`z.infer` 会漂到过宽的 record 类型，导致 `typecheck` 直接失败。

**影响**

- 编译级阻塞
- 后续 workflow 再合理也没法稳定进入执行态

**修复**

- 统一成稳定的 `Record<string, string[]>`
- 相关列解析函数使用同一套别名类型

**结果**

- `bun run typecheck` 恢复通过

---

### 3.2 `data_batch` 跳过普通 QA

**问题**

之前 batch 只有在提供 `entityVar/timeVar` 时才执行 QA。
这和单文件主链不一致，因为单文件链是导入后必须过 QA。

**影响**

- 批量分析和单文件分析规则不一致
- 某些有问题的数据在 batch 里会被直接带进后续 export

**修复**

- batch 固定改成 `import -> filter/preprocess -> qa -> export`
- 即使没有 panel 参数，也必须执行普通 QA
- QA block 会真实影响 batch 成败，而不是被 export 掩盖

**结果**

- batch 行为和主链重新对齐

---

### 3.3 delivery bundle 落点错误

**问题**

交付 bundle 一度会落到 `packages/killstata/killstata_output_*` 这类包目录内部，而不是项目级输出位置。

**影响**

- 文件虽然生成了，但落点语义错
- 用户和后续工具都更难稳定定位交付物

**修复**

- `deliveryBundleDir(runId)` 改为使用项目根语义，而不是 `Instance.directory`
- 保留 legacy typo 兼容逻辑，不硬砍旧路径

**结果**

- 交付文件现在稳定落到项目级输出目录

---

### 3.4 用户可见文本链存在编码污染

**问题**

`analysis-user-view`、`paper-draft`、`slide-generator`、`research-brief`、prompt 源文件里都存在不同程度的编码污染或历史乱码。

**影响**

- 结果算对了，但摘要、论文草稿、slides、系统提示会出现火星文
- 用户会误以为分析失败，或者误以为数字不可信

**修复**

- 清理运行时摘要文本
- 重建论文草稿和演示材料模板中的用户可见文案
- 清理上游 prompt 文本源里的坏字符

**结果**

- 现在“跑通”和“说人话”终于是同一个系统在干活

---

### 3.5 内部错误直接露给用户

**问题**

像下面这类信息，之前会直接出现在用户界面或导出文本里：

- `Cannot read binary file: ...stage_000...parquet`
- `Model tried to call unavailable tool 'econometrics'`

**影响**

- 直接把内部工作层和调度失败细节甩给用户
- 既不利于理解，也不利于定位真实分析进度

**修复**

- 在 sanitizer 层做统一用户友好映射
- 在 TUI、transcript/export、fallback text 都接入这套映射

**当前显示策略**

- 不显示：`Cannot read binary file: ...stage_000...parquet`
- 应显示：`该文件是内部 Parquet 工作层，已自动改用结构化结果文件继续分析。`

- 不显示：`Model tried to call unavailable tool 'econometrics'`
- 应显示：`分析工具调用失败，系统正在回退到可执行路径。`

---

### 3.6 `turn-assembler` 在整轮报错时可能不落 fallback summary

**问题**

以前只在“没有 error”的情况下补分析 fallback summary。
如果工具已经产出了可信结构化结果，但后面的文本阶段翻车，用户可能看到空白或不完整输出。

**影响**

- 有结果，但像没结果
- 这类 bug 很阴，因为文件层可能是好的，展示层却像蒸发

**修复**

- 去掉“只有无 error 才能补 fallback”的限制
- 只要前面有可信最终分析工具结果，就允许补 fallback summary

**结果**

- 现在异常情况下也更容易有用户可见的兜底说明

---

### 3.7 `analysis-state` 存在跨 stage 复用旧路径的风险

**问题**

同一个 `runId` 下，如果 `stageId` 不同，之前部分 visible/delivery output 可能复用旧路径。

**影响**

- 新结果和旧文件名可能串线
- 用户容易以为自己在看当前阶段结果，实际读到的是旧 stage 产物

**修复**

- `publishVisibleOutput()` 和 `publishDeliveryOutput()` 加强 stage 隔离
- 不同 stage 即使共享 `runId`，也不会复用旧路径

**结果**

- 同一轮分析内的不同阶段结果不再串门

---

### 3.8 `analysis-user-view` 会把更早的 econometrics 错当最终结果

**问题**

如果先跑了 `econometrics`，后面又跑了 `paper_draft` 或 `slide_generator`，旧逻辑还可能继续优先展示 econometrics。

**影响**

- 真正最后交付的东西已经变了
- 用户摘要却还停留在前一步

**修复**

- 改成按“最新的最终展示型工具”选择主视图
- 当前优先顺序会正确落到：

```text
paper_draft
-> slide_generator
-> research_brief
-> heterogeneity_runner
-> regression_table
-> econometrics
```

**结果**

- 最终做什么，就总结什么

---

### 3.9 `regression_table` 没有真正接入统一结果链

**问题**

`regression_table` 之前是“半接入”状态：

- 它能生成 `.md / .tex / .xlsx / .docx`
- 它也能发布到 `finalOutputs`
- 但 runtime summary 和 fallback text 并不会把它当正式最终结果层处理

**影响**

- 明明最后一步是三线表，摘要还在讲 econometrics
- fallback 也可能忽略它

**修复**

- 在 runtime 里把 `regression_table` 纳入：
  - `CORE_ANALYSIS_TOOLS`
  - `FINAL_PRESENTATION_TOOLS`
  - `FINAL_ANALYSIS_RESULT_TOOLS`
- 在 `regression-table.ts` 里补上：
  - `analysisView`
  - `display`
  - 用户可见指标
  - 用户可见 artifact
  - 用户可见结论

**结果**

- 三线表现在不再是“会产文件但不会说话的工具”
- 它已经正式进入统一结果链

---

## 4. 当前链路最稳的理解方式

如果你现在要把 killstata 当前实装版记成一句话，最稳的是：

```text
原始表
-> import 成 canonical parquet stage
-> QA / filter / preprocess
-> econometrics / 扩展分析
-> regression_table / paper_draft / slide_generator
-> final_outputs.json / 导航页 / runtime summary / transcript
-> 用户最终看到的结论
```

真正关键的不是某一个工具，而是这 3 层一直要保持对齐：

1. 结构化产物层
   例：`results.json`、`diagnostics.json`、`numeric_snapshot.json`、`three_line_table.docx`

2. 交付登记层
   例：`final_outputs.json`、visible outputs、导航页

3. 用户展示层
   例：runtime summary、TUI、transcript、fallback text

这轮审计的核心工作，就是把这三层尽量拉回同一个口径。

---

## 5. 现在已经确认稳定的部分

截至这轮审计结束，下面这些点可以视为“当前稳定”：

- `data_batch` 能通过类型检查
- batch 和单文件主链的 QA discipline 已对齐
- delivery bundle 会落到项目级目录
- `finalOutputsPath` 与 `internalFinalOutputsPath` 已统一治理
- prompt 源和主要用户文案源不再持续向最终输出链注入明显乱码
- 用户不会再直接看到 raw parquet / unavailable tool 这类内部报错
- `turn-assembler` 能在失败场景下补出更稳定的分析 fallback
- `analysis-state` 的 stage 隔离逻辑已经补强
- `paper_draft`、`slide_generator`、`research_brief`、`heterogeneity_runner`、`regression_table` 都已经进入统一分析视图链

---

## 6. 还存在的客观残留风险

这部分不夸张，也不装没事，客观列出来。

### 6.1 中文编码风险仍未完全从仓库层面清零

虽然主链上会直接影响用户的模板和摘要层已经清理过一轮，但仓库里仍然存在历史中文乱码资产，尤其是：

- 一些旧文档
- 一些历史测试素材
- 一些已落盘的历史产物样例

它们不一定会继续污染当前主链，但会干扰后续维护、阅读和二次审计。

### 6.2 README 和部分顶层文档仍有历史编码包袱

当前 [README.md](/d:/SMWPD/Project_all/openstata/killstata/README.md) 本身就带明显历史编码问题。
这不会直接卡住分析链，但会影响项目对外可读性。

### 6.3 目前测试主要覆盖“关键路径一致性”，不是全仓穷举

当前已经补了很多回归测试，但覆盖策略仍然偏“关键主链”而不是“所有分支穷举”。

这意味着：

- 主链回归风险已经明显下降
- 但边缘工具或非常规输入下，仍可能有未被覆盖到的行为差异

---

## 7. 这轮审计的测试覆盖

这轮修复和审计主要依赖以下测试链：

- `analysis-output-text.test.ts`
- `analysis-sanitizer.test.ts`
- `analysis-state.test.ts`
- `runtime_regression/analysis_user_view_regression.test.ts`
- `runtime_regression/turn_assembler_analysis_fallback_regression.test.ts`
- `packages/killstata/test/runtime/workflow-stage.test.ts`
- `packages/killstata/test/tool/data-import.test.ts`
- `packages/killstata/test/tool/econometrics.test.ts`

当前已经实际通过：

- `bun run typecheck`
- 关键回归测试整组通过

---

## 8. 如果后面还要继续审计，最值得优先看的方向

现在不建议再按“哪里看起来脏就先洗哪里”的方式乱扫了。
更稳的方向是这三个：

### 8.1 仓库级中文编码治理

目标不是“看着顺眼”，而是：

- 避免新旧文案层混用不同编码状态
- 避免后续测试和文档再次被乱码拖累

### 8.2 `final_outputs.json` 与导航页的对外契约固化

建议继续加强：

- 哪些 artifact 必须出现
- 哪些 label 必须稳定
- 哪些路径必须对用户可见

这能进一步降低“文件存在，但别人找不到”的概率。

### 8.3 对最终交付工具做更强的契约测试

重点工具：

- `regression_table`
- `paper_draft`
- `slide_generator`
- `research_brief`
- `heterogeneity_runner`

建议后续继续补：

- `analysisView` 契约测试
- `display` 契约测试
- `finalOutputs` 登记一致性测试

---

## 9. 最终判断

如果你问的是：

`killstata 现在这条从数据处理到实证分析再到结论输出的链，能不能算“基本打通并且对齐了”？`

答案是：

**可以。**

但如果你问的是：

`它是不是已经到了“完全没有历史包袱、完全没有编码风险、所有边角都被穷举测试”的程度？`

答案也是客观的：

**还没有。**

当前最准确的评价应该是：

`主链已打通，关键一致性问题已修复，剩余风险主要集中在历史文本资产和边角覆盖，而不是核心分析流程本身。`

