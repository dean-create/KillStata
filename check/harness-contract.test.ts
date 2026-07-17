import { describe, expect, test } from "bun:test"
import { assertHarnessEvidence } from "./src/harness"

describe("通用 Harness 证据合同", () => {
  test("只接受一次执行、完整生命周期和结构化结果", () => {
    expect(
      assertHarnessEvidence({
        schemaAccepted: true,
        executorCalls: 1,
        lifecycle: ["queued", "running", "completed"],
        result: { rows_used: 445, score_min: 0.1 },
      }),
    ).toEqual({ status: "PASS" })
  })

  test("拒绝跳过运行阶段、重复执行或原始日志结果", () => {
    expect(() =>
      assertHarnessEvidence({
        schemaAccepted: true,
        executorCalls: 1,
        lifecycle: ["queued", "completed"],
        result: { rows_used: 445 },
      }),
    ).toThrow(/lifecycle/i)
    expect(() =>
      assertHarnessEvidence({
        schemaAccepted: true,
        executorCalls: 2,
        lifecycle: ["queued", "running", "completed"],
        result: { rows_used: 445 },
      }),
    ).toThrow(/exactly once/i)
    expect(() =>
      assertHarnessEvidence({
        schemaAccepted: true,
        executorCalls: 1,
        lifecycle: ["queued", "running", "completed"],
        result: "all output was a raw log",
      }),
    ).toThrow(/structured/i)
  })
})
