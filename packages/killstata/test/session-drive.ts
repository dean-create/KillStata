/**
 * 真实会话自动化驱动（session-drive）：模拟用户拿真实数据测试 killstata 全链路。
 *
 * 它不做 mock、不走测试旁路——创建真实会话、真实配置模型、真实工具链
 * （data_import → econometrics_recommend → QA → 估计器）与真实 workflow 状态机，
 * 等价于用户手动在 TUI 里操作，只是自动化驱动 + 结构化断言。
 *
 * 用法（在 packages/killstata 目录下）：
 *   bun run test/session-drive.ts [--panel|--did] [--model [provider/]<id>] [--timeout <ms>] [--max-runs <n>]
 *
 *   默认场景：导入 data/did.xlsx → 画像 → QA → OLS 基准回归
 *   --panel：改为双向固定效应面板回归（创新指数 ~ 高质量发展指数 + 11 控制变量）
 *   --did：改为传统 DID（需要数据含 did/post 变量，did.xlsx 有）
 *
 * 资源控制（不干爆内存）：
 *   - 每轮在独立临时项目目录运行，消息/part/dataset 全落盘在该目录，跑完 finally 删除
 *   - 单轮硬超时（默认 8 分钟）→ 自动 cancel 会话并判 FAIL
 *   - --max-runs N：修复后连跑 N 轮验证稳定性（每轮独立目录）
 *   - 失败时输出结构化 JSON 诊断（tool errors / stage 链 / latestFailure），供修复定位
 *
 * 默认模型跟随 KillStata 配置；完整 provider/model 参数可显式覆盖。依赖本机 auth.json + 受管 Python
 * （~/.killstata/venv，缺 pyarrow/statsmodels 会被 data_import healthcheck 报告）。
 */
import fs from "fs"
import path from "path"
import os from "os"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { getActiveWorkflowRun } from "@/runtime/workflow"
import { MessageV2 } from "@/session/message-v2"
import type { StageNode, WorkflowRun } from "@/runtime/types"
import { AnalysisIntent } from "@/tool/analysis-intent"
import { Question } from "@/question"
import { Bus } from "@/bus"
import { withTimeout } from "./helpers/with-timeout"

const REPO_ROOT = path.resolve(path.dirname(import.meta.dir), "..", "..")
const SOURCE_XLSX = path.join(REPO_ROOT, "data", "did.xlsx")

function flag(name: string, fallback: string | number): string | number {
  const index = process.argv.indexOf(name)
  if (index === -1 || !process.argv[index + 1]) return fallback
  const value = process.argv[index + 1]
  if (typeof fallback === "number") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return value
}

function scenarioFromArgv(): "basic" | "panel" | "did" {
  if (process.argv.includes("--did")) return "did"
  if (process.argv.includes("--panel")) return "panel"
  return "basic"
}

const SCENARIO = scenarioFromArgv()
const modelArg = flag("--model", "")
const MODEL_ID = typeof modelArg === "string" && modelArg.trim() ? modelArg.trim() : undefined
const TURN_TIMEOUT_MS = Number(flag("--timeout", 8 * 60_000))
const MAX_RUNS = Number(flag("--max-runs", 1))

function userMessageForScenario(source: string): string {
  const base = `请导入数据文件 ${source}，完成数据画像、质量检查后，`
  switch (SCENARIO) {
    case "panel":
      return (
        base +
        "做双向固定效应面板回归（实体=地区，时间=year）：被解释变量=创新指数，" +
        "核心解释变量=高质量发展指数，控制变量=人口密度、经济发展水平、金融发展程度、" +
        "城镇化水平、政府干预程度、财政投资力度、财政分权度、产业结构整体升级、" +
        "产业结构高级化、产业结构合理化、教育水平支出。"
      )
    case "did":
      return base + "做传统双重差分 DID：被解释变量=创新指数，处理组变量=did，政策后变量=post（若不存在则先构造）。"
    default:
      return base + "做一个 OLS 基准回归：被解释变量=创新指数，核心解释变量=高质量发展指数。"
  }
}

/** 收集会话里所有 error/aborted 的工具调用（含 reflection 分类，若挂载） */
async function collectToolErrors(sessionID: string) {
  const errors: Array<{
    tool: string
    error: string
    reflection?: { failureType?: string; retryStage?: string; repairAction?: string }
  }> = []
  for await (const msg of MessageV2.stream(sessionID)) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      if (part.state.status !== "error") continue
      const meta = (part.state.metadata ?? {}) as {
        reflection?: { failureType?: string; retryStage?: string; repairAction?: string }
        skippedAfterPriorToolFailure?: boolean
        skippedAfterUserDecision?: boolean
      }
      if (meta.skippedAfterPriorToolFailure === true || meta.skippedAfterUserDecision === true) continue
      errors.push({
        tool: part.tool ?? "unknown",
        error: String(part.state.error ?? "").slice(0, 300),
        ...(meta.reflection
          ? {
              reflection: {
                failureType: meta.reflection.failureType,
                retryStage: meta.reflection.retryStage,
                repairAction: meta.reflection.repairAction,
              },
            }
          : {}),
      })
    }
  }
  return errors
}

/** 收集 workflow stage 链（kind → status → toolName） */
function stageChain(run: WorkflowRun | undefined) {
  if (!run) return []
  return run.stages.map((s: StageNode) => `${s.kind}=${s.status}(${s.toolName ?? "?"})`)
}

/**
 * session-drive测的是“用户最终能否完成任务”，不是模型是否一步不错。
 * 参数契约错误如果随后由同一工具成功重试，必须保留在诊断中，但不能把已恢复的
 * 波折判成整条会话失败；真正没有恢复的错误仍然进入 hard fail。
 */
function recoveredSessionDriveErrors(
  errors: Array<{ tool: string; error: string }>,
  run: WorkflowRun | undefined,
  estimateCompleted: boolean,
) {
  if (!run || !estimateCompleted) return []
  const completedTools = new Set(
    run.stages
      .filter((stage) => stage.status === "completed" && typeof stage.toolName === "string")
      .map((stage) => stage.toolName as string),
  )
  const failedTools = new Set(
    run.stages
      .filter((stage) => stage.status === "failed" && typeof stage.toolName === "string")
      .map((stage) => stage.toolName as string),
  )
  return errors.filter(
    (error) =>
      (completedTools.has(error.tool) &&
        failedTools.has(error.tool) &&
        /参数不合法|参数契约错误|类型错误|未知字段/.test(error.error)) ||
      (error.tool === "read" &&
        /TOOL_OUTPUT_REFERENCE_DENIED/.test(error.error) &&
        estimateCompleted),
  )
}

/** 找估计结果文件（results.json / coefficients.csv），确认"真的产出了结果" */
function findResultFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/results\.json$|coefficients\.csv$/.test(entry.name) && !p.includes("__snapshots__")) found.push(p)
    }
  }
  walk(root)
  return found
}

async function runOnce(runIndex: number): Promise<{ pass: boolean; report: Record<string, unknown> }> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `killstata-drive-${runIndex}-`))
  let pass = false
  let report: Record<string, unknown> = {}
  try {
    report = await Instance.provide({
      directory: tmpRoot,
      fn: async () => {
        // 1. 准备真实数据（复制到隔离目录，不碰主项目 .killstata）
        const source = path.join(tmpRoot, path.basename(SOURCE_XLSX))
        fs.copyFileSync(SOURCE_XLSX, source)

        // 2. 创建会话：全权限（模拟"用户已始终允许"），避免权限弹窗在无 TUI 时挂起
        const session = await Session.create({
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        // analyst 的 data_import 计划审批（Question 弹窗）预置为已批准——
        // 自动化无人工回答，且本脚本场景的消息已把变量/设计说全，无需再确认
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        // 模型若仍主动调 Question（如确认识别策略），自动选第一个选项（通常是"确认/是"）
        const unsubscribe = Bus.subscribe(Question.Event.Asked, (event) => {
          const request = event.properties
          const answers = request.questions.map((q) => [q.options[0]?.label].filter(Boolean))
          Question.reply({ requestID: request.id, answers })
        })
        const model = await Provider.resolveModel(MODEL_ID)
        const modelRef = { providerID: model.providerID, modelID: model.id }

        // 3. 发用户消息并等待整轮完成（超时自动 cancel）
        let timedOut = false
        try {
          await withTimeout(
            SessionPrompt.prompt({
              sessionID: session.id,
              parts: [{ type: "text", text: userMessageForScenario(source) }],
              model: modelRef,
              agent: "analyst",
            }),
            TURN_TIMEOUT_MS,
            () => {
              timedOut = true
              SessionPrompt.cancel(session.id)
            },
          )
        } catch (error) {
          if (timedOut) {
            // 超时是检测项，不是脚本崩溃
          } else {
            throw error
          }
        } finally {
          unsubscribe()
        }

        // 4. 检测
        const errors = await collectToolErrors(session.id)
        const run = getActiveWorkflowRun(session.id)
        const results = findResultFiles(tmpRoot)
        // 结果文件必须在隔离目录（排除 killstata 包内测试 fixture）
        const ownResults = results.filter((p) => p.startsWith(tmpRoot))
        const estimateCompleted = (run?.stages ?? []).some(
          (s) => s.kind === "baseline_estimate" && s.status === "completed",
        )
        const recoveredErrors = recoveredSessionDriveErrors(errors, run, estimateCompleted)
        const finalErrors = errors.filter((error) => !recoveredErrors.includes(error))
        pass = !timedOut && finalErrors.length === 0 && ownResults.length > 0 && estimateCompleted

        return {
          pass,
          scenario: SCENARIO,
          timedOut,
          toolErrors: errors,
          recoveredToolErrors: recoveredErrors,
          activeStage: run?.activeStage,
          stageChain: stageChain(run),
          latestFailure: run?.latestFailure
            ? {
                code: run.latestFailure.code,
                toolName: run.latestFailure.toolName,
                retryStage: run.latestFailure.retryStage,
                message: String(run.latestFailure.message).slice(0, 200),
              }
            : undefined,
          resultFiles: ownResults.map((p) => path.relative(tmpRoot, p)),
          reportCount: ownResults.length,
        }
      },
    })
  } finally {
    // 5. 无论如何清理：消息/part/dataset/workflow 全在临时目录，删掉即释放内存与磁盘
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      // 清理失败不阻塞报告
    }
  }
  return { pass, report }
}

async function main() {
  if (!fs.existsSync(SOURCE_XLSX)) {
    console.error(`数据文件不存在：${SOURCE_XLSX}（脚本从项目 data/ 目录读 did.xlsx）`)
    process.exit(2)
  }
  console.log(
    `[session-drive] scenario=${SCENARIO} model=${MODEL_ID ?? "configured-default"} timeout=${TURN_TIMEOUT_MS}ms runs=${MAX_RUNS}`,
  )

  let anyFail = false
  for (let run = 1; run <= MAX_RUNS; run++) {
    const started = Date.now()
    const { pass, report } = await runOnce(run)
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    if (MAX_RUNS > 1) console.log(`\n===== run ${run}/${MAX_RUNS} (${elapsed}s) =====`)
    console.log(JSON.stringify(report, null, 2))
    if (pass) {
      console.log(`\n✅ PASS (${elapsed}s)：全链路完成（导入→画像→QA→估计→结果文件）`)
    } else {
      anyFail = true
      console.log(`\n❌ FAIL (${elapsed}s)：见上方诊断。toolErrors 为空且 stage 卡住 = 工作流推进问题；`)
      console.log(`   toolErrors 非空 = 对应工具失败（reflection.failureType/repairAction 定位修复方向）。`)
    }
  }
  process.exit(anyFail ? 1 : 0)
}

main().catch((error) => {
  console.error("session-drive 崩溃：", error)
  process.exit(2)
})
