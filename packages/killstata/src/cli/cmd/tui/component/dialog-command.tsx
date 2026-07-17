import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption, type DialogSelectRef } from "@tui/ui/dialog-select"
import {
  createContext,
  createMemo,
  createSignal,
  getOwner,
  onCleanup,
  runWithOwner,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { useKeybind } from "@tui/context/keybind"
import type { KeybindsConfig } from "@killstata/sdk/v2"

type Context = ReturnType<typeof init>
const ctx = createContext<Context>()

export type Slash = {
  name: string
  aliases?: string[]
}

export type CommandOption = DialogSelectOption<string> & {
  keybind?: keyof KeybindsConfig
  suggested?: boolean
  slash?: Slash
  hidden?: boolean
  enabled?: boolean
}

function init() {
  const root = getOwner()
  const [registrations, setRegistrations] = createSignal<Accessor<CommandOption[]>[]>([])
  const [suspendCount, setSuspendCount] = createSignal(0)
  const dialog = useDialog()
  const keybind = useKeybind()

  const entries = createMemo(() => {
    const all = registrations().flatMap((x) => x())
    return all.map((x) => ({
      ...x,
      footer: x.keybind ? keybind.print(x.keybind) : undefined,
    }))
  })

  const isEnabled = (option: CommandOption) => option.enabled !== false
  const isVisible = (option: CommandOption) => isEnabled(option) && !option.hidden

  const visibleOptions = createMemo(() => entries().filter((option) => isVisible(option)))
  const suggestedOptions = createMemo(() =>
    visibleOptions()
      .filter((option) => option.suggested)
      .map((option) => ({
        ...option,
        value: `suggested:${option.value}`,
        category: "推荐",
      })),
  )
  const suspended = () => suspendCount() > 0

  useKeyboard((evt) => {
    if (suspended()) return
    if (dialog.stack.length > 0) return
    for (const option of entries()) {
      if (!isEnabled(option)) continue
      if (option.keybind && keybind.match(option.keybind, evt)) {
        evt.preventDefault()
        option.onSelect?.(dialog)
        return
      }
    }
  })

  const result = {
    trigger(name: string) {
      for (const option of entries()) {
        if (option.value === name) {
          if (!isEnabled(option)) return
          option.onSelect?.(dialog)
          return
        }
      }
    },
    slashes() {
      return visibleOptions().flatMap((option) => {
        const slash = option.slash
        if (!slash) return []
        return {
          display: "/" + slash.name,
          description: option.description ?? option.title,
          aliases: slash.aliases?.map((alias) => "/" + alias),
          onSelect: () => result.trigger(option.value),
        }
      })
    },
    keybinds(enabled: boolean) {
      setSuspendCount((count) => count + (enabled ? -1 : 1))
    },
    suspended,
    show() {
      dialog.replace(() => <DialogCommand options={visibleOptions()} suggestedOptions={suggestedOptions()} />)
    },
    register(cb: () => CommandOption[]) {
      const owner = getOwner() ?? root
      if (!owner) return () => {}

      let results: Accessor<CommandOption[]> | undefined
      runWithOwner(owner, () => {
        results = createMemo(cb)
        const ref = results
        if (!ref) return
        setRegistrations((arr) => [ref, ...arr])
        onCleanup(() => {
          setRegistrations((arr) => arr.filter((x) => x !== ref))
        })
      })
      if (!results) return () => {}
      let done = false
      return () => {
        if (done) return
        done = true
        const ref = results
        if (!ref) return
        setRegistrations((arr) => arr.filter((x) => x !== ref))
      }
    },
  }
  return result
}

export function useCommandDialog() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useCommandDialog must be used within a CommandProvider")
  }
  return value
}

export function CommandProvider(props: ParentProps) {
  const value = init()
  const dialog = useDialog()
  const keybind = useKeybind()

  useKeyboard((evt) => {
    if (value.suspended()) return
    if (dialog.stack.length > 0) return
    if (evt.defaultPrevented) return
    if (keybind.match("command_list", evt)) {
      evt.preventDefault()
      value.show()
      return
    }
  })

  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

function DialogCommand(props: { options: CommandOption[]; suggestedOptions: CommandOption[] }) {
  let ref: DialogSelectRef<string>
  const format = (options: CommandOption[]) =>
    options
      // Ctrl+P is a user command palette, not a list of invisible keyboard
      // shortcuts. Every visible entry therefore has a slash form.
      .filter((option) => option.slash)
      .map((option) => ({
        ...option,
        title: `/${option.slash!.name}`,
        // DialogSelect renders footer at the far right. Put the human-facing
        // Chinese explanation there and keep the command itself on the left.
        description: undefined,
        footer: chineseDescription(option),
        category: chineseCategory(option.category),
      }))
  const list = () => {
    if (ref?.filter) return format(props.options)
    return format([...props.suggestedOptions, ...props.options])
  }
  return <DialogSelect ref={(r) => (ref = r)} title="命令" placeholder="搜索命令" options={list()} />
}

function chineseCategory(category?: string) {
  return ({ Session: "会话", Agent: "模型", System: "系统", Input: "输入" } as Record<string, string>)[category ?? ""] ?? category
}

function chineseDescription(option: CommandOption) {
  if (option.description && /[\u4e00-\u9fff]/.test(option.description)) return option.description
  const slash = option.slash?.name
  const labels: Record<string, string> = {
    sessions: "切换或恢复会话",
    new: "开始一段新对话",
    model: "选择当前使用的模型",
    config: "设置模型与 API Key",
    help: "查看使用帮助",
    exit: "退出 KillStata",
    editor: "在编辑器中编写长消息",
    themes: "切换界面主题",
    rename: "修改当前会话标题",
    timeline: "跳转到指定消息",
    compact: "整理较长的会话内容",
    undo: "撤销上一条提问",
    redo: "恢复已撤销的提问",
    timestamps: "显示或隐藏消息时间",
    thinking: "显示或隐藏分析过程",
    details: "查看处理过程的技术详情",
    copy: "复制当前会话内容",
    export: "导出当前会话记录",
  }
  return labels[slash ?? ""] ?? option.title
}
