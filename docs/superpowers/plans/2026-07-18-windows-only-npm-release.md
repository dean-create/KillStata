# Windows-only npm Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 npm 正式发布收缩为 Windows x64：只发布 `killstata-windows-x64` 与 `killstata` 两个包。

**Architecture:** 保留 launcher + 单一 Windows 原生二进制的现有结构，不引入新安装器或运行时。发布 manifest 继续是唯一真相来源：它仅接受一个 Windows 原生包，主包的 `optionalDependencies` 必须精确引用它；构建脚本也只生成这一个二进制。

**Tech Stack:** Bun、TypeScript、npm registry、bun:test。

## Global Constraints

- 仅支持 `win32/x64`；不保留 macOS、Linux、Windows baseline 或 ARM64 的 npm 分发。
- 只发两个 tarball：`killstata-windows-x64` 在前，`killstata` 在后。
- 不改变用户本地源码开发能力；本次只收缩 npm 原生二进制分发面。
- 同一个 `name@version` 不可覆盖；0.1.26 尚未发布时才可用该版本重新打包。

---

### Task 1: 固化 Windows-only 发布契约

**Files:**
- Modify: `packages/killstata/test/release/release-core.test.ts`
- Modify: `packages/killstata/script/release-core.ts`

**Interfaces:**
- Produces: `EXPECTED_NATIVE_PACKAGE_NAMES = ["killstata-windows-x64"]`。
- Produces: `validateReleaseManifest()` 只接受 Windows x64 原生包及精确对应的 launcher 依赖。

- [x] **Step 1: 写失败测试**

```ts
test("authorizes only the Windows x64 native package", () => {
  expect(EXPECTED_NATIVE_PACKAGE_NAMES).toEqual(["killstata-windows-x64"])
})
```

- [x] **Step 2: 确认失败**

Run: `bun test test/release/release-core.test.ts`

Expected: FAIL，因为当前数组仍包含 11 个跨平台原生包。

- [x] **Step 3: 最小实现**

```ts
export const EXPECTED_NATIVE_PACKAGE_NAMES = ["killstata-windows-x64"] as const
```

- [x] **Step 4: 确认通过**

Run: `bun test test/release/release-core.test.ts`

Expected: PASS，且既有 manifest 完整性、发布顺序和冲突预检测试仍为绿。

### Task 2: 只构建和记录两个 npm tarball

**Files:**
- Modify: `packages/killstata/script/build.ts`
- Test: `packages/killstata/test/release/release-core.test.ts`

**Interfaces:**
- Consumes: Task 1 的单一原生包发布契约。
- Produces: `binaries` 仅包含 `{ "killstata-windows-x64": version }`。

- [x] **Step 1: 写失败契约测试**

```ts
test("orders the Windows native package before the launcher", () => {
  const result = validateReleaseManifest(manifest([
    launcher({ "killstata-windows-x64": VERSION }),
    native("killstata-windows-x64"),
  ]))
  expect(result.map((item) => item.name)).toEqual(["killstata-windows-x64", "killstata"])
})
```

- [x] **Step 2: 确认失败或复用 Task 1 的 RED 结果**

Run: `bun test test/release/release-core.test.ts`

Expected: 在 Task 1 实现前失败；Task 1 之后该测试证明两包顺序契约。

- [x] **Step 3: 最小实现**

将 `allTargets` 收缩成唯一 `{ os: "win32", arch: "x64" }`，删除只服务于已删除目标的 `--windows-priority` 分支；保持既有编译、包元数据和输出路径不变。

- [x] **Step 4: 运行真实打包预演**

Run: `bun run --cwd packages/killstata pack:release --version 0.1.26`

Expected: 生成 `killstata-windows-x64-0.1.26.tgz`、`killstata-0.1.26.tgz` 和两条 artifact 的 manifest。

### Task 3: 让公开文档与实际支持范围一致

**Files:**
- Modify: `docs/npm-release.md`
- Modify: `README.md`
- Modify: `packages/killstata/README.md`
- Modify: `PLAN.md`
- Modify: `PROGRESS.md`

**Interfaces:**
- Consumes: Task 1 与 Task 2 的双包发布结果。
- Produces: 文档只承诺 Windows x64 npm 安装；不再声称跨平台 native npm 包。

- [x] **Step 1: 更新说明**

将“12 个 tarball / 11 个平台包 / 跨平台”替换为“2 个 tarball / 一个 Windows x64 native package”；安装文档明确非 Windows 用户不在此 npm 发布支持范围内。

- [x] **Step 2: 最终验证**

Run: `bun test test/release/release-core.test.ts && bun run typecheck && bun run script/pack-release.ts --version 0.1.26 && bun run script/release.ts --version 0.1.26 --dry-run && git diff --check`

Expected: 测试、类型检查、两包构建和 registry dry-run 均通过；不上传 npm。
