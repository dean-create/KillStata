import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { filterVerifierReadableArtifactRefs, isVerifierReadableArtifactRef } from "@/runtime/workflow"

describe("verifier artifact readability resolves against the workspace root, not process.cwd", () => {
  test("a real artifact stored under the workspace is readable even when the process cwd differs", async () => {
    // 真实死锁最深根因（2026-07-18，5/5 会话复现）：workflow stage 的 artifactRefs 是相对
    // workspace 根的路径，但 isVerifierReadableArtifactRef 曾用 fs.existsSync(相对路径) 基于
    // process.cwd() 解析。killstata 进程的 cwd 是启动目录（如 packages/killstata），不是数据
    // workspace，于是真实存在的产物被判为不存在 → readableArtifactRefs 全空 → verifier
    // artifacts_present 检查假阳性 block → run.repairOnly=true → 工具目录被锁成
    // [readCore, data_import] → estimator 全程不可见。修复：基于 Instance.directory 解析。
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ks-verifier-artifact-"))
    try {
      const relDir = path.join(".killstata", "datasets", "did_x", "meta")
      fs.mkdirSync(path.join(workspace, relDir), { recursive: true })
      const relArtifact = path.join(relDir, "stage_000_schema.json")
      fs.writeFileSync(path.join(workspace, relArtifact), '{"ok":true}', "utf-8")

      // 前置条件：进程 cwd 下这个相对路径确实不存在——否则测不出 cwd 依赖的 bug。
      expect(fs.existsSync(relArtifact)).toBe(false)

      await Instance.provide({
        directory: workspace,
        fn: async () => {
          // 修复后：基于 Instance.directory 解析，找到真实产物，判为可读。
          expect(isVerifierReadableArtifactRef(relArtifact)).toBe(true)
          // 一个真实存在、一个缺失：过滤后只保留存在的那个，且非空（非空正是 verifier 放行的前提）。
          expect(filterVerifierReadableArtifactRefs([relArtifact, "missing/none.json"])).toEqual([relArtifact])
        },
      })
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })
})
