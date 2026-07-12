# PROGRESS

## 当前状态（2026-07-12）

- 本机定位：**只出方案，不改代码**。实际施工在另一台电脑执行。
- ✅ 已完成：全库三路探索（核心架构/数据流水线/供应商与臃肿度）→ 19 项问题逐条代码核实（全部存在、无一已修复）→ 产品决策确认 → 生成施工文档 **refine.md**（问题清单 + 修复建议 + 6 阶段实施方案）。
- 📌 已拍板的决策：DeepSeek 为主 + custom OpenAI 兼容端点；面板 FE 迁移 linearmodels；长期记忆本版本不做；/init /review、git-github MCP、apply_patch 等编码遗留删除；Skill/MCP框架/Stata MCP/会话压缩保留。

## 下一步（在开发机执行，按 refine.md）

1. 阶段 0：Grunfeld 黄金数据集 + 编码 fixtures + panel-fe-golden 测试基线
2. 阶段 1：修 B1/B2/B3/B8/B9/B11 + Excel/CSV 预处理补齐
3. 阶段 2：面板 FE 迁移 linearmodels（修 B4/B5/B10）
4. 阶段 3：provider 手术（DeepSeek + custom）
5. 阶段 4：DeepSeek 专属 prompt + system.ts 清理
6. 阶段 5：全局减法（组 A-D）

## 历史索引

- 无归档。本文件为首次创建。
