# 当前进度

## 桌面/Web 同一界面与本机 CLI 分享体验（2026-10-06）

- 已实现 Desktop/Web 共用研究界面、frontend 默认模式、显式 Core 连接、平台文件/工作区适配、可信 LAN 分享和主机模型只读档案。访客先选择本地 workspace；只有提交连接分析后文件才上传到主机。
- Desktop/Web 的默认模式、“1”研究记录、设置与 reasoning 折叠已做视觉/交互对照；Web 在 1440×900 与 390×844 可用。窄屏设置面板被工作区抽屉遮挡的问题已红绿修复。
- `killstata web` 默认 loopback；显式 `--share` 才开放私有 LAN 访客。候选 `0.1.30` 的 12 个 tarball（11 native + launcher）SHA-512 manifest 匹配，隔离安装的 `--version`、`web --help`、loopback 和 `--share` 启动通过。
- 安装包分享页已在同一台 Mac 经私有网卡连入隔离测试档案：访客 Core ready、模型档案只读、无 API Key；未提交数据给外部 Provider。第二台物理设备尚未验收。
- 修复上一轮 CI 根因：CI Python 绝对路径和 PYTHONPATH；7 个旧模型测试尊重显式 `KILLSTATA_PYTHON`；permission safety 测试从 `Global.Path.data` 构造 managed runtime 路径；panel legacy fixture 正确允许 Hausman 不可判定。各问题均先复现失败再修复。
- 当前本机验证：Core **2165 pass / 5 skip / 0 fail**，共 2170 tests、309 files、10533 assertions；CLI typecheck、diff check、workflow YAML 解析通过。此次运行采用 CI 的 20 秒单测限制和锁定依赖，未改 HOME。
- Draft PR #6 的最新远端结果仍对应上述修复前提交；本地修复尚待提交推送并触发新的 clean-checkout GitHub CI。
- npm registry 仍为 `killstata@0.1.27`；候选 `0.1.30` 未发布。尚待：新 GitHub CI、Linux 主机启动、第二台设备访问、真实 Provider 验收及发布审批。
- 本轮详细验证记录：`test/desktop-web-parity-2026-10-05.md`。

## main 合并与 npm 正式发布（2026-07-18）

- 已将 `agent/repo-cleanup-20260714` 的 22 个既有提交、npm 发布链路提交和两份可复现真实论文 fixture 合并并推送到 GitHub `main`：`907c217`。
- 隔离 main 验证：`bun run typecheck` 通过；全量 `bun test` 为 401 pass、0 fail、1748 assertions；`git diff --check` 通过。
- 首次全量测试暴露已提交测试依赖被 `/test/` 忽略的 `dataset-contract.json` 与 `backend-results.json`；已仅跟踪这两份无路径/无凭据的确定性 fixture，相关 8 项测试与全量测试均转绿。
- 已发起 `release:npm --version 0.1.26`；npm 在第一个原生包上传前以 E403 拒绝，原因是当前认证缺少 2FA bypass。随后逐包核验：12 个 `0.1.26` 包全部不存在，`killstata@latest` 仍为 `0.1.24`，没有半发布。
- 下一步：在 npm 为 `deangeeker` 创建或更新带 `Read and write` 与 `Bypass two-factor authentication` 的 granular token（或配置 Trusted Publishing）；完成后在干净、同步的 main 上重跑同一发布命令。

## npm 多平台发布链路（2026-07-18，已完成整理）

- 发布入口收敛为两条：`pack:release --version X.Y.Z` 只构建打包，`release:npm --version X.Y.Z [--dry-run]` 负责预检与发布。
- 版本必须显式提供；一次生成 11 个原生包和 1 个 `killstata` launcher，并写入 SHA-512 release manifest。
- npm 多包发布按原生包串行、launcher 最后的顺序执行；固定使用 npm 公共 registry，同版本同完整性会跳过，不同完整性会在上传前阻断。
- 发布脚本不接收 Token、不写临时 `.npmrc`，也不再顺带发布 GitHub Release 或 GHCR。
- 实测 `0.1.26 --dry-run` 生成 12 个包并完成 registry 计划检查，未上传任何包。
- 验证：发布协议测试 15/15；全量测试 402/402、1753 个断言；typecheck 通过；`git diff --check` 通过；独立复审 Critical 0、Important 0。
- 尚未执行真实 npm publish。外部待办只有：发布账号权限/2FA 或 Trusted Publishing 配置，以及在干净且与远端同步的 main/master 上运行正式命令。
- 发布原理与恢复手册：`docs/npm-release.md`；实现计划与 RED/GREEN 记录：`docs/superpowers/plans/2026-07-18-npm-release-pipeline.md`。

## npm Windows x64-only 发布（2026-07-18，已完成）

- 用户决定停止 macOS、Linux、Windows baseline 的 npm 原生分发；正式包只保留 `killstata-windows-x64` 和 launcher `killstata`。
- 发布 manifest 现严格要求这两个包，且固定原生包先于 launcher；launcher 同时声明 `os: ["win32"]`、`cpu: ["x64"]` 并仅依赖 `killstata-windows-x64`，macOS/Linux 不会再出现“装了但没有二进制”的假成功。
- `build.ts` 只构建一个 Windows x64 目标；删除全平台、baseline、`--single`、`--windows-priority` 分支及对应 npm script。
- 验证：发布协议 16/16；typecheck、`node --check script/postinstall.mjs`、两包真实 pack、生成 manifest/launcher 元数据断言、registry dry-run、`git diff --check` 均通过。dry-run 仅计划 `killstata-windows-x64@0.1.26`、`killstata@0.1.26`，没有上传。
- 不再需要 `deangeek` owner：Windows-only 后两个包都由 `deangeeker` 持有；待 main 同步后以该账号恢复发布。

## npm 发布恢复：registry 传播延迟（2026-07-18，已完成）

- 真实发布时 `killstata-windows-x64@0.1.26` 的 npm PUT 返回 200，但 registry 在默认 5 次、每秒一次的完整性复核内尚未可见，脚本停止在 launcher 前；这不是权限失败。
- 随后独立 registry 查询确认 Windows 原生包已发布，SHA-512 与本地 tarball 相同；`killstata@0.1.26` 仍为 E404，普通用户尚不可安装到半套发布。
- 已以 RED/GREEN 补回归测试：5 次不可见后正常传播必须通过；默认完整性复核扩展为 45 次（约 44 秒）。
- 0.1.26 的 Windows 原生包已被占用，但并行合入后的新二进制完整性不同，npm 不允许覆盖；脚本正确阻止了 launcher 半发布。正式统一版本改为 `0.1.27`。
- 最终外部 registry 验证：`killstata-windows-x64@0.1.27` 与 `killstata@0.1.27` 均可见且 SRI 与本地 tarball 相同；`killstata@latest = 0.1.27`。用户在 Windows x64 上可执行 `npm i -g killstata@latest`。

## 计量工具并行任务（延续 2026-07-17）

- 真实论文数据 + DeepSeek 工具调用回放验收基座已完成设计；首个 pilot 为 `panel_fe_regression + did.xlsx`。
- `psm_matching/psm_ipw` 已补分析单位和处理前聚合硬门禁；Card 只作为 B 级 wiring/smoke，LaLonde/NSW A 级独立对标仍待完成。
- npm 整理未修改并行中的计量实现与测试文件；共享工作树内这些修改继续归 Claude/Codex 对应任务所有者处理。

## 历史索引

- 2026-07-17 及以前的完整进度：`docs/progress/2026-07-17.md`
