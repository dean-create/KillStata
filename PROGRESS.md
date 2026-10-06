# 当前进度

## 桌面/Web 同一界面与本机 CLI 分享体验（2026-10-07）

- 已实现 Desktop/Web 共用研究界面、frontend 默认模式、显式 Core 连接、平台文件/工作区适配、可信 LAN 分享和主机模型只读档案。访客先选择本地 workspace；只有提交连接分析后文件才上传到主机。
- Desktop/Web 的默认模式、“1”研究记录、设置与 reasoning 折叠已做视觉/交互对照；Web 在 1440×900 与 390×844 可用。窄屏设置面板被工作区抽屉遮挡的问题已红绿修复。
- `killstata web` 默认 loopback；显式 `--share` 才开放私有 LAN 访客。候选 `0.1.30` 的 12 个 tarball（11 native + launcher）SHA-512 manifest 匹配，隔离安装的 `--version`、`web --help`、loopback 和 `--share` 启动通过。
- 2026-10-06 对抗审查后收紧分享 API：每次兑换链接生成独立 HttpOnly 会话，访客工作区和 run ID 绑定该会话；必须显式选择受管工作区，不能回退到 CLI 启动目录，也不能跨会话续接旧 Core 授权。浏览器选择已有目录时通过 `workspaces/ensure` 重新绑定。
- 新增 Host→真实 workspace registry 集成回归，确认伪造 `x-killstata-workspace-role: owner` 与伪造 capability 都被拒绝，真实浏览器 capability 可跨 share 会话重绑。最新 Core Host/session/workspace 专项 **29/29**、Desktop 工作区/App 聚焦 **152/152**、Desktop 全量 **368/2 skip**、CLI 与 Desktop typecheck 均通过。Tauri/Web production build 通过且 CSS（`05bdb526…576d4c`）与 Core chunk（`8261a5e5…d50ceb3`）字节一致。新的局域网预览运行于端口 3082，已请求第二台设备做无数据、无模型的页面加载验收。
- 安全补丁后的 `0.1.30` 候选已重新打包：11 个 native + launcher 共 12 个 tarball；发布 dry-run 完成 manifest/SHA-512 校验、registry 计划显示可发布且未实际发布；12 个包均包含 Web index。隔离 npm global prefix 安装后 `killstata --version` 为 `0.1.30`，`web --help`、默认 3080 启动和局域网 `--share` 启动 smoke 均通过，未调用真实 Provider。公网 `latest` 仍是 Windows-only `0.1.27`；发布前仍需最终确认。
- 分享 Run 只接受 UI 定义的 read-only/workspace-write 精确规则、必须显式给出工作区与模型，且模型必须匹配主机当前活动 Provider/model；Full Access、缺省/自定义权限和其他模型均在 Host 门禁拒绝。分享凭据仅返回主机活动模型摘要，profiles 列表、profile ID、Base URL、小模型与 Key 对访客不可见。
- `PermissionNext` 现在保留 Shell execution policy 的逐次 ask，即使用户档位允许 bash；分享访客无法选择 Full Access。Web `/copy` 在不安全 LAN origin 的 Clipboard API 不可用时尝试浏览器复制命令。
- Fresh verification after these changes: CLI Host/session/workspace/permission suites **78 pass / 0 fail**; serial CLI Core full suite **2177 pass / 5 skip / 0 fail** (2182 tests / 309 files / 10624 assertions / 2 snapshots); Desktop full suite **368 pass / 2 skip**. Desktop and CLI typechecks pass. Core full output: `test/web-share-core-full-managed-2026-10-06.log`; next rerun GitHub CI after pushing.
- 安装包分享页已在同一台 Mac 经私有网卡连入隔离测试档案：访客 Core ready、模型档案只读、无 API Key；未提交数据给外部 Provider。第二台物理设备尚未验收。
- 修复上一轮 CI 根因：CI 使用绝对 Python/PYTHONPATH；7 个旧模型测试尊重注入的 `KILLSTATA_PYTHON`；permission safety 测试从 `Global.Path.data` 构造 managed runtime 路径。
- 独立复审发现无效 Hausman 指标与 `random_effects` 推荐可能冲突。展示层对缺失、超范围或自相矛盾指标不显示 FE/RE 推荐，也隐藏不可信 p 值与理由；legacy Schema 校验 df/统计量/p 值/alpha 范围、`rejectRe === (pValue < alpha)` 和模型推荐一致性。反例先红后绿，面板契约+session 输出测试 9/9 通过，含 `p == alpha` 边界。
- 最新完整 GitHub test suite（head `1e84054`，Nix hash bot commit 之前）：**Core 2105 pass / 72 skip / 0 fail**（2177 tests / 309 files）；Desktop/Web 365 pass / 2 skip；Python engine 150 pass。clean checkout 缺失的三条私有 workbook 回放按设计跳过。
- Desktop 全量在并行 Web build 下重复暴露一项 5.09 秒用例超时；同一用例隔离耗时 1.99 秒。仅将该 parity 测试的单项限制调为 10 秒后，全量 Desktop **365 pass / 2 skip**；Desktop typecheck 和 Web 生产构建通过。
- 三个 scripted DID 用例已改用 `hasLocalRealData` / `localRealDataPath`：无 workbook 显式 skip，有本地 workbook 继续完整运行。clean-data 模拟 3 skip / 3 pass / 0 fail；私有本地 workbook 下 6 pass / 0 fail，数据仍未跟踪。
- 独立 `typecheck` 已在 `ubuntu-latest` 通过。Nix updater 修复了可选 `patches/` 和缺失 `desktop/` workspace 后通过，并自动更新四个平台的 `nix/hashes.json`，提交 `6f9e36f`。GitHub 不会自动启动 bot commit 后续工作流；需用人类提交触发最终 head 检查。
- npm registry 仍为 `killstata@0.1.27`；候选 `0.1.30` 未发布。尚待：新 GitHub CI、Linux 主机启动、第二台设备访问、真实 Provider 验收及发布审批。
- 本轮详细验证记录：`test/desktop-web-parity-2026-10-05.md`。

- 运行形态评估：DSH 官方默认 `dsh web` 仅在本机回环启动并打开浏览器；公网/代理访问属于额外配置。KillStata 采用“npm 分发 CLI + 本机启动同源 Web/Core”的模式，不需要 Docker、远程登录系统或托管站点；SSH 端口转发保持回环边界，可信私有 LAN 分享则显式用 `--share` 且为明文 HTTP。当前 npm `latest` 仍不含 Web 候选，安装命令需等 Web 版正式发布后才可用。
- 两阶段工作区回归：先观察到 `/prepare` 签发 capability 后页面重载，访客 `/ensure` 对尚未登记的 ID 返回 404；同时 Host 仍引用已删除的 session 准备方法，分享创建报 `TypeError`。修复后只用服务端短时 capability 完成 registry 登记，不保留重复 session 准备状态；无效 token 仍拒绝，浏览器刷新和不同分享会话均可通过真实 token 安全续接。registry/Host 针对性回归 **2/2**，Host/session/workspace/permission + CLI Web 套件 **52/52**；Desktop picker/App **156/156**，Desktop 全量 **372/2 skip**；CLI 与 Desktop typecheck 均通过，Core 全量正在运行。
- 对抗审查发现第二个 P2：独立 Web Host 并发读改写共享的 `workspaces.json` 会让多个成功创建只保留最后一条。先红测复现 6 个 registry 同时写入仅落盘 1 条；新增 `proper-lockfile` 跨进程互斥后，6 个并发 registry 与两个独立 Bun Host 进程都保留全部工作区。修复后 Host/session/workspace/permission + CLI Web 套件 **55/55**、CLI typecheck 通过；新增时钟推进回归证明 60 秒过期 capability 被拒绝且不创建工作区；锁覆盖进程崩溃后的 stale lease 回收。
- 跨进程锁修复后的串行 Core 全量 **2181 pass / 5 skip / 0 fail**（2186 tests / 309 files / 10653 assertions / 2 snapshots），5 个 skip 是本机缺少私有数据 fixture 的集成场景；日志 `test/web-share-core-full-managed-2026-10-07-final.log`。Desktop 全量 **372 pass / 2 skip**，日志 `test/desktop-web-parity-2026-10-07.log`；CLI 与 Desktop typecheck 均通过。
- 最终产物复核：Web `build:web` 与 Desktop `build` 都通过；Tauri/Web CSS SHA-256 同为 `05bdb52640fa6be5c756a34aca687f88133231bee24d2fd6f0182e0075576d4c`，Core chunk 同为 `8261a5e51510afea7347ee6c40e783127639b88b158982711196012d6d50ceb3`。`0.1.30` 重打包 12/12 tarball 均含相同 Web `index.html`；npm dry-run 列出 11 个平台包+launcher 且未发布。隔离 npm prefix 本地安装后 `killstata --version`=`0.1.30`、`web --help` 正常；`killstata web --port 0 --no-open` 绑定回环并成功返回 Web HTML 200，Ctrl+C 后端口关闭，未提交数据或调用 Provider。
- 2026-10-07 继续验收：系统已有全局 `dsh 0.2.0-rc.2`；因 KillStata 占用默认 3080，使用 `dsh web --no-open --port 3081` 启动参考 UI，回环 HTTP 返回 200 后关闭。另用隔离 XDG 配置、无模型凭据的 `0.1.30` 启动新 LAN 预览 `--share --port 0`；本机经 LAN 地址访问返回 HTML 200。通过已安装的 Darwin arm64 二进制走完访客 `/prepare`→`/workspaces`，HTTP 200/201；登记前 registry 仍为空，登记后仅保存 token 哈希。端口 62841 服务当前保持运行，分享 token 一小时有效；另一台物理设备验收仍待用户反馈。
- 同步发现：PID 37471 的本机 KillStata Web 仍监听 3080；PID 28969 的旧源码分享服务仍监听 3082。均未擅自停止。新隔离体验服务单独监听 62841，数据/模型目录隔离在 `/tmp/killstata-web-share-preview-2026-10-07`。
- 当前 npm `latest` 仍为 `0.1.27` Windows x64-only；新候选 `0.1.30` 包含 11 个平台原生包，超出此前 Windows-only 发布决定。候选代码与隔离安装已验证，但发布平台策略需要用户明确选择；未推送新改动，因此没有当前 head GitHub CI。仍待第二台实体设备、Linux 主机和真实 Provider 验收；npm 发布未进行。
- 当轮日志：`test/desktop-web-parity-2026-10-07.log`、`test/web-share-focused-2026-10-07.log`、`test/web-share-core-full-managed-2026-10-07-final.log`、`test/killstata-pack-release-0.1.30-2026-10-07.log`、`test/killstata-release-dry-run-0.1.30-2026-10-07.log`。

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
