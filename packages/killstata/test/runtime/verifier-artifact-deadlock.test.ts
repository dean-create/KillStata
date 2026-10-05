/**
 * 2026-08-05 用户真实测试死锁的回归锁。
 *
 * 现场：QA 两次成功，verifier 却报 "No saved artifacts were found for the current stage."
 * （artifactCount=0），估计门禁于是说"请先完成数据质检"，模型重跑 QA → 再次被拦 → 死循环。
 *
 * 三条根因各锁一条：
 *   1. workspace 根解析不到时，存在的产物被判为缺失（artifact.ts）
 *   2. readableArtifactRefs 被写成空数组后 `??` 短路，stage 永久毒化（rerun.ts）
 *   3. "QA 没跑" 与 "QA 被拦" 共用一句文案，模型只能反复重跑（stage.ts）
 */

import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { filterVerifierReadableArtifactRefs, recordWorkflowStageSuccess, runAutomaticVerifier } from "@/runtime/workflow"
import { assertDatasetStageReadyForEstimation } from "@/runtime/workflow/stage"
import { readWorkflowSession, writeWorkflowSession } from "@/runtime/workflow/state"
import { createDatasetManifest, appendStage } from "@/tool/analysis-state"

async function withInstance<T>(fn: (root: string) => Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-verifier-"))
  try {
    return await Instance.provide({ directory: root, fn: () => fn(root) })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("verifier artifact deadlock", () => {
  test("无 instance 上下文时不沿用上一项目的 workspace 根", async () => {
    // 真实现场：产物在 workspace 根下，进程 cwd 是另一个目录（packages/killstata）。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-ws-"))
    const ref = ".killstata/datasets/d/reports/validate.json"
    fs.mkdirSync(path.dirname(path.join(root, ref)), { recursive: true })
    fs.writeFileSync(path.join(root, ref), "{}")
    try {
      // cwd 下不存在这个相对路径——只有 workspace 根解析对了才找得到。
      expect(fs.existsSync(path.resolve(process.cwd(), ref))).toBe(false)

      // 有上下文：必须找到（这一步同时把 workspace 根记进兜底缓存）。
      await Instance.provide({
        directory: root,
        fn: async () => {
          expect(filterVerifierReadableArtifactRefs([ref])).toEqual([ref])
        },
      })

      // 无上下文时不能复用进程级 last-known root，否则并发项目会读取另一项目的同名产物。
      // 新写入的 workflow stage 已保存绝对引用；历史相对引用只能在显式 Instance 内修复。
      expect(filterVerifierReadableArtifactRefs([ref])).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  // dev TUI 下 Instance.directory 是 packages/killstata，而 .killstata 挂在
  // projectRoot()（= Instance.worktree）。曾把 readableArtifactRefs 按 directory 解析成
  // 绝对路径写盘，产出 /…/packages/killstata/.killstata/… 这种不存在的路径；且绝对路径会
  // 让多基准兜底短路，一次写错永久锁死。
  test("directory 与 worktree 不同时，记录的产物引用必须仍可解析", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-wt-"))
    try {
      Bun.spawnSync(["git", "init", "-q"], { cwd: root })
      const sub = path.join(root, "packages", "killstata")
      fs.mkdirSync(sub, { recursive: true })
      const rel = ".killstata/datasets/d/audit/log.md"
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), "# log")

      await Instance.provide({
        directory: sub,
        fn: async () => {
          // 前提：本用例要复现的就是 directory ≠ worktree 的情形
          expect(Instance.directory).not.toBe(Instance.worktree)

          const { stage } = recordWorkflowStageSuccess({
            sessionID: "wt-case",
            toolName: "data_import",
            args: { action: "import", datasetId: "d", stageId: "stage_000" },
            metadata: { action: "import", datasetId: "d", stageId: "stage_000", result: { log_path: rel } },
          })
          expect(stage.readableArtifactRefs?.length).toBeGreaterThan(0)
          for (const ref of stage.readableArtifactRefs ?? []) {
            // 基准必须是 worktree（.killstata 的挂载点），不能是 directory
            expect(ref.startsWith(Instance.worktree)).toBe(true)
            expect(ref.startsWith(path.join(Instance.directory, ".killstata"))).toBe(false)
            // 最硬的断言：写进去的路径必须真的指向磁盘上存在的产物
            expect(fs.existsSync(ref), `写入的产物引用必须真实存在：${ref}`).toBe(true)
          }
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("readableArtifactRefs 非空但全部失效时，必须回落 artifactRefs 自愈", async () => {
    await withInstance(async (root) => {
      const good = ".killstata/datasets/d/audit/log.md"
      fs.mkdirSync(path.dirname(path.join(root, good)), { recursive: true })
      fs.writeFileSync(path.join(root, good), "# log")

      const sessionID = "poisoned"
      const state = readWorkflowSession(sessionID)
      state.runs.push({
        workflowRunId: "wf_poison",
        sessionID,
        workflowMode: "econometrics",
        workflowLocale: "zh-CN",
        datasetId: "d",
        branch: "main",
        activeStage: "import",
        stageSequence: [],
        edges: [],
        trustedArtifacts: [],
        stages: [
          {
            nodeId: "main:stage_000",
            stageId: "stage_000",
            kind: "import",
            status: "completed",
            branch: "main",
            datasetId: "d",
            replayInput: { datasetId: "d", stageId: "stage_000" },
            metadata: { datasetId: "d", stageId: "stage_000" },
            artifactRefs: [good],
            // 历史 bug 写坏的形态：非空，但全部指向不存在的 packages/killstata 绝对路径
            readableArtifactRefs: [path.join(root, "packages", "killstata", good)],
            trustedArtifacts: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as never)
      state.activeRunId = "wf_poison"
      writeWorkflowSession(state)

      const verified = await runAutomaticVerifier({
        sessionID,
        stageId: "stage_000",
        messageID: "m",
        agent: "general",
        model: { providerID: "p", modelID: "m" },
      } as never)

      const artifactsCheck = verified?.report.checks.find((c) => c.key === "artifacts_present")
      expect(artifactsCheck?.status).toBe("pass")
      expect(verified?.report.blockingFindings ?? []).not.toContain(
        "No saved artifacts were found for the current stage.",
      )
    })
  }, 120_000)

  test("QA 被校验器阻断时，门禁必须指出真正的阻断原因而不是让模型重跑质检", async () => {
    await withInstance(async () => {
      const sessionID = "verifier-deadlock"
      const datasetId = "ds_block"
      const stageId = "stage_000"

      const manifest = createDatasetManifest({ datasetId, sourcePath: "/tmp/x.csv", sourceFormat: "csv" })
      appendStage(manifest, {
        stageId,
        branch: "main",
        action: "import",
        workingPath: "/tmp/x.csv",
        workingFormat: "parquet",
        createdAt: new Date().toISOString(),
      })

      const state = readWorkflowSession(sessionID)
      state.runs.push({
        workflowRunId: "wf_block",
        sessionID,
        workflowMode: "econometrics",
        workflowLocale: "zh-CN",
        datasetId,
        branch: "main",
        activeStage: "baseline_estimate",
        stageSequence: [],
        edges: [],
        trustedArtifacts: [],
        stages: [
          {
            nodeId: "main:p",
            stageId: "p",
            kind: "profile_or_schema_check",
            status: "completed",
            branch: "main",
            datasetId,
            replayInput: { datasetId, stageId },
            metadata: { datasetId, stageId },
            artifactRefs: [],
            trustedArtifacts: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          {
            nodeId: "main:q",
            stageId: "q",
            kind: "validate",
            status: "completed",
            branch: "main",
            datasetId,
            replayInput: { datasetId, stageId },
            metadata: { datasetId, stageId },
            artifactRefs: [],
            trustedArtifacts: [],
            verifierReport: {
              status: "block",
              checks: [],
              blockingFindings: ["No saved artifacts were found for the current stage."],
              repairHints: ["Regenerate the missing artifacts before continuing."],
              trustedArtifacts: [],
              createdAt: new Date().toISOString(),
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as never)
      state.activeRunId = "wf_block"
      writeWorkflowSession(state)

      let message = ""
      try {
        assertDatasetStageReadyForEstimation({ sessionID, datasetId, stageId })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }

      // 关键：不能再是那句会让模型无限重跑的"请先完成数据质检"
      expect(message).not.toContain("请先完成数据质检")
      expect(message).toContain("已经执行过")
      expect(message).toContain("No saved artifacts were found")
      expect(message).toContain("不要反复重跑质检")
    })
  })

  test("recordWorkflowStageSuccess 把 readableArtifactRefs 写成绝对路径，避开 cwd 兜底错", async () => {
    // 真实死锁（2026-08-06 did_7f1335de）：readableArtifactRefs 用相对路径写入，
    // verifier 跑在 postTool 异步续体里拿不到 Instance.directory，回退 cwd
    // （packages/killstata）解析相对路径失败 → existsSync 假阳性 → filterVerifierReadableArtifactRefs
    // 把所有产物过滤掉 → readableArtifactRefs=[] → 毒化 stage。修法：写入前用
    // Instance.directory 解析为绝对路径，verifier existsSync 不再受 ALS 上下文丢失影响。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-absolute-"))
    const sessionID = "ses_absolute_path"
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          // 把 validate.json 实际写到 workspace 根，否则 verifierReadableArtifactRefs 过滤时
          // existsSync 失败会把产物从 readableArtifactRefs 中过滤掉
          const qaPath = path.join(root, ".killstata/datasets/ds_abs/reports/main/stage_000_validate.json")
          fs.mkdirSync(path.dirname(qaPath), { recursive: true })
          fs.writeFileSync(qaPath, "{}")
          const manifest = createDatasetManifest({
            datasetId: "ds_abs",
            sourcePath: path.join(root, "x.csv"),
            sourceFormat: "csv",
            workingFormat: "parquet",
          })
          appendStage(manifest, {
            stageId: "stage_000",
            runId: "run_abs",
            branch: "main",
            action: "import",
            workingPath: path.join(root, ".killstata/datasets/ds_abs/stages/import.parquet"),
            workingFormat: "parquet",
            createdAt: new Date().toISOString(),
          })
          const state = { version: 1 as const, sessionID, activeRunId: undefined, runs: [] }
          writeWorkflowSession(state)
          const { stage } = recordWorkflowStageSuccess({
            sessionID,
            toolName: "data_import",
            args: { action: "validate", datasetId: "ds_abs", stageId: "stage_000" },
            metadata: {
              output: "ok",
              outputPath: ".killstata/datasets/ds_abs/reports/main/stage_000_validate.json",
            },
          })
          expect(stage.readableArtifactRefs?.length).toBeGreaterThan(0)
          for (const ref of stage.readableArtifactRefs ?? []) {
            expect(path.isAbsolute(ref), `readableArtifactRefs 必须是绝对路径：${ref}`).toBe(true)
          }
        },
      })    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("dev 启动（directory=packages/killstata）下数据集相对路径仍能通过存在性检查", async () => {
    // 真实死锁（2026-08-06 did_7f1335de 连续第 3 个会话复现）：
    // - Instance.directory = packages/killstata（bun run --cwd packages/killstata）
    // - 数据集根 = Instance.worktree（项目根，.killstata 挂项目根下）
    // - filterVerifierReadableArtifactRefs 只按 directory/cwd 解析 → .killstata/... 相对路径
    //   解析到 packages/killstata/.killstata/... → 不存在 → readableArtifactRefs 恒为 [] → ARTIFACT_MISSING。
    // 修复：候选基准扩为 [worktree, directory, cwd]，三者都试过才判不存在。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-devstart-"))
    try {
      // 模拟 dev 启动：directory 指向"包目录"（root/packages/killstata），数据挂在"项目根"（root/.killstata）
      const packageDir = path.join(root, "packages", "killstata")
      fs.mkdirSync(packageDir, { recursive: true })
      const qaPath = path.join(root, ".killstata/datasets/did_dev/reports/main/validate.json")
      fs.mkdirSync(path.dirname(qaPath), { recursive: true })
      fs.writeFileSync(qaPath, "{}")

      await Instance.provide({
        directory: packageDir,
        fn: async () => {
          // 数据集相对路径（data_import result.output_path 的形态，基准是项目根 .killstata）
          const ref = ".killstata/datasets/did_dev/reports/main/validate.json"
          const filtered = filterVerifierReadableArtifactRefs([ref])
          expect(filtered, "worktree 根下真实存在的产物必须通过存在性检查").toContain(ref)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
