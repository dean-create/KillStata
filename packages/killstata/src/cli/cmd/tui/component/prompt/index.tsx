import path from "path"
import { BoxRenderable, TextareaRenderable, MouseEvent, PasteEvent, t, dim, fg, TextAttributes } from "@opentui/core"
import { createEffect, createMemo, type JSX, onMount, createSignal, onCleanup, Show, on } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useTheme } from "@tui/context/theme"
import { EmptyBorder } from "@tui/component/border"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { Identifier } from "@/id/id"
import { createStore, produce } from "solid-js/store"
import { useKeybind } from "@tui/context/keybind"
import { usePromptHistory, type PromptInfo } from "./history"
import { usePromptStash } from "./stash"
import { DialogStash } from "../dialog-stash"
import { DialogDataFile } from "../dialog-data-file"
import { NativeFilePicker } from "../../util/native-file-picker"
import { type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useCommandDialog } from "../dialog-command"
import { useRenderer } from "@opentui/solid"
import { Editor } from "@tui/util/editor"
import { useExit } from "../../context/exit"
import { Clipboard } from "../../util/clipboard"
import type { FilePart } from "@killstata/sdk/v2"
import { TuiEvent } from "../../event"
import { iife } from "@killstata/util/iife"
import { Locale } from "@/util/locale"
import { useDialog } from "@tui/ui/dialog"
import { cleanupAll } from "@/runtime/retention"
import { parseCleanupCommand } from "../../cleanup-command"
import { parseCompactCommand } from "../../compact-command"
import { DialogProvider as DialogProviderConnect } from "../dialog-provider"
import { DialogReasoning } from "../dialog-reasoning"
import { useToast } from "../../ui/toast"
import { useTextareaKeybindings } from "../textarea-keybindings"
import { ProviderTransform } from "@/provider/transform"
import {
  attachmentLabel,
  dataFileLabel,
  normalizePastedText,
  pastedTextLabel,
  resolvePastedFilePath,
  shouldSummarizePaste,
} from "./paste"

export type PromptProps = {
  sessionID?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  ref?: (ref: PromptRef | undefined) => void
  hint?: JSX.Element
  // OpenTUI 的 box 不能直接接收动态字符串或外部 JSX 节点；把模型标签作为
  // 原始字符串传进来，并在 Prompt 内部放进 text，避免节点重排时产生 orphan text。
  right?: string
  onRightMouseDown?: () => void
  showPlaceholder?: boolean
  placeholders?: {
    normal?: string[]
    shell?: string[]
  }
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

const PLACEHOLDERS = ["输入你的问题..."]
const SHELL_PLACEHOLDERS = ["此模式仅供内部诊断使用"]

let stashed: { prompt: PromptInfo; cursor: number } | undefined

function commandCapabilityDescription(command: {
  description?: string
  availability?: string[]
  queueBehavior?: "queued" | "immediate"
  workflowAware?: boolean
  immediate?: boolean
  remoteSafe?: boolean
}) {
  return command.description ?? ""
}

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  let autocomplete: AutocompleteRef

  const keybind = useKeybind()
  const local = useLocal()
  const sdk = useSDK()
  const route = useRoute()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const status = createMemo(() => sync.data.session_status?.[props.sessionID ?? ""] ?? { type: "idle" })
  const running = createMemo(() => status().type !== "idle")
  const queue = createMemo(() => sync.data.runtimeQueue?.[props.sessionID ?? ""] ?? { pending: 0, actions: [] })
  const history = usePromptHistory()
  const stash = usePromptStash()
  const command = useCommandDialog()
  const renderer = useRenderer()
  const { theme, syntax } = useTheme()
  const list = createMemo(() => props.placeholders?.normal ?? PLACEHOLDERS)
  const shell = createMemo(() => props.placeholders?.shell ?? SHELL_PLACEHOLDERS)
  const hasRightContent = createMemo(() => Boolean(props.right))

  function promptModelWarning() {
    toast.show({
      variant: "warning",
      message: "请先连接模型提供商再发送消息",
      duration: 3000,
    })
    if (sync.data.provider.length === 0) {
      dialog.replace(() => <DialogProviderConnect />)
    }
  }

  const textareaKeybindings = useTextareaKeybindings()

  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  let promptPartTypeId = 0

  sdk.event.on(TuiEvent.PromptAppend.type, (evt) => {
    if (!input || input.isDestroyed) return
    input.insertText(evt.properties.text)
    setTimeout(() => {
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      input.gotoBufferEnd()
      renderer.requestRender()
    }, 0)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.disabled) input.cursorColor = theme.backgroundElement
    if (!props.disabled) input.cursorColor = theme.text
  })

  const lastUserMessage = createMemo(() => {
    if (!props.sessionID) return undefined
    const messages = sync.data.message[props.sessionID]
    if (!messages) return undefined
    return messages.findLast((m) => m.role === "user")
  })

  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPartIndex: Map<number, number>
    interrupt: number
    placeholder: number
  }>({
    placeholder: Math.floor(Math.random() * list().length),
    prompt: {
      input: "",
      parts: [],
    },
    mode: "normal",
    extmarkToPartIndex: new Map(),
    interrupt: 0,
  })

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setStore("placeholder", Math.floor(Math.random() * list().length))
      },
      { defer: true },
    ),
  )

  // Initialize agent/model/variant from last user message when session changes
  let syncedSessionID: string | undefined
  createEffect(() => {
    const sessionID = props.sessionID
    const msg = lastUserMessage()

    if (sessionID !== syncedSessionID) {
      if (!sessionID || !msg) return

      syncedSessionID = sessionID

      // Only set agent if it's a primary agent (not a subagent)
      const isPrimaryAgent = local.agent.list().some((x) => x.name === msg.agent)
      if (msg.agent && isPrimaryAgent) {
        local.agent.set(msg.agent)
        if (msg.model) local.model.set(msg.model)
        if (msg.variant) local.model.variant.set(msg.variant)
      }
    }
  })

  command.register(() => {
    return [
      {
        title: "清空输入框",
        value: "prompt.clear",
        category: "输入",
        hidden: true,
        onSelect: (dialog) => {
          input.extmarks.clear()
          input.clear()
          dialog.clear()
        },
      },
      {
        title: "提交输入",
        value: "prompt.submit",
        keybind: "input_submit",
        category: "输入",
        hidden: true,
        onSelect: async (dialog) => {
          if (!input.focused) return
          const handled = await submit()
          if (!handled) return
          dialog.clear()
        },
      },
      {
        title: "粘贴",
        value: "prompt.paste",
        keybind: "input_paste",
        category: "输入",
        hidden: true,
        onSelect: async () => {
          const content = await Clipboard.read()
          if (content?.mime.startsWith("image/")) {
            await pasteAttachment({
              filename: "clipboard",
              mime: content.mime,
              content: content.data,
            })
          }
        },
      },
      {
        title: "中断当前会话",
        value: "session.interrupt",
        keybind: "session_interrupt",
        category: "会话",
        hidden: true,
        enabled: status().type !== "idle",
        onSelect: (dialog) => {
          if (autocomplete.visible) return
          if (!input.focused) return
          // TODO: this should be its own command
          if (store.mode === "shell") {
            setStore("mode", "normal")
            return
          }
          if (!props.sessionID) return

          setStore("interrupt", store.interrupt + 1)

          setTimeout(() => {
            setStore("interrupt", 0)
          }, 5000)

          if (store.interrupt >= 2) {
            sdk.client.session.abort({
              sessionID: props.sessionID,
            })
            setStore("interrupt", 0)
          }
          dialog.clear()
        },
      },
      {
        title: "打开编辑器",
        description: "打开外部编辑器编辑当前输入",
        category: "会话",
        keybind: "editor_open",
        value: "prompt.editor",
        onSelect: async (dialog) => {
          dialog.clear()

          // replace summarized text parts with the actual text
          const text = store.prompt.parts
            .filter((p) => p.type === "text")
            .reduce((acc, p) => {
              if (!p.source) return acc
              return acc.replace(p.source.text.value, p.text)
            }, store.prompt.input)

          const nonTextParts = store.prompt.parts.filter((p) => p.type !== "text")

          const value = text
          const content = await Editor.open({ value, renderer })
          if (!content) return

          input.setText(content)

          // Update positions for nonTextParts based on their location in new content
          // Filter out parts whose virtual text was deleted
          // this handles a case where the user edits the text in the editor
          // such that the virtual text moves around or is deleted
          const updatedNonTextParts = nonTextParts
            .map((part) => {
              let virtualText = ""
              if (part.type === "file" && part.source?.text) {
                virtualText = part.source.text.value
              } else if (part.type === "agent" && part.source) {
                virtualText = part.source.value
              }

              if (!virtualText) return part

              const newStart = content.indexOf(virtualText)
              // if the virtual text is deleted, remove the part
              if (newStart === -1) return null

              const newEnd = newStart + virtualText.length

              if (part.type === "file" && part.source?.text) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    text: {
                      ...part.source.text,
                      start: newStart,
                      end: newEnd,
                    },
                  },
                }
              }

              if (part.type === "agent" && part.source) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    start: newStart,
                    end: newEnd,
                  },
                }
              }

              return part
            })
            .filter((part) => part !== null)

          setStore("prompt", {
            input: content,
            // keep only the non-text parts because the text parts were
            // already expanded inline
            parts: updatedNonTextParts,
          })
          restoreExtmarksFromParts(updatedNonTextParts)
          input.cursorOffset = Bun.stringWidth(content)
        },
      },
    ]
  })

  const ref: PromptRef = {
    get focused() {
      return input.focused
    },
    get current() {
      return store.prompt
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    set(prompt) {
      input.setText(prompt.input)
      setStore("prompt", prompt)
      restoreExtmarksFromParts(prompt.parts)
      input.gotoBufferEnd()
    },
    reset() {
      input.clear()
      input.extmarks.clear()
      setStore("prompt", {
        input: "",
        parts: [],
      })
      setStore("extmarkToPartIndex", new Map())
    },
    submit() {
      void submit()
    },
  }

  onMount(() => {
    const saved = stashed
    stashed = undefined
    if (store.prompt.input) return
    if (saved && saved.prompt.input) {
      input.setText(saved.prompt.input)
      setStore("prompt", saved.prompt)
      restoreExtmarksFromParts(saved.prompt.parts)
      input.cursorOffset = saved.cursor
    }
  })

  onCleanup(() => {
    if (store.prompt.input) {
      stashed = { prompt: { input: store.prompt.input, parts: [...store.prompt.parts] }, cursor: input.cursorOffset }
    }
    props.ref?.(undefined)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.visible === false || dialog.stack.length > 0) {
      if (input.focused) input.blur()
      return
    }
    if (!input.focused) input.focus()
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    ;(input as any).traits = {
      capture:
        store.mode === "normal"
          ? autocomplete?.visible
            ? (["escape", "navigate", "submit", "tab"] as const)
            : (["tab"] as const)
          : undefined,
      suspend: !!props.disabled || store.mode === "shell",
      status: store.mode === "shell" ? "SHELL" : undefined,
    }
  })

  function restoreExtmarksFromParts(parts: PromptInfo["parts"]) {
    input.extmarks.clear()
    setStore("extmarkToPartIndex", new Map())

    parts.forEach((part, partIndex) => {
      let start = 0
      let end = 0
      let virtualText = ""
      let styleId: number | undefined

      if (part.type === "file" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = fileStyleId
      } else if (part.type === "agent" && part.source) {
        start = part.source.start
        end = part.source.end
        virtualText = part.source.value
        styleId = agentStyleId
      } else if (part.type === "text" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        // 数据文件引用复用文件样式（橙字加粗、无底色）；普通粘贴才用带底色的 paste 样式。
        styleId = part.source.text.kind === "datafile" ? fileStyleId : pasteStyleId
      }

      if (virtualText) {
        const extmarkId = input.extmarks.create({
          start,
          end,
          virtual: true,
          styleId,
          typeId: promptPartTypeId,
        })
        setStore("extmarkToPartIndex", (map: Map<number, number>) => {
          const newMap = new Map(map)
          newMap.set(extmarkId, partIndex)
          return newMap
        })
      }
    })
  }

  function syncExtmarksWithPromptParts() {
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    setStore(
      produce((draft) => {
        const newMap = new Map<number, number>()
        const newParts: typeof draft.prompt.parts = []

        for (const extmark of allExtmarks) {
          const partIndex = draft.extmarkToPartIndex.get(extmark.id)
          if (partIndex !== undefined) {
            const part = draft.prompt.parts[partIndex]
            if (part) {
              if (part.type === "agent" && part.source) {
                part.source.start = extmark.start
                part.source.end = extmark.end
              } else if (part.type === "file" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              } else if (part.type === "text" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              }
              newMap.set(extmark.id, newParts.length)
              newParts.push(part)
            }
          }
        }

        draft.extmarkToPartIndex = newMap
        draft.prompt.parts = newParts
      }),
    )
  }

  command.register(() =>
    sync.data.command
      .filter((serverCommand) => !serverCommand.mcp)
      .map((serverCommand) => ({
        title: `/${serverCommand.name}`,
        value: `server.command.${serverCommand.name}`,
        category: serverCommand.workflowAware ? "数据与计量" : "命令",
        description: commandCapabilityDescription(serverCommand),
        suggested: Boolean(serverCommand.workflowAware && props.sessionID),
        slash: {
          name: serverCommand.name,
        },
        onSelect: (dialog) => {
          const text = `/${serverCommand.name} `
          input.extmarks.clear()
          input.setText(text)
          input.cursorOffset = Bun.stringWidth(text)
          setStore("prompt", { input: text, parts: [] })
          setStore("extmarkToPartIndex", new Map())
          dialog.clear()
        },
      })),
  )

  command.register(() => [
    {
      title: "暂存当前输入",
      value: "prompt.stash",
      category: "输入",
      enabled: !!store.prompt.input,
      onSelect: (dialog) => {
        if (!store.prompt.input) return
        stash.push({
          input: store.prompt.input,
          parts: store.prompt.parts,
        })
        input.extmarks.clear()
        input.clear()
        setStore("prompt", { input: "", parts: [] })
        setStore("extmarkToPartIndex", new Map())
        dialog.clear()
      },
    },
    {
      title: "恢复最近暂存输入",
      value: "prompt.stash.pop",
      category: "输入",
      enabled: stash.list().length > 0,
      onSelect: (dialog) => {
        const entry = stash.pop()
        if (entry) {
          input.setText(entry.input)
          setStore("prompt", { input: entry.input, parts: entry.parts })
          restoreExtmarksFromParts(entry.parts)
          input.gotoBufferEnd()
        }
        dialog.clear()
      },
    },
    {
      title: "查看暂存输入列表",
      value: "prompt.stash.list",
      category: "输入",
      enabled: stash.list().length > 0,
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogStash
            onSelect={(entry) => {
              input.setText(entry.input)
              setStore("prompt", { input: entry.input, parts: entry.parts })
              restoreExtmarksFromParts(entry.parts)
              input.gotoBufferEnd()
            }}
          />
        ))
      },
    },
  ])

  function clearInput() {
    input.extmarks.clear()
    setStore("prompt", { input: "", parts: [] })
    setStore("extmarkToPartIndex", new Map())
    input.clear()
  }

  async function submit(delivery: "queued" | "steer" = "queued") {
    if (input && !input.isDestroyed && input.plainText !== store.prompt.input) {
      setStore("prompt", "input", input.plainText)
      syncExtmarksWithPromptParts()
    }
    if (props.disabled) return false
    if (autocomplete?.visible) return false
    if (!store.prompt.input) return false
    const trimmed = store.prompt.input.trim()
    if (trimmed === "exit" || trimmed === "quit" || trimmed === ":q") {
      void exit()
      return true
    }
    const agent = local.agent.current()
    if (!agent) return false
    const selectedModel = local.model.current()
    if (!selectedModel) {
      promptModelWarning()
      return false
    }

    const contextMatch = trimmed.match(/^\/context(?:\s+.*)?$/i)
    if (contextMatch && props.sessionID) {
      input.extmarks.clear()
      setStore("prompt", { input: "", parts: [] })
      setStore("extmarkToPartIndex", new Map())
      input.clear()
      command.trigger("app.context")
      return true
    }

    const reasoningMatch = trimmed.match(/^\/reasoning(?:\s+(.+))?$/i)
    if (reasoningMatch) {
      const requested = reasoningMatch[1]?.trim().toLowerCase()
      if (!requested) {
        clearInput()
        dialog.replace(() => <DialogReasoning />)
        return true
      }

      const available = local.model.reasoningLevel.list()
      if (requested === "default" || requested === "off") {
        local.model.reasoningLevel.set(undefined)
        toast.show({ variant: "success", message: "已恢复模型默认推理策略", duration: 3000 })
      } else if (!available.includes(requested)) {
        toast.show({
          variant: "error",
          message: `当前模型不支持 ${requested}；可用：${available.join("、")}`,
          duration: 5000,
        })
      } else {
        local.model.reasoningLevel.set(requested)
        toast.show({ variant: "success", message: `推理等级已设为 ${requested}`, duration: 3000 })
      }
      clearInput()
      return true
    }

    const compactCommand = parseCompactCommand(store.prompt.input)
    if (compactCommand.matched) {
      if (compactCommand.error) {
        toast.show({ variant: "error", message: compactCommand.error, duration: 5000 })
        return true
      }
      if (!props.sessionID) {
        toast.show({ variant: "warning", message: "当前还没有可压缩的会话。", duration: 3000 })
        return true
      }
      clearInput()
      void sdk.client.session.summarize({
        sessionID: props.sessionID,
        modelID: selectedModel.modelID,
        providerID: selectedModel.providerID,
        auto: false,
        instructions: compactCommand.instructions,
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        toast.show({
          variant: "error",
          message: ProviderTransform.isBalanceOrQuotaError(message)
            ? ProviderTransform.BALANCE_OR_QUOTA_ERROR_MESSAGE
            : `压缩失败：${message}`,
          duration: 5000,
        })
      })
      return true
    }

    const sessionID = props.sessionID
      ? props.sessionID
      : await (async () => {
          const sessionID = await sdk.client.session.create({}).then((x) => x.data!.id)
          return sessionID
        })()
    const messageID = Identifier.ascending("message")
    let inputText = store.prompt.input

    // /cleanup 不走模型，直接做减法（保留会话/精简产物），toast 展示统计
    const cleanupCommand = parseCleanupCommand(inputText)
    if (cleanupCommand.matched) {
      toast.show({
        variant: "info",
        message: "清理中…",
        duration: 1500,
      })
      try {
        const report = await cleanupAll({
          ...(cleanupCommand.keepTopSessions ? { keepTopSessions: cleanupCommand.keepTopSessions } : {}),
          dryRun: cleanupCommand.dryRun,
        })
        toast.show({
          variant: report.sessionsRemoved + report.childSessionsRemoved > 0 ? "success" : "info",
          message: [
            cleanupCommand.dryRun ? "[dry-run] " : "",
            `会话 ${report.sessionsRemoved + report.childSessionsRemoved} 个`,
            `反思 ${report.reflectionRemoved} 条`,
            `工作流 ${report.workflowsRemoved} 份`,
            `任务 ${report.tasksRemoved} 份`,
            `数据集 ${report.datasetsTrimmed} 个`,
            `释放 ${(report.bytesFreed / 1024 / 1024).toFixed(1)}M`,
          ]
            .filter(Boolean)
            .join(" · "),
          duration: 6000,
        })
      } catch (error) {
        toast.show({
          variant: "error",
          message: `清理失败：${error instanceof Error ? error.message : String(error)}`,
          duration: 5000,
        })
      }
      return true
    }

    // Expand pasted text inline before submitting
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    const sortedExtmarks = allExtmarks.sort((a: { start: number }, b: { start: number }) => b.start - a.start)

    for (const extmark of sortedExtmarks) {
      const partIndex = store.extmarkToPartIndex.get(extmark.id)
      if (partIndex !== undefined) {
        const part = store.prompt.parts[partIndex]
        if (part?.type === "text" && part.text) {
          const before = inputText.slice(0, extmark.start)
          const after = inputText.slice(extmark.end)
          inputText = before + part.text + after
        }
      }
    }

    // Filter out text parts (pasted content) since they're now expanded inline
    const nonTextParts = store.prompt.parts.filter((part) => part.type !== "text")

    // Capture mode before it gets reset
    const currentMode = store.mode
    const variant = local.model.reasoningLevel.current()

    if (store.mode === "shell") {
      void sdk.client.session.shell({
        sessionID,
        agent: agent.name,
        model: {
          providerID: selectedModel.providerID,
          modelID: selectedModel.modelID,
        },
        command: inputText,
      })
      setStore("mode", "normal")
    } else if (
      inputText.startsWith("/") &&
      iife(() => {
        const firstLine = inputText.split("\n")[0]
        const command = firstLine.split(" ")[0].slice(1)
        return sync.data.command.some((x) => x.name === command)
      })
    ) {
      // Parse command from first line, preserve multi-line content in arguments
      const firstLineEnd = inputText.indexOf("\n")
      const firstLine = firstLineEnd === -1 ? inputText : inputText.slice(0, firstLineEnd)
      const [command, ...firstLineArgs] = firstLine.split(" ")
      const commandInfo = sync.data.command.find((item) => item.name === command.slice(1))
      const restOfInput = firstLineEnd === -1 ? "" : inputText.slice(firstLineEnd + 1)
      const args = firstLineArgs.join(" ") + (restOfInput ? "\n" + restOfInput : "")

      void sdk.client.session.command({
        sessionID,
        command: command.slice(1),
        arguments: args,
        agent: agent.name,
        model: `${selectedModel.providerID}/${selectedModel.modelID}`,
        messageID,
        variant,
        queuePriority: delivery === "steer" ? 30 : undefined,
        queueMetadata: {
          delivery,
          source: "tui",
        },
        parts: nonTextParts
          .filter((x) => x.type === "file")
          .map((x) => ({
            id: Identifier.ascending("part"),
            ...x,
          })),
      })
      if (commandInfo?.queueBehavior === "queued" || (!commandInfo?.immediate && commandInfo?.workflowAware)) {
        toast.show({
          variant: "info",
          message: `/${commandInfo.name} 已进入 runtime 队列`,
          duration: 2500,
        })
      }
    } else {
      void sdk.client.session
        .prompt({
          sessionID,
          ...selectedModel,
          messageID,
          agent: agent.name,
          model: selectedModel,
          variant,
          queuePriority: delivery === "steer" ? 30 : undefined,
          queueActionType: "prompt",
          queueMetadata: {
            delivery,
            source: "tui",
          },
          parts: [
            {
              id: Identifier.ascending("part"),
              type: "text",
              text: inputText,
            },
            ...nonTextParts.map((x) => ({
              id: Identifier.ascending("part"),
              ...x,
            })),
          ],
        })
        .catch(() => {})
    }
    if (running() && delivery === "queued") {
      toast.show({
        variant: "info",
        message: queue().pending > 0 ? `已排队（前方 ${queue().pending} 条）` : "已排队，当前任务完成后执行",
        duration: 2500,
      })
    } else if (running() && delivery === "steer") {
      toast.show({
        variant: "success",
        message: "已发送引导，当前任务完成后优先处理",
        duration: 2500,
      })
    }
    history.append({
      ...store.prompt,
      mode: currentMode,
    })
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
    props.onSubmit?.()

    // temporary hack to make sure the message is sent
    if (!props.sessionID)
      setTimeout(() => {
        route.navigate({
          type: "session",
          sessionID,
        })
      }, 50)
    input.clear()
    return true
  }
  const exit = useExit()

  // 选中数据文件后，输入框里显示一枚完整底色的附件标签，
  // 真正发给模型的是完整路径 —— 由 pasteText 的 virtual/real 映射负责。
  //
  // 关键：这里传的是**路径**而不是文件内容。图片走的 pasteAttachment 会把 base64 正文
  // 塞进消息，对一份几 MB 的 Excel 那样做会当场撑爆上下文窗口。数据文件的正文只能由
  // data_import 工具去读，模型永远只该看到路径。
  function insertDataFilePath(filePath: string) {
    const needsSpace = input.plainText.length > 0 && !input.plainText.endsWith(" ")
    if (needsSpace) input.insertText(" ")
    pasteText(filePath, dataFileLabel(path.basename(filePath)), { styleId: fileStyleId, kind: "datafile" })
    input.focus()
  }

  // macOS/Windows 有真正的系统级文件选择对话框（见 native-file-picker.ts）。
  // 只在当前平台/环境没有可用脚本宿主时才回退到内置的 TUI 目录浏览器；
  // 用户主动取消原生对话框后不再弹回退窗口，否则会让人困惑"点了取消怎么又跳一个"。
  async function openDataFilePicker() {
    const result = await NativeFilePicker.pick()
    if (!result.available) {
      dialog.replace(() => <DialogDataFile onPick={insertDataFilePath} />)
      return
    }
    if (result.path) insertDataFilePath(result.path)
  }

  function pasteText(text: string, virtualText: string, opts?: { styleId?: number; kind?: "datafile" }) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + virtualText.length

    input.insertText(virtualText + " ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: opts?.styleId ?? pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push({
          type: "text" as const,
          text,
          source: {
            text: {
              start: extmarkStart,
              end: extmarkEnd,
              value: virtualText,
              kind: opts?.kind,
            },
          },
        })
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
  }

  async function pasteAttachment(file: { filename?: string; filepath?: string; content: string; mime: string }) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const count = store.prompt.parts.filter((x) => {
      if (x.type !== "file") return false
      if (file.mime === "application/pdf") return x.mime === "application/pdf"
      return x.mime.startsWith("image/")
    }).length
    const virtualText = attachmentLabel({ mime: file.mime, count })
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

    input.insertText(textToInsert)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    const part: Omit<FilePart, "id" | "messageID" | "sessionID"> = {
      type: "file" as const,
      mime: file.mime,
      filename: file.filename,
      url: `data:${file.mime};base64,${file.content}`,
      source: {
        type: "file",
        path: file.filepath ?? file.filename ?? "",
        text: {
          start: extmarkStart,
          end: extmarkEnd,
          value: virtualText,
        },
      },
    }
    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push(part)
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
    return
  }

  return (
    <>
      <Autocomplete
        sessionID={props.sessionID}
        ref={(r) => (autocomplete = r)}
        anchor={() => anchor}
        input={() => input}
        onSubmit={() => {
          void submit()
        }}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(partIndex, extmarkId) => {
          setStore("extmarkToPartIndex", (map: Map<number, number>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, partIndex)
            return newMap
          })
        }}
        value={store.prompt.input}
        fileStyleId={fileStyleId}
        agentStyleId={agentStyleId}
        promptPartTypeId={() => promptPartTypeId}
      />
      <box ref={(r) => (anchor = r)} visible={props.visible !== false} width="100%">
        <box
          border={["left"]}
          borderColor={theme.borderSubtle}
          customBorderChars={{
            ...EmptyBorder,
            vertical: "│",
            bottomLeft: "│",
          }}
        >
          <box
            paddingLeft={1}
            paddingRight={1}
            flexShrink={0}
            backgroundColor={theme.background}
            flexGrow={1}
            minWidth={0}
          >
            <box flexDirection="row" gap={1} alignItems="center" width="100%" minWidth={0}>
              {/* 数据文件入口：macOS/Windows 优先唤起系统级文件选择对话框（见
                  native-file-picker.ts），没有可用脚本宿主时回退到内置目录浏览器。
                  半角字符 + 左右各 1 格 padding，总宽 3 列 × 1 行高，与右侧发送按钮
                  完全同尺寸；前景用 theme.secondary——killstata.json 里唯一真正的蓝色
                  （#93C5FD），markdownLink/primary/accent 在这套主题里实际都是青色。 */}
              <box
                flexShrink={0}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={theme.backgroundElement}
                onMouseDown={() => void openDataFilePicker()}
              >
                {/* 用普通 +（U+002B）而不是制表符十字 ┼/╋：制表符字形是为"与相邻格子
                    拼成连续线"设计的，横竖都必须顶到格子边缘，所以竖线和横线一样长；
                    而数学加号的字形本来就是竖笔短于横笔、不顶上下边缘，正是这里要的比例。
                    刻意不加 BOLD，保持细笔画。字符的横竖比例由字体字形决定，代码无法
                    单独拉伸某一笔，只能靠选对字符。 */}
                <text fg={theme.secondary}>+</text>
              </box>
              {/* 斜杠命令入口标志：点击（或按 command_list 快捷键）打开命令面板。
                  与「┼」保持同一尺寸和同一笔画粗细——同样不加 BOLD，否则会比左边的
                  细十字明显粗一圈，两个图标看起来不是一套。 */}
              <box
                flexShrink={0}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={theme.backgroundElement}
                onMouseDown={() => command.show()}
              >
                <text fg={theme.secondary}>/</text>
              </box>
              {/* 执行模式切换：Auto（自由决策调工具） vs Plan（只读文件+列计划，不能写/执行） */}
              <box
                flexShrink={0}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={local.executionMode.current() === "auto" ? theme.primary : theme.warning}
                onMouseDown={() => {
                  const next = local.executionMode.toggle()
                  toast.show({ message: `已切换到 ${next === "auto" ? "Auto 自由执行" : "Plan 只读规划"} 模式`, variant: "info", duration: 2000 })
                }}
              >
                <text fg={theme.background} attributes={TextAttributes.BOLD}>{local.executionMode.current() === "auto" ? "Auto ⇥" : "Plan ⇥"}</text>
              </box>
              <textarea
                placeholder={
                  props.showPlaceholder === false
                    ? undefined
                    : store.mode === "shell"
                      ? shell()[store.placeholder % shell().length]
                      : props.sessionID
                        ? undefined
                        : list()[store.placeholder % list().length]
                }
                textColor={keybind.leader ? theme.textMuted : theme.text}
                focusedTextColor={keybind.leader ? theme.textMuted : theme.text}
                minHeight={1}
                maxHeight={6}
                onContentChange={() => {
                  const value = input.plainText
                  setStore("prompt", "input", value)
                  autocomplete.onInput(value)
                  syncExtmarksWithPromptParts()
                }}
                keyBindings={textareaKeybindings()}
                onKeyDown={async (e) => {
                  if (props.disabled) {
                    e.preventDefault()
                    return
                  }
                  // Handle clipboard paste (Ctrl+V) - check for images first on Windows
                  // This is needed because Windows terminal doesn't properly send image data
                  // through bracketed paste, so we need to intercept the keypress and
                  // directly read from clipboard before the terminal handles it
                  if (keybind.match("input_paste", e)) {
                    const content = await Clipboard.read()
                    if (content?.mime.startsWith("image/")) {
                      e.preventDefault()
                      await pasteAttachment({
                        filename: "clipboard",
                        mime: content.mime,
                        content: content.data,
                      })
                      return
                    }
                    // If no image, let the default paste behavior continue
                  }
                  if (keybind.match("data_file_picker", e)) {
                    void openDataFilePicker()
                    return
                  }
                  if (keybind.match("input_clear", e) && store.prompt.input !== "") {
                    input.clear()
                    input.extmarks.clear()
                    setStore("prompt", {
                      input: "",
                      parts: [],
                    })
                    setStore("extmarkToPartIndex", new Map())
                    return
                  }
                  if (keybind.match("app_exit", e)) {
                    if (store.prompt.input === "") {
                      await exit()
                      // Don't preventDefault - let textarea potentially handle the event
                      e.preventDefault()
                      return
                    }
                  }
                  if (e.name === "!" && input.visualCursor.offset === 0) {
                    setStore("placeholder", Math.floor(Math.random() * shell().length))
                    setStore("mode", "shell")
                    e.preventDefault()
                    return
                  }
                  if (store.mode === "shell") {
                    if ((e.name === "backspace" && input.visualCursor.offset === 0) || e.name === "escape") {
                      setStore("mode", "normal")
                      e.preventDefault()
                      return
                    }
                  }
                  // Tab 快捷切换 Auto/Plan：仅在补全面板未打开时生效，
                  // 补全可见时 Tab 仍归自动补全（接受候选）。
                  if (e.name === "tab" && store.mode === "normal" && !autocomplete.visible) {
                    e.preventDefault()
                    const next = local.executionMode.toggle()
                    toast.show({
                      message: `已切换到 ${next === "auto" ? "Auto 自由执行" : "Plan 只读规划"} 模式`,
                      variant: "info",
                      duration: 2000,
                    })
                    return
                  }
                  if (store.mode === "normal") autocomplete.onKeyDown(e)
                  if (!autocomplete.visible) {
                    if (
                      (keybind.match("history_previous", e) && input.cursorOffset === 0) ||
                      (keybind.match("history_next", e) && input.cursorOffset === input.plainText.length)
                    ) {
                      const direction = keybind.match("history_previous", e) ? -1 : 1
                      const item = history.move(direction, input.plainText)

                      if (item) {
                        input.setText(item.input)
                        setStore("prompt", item)
                        setStore("mode", item.mode ?? "normal")
                        restoreExtmarksFromParts(item.parts)
                        e.preventDefault()
                        if (direction === -1) input.cursorOffset = 0
                        if (direction === 1) input.cursorOffset = input.plainText.length
                      }
                      return
                    }

                    if (keybind.match("history_previous", e) && input.visualCursor.visualRow === 0)
                      input.cursorOffset = 0
                    if (keybind.match("history_next", e) && input.visualCursor.visualRow === input.height - 1)
                      input.cursorOffset = input.plainText.length
                  }
                }}
                onSubmit={() => {
                  setTimeout(() => setTimeout(() => void submit(), 0), 0)
                }}
                onPaste={async (event: PasteEvent) => {
                  if (props.disabled) {
                    event.preventDefault()
                    return
                  }

                  const normalizedText = normalizePastedText(event as PasteEvent & { bytes?: Uint8Array })
                  const pastedContent = normalizedText.trim()
                  if (!pastedContent) {
                    command.trigger("prompt.paste")
                    return
                  }
                  event.preventDefault()

                  const filepath = resolvePastedFilePath(pastedContent)
                  const isUrl = /^(https?):\/\//.test(filepath)
                  if (!isUrl) {
                    try {
                      const file = Bun.file(filepath)
                      const filename = filepath.split(/[\\/]/).at(-1) ?? file.name
                      const lower = filepath.toLowerCase()
                      const mime =
                        file.type ||
                        (lower.endsWith(".pdf") ? "application/pdf" : lower.endsWith(".svg") ? "image/svg+xml" : "")
                      // Handle SVG as raw text content, not as base64 image
                      if (mime === "image/svg+xml") {
                        const content = await file.text().catch(() => {})
                        if (content) {
                          pasteText(content, `[SVG: ${filename ?? "image"}]`)
                          return
                        }
                      }
                      if (mime.startsWith("image/") || mime === "application/pdf") {
                        const content = await file
                          .arrayBuffer()
                          .then((buffer) => Buffer.from(buffer).toString("base64"))
                          .catch(() => {})
                        if (content) {
                          await pasteAttachment({
                            filename,
                            filepath,
                            mime,
                            content,
                          })
                          return
                        }
                      }
                    } catch {}
                  }

                  if (shouldSummarizePaste(pastedContent, sync.data.config.experimental?.disable_paste_summary)) {
                    pasteText(pastedContent, pastedTextLabel(pastedContent))
                    return
                  }

                  input.insertText(normalizedText)

                  // Force layout update and render for the pasted content
                  setTimeout(() => {
                    if (!input || input.isDestroyed) return
                    input.getLayoutNode().markDirty()
                    renderer.requestRender()
                  }, 0)
                }}
                ref={(r: TextareaRenderable) => {
                  input = r
                  if (promptPartTypeId === 0) {
                    promptPartTypeId = input.extmarks.registerType("prompt-part")
                  }
                  props.ref?.(ref)
                  setTimeout(() => {
                    if (!input || input.isDestroyed) return
                    input.cursorColor = theme.text
                  }, 0)
                }}
                onMouseDown={(r: MouseEvent) => r.target?.focus()}
                focusedBackgroundColor={theme.background}
                cursorColor={theme.text}
                cursorStyle={{ style: "line", blinking: true }}
                syntaxStyle={syntax()}
                flexGrow={1}
                flexShrink={1}
                minWidth={0}
              />
              <Show when={hasRightContent()}>
                <box
                  flexDirection="row"
                  flexShrink={0}
                  gap={1}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={theme.backgroundElement}
                  onMouseDown={() => props.onRightMouseDown?.()}
                >
                  <text fg={theme.textMuted}>{props.right} ›</text>
                </box>
              </Show>
              <Show when={running()}>
                <text flexShrink={0} fg={theme.textMuted} onMouseDown={() => void submit("steer")}>
                  ⚡ 引导
                </text>
              </Show>
              {/* 发送/停止：单行高 + 左右各 1 格。终端字符格是宽 1:高 2，所以 3 列宽 ×
                  1 行高在视觉上最接近正方形；一旦加垂直 padding 就会把整个输入行撑成
                  3 行，按钮反而变成一根比输入框还高的竖条，与左侧 + / 图标完全脱节。 */}
              <Show
                when={running() && Boolean(props.sessionID)}
                fallback={
                  <box
                    flexShrink={0}
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={theme.primary}
                    onMouseDown={() => void submit("queued")}
                  >
                    <text fg={theme.background} attributes={TextAttributes.BOLD}>
                      ↑
                    </text>
                  </box>
                }
              >
                <box
                  flexShrink={0}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={theme.error}
                  onMouseDown={() => {
                    const sid = props.sessionID
                    if (sid) sdk.client.session.abort({ sessionID: sid }).catch(() => {})
                  }}
                >
                  <text fg={theme.background} attributes={TextAttributes.BOLD}>
                    ■
                  </text>
                </box>
              </Show>
            </box>
          </box>
        </box>
        {/* 网络重连提示已移到对话流末尾的 RetryNotice；这里只保留可选的 hint 透传。 */}
        <Show when={props.hint}>
          <box flexDirection="row">{props.hint}</box>
        </Show>
      </box>
    </>
  )
}
