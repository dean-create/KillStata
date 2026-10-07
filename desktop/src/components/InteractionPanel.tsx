import { createEffect, For, Show, createMemo, createSignal } from "solid-js"
import type { EngineInteraction, EngineInteractionAnswer } from "../engine/client"

type InteractionPanelProps = {
  interaction: EngineInteraction
  busy?: boolean
  error?: string
  onSubmit: (answer: EngineInteractionAnswer) => void
  onDeny: () => void
}

export function InteractionPanel(props: InteractionPanelProps) {
  const question = () => props.interaction.kind === "question" ? props.interaction.question : undefined
  const permission = () => props.interaction.kind === "permission" ? props.interaction.permission : undefined
  const [selected, setSelected] = createSignal<string[]>([])
  const [text, setText] = createSignal("")
  const canSubmit = createMemo(() => {
    const current = question()
    if (!current) return false
    if (current.mode === "text") return text().trim().length > 0
    return selected().length > 0
  })
  createEffect(() => {
    props.interaction
    setSelected([])
    setText("")
  })
  const toggleOption = (id: string) => {
    const current = selected()
    if (question()?.mode === "multi") {
      setSelected(current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
    } else {
      setSelected([id])
    }
  }
  const submit = () => {
    if (props.busy || !canSubmit()) return
    props.onSubmit({
      ...(question()?.mode === "text" ? { text: text().trim() } : { selected: selected() }),
    })
  }

  return (
    <section class="interaction-panel" aria-label={question()?.title ?? permission()?.title ?? "引擎请求"}>
      <div class="interaction-content">
        <p class="interaction-eyebrow">分析需要你的确认</p>
        <h2>{question()?.title ?? permission()?.title}</h2>
        <Show when={question()} fallback={
          <div class="interaction-permission">
            <p>{permission()?.action}</p>
            <p class="interaction-scope">影响范围：{permission()?.scope}</p>
          </div>
        }>
          {(current) => (
            <>
              <p>{current().prompt}</p>
              <Show when={current().mode === "text"}>
                <textarea
                  class="interaction-textarea"
                  aria-label="回答内容"
                  value={text()}
                  onInput={(event) => setText(event.currentTarget.value)}
                  disabled={props.busy}
                />
              </Show>
              <Show when={current().mode !== "text"}>
                <div class="interaction-options" role={current().mode === "multi" ? "group" : "radiogroup"} aria-label="可选答案">
                  <For each={current().options}>
                    {(option, index) => {
                      const letter = () => String.fromCharCode(65 + index())
                      const isSelected = () => selected().includes(option.id)
                      return (
                        <button
                          type="button"
                          classList={{ "is-selected": isSelected() }}
                          aria-label={option.label}
                          aria-pressed={isSelected()}
                          onClick={() => toggleOption(option.id)}
                          disabled={props.busy}
                        >
                          <span class="option-badge" classList={{ "is-selected": isSelected() }}>{letter()}</span>
                          <span class="option-body">
                            <strong>{option.label}</strong>
                            <Show when={option.description}><small>{option.description}</small></Show>
                          </span>
                          <Show when={isSelected()}>
                            <span class="option-check">✓</span>
                          </Show>
                        </button>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>
      <Show when={props.error}><p class="interaction-error" role="alert">{props.error}</p></Show>
      <div class="interaction-actions">
        <button type="button" class="settings-button is-ghost" onClick={props.onDeny} disabled={props.busy}>拒绝并停止</button>
              <Show when={permission()}>
                <button type="button" class="settings-button" onClick={() => props.onSubmit({ allowed: true })} disabled={props.busy}>允许一次</button>
              </Show>
              <Show when={question()?.allowSkip}>
                <button type="button" class="settings-button is-ghost" onClick={() => props.onSubmit({ skipped: true })} disabled={props.busy}>跳过</button>
              </Show>
              <Show when={question()}>
                <button type="button" class="settings-button" onClick={submit} disabled={props.busy || !canSubmit()}>
                  {props.busy ? "提交中…" : "继续分析"}
                </button>
              </Show>
      </div>
    </section>
  )
}
