import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { classifyToolFailure, evaluateQaGate, persistToolReflection } from "@/tool/analysis-reflection"
import { duplicatePanelKeyMessage } from "@/runtime/analysis-user-view"
import { ManagedProcessError } from "@/runtime/managed-process"
import { Instance } from "@/project/instance"

function classify(input: Parameters<typeof classifyToolFailure>[0]) {
  return Instance.provide({ directory: process.cwd(), fn: async () => classifyToolFailure(input) })
}

describe("analysis failure classification", () => {
  test("Python 计量执行失败按估计失败分类，不伪装成未知副作用重试", async () => {
    const reflection = await classify({
      toolName: "ols_regression",
      errorCode: "METHOD_EXECUTION_FAILED",
      error: "估计器返回了可诊断的数值错误。",
    })

    expect(reflection.failureType).toBe("estimation_failure")
    expect(reflection.retryStage).toBe("estimate")
    expect(reflection.repairAction).toContain("估计")
  })

  test("执行数据快照失败被阻断分类并指向刷新数据阶段，不原样重试估计", async () => {
    const reflection = await classify({
      toolName: "ols_regression",
      errorCode: "DATA_SNAPSHOT_UNSTABLE",
      error: "当前数据文件在创建执行快照时发生变化；估计器没有运行。",
    })

    expect(reflection.failureType).toBe("data_snapshot_failure")
    expect(reflection.blocking).toBe(true)
    expect(reflection.retryStage).toBe("validate")
    expect(reflection.repairAction).toContain("重新准备规格")
  })

  // 未验证是否可消解时（旧版本 QA 报告，或 Python 后端没能算出候选列）：仍走"先核实、
  // 不要假设是重复"的谨慎措辞，不给出结论性建议。
  test("unverified duplicate panel-key QA block asks to verify before assuming it's a real duplicate", () => {
    const result = evaluateQaGate({
      toolName: "data_import",
      qaSource: "quality-report.json",
      blockingErrors: ["Found 115 duplicate entity-time rows"],
    })

    expect(result.reflection?.failureType).toBe("validate_blocked")
    expect(result.reflection?.repairAction).toContain("combine_columns")
    expect(result.reflection?.repairAction).toContain("不要在没有验证的情况下假设是重复")
    expect(result.reflection?.repairAction).not.toContain("Repair blocking QA issues")
    expect(result.reflection?.userVisibleExplanation).toBe(
      "数据质检发现待处理项；请只修复当前数据阶段，重新质检后再继续分析。",
    )
  })

  // 2026-08-12 gf.xlsx 事故的回归锁：QA 已经验证出加"省份"列能让 115 个重复完全消解
  // （这些是 6 个省份各自的"其他"类别，是合法的独立观测，不是重复记录）。此时必须
  // 直接给出可执行指令并明确"不要删除"，不能再问用户"要不要删除重复行"——那正是
  // 事故发生的路径：模型把这句话包装成选择题，用户选了"删除(推荐)"，实际会静默
  // 损毁 115 行合法数据。
  test("verified-resolvable duplicate panel-key QA block gives the exact fix and forbids deletion", async () => {
    const errorText =
      "Data operation blocked by QA gate: QA gate blocked by 1 blocking issue(s): " +
      "Found 115 duplicate entity-time rows under '地区'x'年份'. Verified: combining '地区' with column '省份' " +
      "resolves all duplicates (yields 421 unique entities, 0 duplicates). This is not a true duplicate-record issue."

    const reflection = await classify({ toolName: "data_import", error: errorText })

    expect(reflection.failureType).toBe("validate_blocked")
    expect(reflection.repairAction).toContain("这不是真实重复")
    expect(reflection.repairAction).toContain("combine_columns")
    expect(reflection.repairAction).toContain("'省份'")
    expect(reflection.repairAction).toContain("'地区'")
    expect(reflection.repairAction).toContain("不要删除这些行")

    const gate = evaluateQaGate({
      toolName: "data_import",
      qaSource: "quality-report.json",
      blockingErrors: [errorText],
    })
    expect(gate.reflection?.repairAction).toContain("不要删除这些行")

    const message = duplicatePanelKeyMessage(115, errorText)
    expect(message).toContain("不是数据重复")
    expect(message).toContain("不会删除任何行")
  })

  test("classifies managed-process timeout as a bounded execution failure", async () => {
    const reflection = await classify({
      toolName: "ols_regression",
      error: "ManagedProcessError: PROCESS_TIMEOUT 计量分析超过 300000ms",
    })

    expect(reflection.failureType).toBe("process_timeout")
    expect(reflection.retryStage).toBe("estimate")
    expect(reflection.repairAction).toContain("缩小")
    expect(reflection.repairAction).toContain("不要自动改用")
  })

  test("classifies Chinese Zod feedback as a model tool-contract error", async () => {
    const reflection = await classify({
      toolName: "iv_2sls",
      error: "计量工具参数不合法：instrumentVar：Required；covariance：Invalid option",
    })

    expect(reflection.failureType).toBe("tool_contract_failure")
    expect(reflection.retryStage).toBe("estimate")
    expect(reflection.repairAction).toContain("参数")
  })

  test("classifies Chinese missing-column feedback as column_not_found", async () => {
    const reflection = await classify({
      toolName: "did_static",
      error: "数据中找不到变量：post",
    })

    expect(reflection.failureType).toBe("column_not_found")
    expect(reflection.retryStage).toBe("validate")
  })

  test("classifies the backend's structured plural missing-column error as column_not_found", async () => {
    const reflection = await classify({
      toolName: "data_preprocess",
      error: "COLUMN_NOT_FOUND: Columns not found: cohort\n修复建议：根据字段级错误修正 method、columns 或 options。",
    })

    expect(reflection.failureType).toBe("column_not_found")
    expect(reflection.retryStage).toBe("clean")
  })

  test("classifies the Python data-import variable-list error as column_not_found", async () => {
    const reflection = await classify({
      toolName: "data_import",
      error: "variables 中包含不存在的变量：不存在的年份列。请使用当前数据阶段真实列名。",
    })

    expect(reflection.failureType).toBe("column_not_found")
    expect(reflection.retryStage).toBe("profile")
    expect(reflection.repairAction).toContain("准确列名")
  })

  test("classifies an invalid tool-output reference as a tool-contract error", async () => {
    const reflection = await classify({
      toolName: "read",
      error: "TOOL_OUTPUT_REFERENCE_DENIED：分页输出标识不合法。",
    })

    expect(reflection.failureType).toBe("tool_contract_failure")
    expect(reflection.repairAction).toContain("参数")
  })

  test("classifies Chinese rank-deficient model specifications as actionable contract issues", async () => {
    const reflection = await classify({
      toolName: "ols_regression",
      error: "设计矩阵秩亏（rank=7，列数=8），存在完全共线性，请删除重复或线性组合变量",
    })

    expect(reflection.failureType).toBe("tool_contract_failure")
    expect(reflection.retryStage).toBe("estimate")
    expect(reflection.repairAction).toContain("共线")
    expect(reflection.repairAction).toContain("询问用户")
    expect(reflection.repairAction).not.toContain("幂等执行凭证")
  })

  test("classifies generic Chinese tool schema feedback by structured code", async () => {
    const reflection = await classify({
      toolName: "data_preprocess",
      error: "工具 data_preprocess 参数不合法：参数：包含未定义字段（action）",
      errorCode: "TOOL_INPUT_INVALID",
    })

    expect(reflection.failureType).toBe("tool_contract_failure")
    expect(reflection.retryStage).toBe("clean")
  })

  test("classifies create_column column-reference misuse as a repairable contract error", async () => {
    const reflection = await classify({
      toolName: "data_preprocess",
      error: "INVALID_INPUT: Right value 'time' is not numeric for create_column comparison",
    })

    expect(reflection.failureType).toBe("tool_contract_failure")
    expect(reflection.repairAction).not.toContain("幂等执行凭证")
    expect(reflection.repairAction).toContain("参数")
  })

  test("uses ManagedProcessError.code for classification, independent of message wording", async () => {
    // 文案被改动时，结构化 errorCode 仍能正确分类（文本匹配只作兜底）。
    const timeout = await classify({
      toolName: "ols_regression",
      error: "后端进程被终止",
      errorCode: new ManagedProcessError("PROCESS_TIMEOUT", "后端进程被终止").code,
    })
    expect(timeout.failureType).toBe("process_timeout")
    expect(timeout.retryStage).toBe("estimate")
    expect(timeout.repairAction).toContain("缩小")

    const spawnFailed = await classify({
      toolName: "panel_fe_regression",
      error: "无法启动分析进程",
      errorCode: new ManagedProcessError("PROCESS_SPAWN_FAILED", "无法启动分析进程").code,
    })
    expect(spawnFailed.failureType).toBe("python_missing")

    const aborted = await classify({
      toolName: "iv_2sls",
      error: "计量工具已由用户取消",
      errorCode: new ManagedProcessError("PROCESS_ABORTED", "计量工具已由用户取消").code,
    })
    // 用户主动取消：不归入需要修复的类型，避免自动修复重跑用户刚取消的操作
    expect(aborted.failureType).toBe("unknown_failure")
    expect(aborted.blocking).toBe(false)
  })

  test.each([
    "IPW overlap failure: every propensity score must remain inside the fixed [0.05, 0.95] interval",
    "IPW effective sample size failure: treated ESS=12.00, control ESS=25.00; each must be at least 20",
    "IPW failed weighted balance: max absolute SMD=0.1432 exceeds 0.10",
    // python/psm/runner.py 真实产出的是中文（此前这里是一句虚构的英文合成文本，
    // 从未与实现同步过——分类规则第 132 行的中文关键词修复后，这条合成文案自然测不出
    // 真实产出，换成 runner.py 实际会抛出的文案）。
    "分析单位 data_id 存在 5 行重复；PSM 要求每个分析单位一行，请先按声明的聚合方式（baseline 或 pre_treatment_mean）把面板整理为横截面后再估计",
    "PSM matching failed post-match balance: max absolute SMD=0.1500 exceeds 0.10",
    "PSM matching found no treated observation within the fixed caliper",
    "Propensity-score design matrix is rank deficient (rank=2, columns=3)",
    "Propensity-score Logit did not converge",
    "Propensity-score Logit has perfect separation",
    "Propensity-score Logit returned boundary scores",
    "AIPW treated outcome model requires a full column rank outcome-model design",
  ])("routes PSM safety gate '%s' back to QA", async (error) => {
    const reflection = await classify({ toolName: "psm_double_robust", error })

    expect(reflection.failureType).toBe("validate_blocked")
    expect(reflection.retryStage).toBe("validate")
    expect(reflection.repairAction).toContain("质检")
  })

  test("classifies a blocked claim ceiling as a non-retryable result contract failure", async () => {
    const reflection = await classify({
      toolName: "did_static",
      error: "claim ceiling blocked",
      errorCode: "CLAIM_CEILING_BLOCKED",
    })

    expect(reflection.failureType).toBe("result_contract_failure")
    expect(reflection.retryStage).toBe("verify")
  })

  test("classifies result-contract failures as blocked adapter failures, not estimation retries", async () => {
    const reflection = await classify({
      toolName: "ols_regression",
      error: "RESULT_LINEAGE_MISMATCH: metadata.result.datasetId does not match the requested dataset",
      errorCode: "RESULT_LINEAGE_MISMATCH",
    })

    expect(reflection.failureType).toBe("result_contract_failure")
    expect(reflection.blocking).toBe(true)
    expect(reflection.retryStage).toBe("verify")
    expect(reflection.repairAction).toContain("结果契约")
  })

  test("通用工具输出 Schema 失败属于结果契约错误，不应触发参数修复或重跑", async () => {
    const reflection = await classify({
      toolName: "data_preprocess",
      error: "工具结果未通过输出 Schema 校验：metadata。",
      errorCode: "TOOL_OUTPUT_INVALID",
    })

    expect(reflection.failureType).toBe("result_contract_failure")
    expect(reflection.blocking).toBe(true)
    expect(reflection.repairAction).toContain("结果契约")
  })

  test("classifies an unavailable native tool as a contract error", async () => {
    const reflection = await classify({
      toolName: "hallucinated_estimator",
      error: "Model tried to call unavailable tool 'hallucinated_estimator'. Available tools: ols_regression.",
    })

    expect(reflection.failureType).toBe("tool_contract_failure")
    expect(reflection.repairAction).toContain("参数")
  })

  test("classifies a missing-profile estimator rejection as planning_failure with retryStage=profile", async () => {
    // 真实场景（2026-08-05 did.xlsx）：模型跳过画像直接调估计器，门禁拒绝。
    // 此前落入 unknown_failure、retryStage=estimate，修复指令指向错误阶段，模型瞎猜；
    // 现在应识别为"前置条件缺失"，明确回 profile。
    const reflection = await classify({
      toolName: "panel_fe_regression",
      error: "计量估计前必须先完成当前 canonical stage（或父 stage）的数据画像；请先分析数据结构。",
    })

    expect(reflection.failureType).toBe("planning_failure")
    expect(reflection.retryStage).toBe("profile")
    expect(reflection.blocking).toBe(true)
  })

  test("routes a missing-QA estimator rejection back to QA", async () => {
    // 与 stage.ts 门禁真实文案一致："必须先在"而非"必须先"。
    const reflection = await classify({
      toolName: "panel_fe_regression",
      error: "计量估计前必须先在当前 canonical stage 通过 QA；请先完成数据质检。",
    })

    expect(reflection.failureType).toBe("validate_blocked")
    expect(reflection.retryStage).toBe("validate")
    expect(reflection.repairAction).toContain("质检")
  })

  test("does not turn a constant-result precondition into an idempotency stop", async () => {
    const reflection = await classify({
      toolName: "poisson_regression",
      error: "结果变量没有变异（取值全相同），无法估计",
    })

    expect(reflection.failureType).toBe("validate_blocked")
    expect(reflection.retryStage).toBe("validate")
    expect(reflection.repairAction).toContain("质检")
  })

  test("classifies a missing-profile preprocess rejection as planning_failure", async () => {
    const reflection = await classify({
      toolName: "data_preprocess",
      error: "数据预处理前必须先完成当前会话同一数据集阶段的画像。",
    })

    expect(reflection.failureType).toBe("planning_failure")
  })

  test("unknown failures return a Chinese minimal-repair instruction", async () => {
    const reflection = await classify({
      toolName: "data_import",
      error: "工具调用执行期间已取消",
    })

    expect(reflection.repairAction).toContain("结构化错误")
    expect(reflection.repairAction).toContain("最小修复")
    expect(reflection.repairAction).not.toContain("Inspect the structured error")
  })

  test("classifies the QA-already-blocked estimator rejection as validate_blocked with retryStage=qa", async () => {
    // 与 stage.ts:502-512 新错误文案一致：QA 已跑过但 verifier 判定为阻断。
    // 此前落入 unknown_failure → retryStage=estimate（指回估计阶段），模型在 validate
    // 阻断循环里反复重跑估计器（2026-08-05 did.xlsx 第三轮真实数据测试三次失败）。
    // 修复：识别为 validate_blocked → retryStage=qa，repairAction=修复 QA 阻断项。
    const reflection = await classify({
      toolName: "panel_fe_regression",
      error: [
        "当前 canonical stage 的 QA 已经执行过（stage_000__validate），但被判定为阻断，重复运行 QA 不会改变结果。",
        "阻断原因：No saved artifacts were found for the current stage.",
        "修复建议：Regenerate the missing artifacts from the latest manifest lineage before continuing.",
        "请修复上述阻断项本身；若无法修复，请向用户说明并询问如何继续，不要反复重跑质检。",
      ].join("\n"),
    })

    expect(reflection.failureType).toBe("validate_blocked")
    expect(reflection.retryStage).toBe("validate")
    expect(reflection.blocking).toBe(true)
  })

  test("classifies a Python FileNotFoundError after private-path redaction", async () => {
    const reflection = await classify({
      toolName: "data_import",
      error: "FileNotFoundError: /Users/alice/My Project/private data.xlsx: source missing",
    })

    expect(reflection.failureType).toBe("file_not_found")
    expect(reflection.retryStage).toBe("ingest")
    expect(reflection.error).toContain("source missing")
    expect(reflection.error).not.toContain("/Users/alice")
  })

  test("把 Harness 中文输入文件不存在错误归类为可修复路径失败", async () => {
    const reflection = await classify({
      toolName: "data_import",
      error: "找不到输入文件：/Users/alice/project/data/diid.xlsx",
    })

    expect(reflection.failureType).toBe("file_not_found")
    expect(reflection.retryStage).toBe("ingest")
    expect(reflection.repairAction).toContain("重新查找文件")
    expect(reflection.error).not.toContain("/Users/alice")
  })

  test("把模型读取不存在的外部化报告归类为文件路径错误并指回结构化诊断", async () => {
    const reflection = await classify({
      toolName: "read",
      error: "找不到文件：did_0f88fc12_import_report.json\n修复建议：文件过大时用新的 offset 续读。",
    })

    expect(reflection.failureType).toBe("file_not_found")
    expect(reflection.repairAction).toContain("data_import")
    expect(reflection.repairAction).toContain("不要重复读取")
    expect(reflection.repairAction).not.toContain("换一种参数")
  })

  test("persists a bounded redacted reflection with private permissions", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-reflection-"))
    const reflectionPath = await Instance.provide({
      directory,
      fn: async () => {
        const reflection = classifyToolFailure({
          toolName: "ols_regression",
          error: [
            "估计失败 api_key=sk-reflection-secret",
            "Traceback (most recent call last):",
            '  File "/Users/private/estimate.py", line 4, in <module>',
            "    estimate()",
            `ValueError: ${"x".repeat(20_000)}`,
          ].join("\n"),
          input: {
            datasetId: "dataset_1",
            api_key: "tiny-secret",
            wide: Array.from({ length: 50 }, (_, index) => `${index}:${"wide".repeat(375)}`),
          },
          sessionId: "session_1",
        })
        return persistToolReflection(reflection)
      },
    })

    const stored = fs.readFileSync(reflectionPath, "utf-8")
    expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(32 * 1024)
    expect(stored).not.toContain("sk-reflection-secret")
    expect(stored).not.toContain("tiny-secret")
    expect(stored).not.toContain("Traceback")
    expect(stored).not.toContain("/Users/private")
    expect(stored).toContain("[已脱敏]")
    expect(fs.statSync(reflectionPath).mode & 0o777).toBe(0o600)
    fs.rmSync(directory, { recursive: true, force: true })
  })

  test("never overwrites a concurrent reflection with the same tool and timestamp", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-reflection-unique-"))
    const paths = await Instance.provide({
      directory,
      fn: async () => {
        const reflection = classifyToolFailure({
          toolName: "ols_regression",
          error: "estimation failed",
          sessionId: "session_same_millisecond",
        })
        reflection.createdAt = "2026-07-16T00:00:00.000Z"
        return [persistToolReflection(reflection), persistToolReflection(reflection)]
      },
    })

    expect(paths[0]).not.toBe(paths[1])
    expect(paths.every((filePath) => fs.existsSync(filePath))).toBe(true)
    fs.rmSync(directory, { recursive: true, force: true })
  })
})
