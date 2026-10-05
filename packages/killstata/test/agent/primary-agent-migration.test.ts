import { describe, expect, test } from "bun:test"
import { Agent } from "@/agent/agent"
import { SystemPrompt } from "@/session/system"
import { pickTabCycleAgents } from "@/cli/cmd/tui/context/agent-cycle"

describe("primary agent migration", () => {
  test("maps the retired explorer primary mode to analyst", () => {
    expect(Agent.normalizePrimaryAgent("explorer")).toBe("analyst")
    expect(Agent.normalizePrimaryAgent("analyst")).toBe("analyst")
    expect(Agent.normalizePrimaryAgent("verifier")).toBe("verifier")
  })

  test("renders the analyst role for legacy explorer messages", () => {
    expect(SystemPrompt.agent({ name: "explorer" } as never)).toEqual(SystemPrompt.agent({ name: "analyst" } as never))
  })

  test("keeps explorer out of the user-facing agent cycle", () => {
    expect(pickTabCycleAgents([{ name: "analyst" }, { name: "explorer" }, { name: "verifier" }])).toEqual([
      { name: "analyst" },
    ])
  })

  test("runs an explicit analysis without a ritual approval step", () => {
    const prompt = SystemPrompt.agent({ name: "analyst" } as never).join("\n")

    expect(prompt).toContain("直接执行，不额外要求批准")
    expect(prompt).toContain("实质歧义")
    expect(prompt).not.toContain("运行估计前先请求确认")
  })

  test("按推荐执行时锁定推荐结果，不擅自改用相近估计器", () => {
    const prompt = SystemPrompt.agent({ name: "analyst" } as never).join("\n")

    expect(prompt).toContain("按推荐的方法执行")
    expect(prompt).toContain("不得擅自改用另一个估计器")
  })

  test("用户给出不存在但相近的列名时必须先确认，不能静默替换研究变量", () => {
    const prompt = SystemPrompt.agent({ name: "analyst" } as never).join("\n")

    expect(prompt).toContain("用户指定的列名不存在")
    expect(prompt).toContain("即使存在相近列名也必须先询问用户")
  })

  test("没有数据文件时先向用户索要文件，不主动搜索工作目录", () => {
    const prompt = SystemPrompt.agent({ name: "analyst" } as never).join("\n")

    expect(prompt).toContain("没有数据文件")
    expect(prompt).toContain("不得主动调用 glob/read")
  })

  test("用户只询问进度时只读状态并直接回答", () => {
    const prompt = SystemPrompt.agent({ name: "analyst" } as never).join("\n")

    expect(prompt).toContain("只询问当前状态")
    expect(prompt).toContain("不得重新导入、估计或探查文件")
  })

  test("用户追问可靠性时必须明确诊断与稳健性", () => {
    const prompt = SystemPrompt.agent({ name: "analyst" } as never).join("\n")

    expect(prompt).toContain("靠谱吗")
    expect(prompt).toContain("诊断或稳健性")
  })

  test("缺失派生变量时先确认构造规则，不能由列名自动决定研究含义", () => {
    const prompt = SystemPrompt.provider({
      providerID: "deepseek",
      api: { id: "deepseek-chat" },
    } as never).join("\n")

    expect(prompt).toContain("post")
    expect(prompt).toContain("不能只按列名猜定义")
    expect(prompt).toContain("先用question询问规则")
    expect(prompt).toContain("只构造一次")
  })
})
