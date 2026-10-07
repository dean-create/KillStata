import { describe, expect, test } from "bun:test"
import { formatMessage, formatTranscript } from "../../src/cli/cmd/tui/util/transcript"

describe("analysis transcript safety", () => {
  test("does not export internal model compaction summaries", () => {
    const transcript = formatTranscript(
      { id: "session_1", title: "研究", time: { created: 1, updated: 2 } },
      [{
        info: {
          id: "summary_1",
          role: "assistant",
          sessionID: "session_1",
          parentID: "compact_1",
          modelID: "deepseek-v4-flash",
          providerID: "deepseek",
          mode: "compaction",
          agent: "compaction",
          summary: true,
          path: { cwd: "/project", root: "/project" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, completed: 2 },
        } as any,
        parts: [{ id: "summary_text", sessionID: "session_1", messageID: "summary_1", type: "text", text: "<summary>内部恢复摘要</summary>" } as any],
      }],
      { thinking: false, toolDetails: false, assistantMetadata: false },
    )

    expect(transcript).not.toContain("内部恢复摘要")
  })

  test("does not export the synthetic automatic-compaction continuation as a user message", () => {
    const transcript = formatTranscript(
      { id: "session_1", title: "研究", time: { created: 1, updated: 2 } },
      [{
        info: {
          id: "continuation_1",
          role: "user",
          sessionID: "session_1",
          time: { created: 2 },
          agent: "analyst",
          model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
        } as any,
        parts: [{
          id: "continuation_text",
          sessionID: "session_1",
          messageID: "continuation_1",
          type: "text",
          synthetic: true,
          text: "直接继续压缩前任务。<killstata-analysis-continuation>requestId=internal</killstata-analysis-continuation>",
        } as any],
      }],
      { thinking: false, toolDetails: false, assistantMetadata: false },
    )

    expect(transcript).not.toContain("killstata-analysis-continuation")
    expect(transcript).not.toContain("直接继续压缩前任务")
    expect(transcript).not.toContain("## User")
  })

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
        {
          id: "reasoning_1",
          sessionID: "session_1",
          messageID: "assistant_1",
          type: "reasoning",
          text: "internal chain of thought",
        },
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
