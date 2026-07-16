import { describe, expect, test } from "bun:test"
import { formatMessage } from "../../src/cli/cmd/tui/util/transcript"

describe("analysis transcript safety", () => {
  test("never exports reasoning, internal tool ids, or tracebacks for failed analysis", () => {
    const transcript = formatMessage(
      {
        id: "assistant_1",
        role: "assistant",
        sessionID: "session_1",
        parentID: "user_1",
        modelID: "deepseek-v4-flash",
        providerID: "deepseek",
        agent: "analyst",
        mode: "analyst",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, completed: 2 },
      } as any,
      [
        { id: "reasoning_1", sessionID: "session_1", messageID: "assistant_1", type: "reasoning", text: "internal chain of thought" },
        {
          id: "tool_1",
          sessionID: "session_1",
          messageID: "assistant_1",
          type: "tool",
          tool: "did2s",
          callID: "call_1",
          state: {
            status: "error",
            input: { dependentVar: "y" },
            error: 'Traceback (most recent call last):\n  File "/Users/cw/private.py"\nValueError: broken',
            time: { start: 1, end: 2 },
          },
        },
      ] as any,
      { thinking: true, toolDetails: true, assistantMetadata: false },
      "运行现代 DID",
    )

    expect(transcript).not.toContain("internal chain of thought")
    expect(transcript).not.toContain("did2s")
    expect(transcript).not.toContain("Traceback")
    expect(transcript).not.toContain("/Users/")
    expect(transcript).toContain("分析未完成")
  })
})
