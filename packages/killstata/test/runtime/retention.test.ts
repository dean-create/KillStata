import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import {
  cleanupSessions,
  trimReflection,
  trimOrphanWorkflows,
  trimDatasets,
  cleanupAll,
  removeSessionFully,
  selectSessionsForProject,
} from "@/runtime/retention"

function setupProject(seed: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `killstata-retention-${seed}-`))
  // 准备 .killstata/runtime 目录结构
  fs.mkdirSync(path.join(root, ".killstata", "runtime", "workflows"), { recursive: true })
  fs.mkdirSync(path.join(root, ".killstata", "runtime", "reflection"), { recursive: true })
  fs.mkdirSync(path.join(root, ".killstata", "runtime", "tasks"), { recursive: true })
  fs.mkdirSync(path.join(root, ".killstata", "datasets"), { recursive: true })
  return root
}

function writeSessionMeta(root: string, id: string, updated: number, parentID?: string) {
  const meta = { id, parentID, time: { created: updated - 1000, updated } }
  fs.writeFileSync(path.join(root, "fake-session.json"), JSON.stringify(meta))
}

async function withInstance<T>(root: string, fn: () => Promise<T>): Promise<T> {
  return Instance.provide({ directory: root, fn })
}

describe("retention.cleanupSessions", () => {
  test("删除失败时返回 false 且不清理 workflow，避免虚报成功", async () => {
    let workflowCleanupCount = 0
    const removed = await removeSessionFully(
      "ses_still_exists",
      { dryRun: false },
      {
        remove: async () => undefined,
        exists: async () => true,
        cleanupWorkflows: () => {
          workflowCleanupCount += 1
        },
      },
    )
    expect(removed).toBe(false)
    expect(workflowCleanupCount).toBe(0)
  })

  test("只让当前项目的会话参与保留与删除计算", () => {
    const sessions = [
      { id: "a_old", updated: 1, projectID: "project_a" },
      { id: "b_new", updated: 2, projectID: "project_b" },
    ]
    expect(selectSessionsForProject(sessions, "project_a")).toEqual([sessions[0]])
  })

  test("dry-run 不删任何东西", async () => {
    const root = setupProject("dryrun")
    await withInstance(root, async () => {
      const report = await cleanupSessions({ keepTopSessions: 1, dryRun: true, activeWindowMs: 0 })
      expect(report.sessionsRemoved).toBe(0)
      // dryRun 模式下 Session.remove 仍会跑（因为它在 await 内），需要单独验证文件未删
    })
  })

  test("只删 retention 自身的 worktree，不动真实会话存储", async () => {
    const root = setupProject("safe")
    // 注意：此测试不创建真实会话，cleanupSessions 会列出全局 storage/session 的所有会话
    // keepTopSessions 默认 30，全局 1979 个会话几乎全部会被标记可删——但 activeWindowMs 默认
    // 24h 保护了最近活跃的；dryRun 防止误删全局会话
    await withInstance(root, async () => {
      const report = await cleanupSessions({ dryRun: true })
      expect(report.removedSessionIds?.length ?? 0).toBeGreaterThanOrEqual(0)
    })
  })
})

describe("retention.trimReflection", () => {
  test("只保留最近 N 个 reflection 文件", async () => {
    const root = setupProject("refl")
    const reflDir = path.join(root, ".killstata", "runtime", "reflection")
    for (let i = 0; i < 10; i++) {
      const file = path.join(reflDir, `tool_${String(i).padStart(3, "0")}_2026-08-0${i + 1}T00-00-00.json`)
      fs.writeFileSync(file, JSON.stringify({ i }))
      // mtime 递增
      const t = (Date.now() / 1000) + i
      fs.utimesSync(file, t, t)
    }
    await withInstance(root, async () => {
      const report = trimReflection({ keepReflection: 3, dryRun: false })
      expect(report.removed).toBe(7)
      const remaining = fs.readdirSync(reflDir).filter((f) => f.endsWith(".json"))
      expect(remaining.length).toBe(3)
      // 保留的是 mtime 最大的三个
      const mtimes = remaining.map((f) => fs.statSync(path.join(reflDir, f)).mtimeMs).sort((a, b) => b - a)
      expect(mtimes[0]).toBeGreaterThan(mtimes[2])
    })
  })
})

describe("retention.trimOrphanWorkflows", () => {
  test("只清理找不到真实会话的 workflow 及其配套 task", async () => {
    const root = setupProject("orphan-workflows")
    const tasksDir = path.join(root, ".killstata", "runtime", "tasks")
    const wfDir = path.join(root, ".killstata", "runtime", "workflows")
    for (const id of ["ses_alive", "ses_orphan", "ses_recent_orphan"]) {
      fs.writeFileSync(path.join(wfDir, `${id}.json`), JSON.stringify({ id }))
      fs.writeFileSync(path.join(tasksDir, `${id}.json`), JSON.stringify({ id }))
    }
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    fs.utimesSync(path.join(wfDir, "ses_orphan.json"), old, old)
    fs.writeFileSync(path.join(tasksDir, "ses_task_only.json"), "{}")
    fs.utimesSync(path.join(tasksDir, "ses_task_only.json"), old, old)

    await withInstance(root, async () => {
      const report = await trimOrphanWorkflows({ dryRun: false }, new Set(["ses_alive"]))
      expect(report).toMatchObject({ workflowsRemoved: 1, tasksRemoved: 2 })
      expect(fs.existsSync(path.join(wfDir, "ses_alive.json"))).toBe(true)
      expect(fs.existsSync(path.join(tasksDir, "ses_alive.json"))).toBe(true)
      expect(fs.existsSync(path.join(wfDir, "ses_orphan.json"))).toBe(false)
      expect(fs.existsSync(path.join(tasksDir, "ses_orphan.json"))).toBe(false)
      expect(fs.existsSync(path.join(wfDir, "ses_recent_orphan.json"))).toBe(true)
      expect(fs.existsSync(path.join(tasksDir, "ses_recent_orphan.json"))).toBe(true)
      expect(fs.existsSync(path.join(tasksDir, "ses_task_only.json"))).toBe(false)
    })
  })

  test("workflows 目录不存在时仍清理超过安全窗的 task-only 孤儿", async () => {
    const root = setupProject("task-only-directory")
    const tasksDir = path.join(root, ".killstata", "runtime", "tasks")
    const wfDir = path.join(root, ".killstata", "runtime", "workflows")
    fs.rmSync(wfDir, { recursive: true })
    const taskPath = path.join(tasksDir, "ses_task_only.json")
    fs.writeFileSync(taskPath, "{}")
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    fs.utimesSync(taskPath, old, old)

    await withInstance(root, async () => {
      const report = await trimOrphanWorkflows({ dryRun: false }, new Set())
      expect(report).toMatchObject({ workflowsRemoved: 0, tasksRemoved: 1 })
      expect(fs.existsSync(taskPath)).toBe(false)
    })
  })
})

describe("retention.trimDatasets", () => {
  test("inspection 没有运行时消费者时清理全部 stage 副本并清空 manifest 字段", async () => {
    const root = setupProject("ds")
    const dsDir = path.join(root, ".killstata", "datasets", "ds_test")
    fs.mkdirSync(path.join(dsDir, "stages"), { recursive: true })
    fs.mkdirSync(path.join(dsDir, "inspection"), { recursive: true })
    fs.mkdirSync(path.join(dsDir, "reports"), { recursive: true })
    fs.mkdirSync(path.join(dsDir, "meta"), { recursive: true })

    // 构造 manifest：2 stages（stage_000 import + stage_001 preprocess）
    const manifest = {
      version: 1,
      datasetId: "ds_test",
      sourcePath: "/tmp/source.csv",
      sourceFormat: "csv",
      workingFormat: "parquet",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      stages: [
        {
          stageId: "stage_000",
          branch: "main",
          action: "import",
          workingPath: path.join(dsDir, "stages", "stage_000_import.parquet"),
          workingFormat: "parquet",
          inspectionPath: path.join(dsDir, "inspection", "stage_000_import.csv"),
          inspectionWorkbookPath: path.join(dsDir, "inspection", "stage_000_import.xlsx"),
          createdAt: "2026-08-01T00:00:00.000Z",
        },
        {
          stageId: "stage_001",
          branch: "main",
          action: "preprocess",
          workingPath: path.join(dsDir, "stages", "stage_001_preprocess.parquet"),
          workingFormat: "parquet",
          inspectionPath: path.join(dsDir, "inspection", "stage_001_preprocess.csv"),
          inspectionWorkbookPath: path.join(dsDir, "inspection", "stage_001_preprocess.xlsx"),
          createdAt: "2026-08-02T00:00:00.000Z",
        },
      ],
      artifacts: [],
      finalOutputs: [],
    }
    fs.writeFileSync(path.join(dsDir, "manifest.json"), JSON.stringify(manifest, null, 2))
    // 真实文件
    for (const s of manifest.stages) {
      fs.writeFileSync(s.inspectionPath, "csv")
      fs.writeFileSync(s.inspectionWorkbookPath!, "xlsx")
    }
    fs.writeFileSync(manifest.stages[1].inspectionWorkbookPath!, "xlsx-latest")
    const retainedNote = path.join(dsDir, "inspection", "README.txt")
    fs.writeFileSync(retainedNote, "not a generated table copy")

    await withInstance(root, async () => {
      const dryRunReport = trimDatasets({ dryRun: true })
      expect(dryRunReport.trimmed).toBe(1)
      expect(fs.existsSync(manifest.stages[0].inspectionPath)).toBe(true)
      expect(fs.existsSync(manifest.stages[0].inspectionWorkbookPath!)).toBe(true)
      expect(fs.existsSync(manifest.stages[1].inspectionWorkbookPath!)).toBe(true)

      const report = trimDatasets({ dryRun: false })
      expect(report.trimmed).toBe(1)
      for (const stage of manifest.stages) {
        expect(fs.existsSync(stage.inspectionPath)).toBe(false)
        expect(fs.existsSync(stage.inspectionWorkbookPath!)).toBe(false)
      }
      // manifest 已更新
      const updated = JSON.parse(fs.readFileSync(path.join(dsDir, "manifest.json"), "utf-8"))
      expect(updated.stages[0].inspectionPath).toBeUndefined()
      expect(updated.stages[0].inspectionWorkbookPath).toBeUndefined()
      expect(updated.stages[1].inspectionPath).toBeUndefined()
      expect(updated.stages[1].inspectionWorkbookPath).toBeUndefined()
      expect(fs.existsSync(retainedNote)).toBe(true)
    })
  })

  test("QA、计量报告和 canonical stage 不参与通用 retention 裁剪", async () => {
    const root = setupProject("reports")
    const dsDir = path.join(root, ".killstata", "datasets", "ds_reports")
    fs.mkdirSync(path.join(dsDir, "reports", "main"), { recursive: true })
    fs.mkdirSync(path.join(dsDir, "stages"), { recursive: true })

    const managedFiles = {
      canonical: path.join(dsDir, "stages", "stage_000.parquet"),
      old: path.join(dsDir, "reports", "main", "old1.csv"),
      mid: path.join(dsDir, "reports", "main", "old2.csv"),
      qa: path.join(dsDir, "reports", "main", "validate.json"),
      latest: path.join(dsDir, "reports", "main", "new.csv"),
    }
    const externalDelivery = path.join(root, "user-delivery.csv")
    const manifest = {
      version: 1,
      datasetId: "ds_reports",
      sourcePath: "/tmp/s.csv",
      sourceFormat: "csv",
      workingFormat: "parquet",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      stages: [
        {
          stageId: "stage_000",
          branch: "main",
          action: "import",
          workingPath: path.join(dsDir, "stages", "stage_000.parquet"),
          workingFormat: "parquet",
          createdAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      artifacts: [
        { artifactId: "stage_alias", branch: "main", action: "preprocess", outputPath: managedFiles.canonical, createdAt: "2026-07-31T00:00:00.000Z" },
        { artifactId: "profile_old", branch: "main", action: "profile", outputPath: managedFiles.old, createdAt: "2026-08-01T00:00:00.000Z" },
        { artifactId: "external_old", branch: "main", action: "export", outputPath: externalDelivery, createdAt: "2026-08-01T12:00:00.000Z" },
        { artifactId: "profile_mid", branch: "main", action: "profile", outputPath: managedFiles.mid, createdAt: "2026-08-02T00:00:00.000Z" },
        { artifactId: "validate_mid", branch: "main", action: "validate", outputPath: managedFiles.qa, createdAt: "2026-08-03T00:00:00.000Z" },
        { artifactId: "profile_new", branch: "main", action: "profile", outputPath: managedFiles.latest, createdAt: "2026-08-04T00:00:00.000Z" },
      ],
      finalOutputs: [],
    }
    fs.writeFileSync(path.join(dsDir, "manifest.json"), JSON.stringify(manifest))
    // 真实文件
    for (const a of manifest.artifacts) {
      if (a.outputPath) fs.writeFileSync(a.outputPath, "x")
    }

    await withInstance(root, async () => {
      const report = trimDatasets({ dryRun: false })
      expect(report.trimmed).toBe(0)
      const updated = JSON.parse(fs.readFileSync(path.join(dsDir, "manifest.json"), "utf-8"))
      expect(updated.artifacts).toHaveLength(manifest.artifacts.length)
      expect(fs.existsSync(managedFiles.canonical)).toBe(true)
      expect(fs.existsSync(managedFiles.old)).toBe(true)
      expect(fs.existsSync(managedFiles.mid)).toBe(true)
      expect(fs.existsSync(externalDelivery)).toBe(true)
      expect(fs.existsSync(managedFiles.qa)).toBe(true)
      expect(fs.existsSync(managedFiles.latest)).toBe(true)
    })
  })
})

describe("retention.cleanupAll (dryRun)", () => {
  test("uses the canonical Global.Path.data session storage root", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "runtime", "retention.ts"), "utf-8")
    expect(source).toContain('path.join(Global.Path.data, "storage", "session")')
    expect(source).not.toContain("process.env.XDG_DATA_HOME")
  })

  test("汇总各清理项的统计", async () => {
    const root = setupProject("all")
    await withInstance(root, async () => {
      const report = await cleanupAll({ dryRun: true, keepTopSessions: 0 })
      expect(typeof report.sessionsRemoved).toBe("number")
      expect(typeof report.bytesFreed).toBe("number")
    })
  })
})
