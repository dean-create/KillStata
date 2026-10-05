import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

describe("显式 subtask 的统一执行链", () => {
  test("dispatch 必须经 SessionProcessor 执行 task，不得直调工具实现或使用宽泛 bypass", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/session/prompt/dispatch.ts"), "utf-8")
    const branch = source.slice(source.indexOf('if (task?.type === "subtask")'), source.indexOf("// pending compaction"))

    expect(branch).toContain("executeTool(TaskTool.id")
    expect(branch).not.toContain("taskTool.execute(taskArgs")
    expect(branch).not.toContain("bypassAgentCheck: true")
  })
})
