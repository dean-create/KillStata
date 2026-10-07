import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { SystemPrompt } from "../session/system"
import { Instance } from "../project/instance"
import { Truncate } from "../tool/truncation"
import { Auth } from "../auth"
import { ProviderTransform } from "../provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { VERIFIER_ROLE_PROMPT } from "./prompt/roles"
import { PermissionNext } from "@/permission/next"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import {
  WORKFLOW_ANALYSIS_TOOL_IDS,
  WORKFLOW_DATA_METHOD_TOOL_IDS,
  WORKFLOW_IMPORT_TOOL_IDS,
  WORKFLOW_REPORT_TOOL_IDS,
} from "@/runtime/tool-catalog"
import { Global } from "@/global"
import path from "path"

export namespace Agent {
  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: PermissionNext.Ruleset,
      model: z
        .object({
          modelID: z.string(),
          providerID: z.string(),
        })
        .optional(),
      variant: z.string().optional(),
      prompt: z.string().optional(),
      options: z.record(z.string(), z.any()),
      steps: z.number().int().positive().optional(),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  const state = Instance.state(async () => {
    const cfg = await Config.get()
    const projectRoot = Instance.worktree

    // 计量工作流工具默认放行：这些工具经 admission 表验证、走 managed-process 白名单
    // 安全执行、exposure 分阶段控制可见性——每次调用都弹权限只会打断分析流程。
    // 清单从 tool-catalog 派生（不硬编码工具名，改名即编译期/不变量测试兜底）。
    const workflowToolsAllow = Object.fromEntries(
      [
        ...WORKFLOW_ANALYSIS_TOOL_IDS,
        ...WORKFLOW_IMPORT_TOOL_IDS,
        ...WORKFLOW_DATA_METHOD_TOOL_IDS,
        ...WORKFLOW_REPORT_TOOL_IDS,
      ].map((id) => [id, "allow"]),
    )
    const managedRuntimePattern = `${path.join(Global.Path.data, "venv", "*")} *`

    // 默认收紧：* 从 allow 改为 ask（对齐 claude-code 的 fail-closed 权限管线）。
    // 只读/搜索工具与计量工作流工具显式放行；bash/edit/write 等有副作用的默认要问。
    const defaults = PermissionNext.fromConfig({
      "*": "ask",
      doom_loop: "ask",
      ...workflowToolsAllow,
      read: {
        "*": "allow",
        "*.env": "ask",
        "*.env.*": "ask",
        "*.env.example": "allow",
      },
      glob: "allow",
      grep: "allow",
      list: "allow",
      // 模型不能直接获得这些命令；只有已准入工具以 managedRuntime=true 请求固定
      // `.killstata/venv` runner 时，PermissionNext 的结构校验才允许命中。
      bash: {
        "*": "ask",
        [managedRuntimePattern]: "allow",
      },
      // 网络读取会把 URL/检索词发送到外部；虽不改本地状态，仍按精确目标确认。
      webfetch: "ask",
      skill: "allow",
      workflow: "allow",
      todoread: "allow",
      todowrite: "allow",
      task: "ask",
      external_directory: {
        "*": "allow",
        [Truncate.DIR]: "allow",
        [Truncate.GLOB]: "allow",
      },
      question: "deny",
    })
    const user = PermissionNext.fromConfig(cfg.permission ?? {})

    const result: Record<string, Info> = {
      analyst: {
        name: "analyst",
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
          }),
          user,
        ),
        mode: "primary",
        native: true,
      },
      general: {
        name: "general",
        description: "通用内部 Agent：处理可独立拆分的复杂检索或多步骤任务。仅在任务之间无依赖且不会重复工作时使用。",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            todoread: "deny",
            todowrite: "deny",
          }),
          user,
        ),
        options: {},
        mode: "subagent",
        native: true,
      },
      verifier: {
        name: "verifier",
        description: "核验内部 Agent：在给出结论前检查数据质量、计量假设、诊断和可复现产物。",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            edit: "deny",
            write: "deny",
            bash: "allow",
            read: "allow",
            glob: "allow",
            grep: "allow",
            todoread: "deny",
            todowrite: "deny",
          }),
          user,
        ),
        prompt: VERIFIER_ROLE_PROMPT,
        options: {},
        mode: "subagent",
        native: true,
      },
      explore: {
        name: "explore",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            grep: "allow",
            glob: "allow",
            list: "allow",
            bash: "allow",
            webfetch: "allow",
            read: "allow",
            external_directory: {
              [Truncate.DIR]: "allow",
              [Truncate.GLOB]: "allow",
            },
          }),
          user,
        ),
        description:
          "探索内部 Agent：快速查找数据文件、画像变量和结构，回答数据可用性问题。可指定 quick、medium 或 very thorough；它只读、不做清洗或估计。",
        prompt: PROMPT_EXPLORE,
        options: {},
        mode: "subagent",
        native: true,
      },
      compaction: {
        name: "compaction",
        mode: "primary",
        native: true,
        hidden: true,
        prompt: PROMPT_COMPACTION,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        options: {},
      },
      title: {
        name: "title",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        temperature: 0.5,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_TITLE,
      },
      summary: {
        name: "summary",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_SUMMARY,
      },
    }

    for (const [rawKey, value] of Object.entries(cfg.agent ?? {})) {
      const key = normalizePrimaryAgent(rawKey)
      if (value.disable) {
        delete result[key]
        continue
      }
      let item = result[key]
      if (!item)
        item = result[key] = {
          name: key,
          mode: "all",
          permission: PermissionNext.merge(defaults, user),
          options: {},
          native: false,
        }
      if (value.model) item.model = Provider.parseModel(value.model)
      item.variant = value.variant ?? item.variant
      item.prompt = value.prompt ?? item.prompt
      item.description = value.description ?? item.description
      item.temperature = value.temperature ?? item.temperature
      item.topP = value.top_p ?? item.topP
      item.mode = value.mode ?? item.mode
      item.color = value.color ?? item.color
      item.hidden = value.hidden ?? item.hidden
      item.name = key === "analyst" ? "analyst" : value.name ?? item.name
      item.steps = value.steps ?? item.steps
      item.options = mergeDeep(item.options, value.options ?? {})
      item.permission = PermissionNext.merge(item.permission, PermissionNext.fromConfig(value.permission ?? {}))
    }

    // Ensure Truncate.DIR is allowed unless explicitly configured
    for (const name in result) {
      const agent = result[name]
      const explicit = agent.permission.some((r) => {
        if (r.permission !== "external_directory") return false
        if (r.action !== "deny") return false
        return r.pattern === Truncate.DIR || r.pattern === Truncate.GLOB
      })
      if (explicit) continue

      result[name].permission = PermissionNext.merge(
        result[name].permission,
        PermissionNext.fromConfig({ external_directory: { [Truncate.DIR]: "allow", [Truncate.GLOB]: "allow" } }),
      )
    }

    return result
  })

  export function normalizePrimaryAgent(name: string) {
    return name === "explorer" ? "analyst" : name
  }

  export async function get(agent: string) {
    return state().then((x) => x[normalizePrimaryAgent(agent)])
  }

  export async function list() {
    const cfg = await Config.get()
    return pipe(
      await state(),
      values(),
      sortBy([(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "analyst"), "desc"]),
    )
  }

  export async function defaultAgent() {
    const cfg = await Config.get()
    const agents = await state()

    if (cfg.default_agent) {
      const requested = normalizePrimaryAgent(cfg.default_agent)
      const agent = agents[requested]
      if (!agent) throw new Error(`default agent "${cfg.default_agent}" not found`)
      if (agent.mode === "subagent") throw new Error(`default agent "${cfg.default_agent}" is a subagent`)
      if (agent.hidden === true) throw new Error(`default agent "${cfg.default_agent}" is hidden`)
      return agent.name
    }

    const primaryVisible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
    if (!primaryVisible) throw new Error("no primary visible agent found")
    return primaryVisible.name
  }

  export async function generate(input: { description: string; model?: { providerID: string; modelID: string } }) {
    const cfg = await Config.get()
    const defaultModel = input.model ?? (await Provider.defaultModel())
    const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
    const language = await Provider.getLanguage(model)

    const system = SystemPrompt.header(defaultModel.providerID)
    system.push(PROMPT_GENERATE)
    const existing = await list()

    const params = {
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        recordInputs: false,
        recordOutputs: false,
        metadata: {
          userId: cfg.username ?? "unknown",
        },
      },
      temperature: 0.3,
      messages: [
        ...system.map(
          (item): ModelMessage => ({
            role: "system",
            content: item,
          }),
        ),
        {
          role: "user",
          content: `请根据以下需求生成 Agent 配置："${input.description}"。\n\n以下 identifier 已存在，不得使用：${existing.map((i) => i.name).join(", ")}。\n只返回 JSON 对象，不要附加解释或代码围栏`,
        },
      ],
      model: language,
      schema: z.object({
        identifier: z.string(),
        whenToUse: z.string(),
        systemPrompt: z.string(),
      }),
    } satisfies Parameters<typeof generateObject>[0]

    // 过去这里对 OpenAI Codex OAuth 会话走一条特殊的 streamObject 路径。openai 已不是允许的
    // provider（只剩 deepseek + custom），这条分支恒不命中，已移除。
    const result = await generateObject(params)
    return result.object
  }
}
