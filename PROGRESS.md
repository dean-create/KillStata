# 当前进度

## npm 多平台发布链路（2026-07-18，已完成整理）

- 发布入口收敛为两条：`pack:release --version X.Y.Z` 只构建打包，`release:npm --version X.Y.Z [--dry-run]` 负责预检与发布。
- 版本必须显式提供；一次生成 11 个原生包和 1 个 `killstata` launcher，并写入 SHA-512 release manifest。
- npm 多包发布按原生包串行、launcher 最后的顺序执行；固定使用 npm 公共 registry，同版本同完整性会跳过，不同完整性会在上传前阻断。
- 发布脚本不接收 Token、不写临时 `.npmrc`，也不再顺带发布 GitHub Release 或 GHCR。
- 实测 `0.1.26 --dry-run` 生成 12 个包并完成 registry 计划检查，未上传任何包。
- 验证：发布协议测试 15/15；全量测试 402/402、1753 个断言；typecheck 通过；`git diff --check` 通过；独立复审 Critical 0、Important 0。
- 尚未执行真实 npm publish。外部待办只有：发布账号权限/2FA 或 Trusted Publishing 配置，以及在干净且与远端同步的 main/master 上运行正式命令。
- 发布原理与恢复手册：`docs/npm-release.md`；实现计划与 RED/GREEN 记录：`docs/superpowers/plans/2026-07-18-npm-release-pipeline.md`。

## 计量工具并行任务（延续 2026-07-17）

- 真实论文数据 + DeepSeek 工具调用回放验收基座已完成设计；首个 pilot 为 `panel_fe_regression + did.xlsx`。
- `psm_matching/psm_ipw` 已补分析单位和处理前聚合硬门禁；Card 只作为 B 级 wiring/smoke，LaLonde/NSW A 级独立对标仍待完成。
- npm 整理未修改并行中的计量实现与测试文件；共享工作树内这些修改继续归 Claude/Codex 对应任务所有者处理。

## 历史索引

- 2026-07-17 及以前的完整进度：`docs/progress/2026-07-17.md`
