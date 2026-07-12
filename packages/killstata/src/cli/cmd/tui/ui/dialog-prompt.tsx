import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { onMount, type JSX } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { useKeybind } from "../context/keybind"
import { Clipboard } from "../util/clipboard"

export type DialogPromptProps = {
  title: string
  description?: () => JSX.Element
  placeholder?: string
  value?: string
  onConfirm?: (value: string) => void
  onCancel?: () => void
}

export function DialogPrompt(props: DialogPromptProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const keybind = useKeybind()
  let textarea: TextareaRenderable

  useKeyboard((evt) => {
    if (evt.name === "return") {
      props.onConfirm?.(textarea.plainText)
    }
  })

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      textarea.focus()
    }, 1)
    textarea.gotoLineEnd()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <box gap={1}>
        {props.description}
        <textarea
          onSubmit={() => {
            props.onConfirm?.(textarea.plainText)
          }}
          onKeyDown={async (evt) => {
            if (!keybind.match("input_paste", evt)) return
            const content = await Clipboard.read().catch(() => undefined)
            if (!content || content.mime !== "text/plain") return
            evt.preventDefault()
            const normalized = content.data.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
            textarea.insertText(normalized)
          }}
          onPaste={(event: { text: string; preventDefault: () => void }) => {
            const normalized = event.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
            if (normalized === event.text) return
            event.preventDefault()
            textarea.insertText(normalized)
          }}
          height={3}
          keyBindings={[{ name: "return", action: "submit" }]}
          ref={(val: TextareaRenderable) => (textarea = val)}
          initialValue={props.value}
          placeholder={props.placeholder ?? "Enter text"}
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.text}
        />
      </box>
      <box paddingBottom={1} gap={1} flexDirection="row">
        <text fg={theme.text}>
          enter <span style={{ fg: theme.textMuted }}>submit</span>
        </text>
        <text fg={theme.text}>
          {keybind.print("input_paste")} <span style={{ fg: theme.textMuted }}>paste</span>
        </text>
      </box>
    </box>
  )
}

DialogPrompt.show = (dialog: DialogContext, title: string, options?: Omit<DialogPromptProps, "title">) => {
  return new Promise<string | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogPrompt title={title} {...options} onConfirm={(value) => resolve(value)} onCancel={() => resolve(null)} />
      ),
      () => resolve(null),
    )
  })
}
