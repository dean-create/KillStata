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

    // 断言的是纪律条款本身，不是标题措辞 —— 标题改写不该让这个测试变红，
    // 但这两条纪律要是从 DeepSeek prompt 里消失了，它必须红。
    // 1) 工具参数必须是真 JSON 对象（DeepSeek 会把参数当 JSON 字符串传，tool.ts 里有专门的修复逻辑）
    expect(deepseekPrompt[0]).toContain("MUST be a real JSON object")
    // 2) 统计数字只能从产物里读，不能心算 —— 这是防编数字的底线
    expect(deepseekPrompt[0]).toContain("Never compute or round a statistic in your head")

    // 通用 prompt 走的是另一份文件，不该带上这些 DeepSeek 专属纪律。
    expect(genericPrompt[0]).not.toContain("MUST be a real JSON object")

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
