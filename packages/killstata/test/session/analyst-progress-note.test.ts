import { describe, expect, test } from "bun:test"
import { ANALYST_ROLE_PROMPT } from "@/agent/prompt/roles"
import { ECONOMETRICS_CONTEXT } from "@/session/prompt/econometrics-context"

/**
 * 2026-08-29 真实回放（digital-panel-composite-key）：模型全程沉默 174 秒，
 * 中途做了导入、画像、复合键构造、重新质检、面板估计五个阶段，但只在最后甩出一份完整报告
 * （assistantTexts=1）。drive 的 hasProgressNotes 判失败——这是真实体验缺口，不是断言误判。
 *
 * 约束写在**角色层**（agent 怎么工作），不写进方法论层（计量规则），避免跨层重复。
 */
describe("分析 Agent 的进度提示约束", () => {
  test("角色层要求多阶段任务中途给出简短进度说明", () => {
    expect(ANALYST_ROLE_PROMPT).toMatch(/进度|阶段性|中途/)
  })

  test("进度说明必须限定简短，避免变成第二份报告", () => {
    expect(ANALYST_ROLE_PROMPT).toMatch(/一句|简短|不复述|不展开/)
  })

  test("不在方法论层重复同一条约束（分层不串味）", () => {
    expect(ECONOMETRICS_CONTEXT).not.toMatch(/中途.*进度|每完成一个阶段/)
  })
})
