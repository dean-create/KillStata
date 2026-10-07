/**
 * relativeWithinProject 的根基准。
 *
 * dev/TUI 启动时 Instance.directory 是 packages/killstata，而 .killstata 数据层挂在
 * projectRoot()（= Instance.worktree）下。此前只按 directory 剥前缀，数据层路径必然走
 * ".." 分支直接 return 绝对路径——本机绝对路径就这样漏进模型可见输出（这个函数的全部
 * 存在意义就是防止这件事）。
 */

import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { relativeWithinProject } from "@/tool/analysis-path"

describe("relativeWithinProject", () => {
  test("directory ≠ worktree 时，数据层路径仍剥成项目相对路径", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-relpath-"))
    try {
      // 项目标记就是 .killstata 目录本身（Project.fromDirectory 用 Filesystem.up 往上找它）。
      // 从 packages/killstata 启动时找到的是仓库根那个，于是 worktree ≠ directory——
      // 这正是用户现场的成因，这里如实复现。
      const artifact = path.join(root, ".killstata", "datasets", "d", "reports", "validate.json")
      fs.mkdirSync(path.dirname(artifact), { recursive: true })
      fs.writeFileSync(artifact, "{}")
      const sub = path.join(root, "packages", "killstata")
      fs.mkdirSync(path.join(sub, "src"), { recursive: true })
      fs.writeFileSync(path.join(sub, "src", "x.ts"), "")

      await Instance.provide({
        directory: sub,
        fn: async () => {
          // 前提：复现 dev 启动时两个根不同的情形
          expect(Instance.directory).not.toBe(Instance.worktree)

          const shown = relativeWithinProject(artifact)
          expect(path.isAbsolute(shown)).toBe(false)
          expect(shown).toBe(path.join(".killstata", "datasets", "d", "reports", "validate.json"))

          // directory 内的路径仍以项目根为基准，保持唯一、不产生歧义的相对形式
          expect(relativeWithinProject(path.join(sub, "src", "x.ts"))).toBe(
            path.join("packages", "killstata", "src", "x.ts"),
          )
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("项目外的路径不做相对化，原样返回", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-relpath-out-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-outside-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const target = path.join(outside, "secret.json")
          expect(path.isAbsolute(relativeWithinProject(target))).toBe(true)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})
