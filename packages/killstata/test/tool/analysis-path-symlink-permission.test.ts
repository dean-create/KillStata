import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Instance } from "@/project/instance"
import { resolveDatasetStagePath, resolveManagedProjectPath, resolveToolPath } from "@/tool/analysis-path"

test("项目内 symlink 指向项目外时，写路径必须经过 external-directory 确认", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-symlink-workspace-"))
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-symlink-external-"))
  try {
    fs.symlinkSync(external, path.join(workspace, "linked"), "dir")
    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const resolvedWorkspaceRoot = fs.realpathSync(workspace)
        const resolvedExternalRoot = fs.realpathSync(external)
        const approvals: Array<{ permission: string; metadata?: Record<string, unknown> }> = []
        const resolved = await resolveToolPath({
          filePath: "linked/export.csv",
          mode: "write",
          toolName: "data_import",
          sessionID: "session_symlink_export",
          messageID: "message_symlink_export",
          callID: "call_symlink_export",
          ask: async (request) => {
            approvals.push(request as { permission: string; metadata?: Record<string, unknown> })
          },
        })

        expect(approvals).toHaveLength(1)
        expect(approvals[0]?.permission).toBe("external_directory")
        expect(approvals[0]?.metadata?.filepath).toBe(path.join(resolvedExternalRoot, "export.csv"))
        expect(resolved).toBe(path.join(resolvedExternalRoot, "export.csv"))
        expect(fs.existsSync(path.join(resolvedExternalRoot, "export.csv"))).toBe(false)

        const internalPath = await resolveToolPath({
          filePath: "safe/export.csv",
          mode: "write",
          toolName: "data_import",
          sessionID: "session_internal_export",
          messageID: "message_internal_export",
          callID: "call_internal_export",
          ask: async (request) => {
            approvals.push(request as { permission: string; metadata?: Record<string, unknown> })
          },
        })
        expect(internalPath).toBe(path.join(resolvedWorkspaceRoot, "safe", "export.csv"))
        expect(approvals).toHaveLength(1)
      },
    })
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(external, { recursive: true, force: true })
  }
})

test("规范化数据阶段和新阶段输出不能通过 symlink 逃逸受管数据根", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-managed-stage-workspace-"))
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-managed-stage-external-"))
  const datasetRoot = path.join(workspace, ".killstata", "datasets", "dataset_safe")
  const stages = path.join(datasetRoot, "stages")
  try {
    fs.mkdirSync(stages, { recursive: true })
    const outsideInput = path.join(external, "private.parquet")
    const linkedInput = path.join(stages, "stage_000.parquet")
    fs.writeFileSync(outsideInput, "private data")
    fs.symlinkSync(outsideInput, linkedInput)
    fs.symlinkSync(external, path.join(datasetRoot, "outputs"), "dir")

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        await expect(resolveDatasetStagePath({
          datasetId: "dataset_safe",
          filePath: linkedInput,
          toolName: "ols_regression",
          sessionID: "session_stage_symlink",
          messageID: "message_stage_symlink",
          callID: "call_stage_symlink",
          ask: async () => undefined,
        })).rejects.toThrow(/受管数据目录之外|受管数据路径包含符号链接/)

        expect(() => resolveManagedProjectPath({
          filePath: path.join(datasetRoot, "outputs", "child.parquet"),
          managedRoot: datasetRoot,
        })).toThrow(/受管数据目录之外|受管数据路径包含符号链接/)
      },
    })
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(external, { recursive: true, force: true })
  }
})

test("数据阶段不能借用同一项目中另一个数据集的文件", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-cross-dataset-workspace-"))
  const datasetA = path.join(workspace, ".killstata", "datasets", "dataset_a", "stages", "stage_000.parquet")
  const datasetB = path.join(workspace, ".killstata", "datasets", "dataset_b", "stages", "stage_000.parquet")
  try {
    fs.mkdirSync(path.dirname(datasetA), { recursive: true })
    fs.mkdirSync(path.dirname(datasetB), { recursive: true })
    fs.writeFileSync(datasetA, "dataset A")
    fs.writeFileSync(datasetB, "dataset B")
    await Instance.provide({
      directory: workspace,
      fn: async () => {
        await expect(resolveDatasetStagePath({
          datasetId: "dataset_a",
          filePath: datasetB,
          toolName: "ols_regression",
          sessionID: "session_cross_dataset_stage",
          messageID: "message_cross_dataset_stage",
          callID: "call_cross_dataset_stage",
          ask: async () => undefined,
        })).rejects.toThrow(/当前数据集|其他数据集/)
      },
    })
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test("同一数据集中的阶段 symlink 不能静默切换到另一个 stage", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-stage-swap-workspace-"))
  const stages = path.join(workspace, ".killstata", "datasets", "dataset_stage_swap", "stages")
  const oldStage = path.join(stages, "stage_000.parquet")
  const currentStage = path.join(stages, "stage_003.parquet")
  try {
    fs.mkdirSync(stages, { recursive: true })
    fs.writeFileSync(currentStage, "newer stage")
    fs.symlinkSync(currentStage, oldStage)
    await Instance.provide({
      directory: workspace,
      fn: async () => {
        await expect(resolveDatasetStagePath({
          datasetId: "dataset_stage_swap",
          filePath: oldStage,
          toolName: "ols_regression",
          sessionID: "session_stage_swap",
          messageID: "message_stage_swap",
          callID: "call_stage_swap",
          ask: async () => undefined,
        })).rejects.toThrow(/符号链接|阶段文件/)
      },
    })
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test("真实路径别名不能绕过受管目录内部的阶段目录 symlink 检查", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-stage-canonical-alias-"))
  const dataset = path.join(workspace, ".killstata", "datasets", "dataset_alias")
  const alternateStages = path.join(dataset, "alternate-stages")
  try {
    fs.mkdirSync(alternateStages, { recursive: true })
    fs.writeFileSync(path.join(alternateStages, "stage_000.parquet"), "stage content")
    fs.symlinkSync(alternateStages, path.join(dataset, "stages"), "dir")
    const canonicalWorkspace = fs.realpathSync(workspace)
    const canonicalStagePath = path.join(canonicalWorkspace, ".killstata", "datasets", "dataset_alias", "stages", "stage_000.parquet")
    await Instance.provide({
      directory: workspace,
      fn: async () => {
        await expect(resolveDatasetStagePath({
          datasetId: "dataset_alias",
          filePath: canonicalStagePath,
          toolName: "ols_regression",
          sessionID: "session_stage_canonical_alias",
          messageID: "message_stage_canonical_alias",
          callID: "call_stage_canonical_alias",
          ask: async () => undefined,
        })).rejects.toThrow(/符号链接/)
      },
    })
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test("数据集报告与审计目录的外部 symlink 必须在写入前被拒绝", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-dataset-output-workspace-"))
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-dataset-output-external-"))
  const datasetRoot = path.join(workspace, ".killstata", "datasets", "dataset_outputs")
  try {
    fs.mkdirSync(datasetRoot, { recursive: true })
    fs.symlinkSync(external, path.join(datasetRoot, "reports"), "dir")
    fs.symlinkSync(external, path.join(datasetRoot, "audit"), "dir")
    await Instance.provide({
      directory: workspace,
      fn: async () => {
        for (const directory of ["reports", "audit"]) {
          expect(() => resolveManagedProjectPath({
            filePath: path.join(datasetRoot, directory, "stage_001_output.json"),
            managedRoot: datasetRoot,
          })).toThrow(/受管数据目录之外|符号链接/)
        }
      },
    })
    expect(fs.readdirSync(external)).toEqual([])
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(external, { recursive: true, force: true })
  }
})
