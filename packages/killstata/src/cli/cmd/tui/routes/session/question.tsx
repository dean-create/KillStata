import { createStore } from "solid-js/store"
import { createMemo, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { useKeybind } from "../../context/keybind"
import { tint, useTheme } from "../../context/theme"
import type { QuestionAnswer, QuestionRequest } from "@killstata/sdk/v2"
import { useSDK } from "../../context/sdk"
import { SplitBorder } from "../../component/border"
import { useTextareaKeybindings } from "../../component/textarea-keybindings"
import { useDialog } from "../../ui/dialog"

export function QuestionPrompt(props: { request: QuestionRequest }) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const bindings = useTextareaKeybindings()

  const questions = createMemo(() => props.request.questions)
  const single = createMemo(() => questions().length === 1 && questions()[0]?.multiple !== true)
  const tabs = createMemo(() => (single() ? 1 : questions().length + 1)) // questions + confirm tab (no confirm for single select)
  const [store, setStore] = createStore({
    tab: 0,
    answers: [] as QuestionAnswer[],
    custom: [] as string[],
    selected: 0,
    editing: false,
  })

  let textarea: TextareaRenderable | undefined

  const question = createMemo(() => questions()[store.tab])
  const confirm = createMemo(() => !single() && store.tab === questions().length)
  const options = createMemo(() => question()?.options ?? [])
  const custom = createMemo(() => question()?.custom !== false)
  const other = createMemo(() => custom() && store.selected === options().length)
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const multi = createMemo(() => question()?.multiple === true)
  const customPicked = createMemo(() => {
    const value = input()
    if (!value) return false
    return store.answers[store.tab]?.includes(value) ?? false
  })

  function submit() {
    const answers = questions().map((_, i) => store.answers[i] ?? [])
    sdk.client.question.reply({
      requestID: props.request.id,
      answers,
    })
  }

  function reject() {
    sdk.client.question.reject({
      requestID: props.request.id,
    })
  }

  function pick(answer: string, custom: boolean = false) {
    const answers = [...store.answers]
    answers[store.tab] = [answer]
    setStore("answers", answers)
    if (custom) {
      const inputs = [...store.custom]
      inputs[store.tab] = answer
      setStore("custom", inputs)
    }
    if (single()) {
      sdk.client.question.reply({
        requestID: props.request.id,
        answers: [[answer]],
      })
      return
    }
    // 最后一个问题选完直接提交，无需再进确认 tab
    const isLastQuestion = store.tab === questions().length - 1
    const isSingleChoice = !multi()
    if (isLastQuestion && isSingleChoice) {
      const finalAnswers = questions().map((_, i) => answers[i] ?? [])
      sdk.client.question.reply({
        requestID: props.request.id,
        answers: finalAnswers,
      })
      return
    }
    setStore("tab", store.tab + 1)
    setStore("selected", 0)
  }

  function toggle(answer: string) {
    const existing = store.answers[store.tab] ?? []
    const next = [...existing]
    const index = next.indexOf(answer)
    if (index === -1) next.push(answer)
    if (index !== -1) next.splice(index, 1)
    const answers = [...store.answers]
    answers[store.tab] = next
    setStore("answers", answers)
  }

  function moveTo(index: number) {
    setStore("selected", index)
  }

  function selectTab(index: number) {
    setStore("tab", index)
    setStore("selected", 0)
  }

  function selectOption() {
    if (other()) {
      if (!multi()) {
        setStore("editing", true)
        return
      }
      const value = input()
      if (value && customPicked()) {
        toggle(value)
        return
      }
      setStore("editing", true)
      return
    }
    const opt = options()[store.selected]
    if (!opt) return
    if (multi()) {
      toggle(opt.label)
      return
    }
    pick(opt.label)
  }

  const dialog = useDialog()

  // A/B/C 快捷键：与数字 1/2/3 等价
  const alphaFor = (i: number) => String.fromCharCode(65 + i)

  useKeyboard((evt) => {
    // Skip processing if a dialog (e.g., command palette) is open
    if (dialog.stack.length > 0) return

    // When editing custom answer textarea
    if (store.editing && !confirm()) {
      if (evt.name === "escape") {
        evt.preventDefault()
        setStore("editing", false)
        return
      }
      if (keybind.match("input_clear", evt)) {
        evt.preventDefault()
        const text = textarea?.plainText ?? ""
        if (!text) {
          setStore("editing", false)
          return
        }
        textarea?.setText("")
        return
      }
      if (evt.name === "return") {
        evt.preventDefault()
        const text = textarea?.plainText?.trim() ?? ""
        const prev = store.custom[store.tab]

        if (!text) {
          if (prev) {
            const inputs = [...store.custom]
            inputs[store.tab] = ""
            setStore("custom", inputs)

            const answers = [...store.answers]
            answers[store.tab] = (answers[store.tab] ?? []).filter((x) => x !== prev)
            setStore("answers", answers)
          }
          setStore("editing", false)
          return
        }

        if (multi()) {
          const inputs = [...store.custom]
          inputs[store.tab] = text
          setStore("custom", inputs)

          const existing = store.answers[store.tab] ?? []
          const next = [...existing]
          if (prev) {
            const index = next.indexOf(prev)
            if (index !== -1) next.splice(index, 1)
          }
          if (!next.includes(text)) next.push(text)
          const answers = [...store.answers]
          answers[store.tab] = next
          setStore("answers", answers)
          setStore("editing", false)
          return
        }

        pick(text, true)
        setStore("editing", false)
        return
      }
      // Let textarea handle all other keys
      return
    }

    if (evt.name === "left" || evt.name === "h") {
      evt.preventDefault()
      selectTab((store.tab - 1 + tabs()) % tabs())
    }

    if (evt.name === "right" || evt.name === "l") {
      evt.preventDefault()
      selectTab((store.tab + 1) % tabs())
    }

    if (evt.name === "tab") {
      evt.preventDefault()
      const direction = evt.shift ? -1 : 1
      selectTab((store.tab + direction + tabs()) % tabs())
    }

    if (confirm()) {
      if (evt.name === "return") {
        evt.preventDefault()
        submit()
      }
      if (evt.name === "escape" || keybind.match("app_exit", evt)) {
        evt.preventDefault()
        reject()
      }
    } else {
      const opts = options()
      const total = opts.length + (custom() ? 1 : 0)
      const max = Math.min(total, 9)
      const digit = Number(evt.name)

      if (!Number.isNaN(digit) && digit >= 1 && digit <= max) {
        evt.preventDefault()
        const index = digit - 1
        moveTo(index)
        selectOption()
        return
      }
      // A/B/C 大写字母快捷键
      if (/^[a-z]$/i.test(evt.name) && evt.name.length === 1) {
        const idx = evt.name.toLowerCase().charCodeAt(0) - 97
        if (idx >= 0 && idx < total) {
          evt.preventDefault()
          moveTo(idx)
          selectOption()
          return
        }
      }

      if (evt.name === "up" || evt.name === "k") {
        evt.preventDefault()
        moveTo((store.selected - 1 + total) % total)
      }

      if (evt.name === "down" || evt.name === "j") {
        evt.preventDefault()
        moveTo((store.selected + 1) % total)
      }

      if (evt.name === "return") {
        evt.preventDefault()
        selectOption()
      }

      if (evt.name === "escape" || keybind.match("app_exit", evt)) {
        evt.preventDefault()
        reject()
      }
    }
  })

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.accent}
      customBorderChars={SplitBorder.customBorderChars}
      width={76}
    >
      <box gap={0} paddingLeft={1} paddingRight={4} paddingTop={1} paddingBottom={1}>
        <Show when={!single()}>
          <box flexDirection="row" gap={1} paddingLeft={0} paddingTop={0} paddingBottom={0}>
            <For each={questions()}>
              {(q, index) => {
                const isActive = () => index() === store.tab
                const isAnswered = () => {
                  return (store.answers[index()]?.length ?? 0) > 0
                }
                return (
                  <box
                    paddingLeft={1}
                    paddingRight={1}
                    paddingTop={0}
                    paddingBottom={0}
                    backgroundColor={
                      isActive()
                        ? theme.accent
                        : isAnswered()
                          ? tint(theme.backgroundElement, theme.success, 0.14)
                          : theme.backgroundElement
                    }
                    border={isActive() ? undefined : isAnswered() ? ["bottom"] : undefined}
                    borderColor={isAnswered() ? theme.success : undefined}
                    onMouseUp={() => selectTab(index())}
                  >
                    <text fg={isActive() ? theme.selectedListItemText : isAnswered() ? theme.success : theme.textMuted}>
                      {isAnswered() ? "✓ " : `${index() + 1} `}{q.header}
                    </text>
                  </box>
                )
              }}
            </For>
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={
                confirm()
                  ? theme.accent
                  : questions().every((_, i) => (store.answers[i]?.length ?? 0) > 0)
                    ? tint(theme.backgroundElement, theme.success, 0.14)
                    : theme.backgroundElement
              }
              border={confirm() ? undefined : questions().every((_, i) => (store.answers[i]?.length ?? 0) > 0) ? ["bottom"] : undefined}
              borderColor={theme.success}
              onMouseUp={() => selectTab(questions().length)}
            >
              <text fg={confirm() ? theme.selectedListItemText : theme.textMuted}>确认</text>
            </box>
          </box>
        </Show>

        <Show when={!confirm()}>
          <box paddingLeft={0} gap={0}>
            <box flexDirection="row" gap={1} alignItems="center" paddingLeft={1}>
              <box
                width={1}
                height={1}
                backgroundColor={theme.accent}
              >
                <text fg={theme.selectedListItemText}>◆</text>
              </box>
              <text fg={theme.text}>
                {question()?.question}
                {multi() ? "（可多选，A/B 切换）" : "（A/B/C 快捷键）"}
              </text>
            </box>
            <box flexDirection="column" gap={0} paddingTop={0}>
              <For each={options()}>
                {(opt, i) => {
                  const active = () => i() === store.selected
                  const picked = () => store.answers[store.tab]?.includes(opt.label) ?? false
                  const letter = () => alphaFor(i())
                  return (
                    <box
                      flexDirection="row"
                      gap={1}
                      paddingLeft={1}
                      paddingRight={1}
                      paddingTop={0}
                      paddingBottom={0}
                      backgroundColor={
                        active()
                          ? tint(theme.backgroundElement, theme.accent, 0.18)
                          : picked()
                            ? tint(theme.backgroundElement, theme.success, 0.10)
                            : undefined
                      }
                      border={active() ? ["left"] : picked() ? ["left"] : undefined}
                      borderColor={active() ? theme.accent : picked() ? theme.success : undefined}
                      onMouseOver={() => moveTo(i())}
                      onMouseUp={() => selectOption()}
                    >
                      <box
                        width={3}
                        height={1}
                        justifyContent="center"
                        alignItems="center"
                        backgroundColor={picked() ? theme.success : active() ? theme.accent : theme.backgroundElement}
                      >
                        <text fg={picked() || active() ? theme.selectedListItemText : theme.textMuted}>{letter()}</text>
                      </box>
                      <box flexDirection="row" flexGrow={1} gap={1} alignItems="center">
                        <text fg={active() ? theme.secondary : picked() ? theme.success : theme.text}>
                          {opt.label}
                        </text>
                        <Show when={picked() && !multi()}>
                          <text fg={theme.success}> ✓</text>
                        </Show>
                        <Show when={multi() && picked()}>
                          <text fg={theme.success}> ✓ 已选</text>
                        </Show>
                      </box>
                    </box>
                  )
                }}
              </For>
              <Show when={custom()}>
                <box
                  flexDirection="row"
                  gap={1}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={
                    other()
                      ? tint(theme.backgroundElement, theme.accent, 0.18)
                      : customPicked()
                        ? tint(theme.backgroundElement, theme.success, 0.10)
                        : undefined
                  }
                  border={other() ? ["left"] : customPicked() ? ["left"] : undefined}
                  borderColor={other() ? theme.accent : customPicked() ? theme.success : undefined}
                  onMouseOver={() => moveTo(options().length)}
                  onMouseUp={() => selectOption()}
                >
                  <box
                    width={3}
                    height={1}
                    justifyContent="center"
                    alignItems="center"
                    backgroundColor={customPicked() ? theme.success : other() ? theme.accent : theme.backgroundElement}
                  >
                    <text fg={customPicked() || other() ? theme.selectedListItemText : theme.textMuted}>{alphaFor(options().length)}</text>
                  </box>
                  <box flexDirection="column" flexGrow={1}>
                    <box flexDirection="row" gap={1} alignItems="center">
                      <text fg={other() ? theme.secondary : customPicked() ? theme.success : theme.text}>
                        自己输入答案
                      </text>
                      <Show when={customPicked()}>
                        <text fg={theme.success}> ✓ 已选</text>
                      </Show>
                    </box>
                    <Show when={!store.editing && input()}>
                      <text fg={theme.textMuted}>{input()}</text>
                    </Show>
                  </box>
                </box>
                <Show when={store.editing}>
                  <box paddingLeft={5} paddingRight={1}>
                    <textarea
                      ref={(val: TextareaRenderable) => {
                        textarea = val
                        queueMicrotask(() => {
                          val.focus()
                          val.gotoLineEnd()
                        })
                      }}
                      initialValue={input()}
                      placeholder="输入自定义答案，回车确认"
                      textColor={theme.text}
                      focusedTextColor={theme.text}
                      cursorColor={theme.primary}
                      keyBindings={bindings()}
                    />
                  </box>
                </Show>
              </Show>
            </box>
          </box>
        </Show>

        <Show when={confirm() && !single()}>
          <box paddingLeft={0} gap={0}>
            <box flexDirection="row" gap={1} alignItems="center" paddingLeft={1}>
              <text fg={theme.success}>✓</text>
              <text fg={theme.text}>确认提交 · 请核对你的选择</text>
            </box>
            <For each={questions()}>
              {(q, index) => {
                const value = () => store.answers[index()]?.join(", ") ?? ""
                const answered = () => Boolean(value())
                return (
                  <box flexDirection="row" gap={1} paddingLeft={1}>
                    <text fg={answered() ? theme.success : theme.warning}>{answered() ? "●" : "○"}</text>
                    <text>
                      <span style={{ fg: theme.textMuted }}>{q.header}：</span>{" "}
                      <span style={{ fg: answered() ? theme.text : theme.error }}>
                        {answered() ? value() : "（未回答）"}
                      </span>
                    </text>
                  </box>
                )
              }}
            </For>
          </box>
        </Show>
      </box>
      <box
        flexDirection="row"
        flexShrink={0}
        gap={1}
        paddingLeft={1}
        paddingRight={2}
        paddingBottom={0}
        paddingTop={0}
        justifyContent="space-between"
      >
        <box flexDirection="row" gap={2}>
          <Show when={!single()}>
            <text fg={theme.text}>
              {"⇆"} <span style={{ fg: theme.textMuted }}>切换</span>
            </text>
          </Show>
          <Show when={!confirm()}>
            <text fg={theme.text}>
              {"↑↓"} <span style={{ fg: theme.textMuted }}>选择</span>
            </text>
            <text fg={theme.text}>
              {"A-C"} <span style={{ fg: theme.textMuted }}>快捷</span>
            </text>
          </Show>
          <text fg={theme.text}>
            回车{" "}
            <span style={{ fg: theme.textMuted }}>
              {confirm() ? "提交" : multi() ? "切换" : single() ? "提交" : "确认"}
            </span>
          </text>

          <text fg={theme.text}>
            Esc <span style={{ fg: theme.textMuted }}>关闭</span>
          </text>
        </box>
      </box>
    </box>
  )
}
