import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { DataImportTool } from "@/tool/data-import"
import { EconometricsTool } from "@/tool/econometrics"

// 用户实测踩到的场景：一进会话（默认就是 analyst 模式）随手发了个 "1"，
// 模型不知所措，对着空气调了分析工具——结果系统先弹出一整份「执行计划」让用户签字，
// 用户点了同意之后才发现参数根本没给。
//
// 正确行为：这种调用在参数校验阶段就该被拒掉，用户全程不该被打扰。
// 这里的断言锁住「校验先于审批」这个顺序，而不是审批闸门本身（闸门是对的，该留）。
const ctx = {
  sessionID: "test-approval-gate",
  messageID: "",
  callID: "",
  agent: "analyst", // ← 关键：默认 agent，闸门就是在这个模式下生效的
  abort: AbortSignal.any([]),
  metadata: async () => undefined,
  // 审批弹窗走的是 Question.ask，它不经过 ctx.ask；这里一旦被调用就说明我们打扰了用户。
  ask: async () => {
    throw new Error("用户不该被打扰：参数无效的调用必须在弹窗之前就被拒绝")
  },
}

async function withInstance<T>(fn: () => Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-approval-"))
  try {
    return await Instance.provide({ directory: root, fn })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("approval gate ordering (analyst mode)", () => {
  test("data_import with no data source is rejected on arguments, not after an approval prompt", async () => {
    await withInstance(async () => {
      const tool = await DataImportTool.init()

      // 模型对着一句 "1" 瞎调工具：action 有了，但没有任何数据来源。
      await expect(
        tool.execute({ action: "import" } as any, ctx as any),
      ).rejects.toThrow(/requires inputPath or datasetId \+ stageId/)
    })
  })

  test("econometrics with no data source is rejected on arguments, not after an approval prompt", async () => {
    await withInstance(async () => {
      const tool = await EconometricsTool.init()

      // 变量都齐了，唯独没有任何数据来源——这正是"模型对着空气开工"的形状。
      await expect(
        tool.execute(
          { methodName: "ols_regression", dependentVar: "y", treatmentVar: "x" } as any,
          ctx as any,
        ),
      ).rejects.toThrow(/requires dataPath or datasetId/)
    })
  })

  test("the prompt tells the model to keep its hands off tools for greetings and noise", () => {
    const prompt = fs.readFileSync(path.join(process.cwd(), "src", "session", "prompt", "deepseek.txt"), "utf-8")

    expect(prompt).toContain("When NOT to use a tool")
    expect(prompt).toContain("Greetings and small talk")
    expect(prompt).toContain("What can you do?")
    // 误触场景要点名，否则模型会自作聪明地去猜。
    expect(prompt).toContain('a stray "1"')
  })
})
