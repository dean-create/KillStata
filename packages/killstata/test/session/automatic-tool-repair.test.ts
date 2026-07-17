import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import {
  AUTOMATIC_TOOL_REPAIR_LIMIT,
  shouldAutomaticallyRepairTool,
} from "@/session/prompt"
import { WORKFLOW_KNOWN_TOOL_IDS } from "@/runtime/tool-catalog"
import { InvalidTool } from "@/tool/invalid"

describe("automatic tool repair policy", () => {
  test("allows two model-guided repairs and then stops", () => {
    expect(AUTOMATIC_TOOL_REPAIR_LIMIT).toBe(2)
    expect(shouldAutomaticallyRepairTool(0)).toBe(true)
    expect(shouldAutomaticallyRepairTool(1)).toBe(true)
    expect(shouldAutomaticallyRepairTool(2)).toBe(false)
  })

  test("feeds the bounded repair action back invisibly instead of asking the user to restart", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "session", "prompt.ts"), "utf-8")
    expect(source).toContain("result.repairAction")
    expect(source).toContain("synthetic: true")
    expect(source).not.toContain("不会自动重试")
  })

  test("invalid native tool calls fail into the shared repair budget instead of returning success", async () => {
    const llm = fs.readFileSync(path.join(process.cwd(), "src", "session", "llm.ts"), "utf-8")
    const repair = llm.slice(llm.indexOf("experimental_repairToolCall"), llm.indexOf("temperature: params.temperature"))
    expect(repair).toContain("return null")
    expect(repair).not.toContain('toolName: "invalid"')
    expect(WORKFLOW_KNOWN_TOOL_IDS).not.toContain("invalid")

    const invalid = await InvalidTool.init()
    expect(invalid.execute(
      { tool: "ols_regression", error: "dependentVar: Required" },
      {
        sessionID: "session_1",
        messageID: "message_1",
        agent: "analyst",
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
      },
    )).rejects.toThrow("计量工具参数不合法")
  })
})
