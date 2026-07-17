# npm Release Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 KillStata 的 npm 多平台发布整理成显式版本、可恢复、平台包先行、主包最后发布的一条命令。

**Architecture:** `pack-release.ts` 只负责构建和打包，并生成包含 SRI 完整性的发布清单；`release.ts` 只负责 Git/registry 预检、按清单顺序发布和最终核验。纯逻辑放进 `release-core.ts`，用行为测试锁定“主包最后、同完整性续传、不同完整性阻断”。

**Tech Stack:** Bun、TypeScript、npm CLI、Node `crypto`、Bun test。

## Global Constraints

- 不新增第三方依赖。
- npm 版本号必须通过 `--version X.Y.Z` 显式提供，不再根据主包 `latest` 猜下一个版本。
- 全部原生平台包使用同一版本；`killstata` 主包的 `optionalDependencies` 必须与清单完全一致。
- npm 没有多包事务：原生包串行发布，主包最后发布；重跑时仅跳过 registry 上同版本且同完整性的包。
- registry 上同名同版本但完整性不同必须失败，不能覆盖或假装成功。
- 发布脚本不写 Token 文件，不读取 `NPM_TOKEN`；认证交给 npm 标准配置或 Trusted Publishing。
- Docker/GHCR 与 npm 发布解耦，继续由现有独立 GitHub workflow 管理。

---

### Task 1: 用行为测试冻结发布协议

**Files:**
- Create: `packages/killstata/test/release/release-core.test.ts`
- Create: `packages/killstata/script/release-core.ts`

**Interfaces:**
- Produces: `parseReleaseVersion(args): string`、`validateReleaseManifest(manifest): ReleaseArtifact[]`、`planRegistryActions(artifacts, remote): ReleaseAction[]`。

- [x] **Step 1: 写失败测试**

覆盖四个行为：缺少显式版本被拒绝；原生包排在主包之前；主包漏掉任一原生 optionalDependency 被拒绝；同完整性标为 skip、不同完整性标为 conflict。

- [x] **Step 2: 运行 RED**

Run: `bun test test/release/release-core.test.ts`

Expected: FAIL，因为 `release-core.ts` 尚不存在或导出尚未实现。

- [x] **Step 3: 写最小纯逻辑实现**

定义：

```ts
export interface ReleaseArtifact {
  name: string
  version: string
  tarball: string
  integrity: string
  role: "native" | "launcher"
  optionalDependencies?: Record<string, string>
}

export type ReleaseAction =
  | { kind: "publish"; artifact: ReleaseArtifact }
  | { kind: "skip"; artifact: ReleaseArtifact }
  | { kind: "conflict"; artifact: ReleaseArtifact; remoteIntegrity: string }
```

`validateReleaseManifest` 必须返回 native 按名字排序、launcher 最后一项；launcher 恰好一个，且 optionalDependencies 与 native 名称和版本一一对应。

- [x] **Step 4: 运行 GREEN**

Run: `bun test test/release/release-core.test.ts`

Expected: PASS。

---

### Task 2: 把构建打包与外部发布拆开

**Files:**
- Rename: `packages/killstata/script/publish.ts` → `packages/killstata/script/pack-release.ts`
- Modify: `packages/killstata/script/pack-release.ts`
- Modify: `packages/killstata/package.json`
- Test: `packages/killstata/test/release/release-core.test.ts`

**Interfaces:**
- Consumes: `KILLSTATA_VERSION`。
- Produces: `packages/killstata/dist/release-manifest.json`，以及每个平台和主包的 `.tgz`。

- [x] **Step 1: 扩展失败测试**

新增 tarball SRI 格式和 manifest 文件结构测试，要求每条完整性为 `sha512-<base64>`。

- [x] **Step 2: 运行 RED**

Run: `bun test test/release/release-core.test.ts`

Expected: FAIL，因为 manifest 读取/完整性函数不存在。

- [x] **Step 3: 最小化打包脚本**

保留全平台 `build.ts`、当前平台 `--version` 冒烟、launcher 组装和 `bun pm pack`；删除脚本中的 `npm publish`、GitHub archive、Docker buildx 和 `--windows-priority` 分支。对每个 `.tgz` 计算 SHA-512 SRI，写入 manifest。

- [x] **Step 4: 运行 GREEN 与真实 pack smoke**

Run:

```bash
bun test test/release/release-core.test.ts
KILLSTATA_VERSION=0.1.26 bun run script/pack-release.ts
```

Expected: 测试通过；生成 11 个原生包、1 个 launcher 包和一份合法 manifest，当前平台二进制输出 `0.1.26`。

---

### Task 3: 实现可恢复的 npm 发布编排器

**Files:**
- Rename: `packages/killstata/script/release-windows.ts` → `packages/killstata/script/release.ts`
- Modify: `packages/killstata/script/release.ts`
- Modify: `packages/killstata/package.json`
- Test: `packages/killstata/test/release/release-core.test.ts`

**Interfaces:**
- Consumes: `--version X.Y.Z`、`dist/release-manifest.json`、npm 标准认证。
- Produces: 顺序发布日志和 registry 完整性核验结果。

- [x] **Step 1: 写失败测试**

用内存 registry adapter 验证：部分发布后重跑只发布缺失包；冲突时在 publish 前停止；launcher 永远最后调用 publish；发布后远端完整性不一致视为失败。

- [x] **Step 2: 运行 RED**

Run: `bun test test/release/release-core.test.ts`

Expected: FAIL，因为顺序执行器尚未实现。

- [x] **Step 3: 写最小发布器**

正式发布前检查 main/master、clean worktree、与 origin 同步；dry-run 只打包和输出 publish/skip/conflict 计划。真实发布使用 `npm publish <tgz> --access public --tag latest`，每包发布后立即查询 `dist.integrity`，最后验证 `killstata@latest` 指向指定版本。

- [x] **Step 4: 运行 GREEN**

Run: `bun test test/release/release-core.test.ts`

Expected: PASS，且测试不接触真实 npm registry。

---

### Task 4: 收口命令与发布文档

**Files:**
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `packages/killstata/script/guard-source-publish.mjs`
- Modify: `PLAN.md`
- Modify: `PROGRESS.md`
- Create: `test/npm-release-20260718/VERIFICATION.md`

**Interfaces:**
- Produces: 唯一公开命令 `bun run --cwd packages/killstata release:npm --version X.Y.Z [--dry-run]`。

- [x] **Step 1: 删除旧命令文案**

全仓扫描 `release:windows`、`publish:windows`、`pack:publish`、脚本内 `NPM_TOKEN`，活动代码和文档必须清零。

- [x] **Step 2: 写清认证边界**

文档说明本地 granular token 必须有 Read and write + Bypass 2FA；Token 配置由 npm 自己管理，不进入仓库。Trusted Publishing 作为后续无 Token 方案，不伪装成已经配置完成。

- [x] **Step 3: 更新计划和进度**

PLAN 记录架构决策，PROGRESS 记录完成项、验证和剩余的 npm Trusted Publisher 网站配置。

---

### Task 5: 对抗性验证

**Files:**
- Modify: `test/npm-release-20260718/VERIFICATION.md`

- [x] **Step 1: 聚焦测试**

Run: `bun test test/release/release-core.test.ts`

- [x] **Step 2: 类型和回归测试**

Run:

```bash
bun run typecheck
KILLSTATA_PYTHON="$HOME/.killstata/venv/bin/python" bun test
```

- [x] **Step 3: 干运行和发布物检查**

Run:

```bash
bun run release:npm --version 0.1.26 --dry-run
git diff --check
```

Expected: 不上传 registry；清单包含 12 个同版本包；launcher 最后；已存在同完整性可跳过，冲突会明确阻断。

- [x] **Step 4: 对抗性复核**

确认：没有 Token 文件；没有并发 npm publish；没有主包先发布；没有根据 `latest` 自动猜版本；没有 npm 发布顺带推 GHCR；没有修改计量工具并行工作区。
