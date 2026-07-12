import "opentui-spinner/solid"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useTheme } from "../context/theme"

export function StartupLoading(props: { ready: () => boolean }) {
  const { theme } = useTheme()
  const [show, setShow] = createSignal(false)
  const text = createMemo(() => (props.ready() ? "Finishing startup..." : "Loading Killstata runtime..."))
  let wait: ReturnType<typeof setTimeout> | undefined
  let hold: ReturnType<typeof setTimeout> | undefined
  let shownAt = 0

  createEffect(() => {
    if (props.ready()) {
      if (wait) {
        clearTimeout(wait)
        wait = undefined
      }
      if (!show()) return
      if (hold) return
      const left = 900 - (Date.now() - shownAt)
      if (left <= 0) {
        setShow(false)
        return
      }
      hold = setTimeout(() => {
        hold = undefined
        setShow(false)
      }, left)
      return
    }

    if (hold) {
      clearTimeout(hold)
      hold = undefined
    }
    if (show() || wait) return
    wait = setTimeout(() => {
      wait = undefined
      shownAt = Date.now()
      setShow(true)
    }, 500)
  })

  onCleanup(() => {
    if (wait) clearTimeout(wait)
    if (hold) clearTimeout(hold)
  })

  return (
    <Show when={show()}>
      <box position="absolute" zIndex={5000} left={0} right={0} bottom={1} justifyContent="center" alignItems="center">
        <box backgroundColor={theme.backgroundPanel} paddingLeft={1} paddingRight={1} flexDirection="row" gap={1}>
          <spinner frames={[".", "..", "..."]} interval={180} color={theme.textMuted} />
          <text fg={theme.textMuted}>{text()}</text>
        </box>
      </box>
    </Show>
  )
}
