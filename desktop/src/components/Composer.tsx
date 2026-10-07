/**
 * 底部输入区（Codex 风格）：
 * 附件按钮（最左）→ 多行输入框（自动增高）→ 发送按钮（最右）。
 * 输入以 `/` 开头时显示斜杠命令面板（本地命令 + 引擎命令目录），支持 ↑↓ 选择、Enter 执行。
 */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Icon } from "./Icon"

export type SlashCommand = {
  name: string
  description: string
  hints?: string[]
  /** 本地动作直接执行；引擎命令仅回填，仍需研究者明确发送。 */
  source: "local" | "engine"
}

/**
 * 会话策略展示与切换。Composer 只渲染与回调，档位语义和规则集由调用方持有，
 * 真正的授权判定始终在引擎侧执行。
 */
export type SessionPolicyControl = {
  permissionMode: string
  permissionLabel: string
  permissionDescription: string
  /** Core session 建立后权限规则不可原地改写；新研究可重新选择。 */
  permissionLocked?: boolean
  permissionOptions: ReadonlyArray<{ id: string; label: string; description: string }>
  onPermissionChange: (mode: string) => void
  model: string
  modelName: string
  modelOptions: ReadonlyArray<{ id: string; label: string }>
  onModelChange: (model: string) => void
  effort: string
  effortLabel: string
  effortOptions: ReadonlyArray<{ id: string; label: string }>
  onEffortChange: (effort: string) => void
}

type ComposerProps = {
  prompt: string
  onPromptChange: (value: string) => void
  /** 由 App 持有焦点，供新研究、重述问题等本地动作回到输入框。 */
  inputRef?: (element: HTMLTextAreaElement) => void
  /** 已选择的数据附件；无附件时展示占位提示。 */
  attachmentName?: string
  workbookSheets: string[]
  selectedSheet?: string
  onSelectSheet: (sheet: string) => void
  /** 触发原生文件选择（App 持有隐藏 input 并读取）。 */
  onSelectFile: () => void
  onSend: () => void
  /** 分析进行中时点击发送位（此时按钮为停止图标）：取消当前 run。 */
  onStop?: () => void
  onClearAttachment: () => void
  commands: SlashCommand[]
  onCommand: (name: string) => void
  /** 已选工作区只作为用户明确点名文件时的原生选择起点，不显示目录清单。 */
  workspaceName?: string
  onSelectWorkspace?: () => void
  onSelectWorkspaceFile?: () => Promise<File | undefined>
  /** 文本非空即可发送；附件可选（纯研究对话不需要数据）。 */
  canSend: boolean
  /** 分析进行中（停止发送并禁用输入）。 */
  running: boolean
  disabled?: boolean
  /** 仅 connected 模式提供；缺省时不渲染策略栏。 */
  sessionPolicy?: SessionPolicyControl
}

export function Composer(props: ComposerProps) {
  const [slashOpen, setSlashOpen] = createSignal(false)
  const [highlighted, setHighlighted] = createSignal(0)
  const [openPolicyMenu, setOpenPolicyMenu] = createSignal<"permission" | "model" | "effort">()
  let input: HTMLTextAreaElement | undefined
  let policyRoot: HTMLDivElement | undefined

  const togglePolicyMenu = (menu: "permission" | "model" | "effort") => {
    setOpenPolicyMenu((current) => (current === menu ? undefined : menu))
  }

  // 策略菜单是浮层：点到别处或按 Esc 都应收起，避免遮住输入区。
  onMount(() => {
    const closeOnOutside = (event: MouseEvent) => {
      if (!openPolicyMenu()) return
      if (policyRoot && event.target instanceof Node && policyRoot.contains(event.target)) return
      setOpenPolicyMenu(undefined)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && openPolicyMenu()) setOpenPolicyMenu(undefined)
    }
    document.addEventListener("mousedown", closeOnOutside)
    document.addEventListener("keydown", closeOnEscape)
    onCleanup(() => {
      document.removeEventListener("mousedown", closeOnOutside)
      document.removeEventListener("keydown", closeOnEscape)
    })
  })

  const isSlashInput = () => props.prompt.trimStart().startsWith("/")
  const slashQuery = () => props.prompt.trimStart().slice(1)
  const hasSlashArguments = () => /\s/.test(slashQuery())
  const isWorkspaceReferenceInput = () => /(?:^|\s)@[^\s]*$/.test(props.prompt)

  // 已有附件时不再提示 @（附件已可见，无需重复教学）；未选工作区时不提示 @ 用法。
  const placeholder = () => {
    if (props.running) return "分析进行中…"
    if (props.attachmentName) return "描述研究问题…"
    if (props.workspaceName) return "描述研究问题…（@ 从工作区选择文件）"
    return "描述研究问题…（可 / 选命令、@ 引用工作区文件）"
  }

  const resize = () => {
    if (!input) return
    input.style.height = "auto"
    input.style.height = `${Math.min(input.scrollHeight, 236)}px`
    input.style.overflowY = input.scrollHeight > 236 ? "auto" : "hidden"
  }

  createEffect(() => {
    // starter、/new 与研究切换会从外部更新 prompt，需同样重算输入框高度。
    props.prompt
    queueMicrotask(resize)
  })

  const visibleCommands = createMemo<SlashCommand[]>(() => {
    if (!isSlashInput() || hasSlashArguments()) return []
    const query = slashQuery().toLocaleLowerCase()
    const filtered = props.commands.filter((command) => (
      command.name.toLocaleLowerCase().includes(query) || command.description.toLocaleLowerCase().includes(query)
    ))
    return filtered.length ? filtered : props.commands
  })

  const applyCommand = (command: SlashCommand) => {
    if (command.source === "local") {
      props.onCommand(command.name)
      props.onPromptChange("")
    } else {
      props.onPromptChange(`/${command.name} `)
    }
    setSlashOpen(false)
    input?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    // 中文输入法提交候选词时的 Enter 不能被命令面板或发送动作消费。
    if (event.isComposing || event.keyCode === 229) return
    if (slashOpen() && visibleCommands().length) {
      const commands = visibleCommands()
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setHighlighted((index) => (index + 1) % commands.length)
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setHighlighted((index) => (index - 1 + commands.length) % commands.length)
        return
      }
      if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        applyCommand(commands[highlighted()] ?? commands[0]!)
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        setSlashOpen(false)
        return
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !slashOpen()) {
      // Enter 发送；Shift+Enter 保留 textarea 默认行为换行。
      event.preventDefault()
      props.onSend()
      return
    }
  }

  const handleInput = (value: string) => {
    props.onPromptChange(value)
    const query = value.trimStart().slice(1)
    setSlashOpen(value.trimStart().startsWith("/") && !/\s/.test(query))
    setHighlighted(0)
    resize()
  }

  const selectWorkspaceFile = async () => {
    const file = await props.onSelectWorkspaceFile?.()
    const reference = props.prompt.match(/@[^\s]*$/)
    if (!file || !reference?.[0] || reference.index === undefined) return
    const filename = file.name.replace(/[\\/]/g, "").trim()
    if (!filename) return
    const before = props.prompt.slice(0, reference.index)
    const after = props.prompt.slice(reference.index + reference[0].length)
    props.onPromptChange(`${before}@${filename} ${after}`)
    input?.focus()
  }

  onMount(() => {
    input?.focus()
  })

  return (
    <div class="composer-wrap">
      <Show when={isWorkspaceReferenceInput()}>
        <div class="slash-panel workspace-reference-panel" role="group" aria-label="工作区文件引用">
          <Show
            when={props.workspaceName && props.onSelectWorkspaceFile}
            fallback={
              <Show
                when={props.onSelectWorkspace}
                fallback={<p class="workspace-reference-hint">请先选择本地工作区。</p>}
              >
                <button type="button" class="slash-command" onClick={props.onSelectWorkspace}>
                  <span class="slash-name">选择本地工作区</span>
                  <span class="slash-description">先选文件夹，再点名其中一个文件</span>
                </button>
              </Show>
            }
          >
            <button type="button" class="slash-command" aria-label="从工作区选择文件" onClick={() => void selectWorkspaceFile()}>
              <span class="slash-name">@ 选择工作区文件</span>
              <span class="slash-description">只读取你在系统对话框中明确选择的一个文件</span>
            </button>
          </Show>
        </div>
      </Show>
      <Show when={slashOpen() && visibleCommands().length}>
        <div class="slash-panel" role="listbox" aria-label="斜杠命令">
          <For each={visibleCommands()}>
            {(command, index) => (
              <button
                type="button"
                class="slash-command"
                classList={{ "is-highlighted": index() === highlighted() }}
                role="option"
                aria-selected={index() === highlighted()}
                onClick={() => applyCommand(command)}
              >
                  <span class="slash-name">/{command.name}</span>
                  <span class="slash-description">
                    {command.description}
                    <Show when={command.hints?.length}>
                      <span class="slash-hints"> · {command.hints!.join(" ")}</span>
                    </Show>
                  </span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class="composer" classList={{ "is-disabled": props.disabled }}>
        <div class="composer-main">
        <div class="composer-actions" role="group" aria-label="输入操作">
          <Show
            when={props.attachmentName}
            fallback={
              <button
                type="button"
                class="composer-attach"
                aria-label="选择数据文件"
                title="选择数据文件"
                onClick={props.onSelectFile}
                disabled={props.running || props.disabled}
              >
                <Icon name="paperclip" size={16} />
              </button>
            }
          >
            <div class="attachment-chip" role="status" aria-label="已选择数据文件">
              <Icon name="paperclip" size={13} class="attachment-icon" />
              <span class="attachment-name">{props.attachmentName}</span>
              <Show when={props.workbookSheets.length > 1}>
                <select
                  class="attachment-sheet"
                  aria-label="选择工作表"
                  value={props.selectedSheet ?? props.workbookSheets[0]}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => props.onSelectSheet(event.currentTarget.value)}
                >
                  <For each={props.workbookSheets}>
                    {(sheet) => <option value={sheet}>{sheet}</option>}
                  </For>
                </select>
              </Show>
              <button
                type="button"
                class="attachment-remove"
                aria-label="移除数据文件"
                onClick={props.onClearAttachment}
                disabled={props.running}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          </Show>
        </div>
        <textarea
          ref={(element) => {
            input = element
            props.inputRef?.(element)
          }}
          class="composer-input"
          aria-label="研究问题"
          placeholder={placeholder()}
          value={props.prompt}
          rows={1}
          disabled={props.running || props.disabled}
          onInput={(event) => handleInput(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <Show
          when={props.running}
          fallback={
            <button
              type="button"
              class="composer-send"
              aria-label="发送"
              disabled={!props.canSend || props.disabled}
              onClick={props.onSend}
            >
              <Icon name="arrow-up" size={17} />
            </button>
          }
        >
          {/* 运行中：同一按钮位切换为停止键，点击取消当前 run。
              停止键必须始终可点——不受 props.disabled（运行期禁用输入）影响。 */}
          <button
            type="button"
            class="composer-send is-stop"
            aria-label="停止分析"
            disabled={props.onStop === undefined}
            onClick={() => props.onStop?.()}
          >
            <Icon name="stop" size={17} />
          </button>
        </Show>
        </div>
      <Show when={props.sessionPolicy}>
        <div
          ref={(element) => { policyRoot = element }}
          class="composer-policy"
          role="group"
          aria-label="会话策略"
        >
          <div class="composer-policy-slot">
            <button
              type="button"
              class="policy-chip"
              aria-label={`工具授权：${props.sessionPolicy!.permissionLabel}`}
              aria-expanded={openPolicyMenu() === "permission"}
              aria-haspopup="listbox"
              title={props.sessionPolicy!.permissionLocked
                ? `当前研究已使用此授权档位。开始新对话后可重新选择。${props.sessionPolicy!.permissionDescription}`
                : props.sessionPolicy!.permissionDescription}
              disabled={props.running || props.sessionPolicy!.permissionLocked}
              onClick={() => togglePolicyMenu("permission")}
            >
              <Icon name="shield" size={14} />
              <span>{props.sessionPolicy!.permissionLabel}</span>
              <Icon name="chevron-down" size={12} class="policy-chip-caret" />
            </button>
            <Show when={openPolicyMenu() === "permission"}>
              <div class="policy-menu" role="listbox" aria-label="选择工具授权">
                <For each={props.sessionPolicy!.permissionOptions}>
                  {(option) => (
                    <button
                      type="button"
                      class="policy-option"
                      classList={{ "is-active": option.id === props.sessionPolicy!.permissionMode }}
                      role="option"
                      aria-selected={option.id === props.sessionPolicy!.permissionMode}
                      onClick={() => {
                        props.sessionPolicy!.onPermissionChange(option.id)
                        setOpenPolicyMenu(undefined)
                      }}
                    >
                      <span class="policy-option-label">{option.label}</span>
                      <span class="policy-option-description">{option.description}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <div class="composer-policy-slot">
            <button
              type="button"
              class="policy-chip is-quiet"
              aria-label={`模型 ${props.sessionPolicy!.modelName}`}
              aria-expanded={openPolicyMenu() === "model"}
              aria-haspopup="listbox"
              disabled={props.running}
              onClick={() => togglePolicyMenu("model")}
            >
              <span class="policy-chip-model">{props.sessionPolicy!.modelName}</span>
              <Icon name="chevron-down" size={12} class="policy-chip-caret" />
            </button>
            <Show when={openPolicyMenu() === "model"}>
              <div class="policy-menu" role="listbox" aria-label="选择模型">
                <For each={props.sessionPolicy!.modelOptions}>
                  {(option) => (
                    <button
                      type="button"
                      class="policy-option is-compact"
                      classList={{ "is-active": option.id === props.sessionPolicy!.model }}
                      role="option"
                      aria-selected={option.id === props.sessionPolicy!.model}
                      onClick={() => {
                        props.sessionPolicy!.onModelChange(option.id)
                        setOpenPolicyMenu(undefined)
                      }}
                    >
                      <span class="policy-option-label">{option.label}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <div class="composer-policy-slot is-trailing">
            <button
              type="button"
              class="policy-chip is-quiet"
              aria-label={`推理等级 ${props.sessionPolicy!.effortLabel}`}
              aria-expanded={openPolicyMenu() === "effort"}
              aria-haspopup="listbox"
              disabled={props.running}
              onClick={() => togglePolicyMenu("effort")}
            >
              <span class="policy-chip-effort">{props.sessionPolicy!.effortLabel}</span>
              <Icon name="chevron-up" size={12} class="policy-chip-caret" />
            </button>
            <Show when={openPolicyMenu() === "effort"}>
              <div class="policy-menu is-trailing" role="listbox" aria-label="选择推理等级">
                <For each={props.sessionPolicy!.effortOptions}>
                  {(option) => (
                    <button
                      type="button"
                      class="policy-option is-compact"
                      classList={{ "is-active": option.id === props.sessionPolicy!.effort }}
                      role="option"
                      aria-selected={option.id === props.sessionPolicy!.effort}
                      onClick={() => {
                        props.sessionPolicy!.onEffortChange(option.id)
                        setOpenPolicyMenu(undefined)
                      }}
                    >
                      <span class="policy-option-label">{option.label}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>
      </Show>
      </div>
    </div>
  )
}
