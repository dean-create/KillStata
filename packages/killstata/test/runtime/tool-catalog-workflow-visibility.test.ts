import { describe, expect, test } from "bun:test"
import { isWorkflowReadOnlyAction } from "@/runtime/tool-catalog"

describe("workflow 只读子操作可见性", () => {
  test("artifacts/status 等只读 action 判定为只读", () => {
    expect(isWorkflowReadOnlyAction({ action: "artifacts" })).toBe(true)
    expect(isWorkflowReadOnlyAction({ action: "status" })).toBe(true)
    expect(isWorkflowReadOnlyAction({ action: "doctor" })).toBe(true)
  })

  test("会产生副作用的 action 不判定为只读", () => {
    expect(isWorkflowReadOnlyAction({ action: "rerun" })).toBe(false)
    expect(isWorkflowReadOnlyAction({ action: "restore" })).toBe(false)
    expect(isWorkflowReadOnlyAction({ action: "verify" })).toBe(false)
  })

  test("非法/缺失输入不判定为只读", () => {
    expect(isWorkflowReadOnlyAction(undefined)).toBe(false)
    expect(isWorkflowReadOnlyAction({})).toBe(false)
    expect(isWorkflowReadOnlyAction({ action: 123 })).toBe(false)
  })
})
