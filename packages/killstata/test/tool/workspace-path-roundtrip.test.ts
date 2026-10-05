/**
 * 产物路径的写-读往返必须闭合。
 *
 * 现场（2026-08-12 gf.xlsx 会话）：describe 产物真实存在，模型按工具输出里的相对路径
 * read，却报 `ENOENT: scandir 'packages/killstata/.killstata/datasets/…'`。
 * 根因是两个根被混用——写侧 relativeWithinProject 按 worktree（项目根）剥前缀，读侧
 * resolveWorkspacePath 按 directory（启动目录 packages/killstata）拼回去。
 *
 * killstata 的内部工作区 `.killstata/` 永远挂在 worktree 下（runtime/dataset-state.ts
 * 的 projectRoot()），所以这条往返是可以确定闭合的，不该依赖"文件是否恰好存在"来试探。
 */

import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { relativeWithinProject, resolveWorkspacePath } from "@/tool/analysis-path"

/** 复现 dev/TUI 场景：directory = <root>/packages/killstata，worktree = <root>。 */
async function withSplitRoots<T>(fn: (root: string) => Promise<T>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "killstata-roundtrip-")))
  try {
    // .killstata 的存在即项目根标记（Project.fromDirectory），据此让 worktree ≠ directory
    fs.mkdirSync(path.join(root, ".killstata"), { recursive: true })
    const sub = path.join(root, "packages", "killstata")
    fs.mkdirSync(sub, { recursive: true })
    return await Instance.provide({ directory: sub, fn: () => fn(root) })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("workspace path roundtrip", () => {
  test("内部产物：相对化后再解析回来必须指向原文件", async () => {
    await withSplitRoots(async (root) => {
      expect(Instance.directory).not.toBe(Instance.worktree)

      const artifact = path.join(root, ".killstata", "datasets", "d", "reports", "main", "describe.csv")
      fs.mkdirSync(path.dirname(artifact), { recursive: true })
      fs.writeFileSync(artifact, "a,b\n1,2\n")

      // 写侧：工具输出给模型的形式
      const shown = relativeWithinProject(artifact)
      expect(shown).toBe(".killstata/datasets/d/reports/main/describe.csv")

      // 读侧：模型拿这个字符串回来读
      const resolved = resolveWorkspacePath(shown)
      expect(resolved).toBe(artifact)
      expect(fs.existsSync(resolved)).toBe(true)
    })
  })

  test("基准判定不依赖文件是否存在——不存在时报的必须是真的不存在", async () => {
    await withSplitRoots(async (root) => {
      // 目录整条都不存在：旧实现的 existsSync(dirname) 判据在这里会误落到 directory 基准，
      // 报出 packages/killstata/.killstata/… 这种误导性路径。
      const missing = ".killstata/datasets/nope/reports/main/x.csv"
      const resolved = resolveWorkspacePath(missing)
      expect(resolved).toBe(path.join(root, missing))
      expect(resolved.startsWith(Instance.directory)).toBe(false)
    })
  })

  test("用户自己的文件仍按启动目录解析，不被内部规则波及", async () => {
    await withSplitRoots(async () => {
      const resolved = resolveWorkspacePath("data/gf.xlsx")
      expect(resolved).toBe(path.join(Instance.directory, "data", "gf.xlsx"))
    })
  })

  test("绝对路径不依赖 Instance 上下文——root 默认值必须惰性求值", () => {
    // `root = workspaceRoot()` 这种默认参数在 JS 里函数一调用就会立即执行，不管
    // filePath 是不是绝对路径。改这个函数供 analysis-grounding.ts 复用时，测试环境
    // 没有 Instance.provide 包裹、只传绝对路径，当场复现
    // "instance: No context found for instance"（2026-08-14 排查同类问题时引入又当场
    // 被测试抓到的真实回归）。不包裹 Instance.provide，就是要证明这里不该需要它。
    expect(resolveWorkspacePath("/tmp/some/absolute/path.json")).toBe(path.normalize("/tmp/some/absolute/path.json"))
  })

  test("模型从绝对路径换算的 ../ 相对路径按 cwd 语义解析", async () => {
    await withSplitRoots(async (root) => {
      // 模型从 workflow 记忆的绝对产物路径算出 ../../.killstata/...（相对它的 cwd
      // packages/killstata）传给 read。按 cwd 解析应回到项目根的 .killstata。
      const rel = "../../.killstata/datasets/did_8fa73b03/reports/main/results.json"
      const resolved = resolveWorkspacePath(rel)
      expect(resolved).toBe(path.join(root, ".killstata", "datasets", "did_8fa73b03", "reports", "main", "results.json"))
    })
  })
})
