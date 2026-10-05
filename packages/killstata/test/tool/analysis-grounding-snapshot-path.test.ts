/**
 * 数值快照的路径解析必须与产物真正落盘的基准一致——否则 collectNumericSnapshotsFromToolMetadata
 * 会静默丢失快照（fs.existsSync 返回 false，不报错）。
 *
 * 这是"数字只读不背"这条铁律的校验源之一：模型汇报系数/p 值等数字前，靠这个函数
 * 读回结构化快照做 grounding 检查。若快照因基准分裂丢失，检查会拿到空结果而不自知，
 * 比 ENOENT 更隐蔽（2026-08-14 排查同类问题时发现——resolveSnapshotMetadataPath 此前
 * 只按 Instance.directory 拼接，没有 .killstata/ 前缀走 worktree 的特判，与
 * resolveWorkspacePath 的基准判定不一致）。
 */

import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { collectNumericSnapshotsFromToolMetadata, type NumericSnapshotDocument } from "@/tool/analysis-grounding"

async function withSplitRoots<T>(fn: (root: string) => Promise<T>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "killstata-snapshot-")))
  try {
    fs.mkdirSync(path.join(root, ".killstata"), { recursive: true })
    const sub = path.join(root, "packages", "killstata")
    fs.mkdirSync(sub, { recursive: true })
    return await Instance.provide({ directory: sub, fn: () => fn(root) })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("collectNumericSnapshotsFromToolMetadata path basis", () => {
  test("directory ≠ worktree 时仍能找到 .killstata 下的快照，不静默丢失", async () => {
    await withSplitRoots(async (root) => {
      expect(Instance.directory).not.toBe(Instance.worktree)

      const rel = ".killstata/datasets/d/reports/main/numeric_snapshot.json"
      const doc: NumericSnapshotDocument = {
        version: 1,
        sourceTool: "econometrics",
        scope: "regression",
        generatedAt: new Date().toISOString(),
        snapshotPath: rel,
        entries: [
          {
            metric: "coefficient",
            scope: "regression",
            term: "did",
            value: -0.0056,
            display: "-0.0056",
            sourcePath: rel,
          },
        ],
      }
      const absolute = path.join(root, rel)
      fs.mkdirSync(path.dirname(absolute), { recursive: true })
      fs.writeFileSync(absolute, JSON.stringify(doc))

      const snapshots = await collectNumericSnapshotsFromToolMetadata({ numericSnapshotPath: rel })
      expect(snapshots.length).toBe(1)
      expect(snapshots[0]?.entries[0]?.term).toBe("did")
    })
  })
})
