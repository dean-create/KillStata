import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  useContext,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import path from "path"
import { useRoute, useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { SplitBorder } from "@tui/component/border"
import { analysisProgressText } from "./progress-text"
import { useTheme } from "@tui/context/theme"
import {
  BoxRenderable,
  ScrollBoxRenderable,
  addDefaultParsers,
  MacOSScrollAccel,
  type ScrollAcceleration,
  TextAttributes,
  RGBA,
} from "@opentui/core"
import { Prompt, type PromptRef } from "@tui/component/prompt"
import type { AssistantMessage, Part, ToolPart, UserMessage, TextPart, ReasoningPart } from "@killstata/sdk/v2"
import { useLocal } from "@tui/context/local"
import { Locale } from "@/util/locale"
import type { Tool } from "@/tool/tool"
import type { ReadTool } from "@/tool/read"
import type { WriteTool } from "@/tool/write"
import { BashTool } from "@/tool/bash"
import type { GlobTool } from "@/tool/glob"
import { TodoWriteTool } from "@/tool/todo"
import type { GrepTool } from "@/tool/grep"
import type { ListTool } from "@/tool/ls"
import type { EditTool } from "@/tool/edit"
import type { WebFetchTool } from "@/tool/webfetch"
import type { TaskTool } from "@/tool/task"
import type { QuestionTool } from "@/tool/question"
import { useKeyboard, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useSDK } from "@tui/context/sdk"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "@tui/context/keybind"
import { Header } from "./header"
import { useDialog } from "../../ui/dialog"
import { TodoItem } from "../../component/todo-item"
import { DialogMessage } from "./dialog-message"
import type { PromptInfo } from "../../component/prompt/history"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { DialogModelSettings } from "../../component/dialog-model-settings"
import { Sidebar } from "./sidebar"
import { LANGUAGE_EXTENSIONS } from "@tui/util/language"
import parsers from "../../../../../../parsers-config.ts"
import { Clipboard } from "../../util/clipboard"
import { Toast, useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import { Editor } from "../../util/editor"
import stripAnsi from "strip-ansi"
import { Footer } from "./footer.tsx"
import { usePromptRef } from "../../context/prompt"
import { useExit } from "../../context/exit"
import { Global } from "@/global"
import { PermissionPrompt } from "./permission"
import { QuestionPrompt } from "./question"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import { DialogContext } from "./dialog-context"
import { formatTranscript, isInternalCompactionContinuation, isInternalCompactionSummary } from "../../util/transcript"
import {
  displayGlobPattern,
  displayPath as sharedDisplayPath,
  isInternalWorkspacePath,
  readToolDisplay,
  renderToolDisplay,
} from "@/tool/analysis-display"
import { readToolAnalysisView } from "@/tool/analysis-user-view"
import {
  sanitizeAnalysisAssistantText,
  containsEngineInternalData,
  userFacingAnalysisErrorText,
  type AnalysisToolPartLike,
} from "@/runtime/analysis-text-sanitizer"
import { isAnalysisTurn, pendingTaskLabel, shouldShowReasoning } from "@/runtime/analysis-user-view"
import { FailurePolicy } from "@/runtime/failure-policy"
import {
  WORKFLOW_ANALYSIS_TOOL_IDS,
  isWorkflowAnalysisTool,
  isWorkflowEstimateTool,
  isWorkflowReadOnlyAction,
} from "@/runtime/tool-catalog"
import { isReasoningExpanded, toggleReasoningExpandedState } from "./reasoning-state"
import { analysisToolErrorPresentation } from "@/cli/cmd/tool-error-display"
import { ProviderTransform } from "@/provider/transform"

addDefaultParsers(parsers.parsers)

class CustomSpeedScroll implements ScrollAcceleration {
  constructor(private speed: number) {}

  tick(_now?: number): number {
    return this.speed
  }

  reset(): void {}
}

const ANALYSIS_INTERNAL_ERROR_PATTERNS = [
  /Cannot read .* as text/i,
  /Cannot read binary file/i,
  /不能将.*按文本读取[：:]/,
  /Model tried to call unavailable tool/i,
  /\bartifactRefs\b/i,
  /\blatestTrustedArtifacts\b/i,
  /\bworkflowRunId\b/i,
  /\btrustedArtifacts\b/i,
  /^Bash \[command=/i,
]

function isInternalAnalysisErrorText(text?: string) {
  if (!text) return false
  return containsEngineInternalData(text) || ANALYSIS_INTERNAL_ERROR_PATTERNS.some((pattern) => pattern.test(text))
}

function analysisErrorDisplayText(input: {
  text?: string
  isAnalysis: boolean
  showDetails: boolean
  waitingForAccess?: boolean
}) {
  const message = input.text?.trim()
  if (!message) return undefined
  const friendly = userFacingAnalysisErrorText(message)
  if (friendly) return friendly
  if (ProviderTransform.isBalanceOrQuotaError(message)) return ProviderTransform.BALANCE_OR_QUOTA_ERROR_MESSAGE
  if (!input.isAnalysis) return message
  if (input.waitingForAccess) return undefined
  // 用户输入的是自然语言，没有"参数"可查；这是未分类的内部错误兜底，只给中性、可操作的话。
  if (/[A-Za-z]{3}/.test(message)) return "这一步分析没能完成，请重试，或换一种说法再试一次。"
  return isInternalAnalysisErrorText(message) ? undefined : message
}

const context = createContext<{
  width: number
  sessionID: string
  conceal: () => boolean
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  showGenericToolOutput: () => boolean
  reasoningExpanded: (partID: string) => boolean
  toggleReasoningExpanded: (partID: string) => void
  sync: ReturnType<typeof useSync>
}>()

function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

export function Session() {
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const sync = useSync()
  const kv = useKV()
  const { theme } = useTheme()
  const promptRef = usePromptRef()
  const session = createMemo(() => sync.session.get(route.sessionID))
  const children = createMemo(() => {
    const parentID = session()?.parentID ?? session()?.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  // 消息挂载上限：长会话不无限渲染（对齐 claude-code 的 MAX_MOUNTED_ITEMS）。
  // 默认只渲染最近 MAX_RENDERED_MESSAGES 条；更早的折叠成顶部一行提示，点击展开全部。
  // 展开后不再收回（会话继续增长时仍受上限保护）。
  const MAX_RENDERED_MESSAGES = 150
  const [showAllMessages, setShowAllMessages] = createSignal(false)
  const allMessages = createMemo(() =>
    (sync.data.message[route.sessionID] ?? []).filter((message) => {
      if (isInternalCompactionSummary(message)) return false
      return !isInternalCompactionContinuation({ info: message, parts: sync.data.part[message.id] ?? [] })
    }),
  )
  const earlierHiddenCount = createMemo(() =>
    showAllMessages() ? 0 : Math.max(0, allMessages().length - MAX_RENDERED_MESSAGES),
  )
  const messages = createMemo(() => {
    if (showAllMessages()) return allMessages()
    return allMessages().slice(-MAX_RENDERED_MESSAGES)
  })
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.permission[x.id] ?? [])
  })
  const questions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.question[x.id] ?? [])
  })

  const pending = createMemo(() => {
    const last = messages().findLast((x) => x.role === "assistant" && !x.time.completed)
    return last?.id
  })

  const lastAssistant = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant")
  })

  const dimensions = useTerminalDimensions()
  const [sidebar, setSidebar] = kv.signal<"auto" | "hide">("sidebar", "hide")
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const [conceal, setConceal] = createSignal(true)
  const [showThinking, setShowThinking] = kv.signal("thinking_visibility", true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", false)
  const [showGenericToolOutput, setShowGenericToolOutput] = kv.signal("generic_tool_output_visibility", false)
  const [showAssistantMetadata, setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
  const [contentOverflows, setContentOverflows] = createSignal(false)
  const [animationsEnabled, setAnimationsEnabled] = kv.signal("animations_enabled", true)
  const [reasoningExpandedState, setReasoningExpandedState] = createSignal<Record<string, boolean>>({})

  const wide = createMemo(() => dimensions().width > 120)
  const sidebarVisible = createMemo(() => {
    if (session()?.parentID) return false
    if (sidebarOpen()) return true
    if (sidebar() === "auto" && wide()) return true
    return false
  })
  const showTimestamps = createMemo(() => timestamps() === "show")
  const contentWidth = createMemo(() => dimensions().width - (sidebarVisible() ? 42 : 0) - 4)
  const renderedPartCount = createMemo(() =>
    messages().reduce((count, message) => count + (sync.data.part[message.id]?.length ?? 0), 0),
  )
  const scrollbarVisible = createMemo(() => showScrollbar() || contentOverflows())

  const scrollAcceleration = createMemo(() => {
    const tui = sync.data.config.tui
    if (tui?.scroll_acceleration?.enabled) {
      return new MacOSScrollAccel()
    }
    if (tui?.scroll_speed) {
      return new CustomSpeedScroll(tui.scroll_speed)
    }

    return new CustomSpeedScroll(3)
  })

  createEffect(async () => {
    await sync.session
      .sync(route.sessionID)
      .then(() => {
        if (scroll) scroll.scrollBy(100_000)
      })
      .catch((e) => {
        console.error(e)
        toast.show({
          message: `未找到会话：${route.sessionID}`,
          variant: "error",
        })
        return navigate({ type: "home" })
      })
  })

  const toast = useToast()
  const sdk = useSDK()

  // Handle initial prompt from fork
  createEffect(() => {
    if (route.initialPrompt && prompt) {
      prompt.set(route.initialPrompt)
    }
  })

  let scroll: ScrollBoxRenderable
  let prompt: PromptRef
  const keybind = useKeybind()

  // Allow exit when in child session (prompt is hidden)
  const exit = useExit()
  useKeyboard((evt) => {
    if (!session()?.parentID) return
    if (keybind.match("app_exit", evt)) {
      exit()
    }
  })

  // Helper: Find next visible message boundary in direction
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    const children = scroll.getChildren()
    const messagesList = messages()
    const scrollTop = scroll.y

    // Get visible messages sorted by position, filtering for valid non-synthetic, non-ignored content
    const visibleMessages = children
      .filter((c) => {
        if (!c.id) return false
        const message = messagesList.find((m) => m.id === c.id)
        if (!message) return false

        // Check if message has valid non-synthetic, non-ignored text parts
        const parts = sync.data.part[message.id]
        if (!parts || !Array.isArray(parts)) return false

        return parts.some((part) => part && part.type === "text" && !part.synthetic && !part.ignored)
      })
      .sort((a, b) => a.y - b.y)

    if (visibleMessages.length === 0) return null

    if (direction === "next") {
      // Find first message below current position
      return visibleMessages.find((c) => c.y > scrollTop + 10)?.id ?? null
    }
    // Find last message above current position
    return [...visibleMessages].reverse().find((c) => c.y < scrollTop - 10)?.id ?? null
  }

  // Helper: Scroll to message in direction or fallback to page scroll
  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => {
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {
      scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      dialog.clear()
      return
    }

    const child = scroll.getChildren().find((c) => c.id === targetID)
    if (child) scroll.scrollBy(child.y - scroll.y - 1)
    dialog.clear()
  }

  function toBottom() {
    setTimeout(() => {
      if (scroll) scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  function refreshScrollbarVisibility() {
    if (!scroll) return
    setContentOverflows(scroll.scrollHeight > scroll.height)
  }

  createEffect(() => {
    renderedPartCount()
    dimensions()
    sidebarVisible()
    conceal()
    showThinking()
    showTimestamps()
    showDetails()
    showGenericToolOutput()
    setTimeout(refreshScrollbarVisibility, 0)
  })

  const local = useLocal()

  function moveChild(direction: number) {
    if (children().length === 1) return
    let next = children().findIndex((x) => x.id === session()?.id) + direction
    if (next >= children().length) next = 0
    if (next < 0) next = children().length - 1
    if (children()[next]) {
      navigate({
        type: "session",
        sessionID: children()[next].id,
      })
    }
  }

  const command = useCommandDialog()
  command.register(() => [
    {
      title: "重命名会话",
      description: "修改当前会话标题",
      value: "session.rename",
      keybind: "session_rename",
      category: "会话",
      slash: {
        name: "rename",
      },
      onSelect: (dialog) => {
        dialog.replace(() => <DialogSessionRename session={route.sessionID} />)
      },
    },
    {
      title: "跳转到消息",
      description: "打开时间线并跳转到指定消息",
      value: "session.timeline",
      keybind: "session_timeline",
      category: "会话",
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogTimeline
            onMove={(messageID) => {
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
            setPrompt={(promptInfo) => prompt.set(promptInfo)}
          />
        ))
      },
    },
    {
      title: "压缩会话上下文",
      description: "总结当前会话，减少后续上下文占用",
      value: "session.compact",
      keybind: "session_compact",
      category: "会话",
      slash: {
        name: "compact",
        aliases: ["summarize"],
      },
      onSelect: (dialog) => {
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            variant: "warning",
            message: "请先连接模型提供商再压缩会话",
            duration: 3000,
          })
          return
        }
        sdk.client.session.summarize({
          sessionID: route.sessionID,
          modelID: selectedModel.modelID,
          providerID: selectedModel.providerID,
        })
        dialog.clear()
      },
    },
    {
      title: "查看上下文占用",
      description: "查看当前会话的上下文窗口、剩余预算与实际用量",
      value: "session.context",
      category: "会话",
      slash: {
        name: "context",
      },
      onSelect: (dialog) => {
        dialog.replace(() => <DialogContext />)
      },
    },
    {
      title: "撤销上一条消息",
      description: "回退到上一条用户消息之前的状态",
      value: "session.undo",
      keybind: "messages_undo",
      category: "会话",
      slash: {
        name: "undo",
      },
      onSelect: async (dialog) => {
        const status = sync.data.session_status?.[route.sessionID]
        if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
        const revert = session()?.revert?.messageID
        const message = messages().findLast((x) => (!revert || x.id < revert) && x.role === "user")
        if (!message) return
        sdk.client.session
          .revert({
            sessionID: route.sessionID,
            messageID: message.id,
          })
          .then(() => {
            toBottom()
          })
        const parts = sync.data.part[message.id]
        prompt.set(
          parts.reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(part)
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          ),
        )
        dialog.clear()
      },
    },
    {
      title: "重做",
      description: "恢复刚才撤销的消息状态",
      value: "session.redo",
      keybind: "messages_redo",
      category: "会话",
      enabled: !!session()?.revert?.messageID,
      slash: {
        name: "redo",
      },
      onSelect: (dialog) => {
        dialog.clear()
        const messageID = session()?.revert?.messageID
        if (!messageID) return
        const message = messages().find((x) => x.role === "user" && x.id > messageID)
        if (!message) {
          sdk.client.session.unrevert({
            sessionID: route.sessionID,
          })
          prompt.set({ input: "", parts: [] })
          return
        }
        sdk.client.session.revert({
          sessionID: route.sessionID,
          messageID: message.id,
        })
      },
    },
    {
      title: sidebarVisible() ? "隐藏侧边栏" : "显示侧边栏",
      value: "session.sidebar.toggle",
      keybind: "sidebar_toggle",
      category: "会话",
      onSelect: (dialog) => {
        batch(() => {
          const isVisible = sidebarVisible()
          setSidebar(() => (isVisible ? "hide" : "auto"))
          setSidebarOpen(!isVisible)
        })
        dialog.clear()
      },
    },
    {
      title: "切换代码折叠显示",
      value: "session.toggle.conceal",
      keybind: "messages_toggle_conceal" as any,
      category: "会话",
      onSelect: (dialog) => {
        setConceal((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showTimestamps() ? "隐藏时间戳" : "显示时间戳",
      description: "切换消息时间戳显示",
      value: "session.toggle.timestamps",
      category: "会话",
      slash: {
        name: "timestamps",
        aliases: ["toggle-timestamps"],
      },
      onSelect: (dialog) => {
        setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
        dialog.clear()
      },
    },
    {
      title: showThinking() ? "隐藏思考过程" : "显示思考过程",
      description: "切换模型思考过程显示",
      value: "session.toggle.thinking",
      category: "会话",
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      onSelect: (dialog) => {
        setShowThinking((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showDetails() ? "隐藏工具详情" : "显示工具详情",
      description: "展开命令输出、文件正文与完整diff（默认只显示做了什么）",
      value: "session.toggle.actions",
      keybind: "tool_details",
      category: "会话",
      onSelect: (dialog) => {
        setShowDetails((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showGenericToolOutput() ? "隐藏通用工具输出" : "显示通用工具输出",
      description: "切换通用工具输出内容显示",
      value: "session.toggle.generic_tool_output",
      category: "会话",
      // 与 /details 高度重叠，命令面板里只留 /details 一个逃生门就够了。
      hidden: true,
      onSelect: (dialog) => {
        setShowGenericToolOutput((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showScrollbar() ? "自动隐藏会话滚动条" : "始终显示会话滚动条",
      value: "session.toggle.scrollbar",
      keybind: "scrollbar_toggle",
      category: "会话",
      onSelect: (dialog) => {
        setShowScrollbar((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: animationsEnabled() ? "关闭动画" : "开启动画",
      value: "session.toggle.animations",
      category: "会话",
      onSelect: (dialog) => {
        setAnimationsEnabled((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: local.executionMode.current() === "auto" ? "切换到 Plan 只读规划" : "切换到 Auto 自由执行",
      description: local.executionMode.current() === "auto" ? "只允许读文件和列计划，不能写/执行" : "允许自由决策调工具完成任务",
      value: "session.toggle.execution_mode",
      category: "会话",
      onSelect: (dialog) => {
        const next = local.executionMode.toggle()
        toast.show({ message: `已切换到 ${next === "auto" ? "Auto" : "Plan"} 模式`, variant: "info", duration: 2000 })
        dialog.clear()
      },
    },
    {
      title: "向上翻页",
      value: "session.page.up",
      keybind: "messages_page_up",
      category: "会话",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "向下翻页",
      value: "session.page.down",
      keybind: "messages_page_down",
      category: "会话",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "向上滚动一行",
      value: "session.line.up",
      keybind: "messages_line_up",
      category: "会话",
      disabled: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-1)
        dialog.clear()
      },
    },
    {
      title: "向下滚动一行",
      value: "session.line.down",
      keybind: "messages_line_down",
      category: "会话",
      disabled: true,
      onSelect: (dialog) => {
        scroll.scrollBy(1)
        dialog.clear()
      },
    },
    {
      title: "向上滚动半页",
      value: "session.half.page.up",
      keybind: "messages_half_page_up",
      category: "会话",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "向下滚动半页",
      value: "session.half.page.down",
      keybind: "messages_half_page_down",
      category: "会话",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "跳到第一条消息",
      value: "session.first",
      keybind: "messages_first",
      category: "会话",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollTo(0)
        dialog.clear()
      },
    },
    {
      title: "跳到最后一条消息",
      value: "session.last",
      keybind: "messages_last",
      category: "会话",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollTo(scroll.scrollHeight)
        dialog.clear()
      },
    },
    {
      title: "跳到最后一条用户消息",
      value: "session.messages_last_user",
      keybind: "messages_last_user",
      category: "会话",
      hidden: true,
      onSelect: () => {
        const messages = sync.data.message[route.sessionID]
        if (!messages || !messages.length) return

        // Find the most recent user message with non-ignored, non-synthetic text parts
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== "user") continue

          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart = parts.some(
            (part) => part && part.type === "text" && !part.synthetic && !part.ignored,
          )

          if (hasValidTextPart) {
            const child = scroll.getChildren().find((child) => {
              return child.id === message.id
            })
            if (child) scroll.scrollBy(child.y - scroll.y - 1)
            break
          }
        }
      },
    },
    {
      title: "下一条消息",
      value: "session.message.next",
      keybind: "messages_next",
      category: "会话",
      hidden: true,
      onSelect: (dialog) => scrollToMessage("next", dialog),
    },
    {
      title: "上一条消息",
      value: "session.message.previous",
      keybind: "messages_previous",
      category: "会话",
      hidden: true,
      onSelect: (dialog) => scrollToMessage("prev", dialog),
    },
    {
      title: "复制最后一条助手消息",
      value: "messages.copy",
      keybind: "messages_copy",
      category: "会话",
      onSelect: (dialog) => {
        const revertID = session()?.revert?.messageID
        const lastAssistantMessage = messages().findLast(
          (msg): msg is AssistantMessage => msg.role === "assistant" && (!revertID || msg.id < revertID),
        )
        if (!lastAssistantMessage) {
          toast.show({ message: "没有找到助手消息", variant: "error" })
          dialog.clear()
          return
        }

        const parts = sync.data.part[lastAssistantMessage.id] ?? []
        const text = copyableAssistantText(lastAssistantMessage, parts, sync)
        if (!text) {
          toast.show({
            message: "最后一条助手消息没有文本内容",
            variant: "error",
          })
          dialog.clear()
          return
        }

        Clipboard.copy(text)
          .then(() => toast.show({ message: "消息已复制到剪贴板", variant: "success" }))
          .catch(() => toast.show({ message: "复制到剪贴板失败", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "复制会话记录",
      description: "复制当前会话的完整文本记录",
      value: "session.copy",
      category: "会话",
      slash: {
        name: "copy",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()
          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: false,
              toolDetails: false,
              assistantMetadata: false,
              pendingAccessMessageIDs: pendingExternalDirectoryMessageIDs(route.sessionID, sync),
            },
          )
          await Clipboard.copy(transcript)
          toast.show({ message: "会话记录已复制到剪贴板", variant: "success" })
        } catch (error) {
          toast.show({ message: "复制会话记录失败", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "导出会话记录",
      description: "将当前会话记录导出为文件",
      value: "session.export",
      keybind: "session_export",
      category: "会话",
      slash: {
        name: "export",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()

          const defaultFilename = `session-${sessionData.id.slice(0, 8)}.md`

          const options = await DialogExportOptions.show(dialog, defaultFilename, false, false, false, false)

          if (options === null) return

          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: options.thinking,
              toolDetails: options.toolDetails,
              assistantMetadata: options.assistantMetadata,
              pendingAccessMessageIDs: pendingExternalDirectoryMessageIDs(route.sessionID, sync),
            },
          )

          if (options.openWithoutSaving) {
            // Just open in editor without saving
            await Editor.open({ value: transcript, renderer })
          } else {
            const exportDir = process.cwd()
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await Bun.write(filepath, transcript)

            // Open with EDITOR if available
            const result = await Editor.open({ value: transcript, renderer })
            if (result !== undefined) {
              await Bun.write(filepath, result)
            }

            toast.show({ message: `会话记录已导出到 ${filename}`, variant: "success" })
          }
        } catch (error) {
          toast.show({ message: "导出会话记录失败", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "下一个子会话",
      value: "session.child.next",
      keybind: "session_child_cycle",
      category: "会话",
      hidden: true,
      onSelect: (dialog) => {
        moveChild(1)
        dialog.clear()
      },
    },
    {
      title: "上一个子会话",
      value: "session.child.previous",
      keybind: "session_child_cycle_reverse",
      category: "会话",
      hidden: true,
      onSelect: (dialog) => {
        moveChild(-1)
        dialog.clear()
      },
    },
    {
      title: "返回父会话",
      value: "session.parent",
      keybind: "session_parent",
      category: "会话",
      hidden: true,
      onSelect: (dialog) => {
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
        dialog.clear()
      },
    },
  ])

  const revertInfo = createMemo(() => session()?.revert)
  const revertMessageID = createMemo(() => revertInfo()?.messageID)

  const revertRevertedMessages = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return []
    return messages().filter((x) => x.id >= messageID && x.role === "user")
  })

  const revert = createMemo(() => {
    const info = revertInfo()
    if (!info) return
    if (!info.messageID) return
    return {
      messageID: info.messageID,
      reverted: revertRevertedMessages(),
      dataset: info.dataset,
    }
  })

  const dialog = useDialog()
  const renderer = useRenderer()
  const promptHint = createMemo(() => {
    return undefined
  })
  const promptRight = createMemo(() => {
    const current = local.model.current()
    const level = local.model.reasoningLevel.current()
    if (!current) return undefined
    // 输入框右侧只用原始 modelID（如 "deepseek-v4-flash"）小写展示，弱化视觉权重；
    // 与 DialogModel 里展示的人类可读 Display Name（如 "DeepSeek V4 Flash"）区分开。
    return `${current.modelID.toLowerCase()}${level ? ` ${level}` : ""}`
  })

  // snap to bottom when session changes
  createEffect(on(() => route.sessionID, toBottom))

  return (
    <context.Provider
      value={{
        get width() {
          return contentWidth()
        },
        sessionID: route.sessionID,
        conceal,
        showThinking,
        showTimestamps,
        showDetails,
        showGenericToolOutput,
        reasoningExpanded: (partID) => isReasoningExpanded(reasoningExpandedState(), partID),
        toggleReasoningExpanded: (partID) =>
          setReasoningExpandedState((state) => toggleReasoningExpandedState(state, partID)),
        sync,
      }}
    >
      <box flexDirection="row">
        <box flexGrow={1} paddingBottom={1} paddingTop={1} paddingLeft={2} paddingRight={2} gap={1}>
          <Show when={session()}>
            <Show when={!sidebarVisible() || !wide()}>
              <Header />
            </Show>
            <scrollbox
              ref={(r) => (scroll = r)}
              viewportOptions={{
                paddingRight: scrollbarVisible() ? 1 : 0,
              }}
              verticalScrollbarOptions={{
                paddingLeft: 1,
                visible: scrollbarVisible(),
                trackOptions: {
                  backgroundColor: theme.backgroundElement,
                  foregroundColor: theme.border,
                },
              }}
              stickyScroll={true}
              stickyStart="bottom"
              flexGrow={1}
              scrollAcceleration={scrollAcceleration()}
            >
              <Show when={earlierHiddenCount() > 0}>
                <box
                  marginTop={1}
                  paddingLeft={2}
                  flexShrink={0}
                  onMouseUp={() => {
                    if (renderer.getSelection()?.getSelectedText()) return
                    setShowAllMessages(true)
                  }}
                >
                  <text fg={theme.textMuted}>
                    ↑ 更早的 {earlierHiddenCount()} 条消息已折叠（点击展开全部）
                  </text>
                </box>
              </Show>
              <For each={messages()}>
                {(message, index) => (
                  <Switch>
                    <Match when={message.id === revert()?.messageID}>
                      {(function () {
                        const command = useCommandDialog()
                        const [hover, setHover] = createSignal(false)
                        const dialog = useDialog()

                        const handleUnrevert = async () => {
                          const confirmed = await DialogConfirm.show(
                            dialog,
                            "确认恢复",
                            "确定要恢复已撤回的消息吗？",
                          )
                          if (confirmed) {
                            command.trigger("session.redo")
                          }
                        }

                        return (
                          <box
                            onMouseOver={() => setHover(true)}
                            onMouseOut={() => setHover(false)}
                            onMouseUp={handleUnrevert}
                            marginTop={1}
                            flexShrink={0}
                            border={["left"]}
                            customBorderChars={SplitBorder.customBorderChars}
                            borderColor={theme.backgroundPanel}
                          >
                            <box
                              paddingTop={1}
                              paddingBottom={1}
                              paddingLeft={2}
                              backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
                            >
                              <text fg={theme.textMuted}>已撤回 {revert()!.reverted.length} 条消息</text>
                              <text fg={theme.textMuted}>
                                <span style={{ fg: theme.text }}>{keybind.print("messages_redo")}</span> 或 /redo 恢复
                              </text>
                              <Show when={revert()!.dataset}>
                                <box marginTop={1}>
                                  <text fg={theme.text}>
                                    数据已恢复到撤回前的状态
                                  </text>
                                  <text fg={theme.textMuted}>撤销的操作：{revert()!.dataset!.undoneAction}</text>
                                </box>
                              </Show>
                            </box>
                          </box>
                        )
                      })()}
                    </Match>
                    <Match when={revert()?.messageID && message.id >= revert()!.messageID}>
                      <></>
                    </Match>
                    <Match when={message.role === "user"}>
                      <UserMessage
                        index={index()}
                        onMouseUp={() => {
                          if (renderer.getSelection()?.getSelectedText()) return
                          dialog.replace(() => (
                            <DialogMessage
                              messageID={message.id}
                              sessionID={route.sessionID}
                              setPrompt={(promptInfo) => prompt.set(promptInfo)}
                            />
                          ))
                        }}
                        message={message as UserMessage}
                        parts={sync.data.part[message.id] ?? []}
                        pending={pending()}
                      />
                    </Match>
                    <Match when={message.role === "assistant"}>
                      <AssistantMessage
                        last={lastAssistant()?.id === message.id}
                        message={message as AssistantMessage}
                        parts={sync.data.part[message.id] ?? []}
                      />
                    </Match>
                  </Switch>
                )}
              </For>
              <RetryNotice sessionID={route.sessionID} />
            </scrollbox>
            <box flexShrink={0}>
              <Show when={permissions().length > 0}>
                <PermissionPrompt request={permissions()[0]} />
              </Show>
              <Show when={permissions().length === 0 && questions().length > 0}>
                <QuestionPrompt request={questions()[0]} />
              </Show>
              <Prompt
                visible={!session()?.parentID && permissions().length === 0 && questions().length === 0}
                ref={(r) => {
                  if (!r) return
                  prompt = r
                  promptRef.set(r)
                  // Apply initial prompt when prompt component mounts (e.g., from fork)
                  if (route.initialPrompt) {
                    r.set(route.initialPrompt)
                  }
                }}
                disabled={permissions().length > 0 || questions().length > 0}
                onSubmit={() => {
                  toBottom()
                }}
                sessionID={route.sessionID}
                hint={promptHint()}
                right={promptRight()}
                onRightMouseDown={() => dialog.replace(() => <DialogModelSettings />)}
              />
              <Footer />
            </box>
          </Show>
          <Toast />
        </box>
        <Show when={sidebarVisible()}>
          <Switch>
            <Match when={wide()}>
              <Sidebar sessionID={route.sessionID} />
            </Match>
            <Match when={!wide()}>
              <box
                position="absolute"
                top={0}
                left={0}
                right={0}
                bottom={0}
                alignItems="flex-end"
                backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
              >
                <Sidebar sessionID={route.sessionID} />
              </box>
            </Match>
          </Switch>
        </Show>
      </box>
    </context.Provider>
  )
}

const MIME_BADGE: Record<string, string> = {
  "text/plain": "txt",
  "image/png": "img",
  "image/jpeg": "img",
  "image/gif": "img",
  "image/webp": "img",
  "application/pdf": "pdf",
  "application/x-directory": "dir",
}

function UserMessage(props: {
  message: UserMessage
  parts: Part[]
  onMouseUp: () => void
  index: number
  pending?: string
}) {
  const ctx = use()
  const local = useLocal()
  const text = createMemo(() => props.parts.flatMap((x) => (x.type === "text" && !x.synthetic ? [x] : []))[0])
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  const { theme } = useTheme()
  const queued = createMemo(() => props.pending && props.message.id > props.pending)
  const color = createMemo(() => (queued() ? theme.accent : local.agent.color(props.message.agent)))
  const queuedTask = createMemo(() =>
    pendingTaskLabel({
      text: text()?.text,
      files: files().map((file) => ({ filename: file.filename, url: file.url, mime: file.mime })),
    }),
  )

  const compaction = createMemo(() => props.parts.find((x) => x.type === "compaction"))

  return (
    <>
      <Show when={text()}>
        <box
          id={props.message.id}
          onMouseUp={props.onMouseUp}
          marginTop={props.index === 0 ? 0 : 1}
          paddingLeft={1}
          flexShrink={0}
        >
          <box flexDirection="row" gap={1}>
            <text fg={color()} flexShrink={0}>
              ●
            </text>
            <text fg={color()}>{text()?.text}</text>
          </box>
          <Show when={files().length}>
            <box flexDirection="row" paddingLeft={3} paddingTop={1} gap={1} flexWrap="wrap">
              <For each={files()}>
                {(file) => {
                  const bg = createMemo(() => {
                    if (file.mime.startsWith("image/")) return theme.accent
                    if (file.mime === "application/pdf") return theme.primary
                    return theme.secondary
                  })
                  return (
                    <text fg={theme.text}>
                      <span style={{ bg: bg(), fg: theme.background }}> {MIME_BADGE[file.mime] ?? file.mime} </span>
                      <span style={{ fg: theme.textMuted }}> {file.filename} </span>
                    </text>
                  )
                }}
              </For>
            </box>
          </Show>
          <Show
            when={queued()}
            fallback={
              <Show when={ctx.showTimestamps()}>
                <text paddingLeft={3} fg={theme.textMuted}>
                  {Locale.todayTimeOrDateTime(props.message.time.created)}
                </text>
              </Show>
            }
          >
            <box paddingLeft={3} flexDirection="row" gap={1} flexShrink={0}>
              <Show when={queuedTask()} fallback={<text fg={theme.textMuted}>等待回复</text>}>
                <text fg={theme.primary}>{queuedTask()}</text>
                <ProgressDots />
              </Show>
            </box>
          </Show>
        </box>
      </Show>
      <Show when={compaction()}>
        <box
          marginTop={1}
          border={["top"]}
          title=" Compaction "
          titleAlignment="center"
          borderColor={theme.borderActive}
        />
      </Show>
    </>
  )
}

function AssistantMessage(props: { message: AssistantMessage; parts: Part[]; last: boolean }) {
  const ctx = use()
  const { theme } = useTheme()
  const sync = useSync()

  const visibleError = createMemo(() => {
    const error = props.message.error
    if (!error || error.name === "MessageAbortedError") return undefined
    const rawMessage = typeof error.data.message === "string" ? error.data.message : undefined
    return analysisErrorDisplayText({
      text: rawMessage,
      isAnalysis: isAnalysisAssistantMessage(props.message, sync),
      showDetails: ctx.showDetails(),
      waitingForAccess: isAnalysisAssistantWaitingForAccess(props.message, sync),
    })
  })

  // 思考过程必须排在正文之前：模型可能交错吐出 text/reasoning，按类型重排而不改内容顺序
  const orderedParts = createMemo(() => [
    ...props.parts.filter((part) => part.type === "reasoning"),
    ...props.parts.filter((part) => part.type !== "reasoning"),
  ])

  return (
    <>
      <For each={orderedParts()}>
        {(part, index) => {
          const component = createMemo(() => PART_MAPPING[part.type as keyof typeof PART_MAPPING])
          return (
            <Show when={component()}>
              <Dynamic
                last={index() === orderedParts().length - 1}
                component={component()}
                part={part as any}
                message={props.message}
              />
            </Show>
          )
        }}
      </For>
      <Show when={visibleError()}>
        <box
          border={["left"]}
          paddingTop={0}
          paddingBottom={0}
          paddingLeft={1}
          marginTop={1}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.error}
        >
          <text fg={theme.textMuted}>{visibleError()}</text>
        </box>
      </Show>
      <Show when={props.message.error?.name === "MessageAbortedError"}>
        <text paddingLeft={2} fg={theme.textMuted}>
          回答已停止
        </text>
      </Show>
    </>
  )
}

const PART_MAPPING = {
  text: TextPart,
  tool: ToolPart,
  reasoning: ReasoningPart,
}

// 在 analysis turn 中，这些工具的输出对用户是纯噪音，应当被隐藏
// bash: 内部 Python 脚本执行；write: 写入 parquet/json 产物文件
const INTERNAL_ANALYSIS_MESSAGE_TOOLS = new Set([
  "data_import",
  "econometrics",
  ...WORKFLOW_ANALYSIS_TOOL_IDS,
  "heterogeneity_runner",
  "research_brief",
  "paper_draft",
  "slide_generator",
  "regression_table",
  "glob",
  "grep",
  "list",
  "read",
  "write",
  "bash",
  "pipeline",
  "skill",
  "invalid",
  "todowrite",
  "todoread",
])

function assistantToolsForMessage(message: AssistantMessage, sync: ReturnType<typeof useSync>): AnalysisToolPartLike[] {
  return (sync.data.part[message.id] ?? [])
    .filter((part): part is Extract<Part, { type: "tool" }> => part.type === "tool")
    .map((part) => ({
      tool: part.tool,
      state: {
        status: part.state.status,
        input: part.state.input,
        metadata: "metadata" in part.state ? part.state.metadata : undefined,
      },
    }))
}

function latestUserTextForMessage(message: AssistantMessage, sync: ReturnType<typeof useSync>) {
  const messages = sync.data.message[message.sessionID] ?? []
  const currentIndex = messages.findIndex((entry) => entry.id === message.id)
  const searchIndex = currentIndex >= 0 ? currentIndex - 1 : messages.length - 1

  for (let index = searchIndex; index >= 0; index -= 1) {
    const entry = messages[index]
    if (entry.role !== "user") continue
    const parts = sync.data.part[entry.id] ?? []
    const text = parts
      .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.synthetic)
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n")
    if (text) return text
  }

  return undefined
}

function copyableAssistantText(message: AssistantMessage, parts: Part[], sync: ReturnType<typeof useSync>) {
  const tools = assistantToolsForMessage(message, sync)
  const latestUserText = latestUserTextForMessage(message, sync)
  const rendered: string[] = []
  let lastRendered: string | undefined
  const isAnalysis = isAnalysisTurn(tools, latestUserText)

  for (const part of parts) {
    if (part.type !== "text" || part.synthetic) continue
    const text = sanitizeAnalysisAssistantText({
      text: part.text,
      tools,
      latestUserText,
    }).text.trim()
    if (!text || text === lastRendered) continue
    rendered.push(text)
    lastRendered = text
  }

  if (rendered.length === 0) {
    const rawMessage = typeof message.error?.data.message === "string" ? message.error.data.message : undefined
    const fallback = analysisErrorDisplayText({
      text: rawMessage,
      isAnalysis,
      showDetails: false,
      waitingForAccess: isAnalysisAssistantWaitingForAccess(message, sync),
    })
    if (fallback) return fallback
  }

  return rendered.join("\n").trim()
}

function isAnalysisAssistantMessage(message: AssistantMessage, sync: ReturnType<typeof useSync>) {
  return isAnalysisTurn(assistantToolsForMessage(message, sync), latestUserTextForMessage(message, sync))
}

function pendingExternalDirectoryRequestsForMessage(message: AssistantMessage, sync: ReturnType<typeof useSync>) {
  return (sync.data.permission[message.sessionID] ?? []).filter(
    (request) => request.permission === "external_directory" && request.tool?.messageID === message.id,
  )
}

function isAnalysisAssistantWaitingForAccess(message: AssistantMessage, sync: ReturnType<typeof useSync>) {
  return (
    isAnalysisAssistantMessage(message, sync) && pendingExternalDirectoryRequestsForMessage(message, sync).length > 0
  )
}

function pendingExternalDirectoryMessageIDs(sessionID: string, sync: ReturnType<typeof useSync>) {
  return new Set(
    (sync.data.permission[sessionID] ?? [])
      .filter((request) => request.permission === "external_directory" && request.tool?.messageID)
      .map((request) => request.tool!.messageID),
  )
}

function ReasoningPart(props: { last: boolean; part: ReasoningPart; message: AssistantMessage }) {
  const { theme, subtleSyntax } = useTheme()
  const ctx = use()
  const sync = useSync()
  const renderer = useRenderer()
  // 聚合同一条 assistant 消息内的多段思考，避免 13 个折叠刷屏
  const aggregatedContent = createMemo(() => {
    const parts = (sync.data.part[props.message.id] ?? []).filter(
      (p): p is ReasoningPart => p.type === "reasoning",
    )
    const combined = parts
      .map((p) => p.text.replace("[REDACTED]", "").trim())
      .filter((t) => t && !containsEngineInternalData(t))
      .join("\n\n")
    // 聚合渲染点固定在第一段：思考块必须排在同一条消息的正文之前
    const isFirst = parts.length === 0 || parts[0]!.id === props.part.id
    if (!isFirst) return ""
    const single = props.part.text.replace("[REDACTED]", "").trim()
    if (parts.length <= 1) return containsEngineInternalData(single) ? "" : single
    return combined
  })
  const content = aggregatedContent
  const expanded = createMemo(() => ctx.reasoningExpanded(props.part.id))
  const shouldShow = createMemo(() => {
    // 只有第一段思考才渲染（内容已聚合），保证“先思考后回答”的顺序
    const parts = (sync.data.part[props.message.id] ?? []).filter(
      (p): p is ReasoningPart => p.type === "reasoning",
    )
    const isFirst = parts.length === 0 || parts[0]!.id === props.part.id
    if (!isFirst) return false
    return shouldShowReasoning({
      hasContent: Boolean(content()),
      showThinking: ctx.showThinking(),
      isAnalysis: isAnalysisAssistantMessage(props.message, sync),
      waitingForAccess: isAnalysisAssistantWaitingForAccess(props.message, sync),
    })
  })
  return (
    <Show when={shouldShow()}>
      <box
        id={"text-" + props.part.id}
        paddingLeft={1}
        marginTop={1}
        flexDirection="column"
        border={["left"]}
        paddingTop={0}
        paddingBottom={0}
        customBorderChars={SplitBorder.customBorderChars}
        borderColor={theme.borderSubtle}
        onMouseUp={() => {
          if (renderer.getSelection()?.getSelectedText()) return
          ctx.toggleReasoningExpanded(props.part.id)
        }}
      >
        <text fg={theme.textMuted} paddingLeft={1}>
          {expanded() ? "▾ 思考过程" : "▸ 思考过程"}
        </text>
        <Show when={expanded()}>
          <code
            filetype="markdown"
            drawUnstyledText={false}
            streaming={false}
            syntaxStyle={subtleSyntax()}
            content={content()}
            conceal={ctx.conceal()}
            fg={theme.textMuted}
          />
        </Show>
      </box>
    </Show>
  )
}

function TextPart(props: { last: boolean; part: TextPart; message: AssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const sync = useSync()
  const latestUserText = createMemo(() => latestUserTextForMessage(props.message, sync))
  const content = createMemo(() => {
    const text = props.part.text.trim()
    if (!text) return ""
    const tools = assistantToolsForMessage(props.message, sync)
    const userText = latestUserText()
    const isAnalysis = isAnalysisTurn(tools, userText)
    const waitingForAccess = isAnalysisAssistantWaitingForAccess(props.message, sync)
    if (isAnalysis && props.part.synthetic && !ctx.showDetails()) return ""

    const renderText = (value: string) => {
      const trimmed = value.trim()
      if (!trimmed) return ""
      const hasEngineData = containsEngineInternalData(trimmed)
      if (!isAnalysis && !hasEngineData) return trimmed
      if (ctx.showDetails() && isAnalysis && !hasEngineData) return trimmed
      return sanitizeAnalysisAssistantText({
        text: trimmed,
        tools,
        latestUserText: userText,
      }).text.trim()
    }

    const rendered = renderText(text)
    if (!rendered) return ""

    if (isAnalysis && !ctx.showDetails()) {
      if (waitingForAccess) return ""

      const textParts = (sync.data.part[props.message.id] ?? []).filter(
        (part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.synthetic,
      )
      const currentIndex = textParts.findIndex((part) => part.id === props.part.id)
      if (currentIndex > 0) {
        for (let index = currentIndex - 1; index >= 0; index -= 1) {
          const previous = renderText(textParts[index].text)
          if (!previous) continue
          if (previous === rendered) return ""
          break
        }
      }
    }

    return rendered
  })
  return (
    <Show when={content()}>
      <box id={"text-" + props.part.id} paddingLeft={2} marginTop={1} flexShrink={0}>
        <code
          filetype="markdown"
          drawUnstyledText={false}
          streaming={props.last && !props.message.time.completed}
          syntaxStyle={syntax()}
          content={content()}
          conceal={ctx.conceal()}
          fg={theme.text}
        />
      </box>
    </Show>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = use()
  const sync = useSync()
  const { theme } = useTheme()
  const latestUserText = createMemo(() => latestUserTextForMessage(props.message, sync))
  const metadata = createMemo(() => (props.part.state.status === "pending" ? {} : (props.part.state.metadata ?? {})))
  const display = createMemo(() => readToolDisplay(metadata()))
  const waitingForAccess = createMemo(() => isAnalysisAssistantWaitingForAccess(props.message, sync))
  const showProgress = createMemo(
    () =>
      !ctx.showDetails() &&
      props.part.state.status !== "error" &&
      ([
        "data_import",
        "data_preprocess",
        "econometrics_execute",
        "econometrics_recommend",
        "regression_table",
        "heterogeneity_runner",
        "research_brief",
        "paper_draft",
        "slide_generator",
      ].includes(props.part.tool) ||
        isWorkflowAnalysisTool(props.part.tool)),
  )
  // classifyToolFailure 生成的结构化 reflection（failureType/repairAction），仅错误时存在。
  const reflection = createMemo(() => {
    const meta = metadata()
    if (!meta || typeof meta.reflection !== "object" || meta.reflection === null) return undefined
    const ref = meta.reflection as Record<string, unknown>
    return {
      failureType: typeof ref.failureType === "string" ? ref.failureType : undefined,
      repairAction: typeof ref.repairAction === "string" ? ref.repairAction : undefined,
    }
  })
  const analysisToolErrorText = createMemo(() => {
    if (props.part.state.status !== "error" || !isAnalysisAssistantMessage(props.message, sync)) return undefined
    if (props.part.state.metadata?.skippedAfterPriorToolFailure === true || props.part.state.metadata?.skippedAfterUserDecision === true) return undefined
    const raw = props.part.state.error
    // 计量工具错误经 classifyToolFailure 生成 reflection，已走安全消毒路径；
    // 优先给用户可读文案（如 QA 门拦截），没有匹配时展示真实错误，避免泛化兜底吞掉可操作细节。
    if (reflection()) return userFacingAnalysisErrorText(raw) ?? raw
    return analysisErrorDisplayText({
      text: raw,
      isAnalysis: true,
      showDetails: ctx.showDetails(),
      waitingForAccess: waitingForAccess(),
    })
  })

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => {
    if (analysisToolErrorText()) return false
    const analysisTurn = isAnalysisTurn(assistantToolsForMessage(props.message, sync), latestUserText())
    // 分析详情只允许展开可读说明；内部工具、路径和原始产物永不展示。
    if (display()?.visibility === "internal_only") return true
    if (analysisTurn && INTERNAL_ANALYSIS_MESSAGE_TOOLS.has(props.part.tool)) return true
    // pipeline 的只读子操作（artifacts/status/doctor 等）永远是内部记账调用，
    // 不因当前轮是否被分类为"分析轮"而改变——不该出现在对话流里当工具调用卡片。
    if (props.part.tool === "pipeline" && isWorkflowReadOnlyAction(props.part.state.input)) return true
    if (ctx.showDetails()) return false
    if (waitingForAccess()) {
      if (props.part.state.status !== "completed") return true
      return INTERNAL_ANALYSIS_MESSAGE_TOOLS.has(props.part.tool)
    }
    return false
  })

  const toolprops = {
    get metadata() {
      return metadata()
    },
    get input() {
      return props.part.state.input ?? {}
    },
    get output() {
      return props.part.state.status === "completed" ? props.part.state.output : undefined
    },
    get permission() {
      const permissions = sync.data.permission[props.message.sessionID] ?? []
      const permissionIndex = permissions.findIndex((x) => x.tool?.callID === props.part.callID)
      return permissions[permissionIndex]
    },
    get tool() {
      return props.part.tool
    },
    get part() {
      return props.part
    },
  }

  return (
    <Show
      when={!shouldHide()}
      fallback={
        <Show when={showProgress()}>
          <AnalysisProgress part={props.part} />
        </Show>
      }
    >
      <Show
        when={analysisToolErrorText()}
        fallback={
          <Switch>
            <Match when={props.part.tool === "bash" || props.part.tool === "shell"}>
              <Bash {...toolprops} />
            </Match>
            <Match when={props.part.tool === "glob"}>
              <Glob {...toolprops} />
            </Match>
            <Match when={props.part.tool === "read"}>
              <Read {...toolprops} />
            </Match>
            <Match when={props.part.tool === "grep"}>
              <Grep {...toolprops} />
            </Match>
            <Match when={props.part.tool === "list"}>
              <List {...toolprops} />
            </Match>
            <Match when={props.part.tool === "webfetch"}>
              <WebFetch {...toolprops} />
            </Match>
            <Match when={props.part.tool === "websearch"}>
              <WebSearch {...toolprops} />
            </Match>
            <Match when={props.part.tool === "write"}>
              <Write {...toolprops} />
            </Match>
            <Match when={props.part.tool === "edit"}>
              <Edit {...toolprops} />
            </Match>
            <Match when={props.part.tool === "task"}>
              <Task {...toolprops} />
            </Match>
            <Match when={props.part.tool === "todowrite"}>
              <TodoWrite {...toolprops} />
            </Match>
            <Match when={props.part.tool === "question"}>
              <Question {...toolprops} />
            </Match>
            <Match when={true}>
              <GenericTool {...toolprops} />
            </Match>
          </Switch>
        }
      >
        <Show when={analysisToolErrorText()}>
          <ToolErrorCard tool={props.part.tool} errorText={analysisToolErrorText()!} reflection={reflection()} />
        </Show>
      </Show>
    </Show>
  )
}

function analysisProgressLabel(part: ToolPart) {
  const view = readToolAnalysisView(part.state.status === "pending" ? undefined : part.state.metadata)
  const step = view?.step
  const action = String(part.state.input?.action ?? "")

  if (step === "data_import(import)" || action === "import") return "导入数据"
  if (step === "data_import(validate)" || action === "validate") return "检查数据质量"
  if (step === "data_import(profile)" || action === "profile") return "生成描述统计"
  if (step === "data_import(correlation)" || action === "correlation") return "计算相关性"
  if (part.tool === "data_import") return "处理数据"
  if (part.tool === "data_preprocess") return "清洗数据"
  if (part.tool === "econometrics_recommend") return "推荐计量方法"
  if (part.tool === "econometrics_execute") {
    const methodID = String((part.state.input as any)?.methodID ?? "")
    if (methodID === "hdfe_regression") return "进行高维固定效应回归"
    if (methodID === "did2s") return "进行两阶段双重差分"
    if (methodID === "did_event_study_saturated") return "进行现代事件研究"
    if (methodID === "did_static") return "进行传统双重差分"
    if (methodID === "iv_2sls") return "进行工具变量回归"
    if (methodID === "iv_test") return "进行工具变量诊断"
    if (methodID === "ols_regression") return "拟合OLS回归"
    if (methodID === "wls_regression") return "拟合加权最小二乘"
    if (methodID === "quantile_regression") return "拟合分位数回归"
    if (methodID === "panel_fe_regression") return "拟合面板固定效应"
    if (methodID === "panel_random_effects") return "拟合面板随机效应"
    if (methodID === "logit_regression" || methodID === "probit_regression") return "拟合二元选择模型"
    if (methodID === "poisson_regression" || methodID === "negbin_regression") return "拟合计数模型"
    if (methodID === "multinomial_logit") return "拟合多分类模型"
    if (methodID === "rdd_sharp" || methodID === "rdd_fuzzy") return "进行断点回归"
    if (methodID === "robust_regression") return "拟合稳健回归"
    if (methodID.startsWith("psm_")) return "进行倾向得分分析"
    if (methodID) return "进行计量分析"
  }
  if (part.tool === "hdfe_regression") return "进行高维固定效应回归"
  if (part.tool === "did2s") return "进行两阶段双重差分"
  if (part.tool === "did_event_study_saturated") return "进行现代事件研究"
  if (part.tool === "did_static") return "进行传统双重差分"
  if (part.tool === "iv_2sls") return "进行工具变量回归"
  if (part.tool === "iv_test") return "进行工具变量诊断"
  if (part.tool === "ols_regression") return "拟合OLS回归"
  if (part.tool === "wls_regression") return "拟合加权最小二乘"
  if (part.tool === "quantile_regression") return "拟合分位数回归"
  if (part.tool === "panel_fe_regression") return "拟合面板固定效应"
  if (part.tool === "panel_random_effects") return "拟合面板随机效应"
  if (part.tool === "logit_regression" || part.tool === "probit_regression") return "拟合二元选择模型"
  if (part.tool === "poisson_regression" || part.tool === "negbin_regression") return "拟合计数模型"
  if (part.tool === "multinomial_logit") return "拟合多分类模型"
  if (part.tool === "rdd_sharp" || part.tool === "rdd_fuzzy") return "进行断点回归"
  if (part.tool === "robust_regression") return "拟合稳健回归"
  if (part.tool.startsWith("psm_")) return "进行倾向得分分析"
  if (isWorkflowEstimateTool(part.tool)) return "进行计量分析"
  if (part.tool === "regression_table") return "整理回归结果表"
  if (part.tool === "heterogeneity_runner") return "进行异质性分析"
  if (part.tool === "research_brief") return "整理研究摘要"
  if (part.tool === "paper_draft") return "生成论文草稿"
  if (part.tool === "slide_generator") return "生成演示材料"
  return "处理请求"
}

// 进度行文案纯函数见 progress-text.ts：锁死「正在X，已用 Ns」输出格式（曾有终端渲染成「已已用」）。
function AnalysisProgress(props: { part: ToolPart }) {
  const { theme } = useTheme()
  const completed = createMemo(() => props.part.state.status === "completed")
  const label = createMemo(() => analysisProgressLabel(props.part))
  // 运行时长：从进入 running 起计时，Python 子进程常跑 3-60s，用户需要知道"已经多久了"。
  const [elapsed, setElapsed] = createSignal(0)
  createEffect(() => {
    if (completed()) return
    const startedAt = Date.now()
    setElapsed(0)
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250)
    onCleanup(() => clearInterval(timer))
  })
  const progressText = createMemo(() =>
    analysisProgressText({ label: label(), elapsed: elapsed(), completed: completed() }),
  )

  return (
    <box marginTop={1} paddingLeft={2} flexDirection="row" gap={1} flexShrink={0}>
      <text fg={completed() ? theme.success : theme.primary}>{completed() ? "✓" : "·"}</text>
      <text fg={theme.textMuted}>{progressText()}</text>
      <Show when={!completed()}>
        <ProgressDots />
      </Show>
    </box>
  )
}

function ProgressDots() {
  const { theme } = useTheme()
  const [activeDot, setActiveDot] = createSignal(0)

  onMount(() => {
    const timer = setInterval(() => setActiveDot((current) => (current + 1) % 3), 350)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <text flexShrink={0}>
      <For each={[0, 1, 2]}>
        {(dot) => <span style={{ fg: activeDot() === dot ? theme.primary : theme.border }}>.</span>}
      </For>
    </text>
  )
}

// 网络重连提示：跟在对话流末尾，网络/连接类瞬时故障时由 runtime 发 { type: "retry" } 状态触发。
// 展示当前第几次、总共几次、以及距下次重试的倒计时；重试成功后 runtime 会把状态切回 busy/idle，
// 本组件随之消失。上限对齐 FailurePolicy.MAX_TRANSIENT_NETWORK_RETRIES。
function RetryNotice(props: { sessionID: string }) {
  const { theme } = useTheme()
  const sync = useSync()
  const retry = createMemo(() => {
    const status = sync.data.session_status?.[props.sessionID]
    return status?.type === "retry" ? status : undefined
  })
  const [now, setNow] = createSignal(Date.now())
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const text = createMemo(() => {
    const r = retry()
    if (!r) return ""
    const lead = (r.message || "网络连接不稳定，正在重连").replace(/[。.]+$/, "")
    const seconds = Math.max(0, Math.ceil((r.next - now()) / 1000))
    const tail = seconds > 0 ? `，${seconds} 秒后重试` : "，正在重试…"
    return `⚠ ${lead}（第 ${r.attempt}/${FailurePolicy.MAX_TRANSIENT_NETWORK_RETRIES} 次${tail}）`
  })
  return (
    <Show when={retry()}>
      <box marginTop={1} paddingLeft={2} flexShrink={0}>
        <text fg={theme.warning}>{text()}</text>
      </box>
    </Show>
  )
}

// Pending 动画：给正在执行的单条工具行加一个轻量字符动画（会话没有全局 spinner）。
// 关键约束：必须返回合法的文本子节点（span），不能返回 <text>/<box>/<spinner>，否则作为
// <text> 的子节点会在 OpenTUI Solid 中触发 Orphan/类型错误。
function ToolSpinner() {
  const { theme } = useTheme()
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  const [frame, setFrame] = createSignal(0)
  onMount(() => {
    const timer = setInterval(() => setFrame((n) => (n + 1) % frames.length), 80)
    onCleanup(() => clearInterval(timer))
  })
  return <span style={{ fg: theme.primary }}>{frames[frame()]}</span>
}

// classifyToolFailure 的 FailureType 中文标签（与 runtime/failure-reflection.ts 值域一一对应）。
const FAILURE_TYPE_LABELS: Record<string, string> = {
  python_missing: "python环境缺失",
  process_timeout: "执行超时",
  dependency_broken: "依赖损坏",
  file_not_found: "数据文件未找到",
  column_not_found: "列不存在",
  validate_blocked: "数据需要处理",
  estimation_failure: "估计失败",
  panel_integrity_failure: "面板键需要确认",
  tool_contract_failure: "参数契约错误",
  result_contract_failure: "结果未通过校验",
  data_snapshot_failure: "数据快照未就绪",
  schema_mismatch: "数据模式不匹配",
  encoding_or_locale_error: "编码/区域设置错误",
  path_resolution_error: "路径解析错误",
  planning_failure: "规划阶段错误",
  unknown_failure: "执行未完成",
}

function ToolErrorCard(props: {
  tool: string
  errorText: string
  reflection?: { failureType?: string; repairAction?: string }
}) {
  const { theme } = useTheme()
  const failureLabel = () => {
    const type = props.reflection?.failureType
    return (type && FAILURE_TYPE_LABELS[type]) || "执行未完成"
  }
  const presentation = () =>
    analysisToolErrorPresentation({
      tool: props.tool,
      failureType: props.reflection?.failureType,
      failureLabel: failureLabel(),
    })
  const accentColor = () => (presentation().tone === "warning" ? theme.warning : theme.error)
  // 错误文本可能很长（含 stderr 尾部），卡片只展示首行，完整文本仍在 state.error 中可查。
  const firstLine = () => {
    const line = props.errorText.split("\n")[0]?.trim() ?? props.errorText
    return line.length > 180 ? `${line.slice(0, 177)}...` : line
  }
  return (
    <box
      marginTop={1}
      paddingLeft={1}
      paddingTop={0}
      paddingBottom={0}
      flexDirection="column"
      border={["left"]}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={accentColor()}
      flexShrink={0}
    >
      <text fg={accentColor()}>
        <span style={{ bold: true }}>{presentation().title}</span>
      </text>
      <text fg={theme.text}>{firstLine()}</text>
      <Show when={props.reflection?.repairAction}>
        <text fg={theme.textMuted}>↳ {presentation().guidanceLabel}：{props.reflection?.repairAction}</text>
      </Show>
    </box>
  )
}

// 有执行进度态的分析工具：completed 时以结果卡片展示（与 showProgress 的集合保持一致）。
function isResultCardTool(tool: string) {
  return (
    isWorkflowAnalysisTool(tool) ||
    [
      "data_import",
      "data_preprocess",
      "regression_table",
      "heterogeneity_runner",
      "research_brief",
      "paper_draft",
      "slide_generator",
    ].includes(tool)
  )
}

function AnalysisResultCard(props: { part: ToolPart; summary: string }) {
  const { theme } = useTheme()
  const label = createMemo(() => analysisProgressLabel(props.part).replace(/^进行/, ""))
  return (
    <box
      marginTop={1}
      paddingLeft={1}
      paddingTop={0}
      paddingBottom={0}
      flexDirection="column"
      border={["left"]}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.success}
      flexShrink={0}
    >
      <text fg={theme.success}>
        <span style={{ bold: true }}>{`✓ ${label()}完成`}</span>
      </text>
      <text fg={theme.text}>{props.summary}</text>
    </box>
  )
}

type ToolProps<T extends Tool.Info> = {
  input: Partial<Tool.InferParameters<T>>
  metadata: Partial<Tool.InferMetadata<T>>
  permission: Record<string, any>
  tool: string
  output?: string
  part: ToolPart
}
function GenericTool(props: ToolProps<any>) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const summary = createMemo(() => {
    const raw =
      renderToolDisplay(props.metadata, {
        includeDetails: false,
        includeArtifacts: false,
        pathMode: "name",
      }) ?? `${props.tool} ${input(props.input)}`.trim()
    // 防止 metadata dump 溢出：超过 200 字符的 summary 自动截断
    if (raw.length > 200) return raw.slice(0, 197) + "..."
    return raw
  })
  const details = createMemo(() => {
    return renderToolDisplay(props.metadata, {
      includeDetails: true,
      includeArtifacts: true,
      pathMode: "relative",
    })
  })
  const rawOutput = createMemo(() => props.output?.trim() ?? "")
  const showRawOutput = createMemo(() => {
    if (!ctx.showGenericToolOutput() || !rawOutput()) return false
    const visibleText = [summary(), details()].filter(Boolean).join("\n")
    return !visibleText.includes(rawOutput())
  })

  return (
    <Switch>
      <Match when={(ctx.showDetails() || ctx.showGenericToolOutput()) && (details() || props.output)}>
        <BlockTool title={`# ${props.tool}`} part={props.part}>
          <box gap={1}>
            <text fg={theme.text}>{summary()}</text>
            <Show when={details()}>
              <text fg={theme.textMuted}>{details()}</text>
            </Show>
            <Show when={showRawOutput()}>
              <code
                filetype="text"
                drawUnstyledText={false}
                streaming={false}
                syntaxStyle={syntax()}
                content={rawOutput()}
                fg={theme.textMuted}
              />
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={isResultCardTool(props.tool) && summary()}>
        <AnalysisResultCard part={props.part} summary={summary()} />
      </Match>
      <Match when={true}>
        <InlineTool icon="⚙" pending="正在准备工具…" complete={true} part={props.part}>
          {summary()}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ToolTitle(props: { fallback: string; when: any; icon: string; children: JSX.Element }) {
  const { theme } = useTheme()
  return (
    <text paddingLeft={3} fg={props.when ? theme.textMuted : theme.text}>
      <Show
        fallback={
          <>
            ~ {props.fallback}
          </>
        }
        when={props.when}
      >
        <span style={{ bold: true }}>{props.icon}</span> {props.children}
      </Show>
    </text>
  )
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  complete: any
  pending: string
  children: JSX.Element
  part: ToolPart
}) {
  const [margin, setMargin] = createSignal(0)
  const { theme } = useTheme()
  const ctx = use()
  const sync = useSync()

  const permission = createMemo(() => {
    const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
    if (!callID) return false
    return callID === props.part.callID
  })

  const fg = createMemo(() => {
    if (permission()) return theme.warning
    if (props.complete) return theme.textMuted
    return theme.text
  })
  const assistantMessage = createMemo(() =>
    (sync.data.message[props.part.sessionID] ?? []).find(
      (entry): entry is AssistantMessage => entry.id === props.part.messageID && entry.role === "assistant",
    ),
  )

  const suppressError = createMemo(() => {
    const display = props.part.state.status === "pending" ? undefined : readToolDisplay(props.part.state.metadata ?? {})
    const stateMetadata = props.part.state.status === "pending" ? undefined : props.part.state.metadata
    const message = assistantMessage()
    const errorText = analysisErrorDisplayText({
      text: props.part.state.status === "error" ? props.part.state.error : undefined,
      isAnalysis: Boolean(message && isAnalysisAssistantMessage(message, sync)),
      showDetails: ctx.showDetails(),
      waitingForAccess: Boolean(message && isAnalysisAssistantWaitingForAccess(message, sync)),
    })
    if (stateMetadata?.skippedAfterPriorToolFailure === true || stateMetadata?.skippedAfterUserDecision === true) return true
    const analysisTool =
      !ctx.showDetails() &&
      message &&
      isAnalysisAssistantMessage(message, sync) &&
      INTERNAL_ANALYSIS_MESSAGE_TOOLS.has(props.part.tool)
    if (errorText) return false
    return (
      props.part.tool === "todowrite" ||
      props.part.tool === "todoread" ||
      display?.visibility === "internal_only" ||
      Boolean(analysisTool)
    )
  })
  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : undefined))
  const visibleError = createMemo(
    () =>
      analysisErrorDisplayText({
        text: error(),
        isAnalysis: Boolean(assistantMessage() && isAnalysisAssistantMessage(assistantMessage()!, sync)),
        showDetails: ctx.showDetails(),
        waitingForAccess: Boolean(assistantMessage() && isAnalysisAssistantWaitingForAccess(assistantMessage()!, sync)),
      }) ?? error(),
  )

  const denied = createMemo(
    () =>
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  return (
    <box
      marginTop={margin()}
      paddingLeft={3}
      renderBefore={function () {
        const el = this as BoxRenderable
        const parent = el.parent
        if (!parent) {
          return
        }
        if (el.height > 1) {
          setMargin(1)
          return
        }
        const children = parent.getChildren()
        const index = children.indexOf(el)
        const previous = children[index - 1]
        if (!previous) {
          setMargin(0)
          return
        }
        if (previous.height > 1 || previous.id.startsWith("text-")) {
          setMargin(1)
          return
        }
      }}
    >
      <text paddingLeft={3} fg={fg()} attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}>
        <Show
          fallback={
            <>
              <ToolSpinner /> {props.pending}
            </>
          }
          when={props.complete}
        >
          <span style={{ fg: props.iconColor }}>{props.icon}</span> {props.children}
        </Show>
      </text>
      <Show when={visibleError() && !denied() && !suppressError()}>
        <text fg={theme.error}>{visibleError()}</text>
      </Show>
    </box>
  )
}

function BlockTool(props: { title: string; children: JSX.Element; onClick?: () => void; part?: ToolPart }) {
  const ctx = use()
  const sync = useSync()
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const assistantMessage = createMemo(() => {
    const part = props.part
    if (!part) return undefined
    return (sync.data.message[part.sessionID] ?? []).find(
      (entry): entry is AssistantMessage => entry.id === part.messageID && entry.role === "assistant",
    )
  })
  const suppressError = createMemo(() => {
    if (!props.part || props.part.state.status === "pending") return false
    const part = props.part
    const display = readToolDisplay("metadata" in part.state ? (part.state.metadata ?? {}) : {})
    const message = assistantMessage()
    const errorText = analysisErrorDisplayText({
      text: part.state.status === "error" ? part.state.error : undefined,
      isAnalysis: Boolean(message && isAnalysisAssistantMessage(message, sync)),
      showDetails: ctx.showDetails(),
      waitingForAccess: Boolean(message && isAnalysisAssistantWaitingForAccess(message, sync)),
    })
    const analysisTool =
      !ctx.showDetails() &&
      message &&
      isAnalysisAssistantMessage(message, sync) &&
      INTERNAL_ANALYSIS_MESSAGE_TOOLS.has(part.tool)
    if (errorText) return false
    return (
      part.tool === "todowrite" ||
      part.tool === "todoread" ||
      display?.visibility === "internal_only" ||
      Boolean(analysisTool)
    )
  })
  const error = createMemo(() => {
    const part = props.part
    return part?.state.status === "error" ? part.state.error : undefined
  })
  const visibleError = createMemo(
    () =>
      analysisErrorDisplayText({
        text: error(),
        isAnalysis: Boolean(assistantMessage() && isAnalysisAssistantMessage(assistantMessage()!, sync)),
        showDetails: ctx.showDetails(),
        waitingForAccess: Boolean(assistantMessage() && isAnalysisAssistantWaitingForAccess(assistantMessage()!, sync)),
      }) ?? error(),
  )
  return (
    <box
      border={["left"]}
      paddingTop={0}
      paddingBottom={0}
      paddingLeft={1}
      marginTop={1}
      gap={1}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.borderSubtle}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <text paddingLeft={1} fg={theme.textMuted}>
        {props.title}
      </text>
      {props.children}
      <Show when={visibleError() && !suppressError()}>
        <text fg={theme.error}>{visibleError()}</text>
      </Show>
    </box>
  )
}

function Bash(props: ToolProps<typeof BashTool>) {
  const { theme } = useTheme()
  const sync = useSync()
  const ctx = use()
  const output = createMemo(() => stripAnsi(props.metadata.output?.trim() ?? ""))
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => output().split("\n"))
  const overflow = createMemo(() => lines().length > 10)
  const limited = createMemo(() => {
    if (expanded() || !overflow()) return output()
    return [...lines().slice(0, 10), "…"].join("\n")
  })
  // 默认只报告"跑了什么、产出多少行"，命令输出正文留给 /details 展开。
  const outputSummary = createMemo(() => {
    const count = output() ? lines().length : 0
    if (!count) return ""
    return count === 1 ? "1 line" : `${count} lines`
  })

  const workdirDisplay = createMemo(() => {
    const workdir = props.input.workdir
    if (!workdir || workdir === ".") return undefined

    const base = sync.data.path.directory
    if (!base) return undefined

    const absolute = path.resolve(base, workdir)
    if (absolute === base) return undefined

    const home = Global.Path.home
    if (!home) return absolute

    const match = absolute === home || absolute.startsWith(home + path.sep)
    return match ? absolute.replace(home, "~") : absolute
  })

  const title = createMemo(() => {
    const desc = props.input.description ?? "Shell"
    const wd = workdirDisplay()
    if (!wd) return `# ${desc}`
    if (desc.includes(wd)) return `# ${desc}`
    return `# ${desc} in ${wd}`
  })

  return (
    <Switch>
      <Match when={ctx.showDetails() && props.metadata.output !== undefined}>
        <BlockTool
          title={title()}
          part={props.part}
          onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
        >
          <box gap={1}>
            <text fg={theme.text}>$ {props.input.command}</text>
            <text fg={theme.text}>{limited()}</text>
            <Show when={overflow()}>
              <text fg={theme.textMuted}>{expanded() ? "点击收起" : "点击展开"}</text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="$" pending="正在写命令…" complete={props.input.command} part={props.part}>
          {props.input.description ?? props.input.command}
          <Show when={outputSummary()}> ({outputSummary()})</Show>
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Write(props: ToolProps<typeof WriteTool>) {
  const { theme, syntax } = useTheme()
  const ctx = use()
  const code = createMemo(() => {
    if (!props.input.content) return ""
    return props.input.content
  })

  // 默认只说写了哪个文件、多大，正文不铺给用户。
  const sizeSummary = createMemo(() => {
    const content = code()
    if (!content) return ""
    const count = content.split("\n").length
    return count === 1 ? "1 line" : `${count} lines`
  })

  return (
    <Switch>
      <Match when={ctx.showDetails()}>
        <BlockTool title={"# Wrote " + displayPath(props.input.filePath)} part={props.part}>
          <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.text}
              filetype={filetype(props.input.filePath!)}
              syntaxStyle={syntax()}
              content={code()}
            />
          </line_number>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="正在准备写入…" complete={props.input.filePath} part={props.part}>
          Write {displayPath(props.input.filePath)}
          <Show when={sizeSummary()}> ({sizeSummary()})</Show>
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps<typeof GlobTool>) {
  // 目标在内部工作区（.killstata）的探索调用对用户是纯噪声：模型在找自己的产物，
  // 不是分析步骤。整行折叠（连报错一起），用户只看到关键步骤与最终结果。
  // pattern 经 displayGlobPattern 折叠，避免内部目录与数据集 ID 泄漏给用户。
  // pattern 在参数尚未流式解析完时可能为 undefined（pending 态）。
  const pattern = createMemo(() => (props.input.pattern ? displayGlobPattern(props.input.pattern) : ""))
  const internal = createMemo(() => {
    const rawPattern = props.input.pattern
    const pathArg = props.input.path
    return Boolean(
      (typeof rawPattern === "string" && isInternalWorkspacePath(rawPattern)) ||
        (pathArg && isInternalWorkspacePath(pathArg)),
    )
  })
  return (
    <Show when={!internal()}>
      <InlineTool icon="✱" pending="正在查找文件…" complete={pattern()} part={props.part}>
        Glob "{pattern()}" <Show when={props.input.path}>in {displayPath(props.input.path)} </Show>
        <Show when={props.metadata.count}>({props.metadata.count} matches)</Show>
      </InlineTool>
    </Show>
  )
}

function Read(props: ToolProps<typeof ReadTool>) {
  // 读内部产物（describe/QA/结果 json）是模型找自己结果的过程，对用户折叠。
  const internal = createMemo(() =>
    props.input.filePath ? isInternalWorkspacePath(props.input.filePath) : false,
  )
  return (
    <Show when={!internal()}>
      <InlineTool icon="→" pending="正在读取文件…" complete={displayPath(props.input.filePath)} part={props.part}>
        Read {displayPath(props.input.filePath)} {input(props.input, ["filePath"])}
      </InlineTool>
    </Show>
  )
}

function Grep(props: ToolProps<typeof GrepTool>) {
  // grep 目标在内部工作区时同样折叠（pattern 是搜索内容，不判；判 path）。
  const internal = createMemo(() => Boolean(props.input.path && isInternalWorkspacePath(props.input.path)))
  return (
    <Show when={!internal()}>
      <InlineTool icon="✱" pending="正在搜索内容…" complete={props.input.pattern} part={props.part}>
        Grep "{props.input.pattern}" <Show when={props.input.path}>in {displayPath(props.input.path)} </Show>
        <Show when={props.metadata.matches}>({props.metadata.matches} matches)</Show>
      </InlineTool>
    </Show>
  )
}

function List(props: ToolProps<typeof ListTool>) {
  const dir = createMemo(() => {
    if (props.input.path) {
      return displayPath(props.input.path)
    }
    return ""
  })
  const internal = createMemo(() => Boolean(props.input.path && isInternalWorkspacePath(props.input.path)))
  return (
    <Show when={!internal()}>
      <InlineTool icon="→" pending="正在列出目录…" complete={props.input.path !== undefined} part={props.part}>
        List {dir()}
      </InlineTool>
    </Show>
  )
}

function WebFetch(props: ToolProps<typeof WebFetchTool>) {
  return (
    <InlineTool icon="%" pending="正在联网获取…" complete={(props.input as any).url} part={props.part}>
      WebFetch {(props.input as any).url}
    </InlineTool>
  )
}

function WebSearch(props: ToolProps<any>) {
  const input = props.input as any
  const metadata = props.metadata as any
  return (
    <InlineTool icon="◈" pending="正在联网搜索…" complete={input.query} part={props.part}>
      Exa Web Search "{input.query}" <Show when={metadata.numResults}>({metadata.numResults} results)</Show>
    </InlineTool>
  )
}

function Task(props: ToolProps<typeof TaskTool>) {
  const { theme } = useTheme()
  const keybind = useKeybind()
  const { navigate } = useRoute()
  const local = useLocal()

  const current = createMemo(() => props.metadata.summary?.findLast((x) => x.state.status !== "pending"))
  const color = createMemo(() => local.agent.color(props.input.subagent_type ?? "unknown"))

  return (
    <Switch>
      <Match when={props.metadata.summary?.length}>
        <BlockTool
          title={"# " + Locale.titlecase(props.input.subagent_type ?? "unknown") + " Task"}
          onClick={
            props.metadata.sessionId
              ? () => navigate({ type: "session", sessionID: props.metadata.sessionId! })
              : undefined
          }
          part={props.part}
        >
          <box>
            <text style={{ fg: theme.textMuted }}>
              {props.input.description} ({props.metadata.summary?.length} toolcalls)
            </text>
            <Show when={current()}>
              <text style={{ fg: current()!.state.status === "error" ? theme.error : theme.textMuted }}>
                └ {Locale.titlecase(current()!.tool)}{" "}
                {current()!.state.status === "completed" ? current()!.state.title : ""}
              </text>
            </Show>
          </box>
          <text fg={theme.text}>
            {keybind.print("session_child_cycle")}
            <span style={{ fg: theme.textMuted }}> view subagents</span>
          </text>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="◉"
          iconColor={color()}
          pending="正在派发子任务…"
          complete={props.input.subagent_type ?? props.input.description}
          part={props.part}
        >
          <span style={{ fg: theme.text }}>{Locale.titlecase(props.input.subagent_type ?? "unknown")}</span> Task "
          {props.input.description}"
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Edit(props: ToolProps<typeof EditTool>) {
  return (
    <InlineTool icon="←" pending="正在准备编辑…" complete={props.input.filePath} part={props.part}>
      Edit {displayPath(props.input.filePath)}
    </InlineTool>
  )
}

function TodoWrite(props: ToolProps<typeof TodoWriteTool>) {
  return (
    <Switch>
      <Match when={props.metadata.todos?.length}>
        <BlockTool title="# Todos" part={props.part}>
          <box>
            <For each={props.input.todos ?? []}>
              {(todo) => <TodoItem status={todo.status ?? "pending"} content={todo.content ?? ""} />}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="⚙" pending="正在更新待办…" complete={false} part={props.part}>
          Updating todos...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps<typeof QuestionTool>) {
  const { theme } = useTheme()
  const count = createMemo(() => props.input.questions?.length ?? 0)

  function format(answer?: string[]) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={props.metadata.answers}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={props.input.questions ?? []}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={theme.textMuted}>{q.question}</text>
                  <text fg={theme.text}>{format(props.metadata.answers?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="正在提问…" complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function normalizePath(input?: string) {
  if (!input) return ""
  if (path.isAbsolute(input)) {
    return path.relative(process.cwd(), input) || "."
  }
  return input
}

// 内部工作区（.killstata）路径对用户隐身：工具标题只显示文件名，不暴露内部目录结构。
// 用户自己放进来的文件（data/*.xlsx 等）正常显示相对路径——两者区分让"内部细节不可见"
// 但不伤害"用户文件可追踪"。判定与末段提取都复用 analysis-display 的单一真相源，
// 这里只负责 TUI 特有的相对化基准（process.cwd()）。
function displayPath(input?: string) {
  const normalized = normalizePath(input)
  if (!normalized) return ""
  if (isInternalWorkspacePath(normalized)) return sharedDisplayPath(normalized)
  return normalized
}

function input(input: Record<string, any>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}
