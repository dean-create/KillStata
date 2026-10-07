/**
 * 模型可见的工具输出里，内部产物路径必须保持可用，不能被脱敏成占位符。
 *
 * 现场（2026-08-14 实测）：workflow artifacts 返回的 artifactRefs 数组里，
 * 产物目录名 stage_000_panel_fe_regression_20260814-171259（45 字符连续串）被
 * Redact 的 LONG_TOKEN（≥40 连续串）误当密钥 REDACT 成 [已脱敏]——模型拿这个
 * 路径去 read 必然 ENOENT，只能绕行（scandir '.../reports/main/[已脱敏]'）。
 * sanitizeToolRecord 之前只在字段名以 path 结尾时保护内部路径，数组元素这种
 * 非 path key 走了通用脱敏。
 */

import { describe, expect, test } from "bun:test"
import { sanitizeToolRecord } from "@/runtime/tool-result-policy"

const LONG_INTERNAL_NAME = "stage_000_panel_fe_regression_20260814-171259"
const REL = `.killstata/datasets/did_8fa73b03/reports/main/${LONG_INTERNAL_NAME}/results.json`
const ABS = `/Users/cw/Desktop/KillStata-main/${REL}`

describe("sanitizeToolRecord internal paths", () => {
  test("artifactRefs 数组里的内部相对路径原样保留，不出现 [已脱敏]", () => {
    const out = sanitizeToolRecord({ artifactRefs: [REL] }) as { artifactRefs: unknown }
    const refs = out.artifactRefs as string[]
    expect(refs[0]).toContain(LONG_INTERNAL_NAME)
    expect(refs[0]).toContain("results.json")
    expect(refs[0]).not.toContain("[已脱敏]")
    expect(refs[0]).not.toContain("[REDACTED]")
  })

  test("非 path 字段里的内部路径同样保护（key 不依赖后缀）", () => {
    const out = sanitizeToolRecord({ payload: ABS }) as { payload: unknown }
    expect(String(out.payload)).toContain("results.json")
    expect(String(out.payload)).not.toContain("[已脱敏]")
    // 绝对路径应收敛成相对形式，不把本机前缀泄漏给模型输出
    expect(String(out.payload)).toContain(".killstata/")
  })

  test("普通长串（真 token 形态）仍被脱敏——保护没有过度", () => {
    const out = sanitizeToolRecord({ token: "sk-abcdefghijklmnopqrstuvwxyz1234567890abcdefghij" }) as {
      token: unknown
    }
    expect(String(out.token)).toBe("[已脱敏]")
  })

  test("以 .killstata 目录本身收尾（不带尾部斜杠）时也被保护——第一版实现在此漏判", () => {
    // 第一版判断是 startsWith(".killstata/") || includes("/.killstata/")：值以裸
    // .killstata 收尾、不带尾部斜杠时两个条件都不命中，落到 __FELLTHROUGH__（即继续
    // 走 summarizeToolError）。前段目录名若 ≥40 字符，LONG_TOKEN 会把它整体 REDACT
    // 成 [已脱敏]，.killstata 这个关键路径段直接消失——模型据此判断"这是不是内部路径"
    // 的依据都没了。用真实会出现的长数据集目录名复现（2026-08-14 排查同类问题时发现）。
    const value = "some_dataset_directory_name_that_is_forty_chars_or_more/.killstata"
    const out = sanitizeToolRecord({ payload: value }) as { payload: unknown }
    expect(String(out.payload)).not.toContain("[已脱敏]")
    expect(String(out.payload)).toContain(".killstata")
  })
})
