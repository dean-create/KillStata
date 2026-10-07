import { Prompt, type PromptRef } from "@tui/component/prompt"
import { createMemo, onMount, Show } from "solid-js"
import { Logo } from "../component/logo"
import { Tips } from "../component/tips"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRouteData } from "@tui/context/route"
import { usePromptRef } from "../context/prompt"
import { useKV } from "../context/kv"
import { useCommandDialog } from "../component/dialog-command"

// TODO: what is the best way to do this?
let once = false

export function Home() {
  const sync = useSync()
  const kv = useKV()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const command = useCommandDialog()

  const isFirstTimeUser = createMemo(() => sync.data.session.length === 0)
  const tipsHidden = createMemo(() => kv.get("tips_hidden", false))
  const showTips = createMemo(() => {
    // Don't show tips for first-time users
    if (isFirstTimeUser()) return false
    return !tipsHidden()
  })

  command.register(() => [
    {
      title: tipsHidden() ? "显示提示" : "隐藏提示",
      value: "tips.toggle",
      keybind: "tips_toggle",
      category: "系统",
      onSelect: (dialog) => {
        kv.set("tips_hidden", !tipsHidden())
        dialog.clear()
      },
    },
  ])

  let prompt: PromptRef
  const args = useArgs()
  onMount(() => {
    if (once) return
    if (route.initialPrompt) {
      prompt.set(route.initialPrompt)
      once = true
    } else if (args.prompt) {
      prompt.set({ input: args.prompt, parts: [] })
      once = true
      prompt.submit()
    }
  })
  return (
    <>
      <box flexGrow={1} justifyContent="center" alignItems="center" paddingLeft={2} paddingRight={2} gap={1}>
        <box height={3} />
        <Logo />
        <box width="100%" maxWidth={75} zIndex={1000} paddingTop={1}>
          <Prompt
            ref={(r) => {
              if (!r) return
              prompt = r
              promptRef.set(r)
            }}
          />
        </box>
        <box width="100%" maxWidth={75} alignItems="flex-start" paddingTop={2} paddingBottom={1}>
          <Show when={showTips()}>
            <Tips />
          </Show>
        </box>
        <Toast />
      </box>
    </>
  )
}
