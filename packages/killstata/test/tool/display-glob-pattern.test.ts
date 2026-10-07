/**
 * glob 模式串不得把内部工作区结构渲染给用户。
 *
 * 现场（2026-08-12 gf.xlsx 会话）：用户在"展开分析过程"里看到
 *   ✱ Glob ".killstata/datasets/gf_68825014/**\/*.json"
 * 内部目录名与数据集 ID 一起暴露。displayPath 那套不能直接用——它取 basename，
 * 会把通配结构毁掉。
 */

import { describe, expect, test } from "bun:test"
import { displayGlobPattern } from "@/tool/analysis-display"

describe("displayGlobPattern", () => {
  test("命中内部工作区的 pattern 一律折叠，不泄漏目录与数据集 ID", () => {
    for (const pattern of [
      ".killstata/datasets/gf_68825014/**/*.json",
      ".killstata/datasets/gf_68825014/reports/main/*.json",
      "**/.killstata/**",
      "./.killstata/runtime/workflows/*.json",
    ]) {
      const shown = displayGlobPattern(pattern)
      expect(shown).not.toContain(".killstata")
      expect(shown).not.toContain("gf_68825014")
    }
  })

  test("普通 pattern 原样保留——通配结构不能被破坏", () => {
    expect(displayGlobPattern("**/*.ts")).toBe("**/*.ts")
    expect(displayGlobPattern("data/*.xlsx")).toBe("data/*.xlsx")
    expect(displayGlobPattern("src/**/*.{ts,tsx}")).toBe("src/**/*.{ts,tsx}")
  })
})
