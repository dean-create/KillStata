# npm 多平台 CLI 发布

KillStata 通过一个跨平台 launcher 和 11 个原生运行时包分发 `killstata web` 与终端 CLI。`packages/killstata/script/release-core.ts` 是原生包名单的权威来源：

- macOS：arm64、x64、x64-baseline
- Linux：arm64、arm64-musl、x64、x64-baseline、x64-musl、x64-baseline-musl
- Windows：x64、x64-baseline

一次正式 release 包含 11 个原生 tarball 和 `killstata` launcher tarball。构建/发布命令为：

```bash
# 只构建和打包，不访问 npm 写接口
bun run --cwd packages/killstata pack:release --version 0.1.30

# 完整预演：构建、计算完整性、查询 registry，但不上传
bun run --cwd packages/killstata release:npm --version 0.1.30 --dry-run
```

正式发布只能从与远端同步、工作树干净的 `main`/`master` 执行：

```bash
bun run --cwd packages/killstata release:npm --version 0.1.30
```

## 包是怎么组成的

`killstata` 是 launcher package，包含 Node 启动脚本、Web 静态资源、引擎文件和可选原生依赖元数据。每个原生包只含该目标平台的可执行文件与配套资源。npm 根据包的 `os`/`cpu` 元数据安装当前系统的包；launcher 再根据 Node 诊断报告中 `glibcVersionRuntime` 选择 Linux glibc 或 musl 变体。

launcher 的 `optionalDependencies` 将每个原生包固定到同一个精确版本；安装脚本检查目标包是否就绪。launcher 会优先选择当前 libc 对应的 Linux 二进制，缺少运行时报告时优先 musl。

## npm 发布的三个关键概念

1. **Tarball**：`npm publish` 上传的是由 `package.json` 和文件内容打成的 `.tgz`，不是整个 Git 仓库。
2. **不可变版本**：同一个 `name@version` 发布后不能用另一份内容覆盖。代码变了就必须换版本号。
3. **Dist-tag**：`latest` 只是指向某个已发布版本的可移动指针；`npm i killstata@latest` 会先解析该指针。

因此，多个包不能真正做到数据库式原子提交。KillStata 使用下面的安全顺序模拟事务：

```text
显式版本 → 11 个平台构建 → 12 个 tarball → SHA-512 manifest
        → registry 冲突预检 → native packages 上传
        → 每包完整性复查 → launcher 最后上传 → 校验 latest
```

launcher 最后发布很关键：只要 launcher 的 `latest` 尚未切换，普通用户就不会安装到一组尚未齐全的
新平台包。

## 为什么版本必须显式指定

不能只查看 `killstata@latest` 后自动加一。一次中断的发布可能已经占用了某些 native package 的版本，
但 launcher 仍停留在旧版本；只看 launcher 会再次选择已经不可变的版本，造成 403/版本冲突。

现在必须明确传入 `--version X.Y.Z`。脚本还会验证：

- 12 个包版本完全相同；
- native package 名单必须精确等于 `EXPECTED_NATIVE_PACKAGE_NAMES`；
- launcher 的 `optionalDependencies` 必须覆盖 11 个原生目标；
- 每个 tarball 的 SHA-512 SRI 完整性，并在 registry 预检前和每次上传前重新计算；
- registry 已存在的同版本内容是否与本地一致；上传后最多等待约 44 秒让 npm registry 传播，再确认完整性。

所有 npm 查询、发布和 dist-tag 操作都显式固定到 `https://registry.npmjs.org/`，避免本机自定义
registry 把发布悄悄导向私有镜像。

## 中断后怎么恢复

直接用同一个版本重跑即可：

- registry 不存在：`publish`；
- 已存在且完整性相同：`skip`；
- 已存在但完整性不同：`conflict` 并在上传任何新包前停止。

遇到 conflict 不要试图覆盖或 unpublish；确认本地构建正确后换一个新版本重新发布。

## 认证

发布脚本不接收 Token 参数，也不创建临时 `.npmrc`。认证完全交给 npm 标准配置：

```bash
npm whoami
```

本地使用 granular access token 时，至少需要 package `Read and write` 权限；如果账号或包要求 2FA，
Token 还必须启用 `Bypass two-factor authentication`，否则 `npm publish` 会进入网页/TOTP 验证。
Token 不得写入仓库、命令参数、文档或聊天记录。

更长期的方案是 npm Trusted Publishing + GitHub Actions OIDC。它不需要长期 Token，但必须先在 npm
网站为每个现有包配置 trusted publisher；新包的首次发布仍需由有权限的账号完成。项目目前没有把这项
外部配置冒充成已完成。

## 与 GitHub Release / GHCR 的关系

npm、GitHub Release 和 GHCR 是三个不同 registry。npm 发布脚本不再顺带创建压缩包或推 Docker 镜像：

- npm：`release:npm`
- GitHub Release：`.github/workflows/release-cli.yml`
- GHCR：`.github/workflows/publish-ghcr.yml`

拆开后任一渠道失败都不会污染另外两个渠道，也不会要求发布者为了发 npm 先配置 Docker buildx。
