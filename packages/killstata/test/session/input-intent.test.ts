import { expect, test } from "bun:test"
import { SessionPrompt } from "@/session/prompt"

test("a negated analysis instruction stays in conversation mode", () => {
  const detectInputIntent = (SessionPrompt as Record<string, any>).detectInputIntent

  expect(detectInputIntent?.([{ type: "text", text: "不要再分析了，先聊聊模型选择" }])).toBe("conversation")
})

test("image filenames never select an analysis or ingest workflow", () => {
  const parts = [
    { type: "text", text: "看看这张图" },
    { type: "file", filename: "regression.csv.png", url: "file:///regression.csv.png", mime: "image/png" },
  ] as any

  expect(SessionPrompt.detectInputIntent(parts)).toBe("conversation")
})

test("negation follows the last workflow instruction in the sentence", () => {
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "别做回归" }] as any)).toBe("conversation")
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "不要对这份数据做回归" }] as any)).toBe("conversation")
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "先别分析 A，但直接回归 B" }] as any)).toBe("analysis")
})

test("method questions remain conversation even when they repeat analysis keywords", () => {
  expect(
    SessionPrompt.detectInputIntent([
      { type: "text", text: "别做回归，告诉我回归和面板模型有什么区别" },
    ] as any),
  ).toBe("conversation")
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "别做稳健性检验" }] as any)).toBe("conversation")
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "你觉得应该怎么进行计量分析" }] as any)).toBe(
    "conversation",
  )
  expect(
    SessionPrompt.detectInputIntent([{ type: "text", text: "告诉我回归和面板模型有什么区别，然后帮我跑一下 OLS" }] as any),
  ).toBe("analysis")
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "回归应该怎么做，然后用 OLS 跑一个" }] as any)).toBe(
    "analysis",
  )
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "先别分析，改用 DID 做一遍" }] as any)).toBe(
    "analysis",
  )
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "别跑 OLS" }] as any)).toBe("conversation")
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "先别分析！现在做回归" }] as any)).toBe("analysis")
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "OLS 是什么，先跑一个看看" }] as any)).toBe(
    "analysis",
  )
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "OLS 是什么，先做个解释" }] as any)).toBe(
    "conversation",
  )
  expect(SessionPrompt.detectInputIntent([{ type: "text", text: "回归是什么，先做个总结" }] as any)).toBe(
    "conversation",
  )
})
