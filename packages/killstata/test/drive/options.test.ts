import { describe, expect, test } from "bun:test"
import { parseQuestionOptionIndexes } from "./options"

describe("drive CLI question options", () => {
  test("解析按题目序号选择的非负整数", () => {
    expect(parseQuestionOptionIndexes("1,0,2")).toEqual([1, 0, 2])
    expect(parseQuestionOptionIndexes(" 1, 0 ")).toEqual([1, 0])
    expect(parseQuestionOptionIndexes(undefined)).toBeUndefined()
    expect(parseQuestionOptionIndexes("")).toBeUndefined()
  })

  test("非法选项序列必须拒绝，不能静默回退到第一项", () => {
    expect(() => parseQuestionOptionIndexes("1,-1")).toThrow(/非负整数/)
    expect(() => parseQuestionOptionIndexes("1,x")).toThrow(/非负整数/)
  })
})
