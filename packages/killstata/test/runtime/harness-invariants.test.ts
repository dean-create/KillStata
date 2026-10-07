import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { ToolRegistry } from "@/tool/registry"
import { SystemPrompt } from "@/session/system"
import { resolveToolAvailability } from "@/runtime/workflow"
import { WORKFLOW_INPUT_INTENT_TOOL_BUNDLES, WORKFLOW_KNOWN_TOOL_IDS } from "@/runtime/tool-catalog"
import { PROMPT_TOOL_NAMES, TOOL_MANIFEST, assertPromptToolNamesRegistered } from "@/runtime/tool-manifest"
import type { WorkflowInputIntent, WorkflowStageKind } from "@/runtime/types"

/**
 * Harness 不变量测试网（阶段 0）。
 *
 * 目的不是验证某个功能"对不对"，而是把 harness 当前的**装配结果**锁成快照，
 * 让后续对提示词分层、工具真相源的重构可以证明"行为没变"。
 *
 * 三条不变量：
 *   1. 提示词里提到的每个工具名，必须在 ToolRegistry 里真实存在（防止改名后提示词漂移）；
 *   2. 每个 intent × stage 组合暴露的工具集合保持稳定（防止重构悄悄改变模型可见面）；
 *   3. system prompt 的分层装配结构保持稳定（防止某层内容意外丢失或串层）。
 */

const ALL_INTENTS: WorkflowInputIntent[] = [
  "conversation",
  "status",
  "repair",
  "verify",
  "report",
  "analysis",
  "ingest",
]

const ALL_STAGES: WorkflowStageKind[] = [
  "healthcheck",
  "import",
  "profile_or_schema_check",
  "validate",
  "preprocess_or_filter",
  "profile_or_diagnostics",
  "baseline_estimate",
  "verifier",
  "report",
]

async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-harness-invariants-"))
  try {
    return await Instance.provide({ directory: root, fn })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

/**
 * 从提示词文本里抽出所有"看起来像工具名"的标识符。
 *
 * 约定：产品的工具 ID 一律 snake_case 且至少两段（`ols_regression`、`data_import`）。
 * 提示词里的散文不会长这样，所以这个模式的误报可以靠白名单收敛，漏报则不影响
 * 本测试的目的——它要抓的是"提示词写了一个不存在的工具名"。
 */
function extractToolLikeNames(text: string): string[] {
  const matches = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []
  return [...new Set(matches)]
}

/**
 * 提示词里合法出现、但不是工具 ID 的 snake_case 词。
 * 主要是产物文件名、字段名和阶段名——它们与工具同形，但不受 registry 约束。
 */
const NON_TOOL_SNAKE_CASE_TERMS = new Set([
  // 产物文件
  "numeric_snapshot",
  "model_metadata",
  "results_json",
  "diagnostics_json",
  "data_path",
  "output_dir",
  // 阶段名
  "baseline_estimate",
  "profile_or_schema_check",
  "validate",
  "preprocess_or_filter",
  "profile_or_diagnostics",
  // 方法/概念名（非工具 ID）
  "random_effects",
  "fixed_effects",
  "parallel_trends",
  "event_study",
  "att_gt",
  "synthetic_control",
  "control_function",
  "first_stage",
  "forward_fill",
  "backward_fill",
  "linear_interpolate",
  "create_dummies",
  "relative_time",
  "combine_columns",
  "exit_plan",
  "plan_enter",
  "plan_exit",
  // workflow 工具的只读/查询类 action（不是独立工具 ID）
  "rerun_plan",
  "timeline",
  "diagnostics",
  "tools",
  "skills",
  "status",
  "artifacts",
  "export_artifact",
  "doctor",
  "verify",
  // data_preprocess filter 的 operator 取值（不是工具 ID）
  "not_in",
  "not_contains",
])

describe("harness 不变量：提示词与工具真相源一致", () => {
  test("ECONOMETRICS_CONTEXT 提到的每个工具名都在 ToolRegistry 中真实注册", async () => {
    await withInstance(async () => {
      const registered = new Set(await ToolRegistry.ids())
      // provider prompt = 人格 prompt + ECONOMETRICS_CONTEXT
      const promptText = SystemPrompt.provider({
        providerID: "deepseek",
        api: { id: "deepseek-v4-flash" },
      } as never).join("\n")

      const candidates = extractToolLikeNames(promptText).filter((name) => !NON_TOOL_SNAKE_CASE_TERMS.has(name))

      // 只对"确实像工具"的名字断言：候选词若既不在 registry 也不在已知非工具白名单，
      // 就说明提示词引用了一个不存在的工具，或白名单需要补充——两种都必须显式处理。
      const unknown = candidates.filter((name) => !registered.has(name))
      expect(unknown, `提示词引用了未注册的工具名（改名漏改或白名单缺失）: ${unknown.join(", ")}`).toEqual([])
    })
  })

  test("稳定提示词通过 Registry 协议发现计量方法，不枚举方法名", async () => {
    await withInstance(async () => {
      const promptText = SystemPrompt.provider({
        providerID: "deepseek",
        api: { id: "deepseek-v4-flash" },
      } as never).join("\n")

      for (const term of ["econometrics_recommend", "data_import", "tool_search", "econometrics_execute"]) {
        expect(promptText, `方法论层应提及 ${term}`).toContain(term)
      }
      for (const methodID of ["ols_regression", "panel_fe_regression", "did_static", "did2s", "iv_2sls"]) {
        expect(promptText).not.toContain(methodID)
      }
    })
  })

  test("稳定工具发现提示不枚举计量方法 ID", () => {
    const promptText = SystemPrompt.toolInventory([]).join("\n")
    for (const methodID of ["ols_regression", "panel_fe_regression", "did2s", "iv_2sls"]) {
      expect(promptText).not.toContain(methodID)
    }
    expect(promptText).toContain("tool_search")
  })

  test("PROMPT_TOOL_NAMES 的每个工具都在 TOOL_MANIFEST 里（提示词与清单同源）", () => {
    // manifest 的 id 由准入表运行时派生，类型层面只是 string，因此靠这个显式校验兜底：
    // 估计器被移出准入表而提示词还在引用时，这里立刻失败。
    expect(() => assertPromptToolNamesRegistered()).not.toThrow()
  })

  test("提示词点名的工具都真实出现在渲染后的方法论层里", async () => {
    await withInstance(async () => {
      const promptText = SystemPrompt.provider({
        providerID: "deepseek",
        api: { id: "deepseek-v4-flash" },
      } as never).join("\n")

      // 防止插值写错位置导致某个工具名根本没进提示词（模板字符串不会报错，只会静默丢失）
      for (const toolID of Object.values(PROMPT_TOOL_NAMES)) {
        expect(promptText, `PROMPT_TOOL_NAMES.${toolID} 应出现在方法论层`).toContain(toolID)
      }
    })
  })

  test("TOOL_MANIFEST 没有重复 ID", () => {
    const ids = TOOL_MANIFEST.map((entry) => entry.id)
    expect(new Set(ids).size, `manifest 存在重复 ID: ${ids.join(", ")}`).toBe(ids.length)
  })

  test("ToolRegistry.all() 内工具 ID 唯一（同 ID 双实现会互相覆盖）", async () => {
    // 曾发生 did_static 被 did.ts(linearmodels) 与 pyfixest.ts(PyFixest) 各 define 一次：
    // 模型新调用由 tools.ts 逐项覆盖赋值取数组后出现的（did.ts 版），历史阶段重跑由
    // byID() 的 .find() 取数组先出现的（pyfixest.ts 版）——同一 ID 在两条路径解析到
    // 不同实现。这里把"注册表数组内 ID 必须唯一"钉死，防止同款冲突再次出现。
    await withInstance(async () => {
      const ids = await ToolRegistry.ids()
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
      expect(dupes, `注册表存在重复工具 ID（模型/重跑将解析到不同实现）: ${[...new Set(dupes)].join(", ")}`).toEqual([])
    })
  })

  test("TOOL_MANIFEST 里每个工具都能被工作流重跑加载", async () => {
    // workflow 重跑曾用一张手写的 toolID→Tool switch 表，与准入表各写各的：准入表新增
    // logit / rdd / quantile 等估计器后，重跑这些阶段会抛 "No executable workflow tool
    // is registered"。改走 ToolRegistry.byID 后用这条不变量冻住——准入表增项而实现
    // 没注册时立刻失败，而不是等用户重跑到一半才炸。
    //
    // `list` 此前是已知例外——manifest 声明了但 registry.ts 从未 import。仅会话内部
    // 直调（message.ts 用户 @ 目录时）、模型层面不可见。补注册后已对齐。
    const KNOWN_UNREGISTERED: string[] = []
    await withInstance(async () => {
      const unloadable: string[] = []
      for (const entry of TOOL_MANIFEST) {
        if (!(await ToolRegistry.byID(entry.id))) unloadable.push(entry.id)
      }
      expect(unloadable, `manifest 声明了但注册表里没有实现的工具: ${unloadable.join(", ")}`).toEqual(
        KNOWN_UNREGISTERED,
      )
    })
  })

  test("toolCatalog 的延迟加载文案只给命名空间数量，不枚举隐藏工具ID", () => {
    const rendered = SystemPrompt.toolCatalog(
      [{ id: "tool_search", modelNamespace: "pipeline" }],
      [{ modelNamespace: "econometrics_estimator", count: 16 }],
    ).join("\n")
    expect(rendered).toContain("先调用 tool_search")
    expect(rendered).not.toContain("ols_regression")
  })
})

describe("harness 不变量：工具可见面快照", () => {
  test("每个 intent 的工具包保持稳定", () => {
    const snapshot: Record<string, string[]> = {}
    for (const intent of ALL_INTENTS) {
      snapshot[intent] = [...WORKFLOW_INPUT_INTENT_TOOL_BUNDLES[intent]].sort()
    }
    expect(snapshot).toMatchSnapshot()
  })

  test("每个 intent × stage 组合解析出的直连工具集合保持稳定", () => {
    const snapshot: Record<string, string[]> = {}
    for (const intent of ALL_INTENTS) {
      for (const stage of ALL_STAGES) {
        const resolution = resolveToolAvailability({
          policy: {
            sessionID: "ses_harness_invariants",
            agent: "analyst",
            inputIntent: intent,
            currentStage: stage,
            platformCapabilities: { mcp: false, images: false, remote: false },
            modelCapabilities: { supportsTools: true, supportsImages: false },
          },
          toolIDs: [...WORKFLOW_KNOWN_TOOL_IDS],
        })
        snapshot[`${intent}::${stage}`] = [...(resolution.directToolIDs ?? [])].sort()
      }
    }
    expect(snapshot).toMatchSnapshot()
  })

  test("conversation 意图在任何阶段都保留系统工具，但不直出具体计量方法", () => {
    for (const stage of ALL_STAGES) {
      const resolution = resolveToolAvailability({
        policy: {
          sessionID: "ses_harness_invariants",
          agent: "analyst",
          inputIntent: "conversation",
          currentStage: stage,
          platformCapabilities: { mcp: false, images: false, remote: false },
          modelCapabilities: { supportsTools: true, supportsImages: false },
        },
        toolIDs: [...WORKFLOW_KNOWN_TOOL_IDS],
      })
      expect(resolution.directToolIDs, `conversation@${stage} 必须保留系统工具`).toEqual(expect.arrayContaining([
        "question", "read", "list", "glob", "grep", "skill", "pipeline", "tool_search",
        "webfetch", "todoread", "todowrite", "data_import", "data_preprocess", "composite_evaluation",
        "econometrics_recommend",
      ]))
      expect(resolution.directToolIDs, `conversation@${stage} 不应直出估计器`).not.toContain("ols_regression")
    }
  })

  /**
   * baseline_estimate 不变量：必须能见 data_preprocess + econometrics_recommend。
   *
   * 历史教训（2026-08-02 gf.xlsx）：estimateBundle 只含 READ_CORE+IMPORT+ESTIMATE，
   * 模型要构造 β 收敛的对数/滞后变量（data_preprocess）或重选估计方法
   * （econometrics_recommend）时被卡死。任何回归到这版 estimateBundle 的改动
   * 都会被这条断言抓到。
   *
   * 此断言与 snapshot 解耦：snapshot 描述整体装配结果，这条断言描述死锁场景的最小集。
   */
  test("baseline_estimate 阶段必须可见 data_preprocess + econometrics_recommend（防 estimateBundle 回退）", () => {
    const resolution = resolveToolAvailability({
      policy: {
        sessionID: "ses_estimate_lock",
        agent: "analyst",
        inputIntent: "analysis",
        currentStage: "baseline_estimate",
        platformCapabilities: { mcp: false, images: false, remote: false },
        modelCapabilities: { supportsTools: true, supportsImages: false },
      },
      toolIDs: [...WORKFLOW_KNOWN_TOOL_IDS],
    })
    const direct = new Set(resolution.directToolIDs ?? [])
    expect(direct.has("data_preprocess")).toBe(true)
    expect(direct.has("econometrics_recommend")).toBe(true)
    // 反向断言：不该被 deferred 推到 deferred 列表
    const deferred = new Set(resolution.deferredToolIDs ?? [])
    expect(deferred.has("data_preprocess")).toBe(false)
    expect(deferred.has("econometrics_recommend")).toBe(false)
  })
})

describe("harness 不变量：system prompt 分层装配", () => {
  test("provider 层返回人格 + 计量方法论两段", () => {
    const layers = SystemPrompt.provider({
      providerID: "deepseek",
      api: { id: "deepseek-v4-flash" },
    } as never)
    expect(layers.length).toBe(2)
    // 第一段是 provider 差异，第二段是方法论（含必经工作流）
    expect(layers[1]).toContain("## 必经工作流")
  })

  test("custom provider 走通用人格而非 deepseek 人格", () => {
    const deepseek = SystemPrompt.provider({
      providerID: "deepseek",
      api: { id: "deepseek-v4-flash" },
    } as never)
    const custom = SystemPrompt.provider({
      providerID: "custom",
      api: { id: "qwen-max" },
    } as never)
    expect(deepseek[0]).not.toBe(custom[0])
    // 方法论层对两家 provider 必须完全一致——它是单一真相源
    expect(deepseek[1]).toBe(custom[1])
  })

  test("agent 层将旧 explorer 会话映射到唯一的 analyst 角色指令", () => {
    const analyst = SystemPrompt.agent({ name: "analyst" } as never)
    const explorer = SystemPrompt.agent({ name: "explorer" } as never)
    const other = SystemPrompt.agent({ name: "general" } as never)

    expect(analyst.length).toBe(1)
    expect(explorer.length).toBe(1)
    expect(other).toEqual([])
    expect(analyst[0]).toContain("# 主分析 Agent")
    expect(explorer[0]).toContain("# 主分析 Agent")
  })

  test("toolCatalog 层区分可调用与延迟解锁两段", () => {
    const withDeferred = SystemPrompt.toolCatalog(
      [
        { id: "read", modelNamespace: "filesystem" },
        { id: "data_import", modelNamespace: "data" },
      ],
      [{ modelNamespace: "econometrics_estimator", count: 16 }],
    )
    expect(withDeferred).toHaveLength(1)
    expect(withDeferred[0]).toContain("数据管理：data_import")
    expect(withDeferred[0]).toContain("文件与命令：read")
    expect(withDeferred[0]).toContain("计量估计：16 个")
    expect(withDeferred[0]).toContain("先调用 tool_search")
    expect(withDeferred[0]).not.toContain("ols_regression")

    const noTools = SystemPrompt.toolCatalog([], [])
    expect(noTools[0]).toContain("本轮没有可调用工具")
  })
})
