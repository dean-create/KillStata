import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Instance } from "@/project/instance"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { EconometricsEngineError } from "@/runtime/services/econometrics-engine-client"
import {
  prepareAnalysisSpec,
  resolvePreparedSpecForExecution,
  type AnalysisSpecEngine,
} from "@/runtime/services/analysis-spec-service"
import { AnalysisPrepareTool } from "@/tool/analysis-prepare"

const DATA_FINGERPRINT = `sha256:${"a".repeat(64)}`

async function withTask<T>(fn: (input: { sessionID: string; taskId: string; sourceMessageId: string; requestId: string }) => T | Promise<T>, kind: "estimate" | "inspect" = "estimate") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-analysis-spec-"))
  try {
    return await Instance.provide({ directory: root, fn: async () => {
      const input = {
        sessionID: "session_analysis_spec",
        taskId: "task_analysis_spec",
        sourceMessageId: "message_analysis_spec",
      }
      RuntimeTaskLedger.recordQueued({
        id: input.taskId,
        sessionID: input.sessionID,
        type: "prompt",
        priority: 10,
        createdAt: Date.now(),
        metadata: { messageID: input.sourceMessageId },
      })
      const request = RuntimeTaskLedger.recordAnalysisRequest({
        sessionID: input.sessionID,
        taskId: input.taskId,
        sourceMessageId: input.sourceMessageId,
        kind,
        researchGoal: "估计核心解释变量与结果变量的关系",
        constraints: ["不作因果解释"],
      })
      return fn({ ...input, requestId: request.requestId })
    } })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function fakeEngine(overrides: Partial<AnalysisSpecEngine> = {}) {
  const calls: Array<{ operation: string; value: unknown }> = []
  const engine: AnalysisSpecEngine = {
    health: async () => ({ registry_version: 2, method_count: 30 }),
    describe: async (methodID: string) => {
      calls.push({ operation: "describe", value: methodID })
      return {
        method_id: methodID,
        schema_version: 2,
        runtime_injected_fields: [],
        input_schema: { type: "object", properties: { dependentVar: { type: "string" }, treatmentVar: { type: "string" } } },
      }
    },
    validate: async (methodID: string, args: Record<string, unknown>) => {
      calls.push({ operation: "validate", value: { methodID, args } })
      return { registry_version: 2, method_id: methodID, arguments: args }
    },
    preflight: async (payload: { method_id: string; data_path: string; arguments: Record<string, unknown> }) => {
      calls.push({ operation: "preflight", value: payload })
      return {
        method_id: payload.method_id,
        executable: true,
        status: "ready",
        normalized_arguments: payload.arguments,
        data_fingerprint: DATA_FINGERPRINT,
        issues: [],
        repair_plan: [],
      }
    },
    ...overrides,
  }
  return { engine, calls }
}

function preparationInput(input: { sessionID: string; taskId: string; sourceMessageId: string; requestId: string }, engine: AnalysisSpecEngine, extra: Record<string, unknown> = {}) {
  return {
    ...input,
    requestId: input.requestId,
    methodID: "ols_regression",
    arguments: { dependentVar: "结果", treatmentVar: "解释变量" },
    currentData: {
      datasetId: "dataset_1",
      stageId: "stage_000",
      dataPath: "/managed/dataset/stage_000.parquet",
      stageMetadata: {
        dataDiagnosis: {
          version: 1,
          stage_id: "stage_000",
          data_fingerprint: DATA_FINGERPRINT,
        },
      },
    },
    engine,
    ...extra,
  }
}

describe("prepareAnalysisSpec", () => {
  test("tool schema accepts only the generic request/method/arguments envelope", async () => {
    const tool = await AnalysisPrepareTool.init()
    const valid = { requestId: "analysis_request_1", methodID: "ols_regression", arguments: {} }

    expect(tool.parameters.safeParse(valid).success).toBe(true)
    expect(tool.parameters.safeParse({ ...valid, datasetId: "forged_dataset" }).success).toBe(false)
    expect(tool.parameters.safeParse({ ...valid, stageId: "forged_stage" }).success).toBe(false)
    expect(tool.parameters.safeParse({ ...valid, data_path: "/tmp/other.parquet" }).success).toBe(false)
  })

  test("validates with Python, preflights the exact current stage, and persists a prepared spec without estimating", async () => {
    await withTask(async (task) => {
      const { engine, calls } = fakeEngine()
      const result = await prepareAnalysisSpec(preparationInput(task, engine))

      expect(result.status).toBe("ready")
      expect(result.preparedSpec).toMatchObject({
        requestId: task.requestId,
        sourceMessageId: task.sourceMessageId,
        methodID: "ols_regression",
        datasetId: "dataset_1",
        stageId: "stage_000",
        stageFingerprint: DATA_FINGERPRINT,
        registryVersion: 2,
        schemaVersion: 2,
      })
      expect(result.spec?.argumentSources).toMatchObject({
        dependentVar: { kind: "model_interpretation", sourceMessageId: task.sourceMessageId },
      })
      expect(calls.map((item) => item.operation)).toEqual(["describe", "validate", "preflight"])
      expect(calls.find((item) => item.operation === "preflight")?.value).toMatchObject({
        method_id: "ols_regression",
        data_path: "/managed/dataset/stage_000.parquet",
      })
      expect(RuntimeTaskLedger.listTasks(task.sessionID).tasks[0]?.preparedSpec).toEqual(result.preparedSpec)
      expect(RuntimeTaskLedger.listTasks(task.sessionID).tasks[0]?.analysisLifecycle).toMatchObject({
        status: "ready",
        requestId: task.requestId,
        specId: result.preparedSpec?.specId,
        specRevision: result.preparedSpec?.revision,
        methodID: "ols_regression",
        stageFingerprint: DATA_FINGERPRINT,
      })
      expect(RuntimeTaskLedger.listTasks(task.sessionID).tasks[0]?.analysisLifecycle)
        .not.toHaveProperty("authorization")
    })
  })

  test("an inspect request can assess feasibility but cannot create an executable PreparedSpec", async () => {
    await withTask(async (task) => {
      const { engine } = fakeEngine()
      const result = await prepareAnalysisSpec(preparationInput(task, engine))
      const storedTask = RuntimeTaskLedger.listTasks(task.sessionID).tasks[0]

      expect(result.status).toBe("preflight_ready")
      expect(result.spec?.status).toBe("preflight_ready")
      expect(result.preparedSpec).toBeUndefined()
      expect(storedTask?.preparedSpec).toBeUndefined()
      expect(storedTask?.analysisLifecycle?.status).toBe("ready")
      expect(storedTask?.analysisLifecycle?.authorization).toBeUndefined()
    }, "inspect")
  })

  test("does not prepare against a stale or missing diagnosis fingerprint", async () => {
    await withTask(async (task) => {
      const { engine } = fakeEngine()
      const result = await prepareAnalysisSpec(preparationInput(task, engine, {
        currentData: {
          datasetId: "dataset_1",
          stageId: "stage_000",
          dataPath: "/managed/dataset/stage_000.parquet",
          stageMetadata: { dataDiagnosis: { version: 1, stage_id: "stage_000", data_fingerprint: `sha256:${"b".repeat(64)}` } },
        },
      }))

      expect(result.status).toBe("diagnosis_refresh_required")
      expect(result.preparedSpec).toBeUndefined()
      expect(RuntimeTaskLedger.listTasks(task.sessionID).tasks[0]?.preparedSpec).toBeUndefined()
    })
  })

  test("records Pydantic-normalized defaults separately from model-interpreted fields", async () => {
    await withTask(async (task) => {
      const { engine } = fakeEngine({
        validate: async (methodID, args) => ({
          registry_version: 2,
          method_id: methodID,
          arguments: { ...args, covariates: [] },
        }),
      })
      const result = await prepareAnalysisSpec(preparationInput(task, engine, {
        arguments: { dependentVar: "结果", treatmentVar: "解释变量" },
      }))

      expect(result.spec?.argumentSources).toMatchObject({
        covariates: { kind: "registry_default_or_normalization", registryVersion: 2, schemaVersion: 2 },
      })
      expect(result.spec?.argumentSources.covariates).not.toHaveProperty("sourceMessageId")
    })
  })

  test("records an exact column restored from the user message as user-explicit provenance", async () => {
    await withTask(async (task) => {
      const { engine } = fakeEngine()
      const result = await prepareAnalysisSpec(preparationInput(task, engine, {
        methodID: "panel_fe_regression",
        arguments: { dependentVar: "结果", treatmentVar: "解释变量", entityVar: "地区", timeVar: "年份" },
        userSpecifiedFields: ["timeVar"],
      }))

      expect(result.status).toBe("ready")
      expect(result.spec?.argumentSources.timeVar).toEqual({
        kind: "user_explicit",
        sourceMessageId: task.sourceMessageId,
      })
    })
  })

  test("returns missing research roles for clarification without preparing or estimating", async () => {
    await withTask(async (task) => {
      const { engine } = fakeEngine({
        validate: async () => {
          throw new EconometricsEngineError("INVALID_ARGUMENT", "缺少必要参数。", {
            validation_errors: [{ type: "missing", loc: ["dependentVar"], msg: "Field required" }],
          })
        },
      })
      const result = await prepareAnalysisSpec(preparationInput(task, engine))

      expect(result.status).toBe("clarification_required")
      expect(result.missingFields).toEqual(["dependentVar"])
      expect(result.preparedSpec).toBeUndefined()
      expect(RuntimeTaskLedger.listTasks(task.sessionID).tasks[0]?.analysisSpecs ?? []).toHaveLength(0)
      expect(RuntimeTaskLedger.listTasks(task.sessionID).tasks[0]?.analysisLifecycle).toMatchObject({
        status: "waiting_user",
        issueCode: "RESEARCH_ROLES_REQUIRED",
      })
    })
  })

  test("a missing data column becomes a structured user-decision result instead of an opaque tool error", async () => {
    await withTask(async (task) => {
      const { engine } = fakeEngine({
        preflight: async () => {
          throw new EconometricsEngineError("DATA_COLUMN_MISSING", "数据中找不到变量：year。", {
            method_id: "panel_fe_regression",
            columns: ["year"],
          })
        },
      })
      const result = await prepareAnalysisSpec(preparationInput(task, engine, {
        methodID: "panel_fe_regression",
        arguments: { dependentVar: "结果", treatmentVar: "解释变量", entityVar: "地区", timeVar: "year" },
      }))
      const storedTask = RuntimeTaskLedger.listTasks(task.sessionID).tasks[0]

      expect(result.status).toBe("requires_user_decision")
      expect(result.issueCode).toBe("DATA_COLUMN_MISSING")
      expect(result.message).toContain("year")
      expect(result.message).toContain("没有运行估计")
      expect(result.spec).toBeUndefined()
      expect(storedTask?.analysisSpecs ?? []).toHaveLength(0)
      expect(storedTask?.analysisLifecycle).toMatchObject({
        status: "waiting_user",
        issueCode: "DATA_COLUMN_MISSING",
      })
    })
  })

  test("preserves deterministic Pydantic type and enum errors for model correction", async () => {
    await withTask(async (task) => {
      const { engine } = fakeEngine({
        validate: async () => {
          throw new EconometricsEngineError("INVALID_ARGUMENT", "参数 covariance 类型或取值不合法。", {
            validation_errors: [{ type: "literal_error", loc: ["covariance"], msg: "Input should be 'HC1'" }],
          })
        },
      })

      await expect(prepareAnalysisSpec(preparationInput(task, engine))).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        message: "参数 covariance 类型或取值不合法。",
      })
      expect(RuntimeTaskLedger.listTasks(task.sessionID).tasks[0]?.analysisSpecs ?? []).toHaveLength(0)
    })
  })

  test("rejects model-supplied Harness runtime fields through Python validation", async () => {
    await withTask(async (task) => {
      const { engine } = fakeEngine({
        validate: async () => {
          throw new EconometricsEngineError("INVALID_ARGUMENT", "arguments 不得包含由 Harness 注入的 runtime 字段：stageId。", {
            field: "stageId",
            validation_errors: [{ type: "extra_forbidden", loc: ["stageId"], msg: "Extra inputs are not permitted" }],
          })
        },
      })

      await expect(prepareAnalysisSpec(preparationInput(task, engine, {
        arguments: { dependentVar: "结果", treatmentVar: "解释变量", stageId: "stage_999" },
      }))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
      expect(RuntimeTaskLedger.listTasks(task.sessionID).tasks[0]?.analysisSpecs ?? []).toHaveLength(0)
    })
  })

  test("unknown Registry methods fail before schema validation or persistence", async () => {
    await withTask(async (task) => {
      const { engine } = fakeEngine({
        describe: async (methodID) => {
          throw new EconometricsEngineError("METHOD_NOT_FOUND", `未找到计量方法：${methodID}。`, { method_id: methodID })
        },
      })

      await expect(prepareAnalysisSpec(preparationInput(task, engine, { methodID: "made_up_method" })))
        .rejects.toMatchObject({ code: "METHOD_NOT_FOUND" })
      expect(RuntimeTaskLedger.listTasks(task.sessionID).tasks[0]?.analysisSpecs ?? []).toHaveLength(0)
    })
  })

  test("same spec is idempotent and a changed proposal creates a new revision and invalidates the old prepared spec", async () => {
    await withTask(async (task) => {
      const { engine } = fakeEngine()
      const first = await prepareAnalysisSpec(preparationInput(task, engine))
      const repeated = await prepareAnalysisSpec(preparationInput(task, engine))
      const changed = await prepareAnalysisSpec(preparationInput(task, engine, {
        arguments: { dependentVar: "结果", treatmentVar: "解释变量", covariates: ["控制变量"] },
      }))

      expect(repeated.spec?.specId).toBe(first.spec?.specId)
      expect(repeated.spec?.revision).toBe(1)
      expect(changed.spec?.revision).toBe(2)
      expect(changed.spec?.specId).not.toBe(first.spec?.specId)
      expect(RuntimeTaskLedger.listTasks(task.sessionID).tasks[0]?.analysisSpecs).toHaveLength(2)
      expect(RuntimeTaskLedger.listTasks(task.sessionID).tasks[0]?.preparedSpec?.specId).toBe(changed.spec?.specId)
    })
  })

  test("execution can resolve only the latest PreparedSpec bound to this request and current stage", async () => {
    await withTask(async (task) => {
      const { engine } = fakeEngine()
      const prepared = await prepareAnalysisSpec(preparationInput(task, engine))
      if (!prepared.preparedSpec) throw new Error("test setup did not prepare a spec")
      const currentData = preparationInput(task, engine).currentData

      const resolved = resolvePreparedSpecForExecution({
        sessionID: task.sessionID,
        taskId: task.taskId,
        sourceMessageId: task.sourceMessageId,
        requestId: task.requestId,
        specId: prepared.preparedSpec.specId,
        currentData,
        authorizedMethodIDs: ["ols_regression"],
      })
      expect(resolved.status).toBe("ready")
      if (resolved.status !== "ready") throw new Error("PreparedSpec should resolve as ready in this test")
      expect(resolved.preparedSpec).toEqual(prepared.preparedSpec)

      const staleStage = resolvePreparedSpecForExecution({
        sessionID: task.sessionID,
        taskId: task.taskId,
        sourceMessageId: task.sourceMessageId,
        requestId: task.requestId,
        specId: prepared.preparedSpec.specId,
        currentData: { ...currentData, stageId: "stage_001" },
        authorizedMethodIDs: ["ols_regression"],
      })
      expect(staleStage.status).toBe("invalidated")
      expect("message" in staleStage && staleStage.message).toContain("当前阶段")

      const staleDiagnosis = resolvePreparedSpecForExecution({
        sessionID: task.sessionID,
        taskId: task.taskId,
        sourceMessageId: task.sourceMessageId,
        requestId: task.requestId,
        specId: prepared.preparedSpec.specId,
        currentData: {
          ...currentData,
          stageMetadata: {
            dataDiagnosis: {
              version: 1,
              stage_id: currentData.stageId,
              data_fingerprint: `sha256:${"b".repeat(64)}`,
            },
          },
        },
        authorizedMethodIDs: ["ols_regression"],
      })
      expect(staleDiagnosis.status).toBe("invalidated")
      expect("message" in staleDiagnosis && staleDiagnosis.message).toContain("数据诊断已失效")

      const forgedID = resolvePreparedSpecForExecution({
        sessionID: task.sessionID,
        taskId: task.taskId,
        sourceMessageId: task.sourceMessageId,
        requestId: task.requestId,
        specId: "spec_forged",
        currentData,
        authorizedMethodIDs: ["ols_regression"],
      })
      expect(forgedID.status).toBe("invalidated")
      expect("message" in forgedID && forgedID.message).toContain("specId")

      const unapprovedMethod = resolvePreparedSpecForExecution({
        sessionID: task.sessionID,
        taskId: task.taskId,
        sourceMessageId: task.sourceMessageId,
        requestId: task.requestId,
        specId: prepared.preparedSpec.specId,
        currentData,
        authorizedMethodIDs: [],
      })
      expect(unapprovedMethod.status).toBe("authorization_required")
    })
  })

  test("a non-ready preflight is persisted as a decision state but never becomes executable", async () => {
    await withTask(async (task) => {
      const { engine } = fakeEngine({
        preflight: async (payload: { method_id: string; data_path: string; arguments: Record<string, unknown> }) => ({
          method_id: payload.method_id,
          executable: false,
          status: "requires_user_decision",
          normalized_arguments: payload.arguments,
          data_fingerprint: DATA_FINGERPRINT,
          issues: [{ code: "DESIGN_AMBIGUOUS", summary_zh: "处理组定义需要确认。" }],
          repair_plan: [],
        }),
      })
      const result = await prepareAnalysisSpec(preparationInput(task, engine))
      const ledgerTask = RuntimeTaskLedger.listTasks(task.sessionID).tasks[0]

      expect(result.status).toBe("requires_user_decision")
      expect(result.preparedSpec).toBeUndefined()
      expect(ledgerTask?.analysisSpecs?.at(-1)?.status).toBe("requires_user_decision")
      expect(ledgerTask?.preparedSpec).toBeUndefined()
    })
  })

  test("analysis_prepare returns preflight issues and repair options as structured tool metadata", async () => {
    await withTask(async (task) => {
      const issue = {
        code: "DID_GROUP_NOT_BINARY",
        severity: "blocking",
        summary_zh: "组变量 time 不是二元变量。",
        evidence: { column: "time", missingRows: 2, observedValueCount: 3 },
      }
      const repair = {
        id: "confirm_treatment_cohort_semantics",
        label_zh: "确认处理组与 cohort 含义",
        description_zh: "传统 2×2 DID 要求固定处理组和统一政策前后期。",
        semantic_impact: "changes_research_design",
        requires_user_confirmation: true,
      }
      const { engine } = fakeEngine({
        preflight: async (payload) => ({
          method_id: payload.method_id,
          executable: false,
          status: "requires_user_decision",
          normalized_arguments: payload.arguments,
          data_fingerprint: DATA_FINGERPRINT,
          issues: [issue],
          repair_plan: [repair],
        }),
      })
      const tool = await AnalysisPrepareTool.init()
      const output = await tool.execute(
        {
          requestId: task.requestId,
          methodID: "did_static",
          arguments: { dependentVar: "结果", groupVar: "time", postVar: "did" },
        },
        {
          sessionID: task.sessionID,
          messageID: task.sourceMessageId,
          agent: "analyst",
          abort: new AbortController().signal,
          extra: {
            prepareAnalysisSpec: (input: { requestId: string; methodID: string; arguments: Record<string, unknown> }) => prepareAnalysisSpec({
              sessionID: task.sessionID,
              taskId: task.taskId,
              sourceMessageId: task.sourceMessageId,
              requestId: input.requestId,
              methodID: input.methodID,
              arguments: input.arguments,
              currentData: {
                datasetId: "dataset_1",
                stageId: "stage_000",
                dataPath: "/managed/dataset/stage_000.parquet",
                stageMetadata: {
                  dataDiagnosis: {
                    version: 1,
                    stage_id: "stage_000",
                    data_fingerprint: DATA_FINGERPRINT,
                  },
                },
              },
              engine,
            }),
          },
          metadata() {},
          async ask() {},
        },
      )

      expect(output.metadata).toMatchObject({
        analysisSpecStatus: "requires_user_decision",
        requiresUserDecision: true,
        repairOnly: true,
        preflightStatus: "requires_user_decision",
        issues: [expect.objectContaining({ code: issue.code, evidence: issue.evidence })],
        repairPlan: [expect.objectContaining({ id: repair.id, requires_user_confirmation: true })],
      })
      expect(output.metadata.issues).toHaveLength(1)
      expect(output.metadata.repairPlan).toHaveLength(1)
      expect(output.output).toContain(issue.summary_zh)
      expect(output.output).toContain(repair.label_zh)
    })
  })
})
