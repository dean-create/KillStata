import { describe, expect, test } from "bun:test"
import { detectInputIntent, detectToolFocus } from "@/session/prompt/intent"
import { PromptInput } from "@/session/prompt/types"

describe("intent detection for drive scenarios", () => {
  test("did-direct message → analysis", () => {
    const parts: PromptInput["parts"] = [
      { type: "text", text: "别墨迹了，直接跑 DID：文件在 /tmp/killstata-drive-did-direct-abc/did.xlsx，被解释变量=创新指数，处理组=did，政策后=post。" },
    ]
    expect(detectInputIntent(parts, undefined, false, false)).toBe("analysis")
  })
  test("did-standard message → analysis", () => {
    const parts: PromptInput["parts"] = [
      { type: "text", text: "请导入数据文件 /tmp/x/did.xlsx，做传统双重差分 DID：被解释变量=创新指数，处理组变量=did，政策后变量=post。" },
    ]
    expect(detectInputIntent(parts, undefined, false, false)).toBe("analysis")
  })

  test("总体份额推断限制不应否定明确的多项 Logit 估计请求", () => {
    const text = "这是 statsmodels 官方 Travel Mode Choice 长表，每位 individual 有 plane/train/bus/car 四行，choice=1 是本人选中的方式，mode 编码为 1=air、2=train、3=bus、4=car。请先只保留 choice=1，确认后得到一人一行和四个类别，再估计 mode ~ hinc 的多项 Logit，baseline=1。这个样本是 choice-based 抽样，不用它推断总体方式份额；只解释条件关联，不作因果结论。"
    const focus = detectToolFocus([{ type: "text", text }])

    expect(focus.requiredToolIDs).toContain("multinomial_logit")
  })

  test("多项 Logit 间隔空格仍路由到多项而非二元 Logit 工具", () => {
    const focus = detectToolFocus([{ type: "text", text: "请估计 mode ~ hinc 的多项 Logit，baseline=1。" }])

    expect(focus.preferredToolIDs).toContain("multinomial_logit")
    expect(focus.preferredToolIDs).not.toContain("logit_regression")
  })

  test("OLS 的结果外推限制保留估计请求", () => {
    const focus = detectToolFocus([{ type: "text", text: "请估计 OLS，不用结果外推到全国，只报告样本内关联。" }])
    expect(focus.requiredToolIDs).toContain("ols_regression")
  })

  test("明确取消执行仍取消方法完成要求", () => {
    for (const text of [
      "请估计多项 Logit，但不要执行该方法。",
      "请估计多项 Logit，但不要使用它。",
      "请估计多项 Logit，但不要运行它来推断总体份额。",
    ]) {
      expect(detectToolFocus([{ type: "text", text }]).requiredToolIDs).not.toContain("multinomial_logit")
    }
  })

  test("分别请求二元和多项 Logit 时保留两个工具偏好", () => {
    const focus = detectToolFocus([{ type: "text", text: "请分别估计二元 Logit 和多项 Logit。" }])
    expect(focus.preferredToolIDs).toEqual(expect.arrayContaining(["logit_regression", "multinomial_logit"]))
  })
})
