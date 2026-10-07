import { describe, expect, test } from "bun:test"
import { assemblePromptSections, type PromptSection } from "@/runtime/services/prompt-assembly"

const sections: PromptSection[] = [
  { id: "global.identity", stability: "global", content: "全局身份规则" },
  { id: "global.methodology", stability: "global", content: "只读取可信产物中的统计数字。" },
  { id: "session.agent", stability: "session", content: "主分析 Agent 角色。" },
]

describe("prompt section assembly", () => {
  test("保持 global、session、turn 的顺序和独立 Provider 区块", () => {
    const bundle = assemblePromptSections([
      ...sections,
      { id: "turn.runtime", stability: "turn", content: "数据集=wave_1" },
      { id: "turn.catalog", stability: "turn", content: "本轮可调用：data_import" },
    ])

    expect(bundle.globalSystem).toEqual(["全局身份规则", "只读取可信产物中的统计数字。"])
    expect(bundle.sessionSystem).toEqual(["主分析 Agent 角色。"])
    expect(bundle.turnSystem).toEqual(["数据集=wave_1", "本轮可调用：data_import"])
    expect(bundle.system).toEqual([...bundle.globalSystem, ...bundle.sessionSystem, ...bundle.turnSystem])
    expect(bundle.providerSystem).toEqual([
      "全局身份规则\n只读取可信产物中的统计数字。",
      "主分析 Agent 角色。",
      "数据集=wave_1",
      "本轮可调用：data_import",
    ])
  })

  test("当前轮变化不破坏 global 或 session 前缀", () => {
    const first = assemblePromptSections([
      ...sections,
      { id: "turn.runtime", stability: "turn", content: "数据集=wave_1" },
    ])
    const second = assemblePromptSections([
      ...sections,
      { id: "turn.runtime", stability: "turn", content: "数据集=wave_2" },
    ])

    expect(first.globalHash).toBe(second.globalHash)
    expect(first.sessionHash).toBe(second.sessionHash)
    expect(first.turnHash).not.toBe(second.turnHash)
  })
})
