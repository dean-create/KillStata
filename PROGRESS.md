# 当前进度

## 桌面/Web 同一界面与本机 CLI 分享体验（2026-10-04）

- 已实现共同研究界面、frontend 默认模式、显式 Core 连接、Web 文件/工作区适配、可信 LAN 分享和主机模型只读档案。分享访客连接需先选择本地工作区；不提交研究文件时不会把文件传到主机。
- TDD 回归修复：窄屏从工作区抽屉打开设置时先关闭抽屉，避免设置面板被遮挡。红测复现、绿测通过。
- 当前验证：Desktop 全量 365 pass / 2 skip；Desktop 与 CLI typecheck 通过；CLI Web 命令 9/9；最终候选 CLI 全量曾为 2161 pass / 5 skip / 3 fail。两项 runtime-config 失败单独复跑通过；复合面板回放在具备受管 Python 的全量运行中进入 `unknown_model_failure`。相关计量文件未在本任务修改范围内。当前续跑时旧 `/tmp` Python 环境已被系统清理，孤立重跑停在 runtime setup；根因仍待有受管 Python 的环境复核。
- 最终共享 UI 窄屏修复已红绿验证；Desktop debug bundle 与 Web 生产构建均在修复后完成。Desktop/Web 默认模式、“1”研究记录、设置分类和 reasoning 折叠行为一致；Web 在 1440×900 / 390×844 可用，手机视图设置面板不再被工作区抽屉遮住。
- `killstata@0.1.30` 最终 12 个包已重新 dry-run；11 个 native + launcher 的 SHA-512 manifest 全部匹配。最终候选已安装到隔离 npm prefix，`--version`、`web --help`、默认 loopback 页面启动和 `--share` 启动通过；当前本机预览服务使用该隔离安装在 `127.0.0.1:3080` 运行。
- 已通过安装包 LAN 分享页连接隔离测试档案：访客选择自己的 workspace 后 Core ready，档案只读且无 API Key；合成文件未提交外部 Provider。LAN 链路只在同一台 Mac 上经私有网卡验证，未用第二台物理设备验收。
- npm registry 仍为 `killstata@0.1.27`；`0.1.30` 未发布。Draft PR #6 已打开，push protection 的 key-shaped 测试夹具已替换为非密钥占位符。上一版 GitHub `typecheck` 因 clean checkout 缺少依赖而失败。
- 已在本地候选补入已提交历史中的 `file-discovery.ts`，并把 28 个被测试引用的 legacy oracle 和 OLS runner fixture 放到包内 test fixtures；测试不再依赖忽略的本机 trash 路径，未复制主工作树修改。CLI typecheck 通过，相关聚焦测试 188/188 通过。此修复尚未提交或推送到 PR。
- 剩余：提交并推送 clean-checkout 修复后等待 GitHub CI；复核 CLI full-suite 门禁；Linux 主机启动及第二台设备验收；真实模型 Provider 未连接。公开发布须等门禁复核和最终用户批准。
- 本轮详细验证记录：`test/desktop-web-parity-2026-10-05.md`。
- 环境验收限制：LAN 页面在同一台 Mac 通过私有网卡打开，尚未用第二台物理设备验收；未连接真实模型服务，也未在 Linux 主机运行原生程序。

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
