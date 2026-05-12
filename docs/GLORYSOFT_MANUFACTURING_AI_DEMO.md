# Glorysoft AI Hackathon Manufacturing Demo

本文档用于录制哥瑞利 AI Hackathon 初赛 demo。目标是展示 Killstata 作为制造业工艺异常与质量分析 AI Agent 的桌面执行能力。

## 定位

主题描述：

> 面向制造工艺数据的 Killstata AI 分析助手，可自动读取多 Sheet Excel，识别缺失值、机台差异、关键工艺因子和预测变量，并生成中文分析报告，帮助工程师快速完成异常初筛与质量归因。

推荐赛道：

- 首选：AI Agent
- 备选：产品研发（EAP, LOFA, MES）

边界说明：

- 当前样例数据适合做同类异常样本内的关键因子筛查。
- 当前样例不适合宣称“正常/异常自动分类”，因为 `加检状况` 基本是单一异常标签。

## DeepSeek Key 设置

不要把 API Key 写进代码、提交到仓库，或者粘贴进聊天记录。

当前 Killstata 已内置 DeepSeek provider，读取的环境变量是：

```powershell
$env:DEEPSEEK_API_KEY = "你的 DeepSeek API Key"
```

只在当前 PowerShell 窗口生效。录屏前建议用这种方式，录完关闭窗口即可，比较干净。

如果需要持久化到当前用户环境变量：

```powershell
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "你的 DeepSeek API Key", "User")
```

持久化后需要重开终端。

推荐模型：

- `deepseek-chat`：适合 demo 对话和工具调用，速度更稳。
- `deepseek-reasoner`：适合复杂解释，但录屏时可能更慢。

## Demo 输入

示例数据：

```text
D:\SMWPD\Project_all\openstata\demo\全量演示文档.xlsx
```

推荐提示词：

```text
请使用 manufacturing_analysis 分析 demo\全量演示文档.xlsx，生成制造业工艺异常与质量分析 demo 报告。重点展示：多 Sheet 自动识别、缺失值诊断、Chamber 机差分析、PCA 关键因子筛查、PLS 关键变量筛查，并用中文总结适合比赛录屏的业务价值。不要宣称正常/异常分类。
```

## 录屏节奏

1. 导入数据：展示 AI 自动读取 10 个 Sheet。
2. 自动诊断：展示缺失值、Chamber 差异、PCA、PLS、方差分析。
3. 生成交付：展示 Word 报告、Excel 结果表、Markdown 摘要和 JSON 结构化结果。
4. 业务价值：强调工程师可以从手工筛表转为 AI 自动初筛。

## 已验证输出

本地烟测输出目录：

```text
D:\SMWPD\Project_all\openstata\modelpctest\manufacturing-demo
```

关键产物：

- `manufacturing_analysis_report.docx`
- `manufacturing_analysis_results.xlsx`
- `manufacturing_analysis_report.md`
- `manufacturing_analysis_summary.json`
