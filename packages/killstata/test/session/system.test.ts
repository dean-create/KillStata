import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

describe("session.system prompt contracts", () => {
  test("econometrics prompt defaults vague baselines to smart_baseline and keeps explicit estimators", () => {
    const sourcePath = path.join(process.cwd(), "src", "session", "system.ts")
    const source = fs.readFileSync(sourcePath, "utf-8")

    expect(source).toContain("prefer econometrics with methodName=\"smart_baseline\"")
    expect(source).toContain("prefer econometrics with methodName=\"auto_recommend\"")
    expect(source).toContain("respect that method unless it is not executable")
    expect(source).toContain("original request, the failure reason, and the executed method")
  })

  test("spreadsheet intake does not inject bundled skill context", () => {
    const systemSource = fs.readFileSync(path.join(process.cwd(), "src", "session", "system.ts"), "utf-8")
    const promptSource = fs.readFileSync(path.join(process.cwd(), "src", "session", "prompt.ts"), "utf-8")

    expect(promptSource).toContain("return \"ingest\"")
    expect(promptSource).not.toContain("autoSkillBundle")
    expect(systemSource).not.toContain("<auto_skill_context>")
    expect(systemSource).not.toContain("workflow-orchestrator")
  })

  test("econometrics tool contract documents rescue behavior for explicit method failures", () => {
    const sourcePath = path.join(process.cwd(), "src", "tool", "econometrics.txt")
    const source = fs.readFileSync(sourcePath, "utf-8")

    expect(source).toContain("use `smart_baseline`")
    expect(source).toContain("use `auto_recommend`")
    expect(source).toContain("keep that estimator unless it is not executable")
    expect(source).toContain("rescue to `smart_baseline`")
  })

  test("environment prompt no longer injects an always-empty <files> block", () => {
    const sourcePath = path.join(process.cwd(), "src", "session", "system.ts")
    const source = fs.readFileSync(sourcePath, "utf-8")

    expect(source).not.toContain("<files>")
    expect(source).not.toContain("Ripgrep.tree")
  })

  test("DeepSeek models route to the dedicated deepseek prompt, not the generic fallback", async () => {
    const { SystemPrompt } = await import("../../src/session/system")

    const deepseekPrompt = SystemPrompt.provider({
      providerID: "deepseek",
      api: { id: "deepseek-v4-flash" },
    } as any)
    const genericPrompt = SystemPrompt.provider({
      providerID: "custom",
      api: { id: "qwen3-max" },
    } as any)

    // The DeepSeek prompt carries tool-call and grounding discipline the generic one does not.
    expect(deepseekPrompt[0]).toContain("Tool Call Discipline")
    expect(deepseekPrompt[0]).toContain("Grounding Discipline")
    expect(genericPrompt[0]).not.toContain("Tool Call Discipline")

    // Both still get the econometrics context appended.
    expect(deepseekPrompt).toHaveLength(2)
    expect(genericPrompt).toHaveLength(2)
  })

  test("anthropic spoof header is gone", () => {
    const sourcePath = path.join(process.cwd(), "src", "session", "system.ts")
    const source = fs.readFileSync(sourcePath, "utf-8")

    expect(source).not.toContain("PROMPT_ANTHROPIC_SPOOF")
    expect(source).not.toContain("anthropic_spoof")
  })
})
