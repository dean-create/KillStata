# killstata

**killstata** - 基于CLI的计量经济学智能助理

## 简介

killstata不是聊天机器人，也不是代码补全工具，而是一个能理解"论文语境"的计量经济学家，工作在当前目录，用代码帮用户完成完整的计量分析流程。

### 核心特征

- 工作在 CLI + 当前工作目录
- 面向论文/实证研究/计量用户  
- 不要求用户会写 Stata/Python 代码
- 所有操作可复现、可追溯、可导出

## 安装

```bash
bun install
```

## 运行

```bash
killstata
```

## 功能特点

### 数据处理
- Excel / Stata DTA / CSV 格式互转
- 智能数据预处理和清洗
- 变量类型自动识别

### 计量方法
- OLS 回归(支持聚类标准误/异方差稳健标准误)
- 倾向得分方法(PSM, IPW, 双重稳健估计)
- 工具变量法(IV-2SLS)
- 双重差分法(静态DID, 交错DID, 事件研究法)

### 输出
- 论文级回归表(LaTeX/CSV格式)
- 自动生成分析报告  
- 完整的处理日志

## 技术栈

- TypeScript + Bun 运行时
- Python 计量经济学工具库
- AI 驱动的自然语言理解

---

基于 [OpenCode](https://github.com/anomalyco/opencode) 构建
