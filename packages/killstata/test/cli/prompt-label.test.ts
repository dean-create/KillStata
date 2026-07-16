import { expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { dataFileLabel } from "@/cli/cmd/tui/component/prompt/paste"

test("data-file label has visual padding inside its highlighted extent", () => {
  expect(dataFileLabel("candidate_clues.xlsx")).toBe("  数据文件 candidate_clues.xlsx  ")
})

test("the initial prompt renders its placeholder exactly once", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src", "cli", "cmd", "tui", "component", "prompt", "index.tsx"),
    "utf-8",
  )

  expect(source).toContain(": list()[store.placeholder % list().length]")
  expect(source).not.toContain('`输入你的问题... "${list()')
})
