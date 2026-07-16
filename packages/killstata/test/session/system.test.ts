import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

describe("session.system prompt contracts", () => {
  test("econometrics prompt uses dedicated tools and never changes the requested estimator silently", () => {
    const sourcePath = path.join(process.cwd(), "src", "session", "system.ts")
    const source = fs.readFileSync(sourcePath, "utf-8")

    expect(source).toContain("Call the dedicated tool whose ID matches the estimator")
    expect(source).toContain("Never switch to another estimator automatically")
    expect(source).toContain("econometrics_recommend")
    expect(source).not.toContain("methodName=\"smart_baseline\"")
    expect(source).not.toContain("rescue to smart_baseline")
  })

  test("routes a traditional two-by-two DID to the static DID tool without requiring panel keys", () => {
    const systemSource = fs.readFileSync(path.join(process.cwd(), "src", "session", "system.ts"), "utf-8")
    const deepseekSource = fs.readFileSync(path.join(process.cwd(), "src", "session", "prompt", "deepseek.txt"), "utf-8")

    for (const source of [systemSource, deepseekSource]) {
      expect(source).toContain("did_static")
      expect(source).toContain("groupVar")
      expect(source).toContain("postVar")
    }
    expect(deepseekSource).toContain("Do not pass entityVar or timeVar")
    expect(deepseekSource).toContain("call econometrics_recommend before QA")
  })

  test("spreadsheet intake does not inject bundled skill context", () => {
    const systemSource = fs.readFileSync(path.join(process.cwd(), "src", "session", "system.ts"), "utf-8")
    const promptSource = fs.readFileSync(path.join(process.cwd(), "src", "session", "prompt.ts"), "utf-8")

    expect(promptSource).toContain("return \"ingest\"")
    expect(promptSource).not.toContain("autoSkillBundle")
    expect(systemSource).not.toContain("<auto_skill_context>")
    expect(systemSource).not.toContain("workflow-orchestrator")
  })

  test("legacy econometrics contract is marked internal and does not advertise unsafe rescue behavior", () => {
    const sourcePath = path.join(process.cwd(), "src", "tool", "econometrics.txt")
    const source = fs.readFileSync(sourcePath, "utf-8")

    expect(source).toContain("internal compatibility dispatcher")
    expect(source).not.toContain("rescue to `smart_baseline`")
    expect(source).not.toContain("`psm_double_robust`")
  })

  test("environment prompt no longer injects an always-empty <files> block", () => {
    const sourcePath = path.join(process.cwd(), "src", "session", "system.ts")
    const source = fs.readFileSync(sourcePath, "utf-8")

    expect(source).not.toContain("<files>")
    expect(source).not.toContain("Ripgrep.tree")
  })

  test("default delivery stays in chat and does not market document bundles", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "session", "system.ts"), "utf-8")

    expect(source).toContain("The default product is a concise in-chat conclusion")
    expect(source).not.toContain("required four default files")
    expect(source).not.toContain("journal-style paper Word")
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
