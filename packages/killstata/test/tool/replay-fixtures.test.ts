import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Tool } from "@/tool/tool"
import {
  EconometricsRecommendTool,
  PropensityScoreConstructionTool,
  PropensityScoreVisualizationTool,
  OlsRegressionTool,
  PanelFeRegressionTool,
  Iv2slsTool,
} from "@/tool/econometrics-method-tools"
import {
  HdfeRegressionTool,
  DidStaticTool,
  Did2sTool,
  SaturatedDidEventStudyTool,
} from "@/tool/pyfixest"

/**
 * 模型调用回放：五关准入协议里的第五关。
 *
 * 参数契约、后端校验、数值测试、失败测试都只证明"工具本身正确"；
 * 这一关证明"模型真实会怎么调用它，契约接得住吗"。
 *
 * 只跑到 Zod parameters + formatValidationError 这一层（跟 Tool.define 的
 * 真实校验前缀完全一致，见 tool.ts 的 normalizeToolArgs + parameters.parse），
 * 不触发 execute，所以不需要真实数据集或 Python 子进程——纯 TS，零成本。
 */

type ReplayFixture = {
  description: string
  modelArgs: unknown
  expect: "pass" | "reject"
  rejectHint?: string[]
}

const FIXTURES_ROOT = path.join(import.meta.dir, "..", "fixtures", "replay")

const REPLAY_TOOLS: Record<string, Tool.Info> = {
  econometrics_recommend: EconometricsRecommendTool,
  psm_construction: PropensityScoreConstructionTool,
  psm_visualize: PropensityScoreVisualizationTool,
  ols_regression: OlsRegressionTool,
  panel_fe_regression: PanelFeRegressionTool,
  iv_2sls: Iv2slsTool,
  hdfe_regression: HdfeRegressionTool,
  did_static: DidStaticTool,
  did2s: Did2sTool,
  did_event_study_saturated: SaturatedDidEventStudyTool,
}

const MIN_TOTAL = 5
const MIN_PASS = 2
const MIN_REJECT = 3

function loadFixtures(toolId: string): Array<ReplayFixture & { file: string }> {
  const dir = path.join(FIXTURES_ROOT, toolId)
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
  return files.map((file) => ({
    ...(JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as ReplayFixture),
    file,
  }))
}

describe("model call replay (五关准入协议·第五关)", () => {
  for (const [toolId, tool] of Object.entries(REPLAY_TOOLS)) {
    describe(toolId, () => {
      const fixtures = loadFixtures(toolId)
      const passCount = fixtures.filter((f) => f.expect === "pass").length
      const rejectCount = fixtures.filter((f) => f.expect === "reject").length

      test("回放用例数量满足准入下限（≥5 条，≥2 正 ≥3 反）", () => {
        expect(fixtures.length).toBeGreaterThanOrEqual(MIN_TOTAL)
        expect(passCount).toBeGreaterThanOrEqual(MIN_PASS)
        expect(rejectCount).toBeGreaterThanOrEqual(MIN_REJECT)
      })

      test("每条拒绝用例都必须提供可操作的 rejectHint", () => {
        for (const fixture of fixtures) {
          if (fixture.expect !== "reject") continue
          expect(fixture.rejectHint, `${fixture.file} 缺少 rejectHint`).toBeDefined()
          expect(fixture.rejectHint!.length, `${fixture.file} 的 rejectHint 为空`).toBeGreaterThan(0)
        }
      })

      for (const fixture of fixtures) {
        test(`[${fixture.file}] ${fixture.description}`, async () => {
          const info = await tool.init()
          const normalized = Tool.normalizeToolArgs(fixture.modelArgs)
          const result = info.parameters.safeParse(normalized)

          if (fixture.expect === "pass") {
            if (!result.success) {
              throw new Error(`期望通过但被拒绝：${JSON.stringify(result.error.issues)}`)
            }
            expect(result.success).toBe(true)
            return
          }

          expect(result.success).toBe(false)
          if (result.success) return
          const message = info.formatValidationError
            ? info.formatValidationError(result.error)
            : result.error.issues.map((issue) => issue.message).join("；")
          for (const hint of fixture.rejectHint ?? []) {
            expect(message).toContain(hint)
          }
        })
      }
    })
  }
})
