import { expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { dataFileLabel } from "@/cli/cmd/tui/component/prompt/paste"
import { shouldSubmitImmediateCommand } from "@/cli/cmd/tui/component/prompt/command"

test("data-file label is a plain inline reference without chip padding", () => {
  // 数据文件引用改走文件样式（橙字加粗、无底色），不再为底色留首尾空格
  expect(dataFileLabel("candidate_clues.xlsx")).toBe("数据文件 candidate_clues.xlsx")
})

test("the initial prompt renders its placeholder exactly once", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src", "cli", "cmd", "tui", "component", "prompt", "index.tsx"),
    "utf-8",
  )

  expect(source).toContain(": list()[store.placeholder % list().length]")
  expect(source).not.toContain('`输入你的问题... "${list()')
})

test("immediate slash commands submit on the autocomplete selection", () => {
  expect(shouldSubmitImmediateCommand("/reasoning", { value: "/reasoning", immediate: true })).toBe(true)
  expect(shouldSubmitImmediateCommand("/REASONING ", { value: "/reasoning", immediate: true })).toBe(true)
  expect(shouldSubmitImmediateCommand("/reasoning high", { value: "/reasoning", immediate: true })).toBe(false)
  expect(shouldSubmitImmediateCommand("/model", { value: "/model", immediate: false })).toBe(false)
})

test("the session prompt passes its model label through the safe text boundary", () => {
  const sessionSource = fs.readFileSync(
    path.join(process.cwd(), "src", "cli", "cmd", "tui", "routes", "session", "index.tsx"),
    "utf-8",
  )
  const promptSource = fs.readFileSync(
    path.join(process.cwd(), "src", "cli", "cmd", "tui", "component", "prompt", "index.tsx"),
    "utf-8",
  )

  expect(sessionSource).toContain("right={promptRight()}")
  expect(sessionSource).toContain("onRightMouseDown={() => dialog.replace(() => <DialogModelSettings />)}")
  expect(promptSource).toContain("right?: string")
  expect(promptSource).toContain("<text fg={theme.textMuted}>{props.right} ›</text>")
  expect(sessionSource).not.toContain("{promptRight()} ›")
})
