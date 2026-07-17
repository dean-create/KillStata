import { Show, createMemo } from "solid-js"
import { useConnected } from "../../component/dialog-model"
import { useRoute } from "../../context/route"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"

// This is a product status line, not a developer console. Internal workflow,
// Git, LSP, MCP and context diagnostics remain out of the user's way.
export function Footer() {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const connected = useConnected()
  const status = createMemo(() => {
    if (route.data.type !== "session") return undefined
    return sync.data.session_status?.[route.data.sessionID]?.type
  })

  return (
    <box flexDirection="row" justifyContent="space-between" flexShrink={0} paddingTop={1}>
      <text fg={theme.textMuted}>KillStata · 计量分析工作台</text>
      <Show when={connected()}>
        <text fg={status() === "busy" ? theme.primary : theme.textMuted}>
          {status() === "busy" ? "正在处理" : "就绪"}
        </text>
      </Show>
    </box>
  )
}
