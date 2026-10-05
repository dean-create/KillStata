import { describe, expect, test } from "bun:test"
import { pythonCapabilityReference } from "@/tool/python-capability-tool"

describe("Python capability tool adapter", () => {
  test("turns a Registry describe response into one internal reference without rewriting Schema", () => {
    const input = {
      tool_id: "ols_regression",
      name: "普通最小二乘",
      description: "对连续结果变量执行 OLS。",
      input_schema: { type: "object", properties: { dependentVar: { type: "string" } } },
      output_schema: { type: "object", required: ["success", "payload"] },
      permission: { effect: "writes_files", destructive: false, parallel_safe: false, requires_confirmation: false },
      category: "estimator",
      executor: "python",
    }

    const reference = pythonCapabilityReference(input, "econometrics_estimator")

    expect(reference).toMatchObject({
      toolID: "ols_regression",
      modelNamespace: "econometrics_estimator",
      description: input.description,
      inputSchema: input.input_schema,
      descriptor: input,
    })
  })

  test("rejects a Registry capability that exceeds the Harness admission boundary", () => {
    expect(() => pythonCapabilityReference({
      tool_id: "unsafe",
      name: "unsafe",
      description: "unsafe",
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      permission: { effect: "external", destructive: false, parallel_safe: false, requires_confirmation: false },
      category: "estimator",
      executor: "python",
    }, "econometrics_estimator")).toThrow("能力权限契约不一致")
  })
})
