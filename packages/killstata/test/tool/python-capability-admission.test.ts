import { describe, expect, test } from "bun:test"
import { validateCapabilityAdmission } from "@/tool/python-capability-admission"

const descriptor = (effect: "read_only" | "writes_state" | "writes_files" | "external") => ({
  tool_id: "python_capability",
  name: "Python capability",
  description: "test",
  input_schema: { type: "object" },
  output_schema: { type: "object" },
  permission: { effect, destructive: false, parallel_safe: false, requires_confirmation: false },
  category: "data" as const,
  executor: "python" as const,
})

describe("Python 能力准入", () => {
  test("Registry 声明的权限超过 Harness allowlist 时拒绝", () => {
    expect(() => validateCapabilityAdmission({
      descriptor: descriptor("external"),
      admission: { maximum_permission: "read_only" },
    })).toThrow("能力权限契约不一致")
  })

  test("匹配 allowlist 时原样返回 descriptor，不重写 Schema", () => {
    const value = descriptor("writes_files")
    expect(validateCapabilityAdmission({
      descriptor: value,
      admission: { maximum_permission: "writes_files" },
    })).toBe(value)
  })
})
