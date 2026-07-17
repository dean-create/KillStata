import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Project } from "@/project/project"

// killstata 用户的数据目录就是个放 excel 的普通文件夹——不是 git 仓库。
// 旧实现在这种情况下返回 id="global" + worktree="/"，代价是四个真 bug：
//   1. 所有非 git 目录共用一个 project → 不同数据目录的会话互相串台
//   2. "总是允许"的权限授权按 project.id 存 → 一个目录的授权泄漏到所有其他目录
//   3. 权限 pattern 相对 worktree 计算 → worktree="/" 让用户写的规则永不匹配
//   4. 配置/AGENTS.md 的向上查找以 worktree 为 stop → 一路扫到文件系统根
//
// 这些断言锁住根因的修复：worktree 永远是真实目录，id 永远按目录区分。
// 注意 async/await：同步的 try/finally 包一个 async fn 会在 Promise 还没 resolve 时
// 就执行 finally，把目录提前删掉——测试会以一种极其误导的方式失败。
async function withDataDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-proj-"))
  try {
    return await fn(fs.realpathSync(dir))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("project identity (non-git data directories)", () => {
  test("a plain data folder gets a real worktree, never the filesystem root", async () => {
    await withDataDir(async (dir) => {
      fs.writeFileSync(path.join(dir, "我的数据.csv"), "a,b\n1,2\n")

      const { project } = await Project.fromDirectory(dir)

      expect(project.worktree).not.toBe("/")
      expect(project.worktree).toBe(dir)
      expect(project.vcs).toBeUndefined()
    })
  })

  test("two different data folders get different project ids (sessions must not cross-talk)", async () => {
    await withDataDir(async (a) => {
      await withDataDir(async (b) => {
        const { project: first } = await Project.fromDirectory(a)
        const { project: second } = await Project.fromDirectory(b)

        expect(first.id).not.toBe("global")
        expect(second.id).not.toBe("global")
        expect(first.id).not.toBe(second.id)
      })
    })
  })

  test("the same folder always resolves to the same id (sessions must survive a restart)", async () => {
    await withDataDir(async (dir) => {
      const { project: first } = await Project.fromDirectory(dir)
      const { project: second } = await Project.fromDirectory(dir)

      expect(first.id).toBe(second.id)
    })
  })

  test("a subdirectory resolves up to the .killstata project root", async () => {
    await withDataDir(async (root) => {
      // 用户跑过一次分析后就会有 .killstata/，它标记了这个分析项目的边界
      fs.mkdirSync(path.join(root, ".killstata"), { recursive: true })
      const sub = path.join(root, "raw", "2024")
      fs.mkdirSync(sub, { recursive: true })

      const { project: fromRoot } = await Project.fromDirectory(root)
      const { project: fromSub } = await Project.fromDirectory(sub)

      // 从子目录启动，也应该认出同一个项目——否则会话会分裂
      expect(fromSub.worktree).toBe(root)
      expect(fromSub.id).toBe(fromRoot.id)
    })
  })
})
