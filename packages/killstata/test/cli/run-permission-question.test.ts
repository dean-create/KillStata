import { describe, expect, test } from "bun:test"
import { decideNonInteractiveQuestion } from "../../src/cli/cmd/run-permission"

const workspaceRoot = "/tmp/ws"

// P1-B：非交互 `killstata run` 是一次性命令，用户不在场。原先模型想调 question 澄清
// 研究设计时，系统直接 reject，模型收到"用户已取消"并被 blocked=stop 终止整轮，
// 任务半途而废、且没有恢复出路。修复：把澄清型问题改为"合成回答"引导模型自主继续，
// 复用 reply 链路，彻底绕开 turn 生命周期的 stop。
describe("decideNonInteractiveQuestion 非交互澄清问题", () => {
  test("普通研究设计澄清问题：不再 reject，而是回复引导自主继续的答案", () => {
    const decision = decideNonInteractiveQuestion({
      workspaceRoot,
      request: {
        questions: [
          {
            header: "识别设计",
            question: "绿色金融指数是否包含绿色信贷子维度？这会影响是否存在机械相关性。",
          },
        ],
      },
    })

    expect(decision.action).toBe("reply")
    expect(decision.answers).toBeDefined()
    const answerText = decision.answers!.flat().join(" ")
    // 合成回答必须让模型明白：无人可答，请基于最合理默认假设继续，并在结论中说明假设
    expect(answerText.length).toBeGreaterThan(0)
    expect(/假设|继续|默认|非交互/.test(answerText)).toBe(true)
  })

  test("回复的答案数量与问题数量一致（多问题场景）", () => {
    const decision = decideNonInteractiveQuestion({
      workspaceRoot,
      request: {
        questions: [
          { header: "A", question: "问题一？" },
          { header: "B", question: "问题二？" },
        ],
      },
    })

    expect(decision.action).toBe("reply")
    expect(decision.answers).toHaveLength(2)
  })

  test("回归保护：Path Access 仍自动放行", () => {
    const decision = decideNonInteractiveQuestion({
      workspaceRoot,
      request: {
        questions: [
          {
            header: "Path Access",
            question: "killstata wants read access to project-external path: /data/x.csv Allow this access?",
          },
        ],
      },
    })

    expect(decision.action).toBe("reply")
    expect(decision.reason).toContain("auto_allow_external_read")
  })

  test("回归保护：分析计划问题仍自动确认", () => {
    const decision = decideNonInteractiveQuestion({
      workspaceRoot,
      request: {
        questions: [{ header: "分析计划", question: "是否按此计划执行？" }],
      },
    })

    expect(decision.action).toBe("reply")
    expect(decision.answers).toEqual([["是"]])
  })

  test("空问题仍拒绝", () => {
    const decision = decideNonInteractiveQuestion({
      workspaceRoot,
      request: { questions: [] },
    })

    expect(decision.action).toBe("reject")
  })
})
