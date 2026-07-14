import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { For } from "solid-js"

// KillStata 的终端字标。颜色从上到下过渡，保持启动页具有辨识度。
export function Logo() {
  const { theme } = useTheme()

  const lines = [
    { text: "██╗  ██╗██╗██╗     ██╗     ███████╗████████╗ █████╗ ████████╗ █████╗", color: theme.primary },
    { text: "██║ ██╔╝██║██║     ██║     ██╔════╝╚══██╔══╝██╔══██╗╚══██╔══╝██╔══██╗", color: theme.info },
    { text: "█████╔╝ ██║██║     ██║     ███████╗   ██║   ███████║   ██║   ███████║", color: theme.success },
    { text: "██╔═██╗ ██║██║     ██║     ╚════██║   ██║   ██╔══██║   ██║   ██╔══██║", color: theme.text },
    { text: "██║  ██╗██║███████╗███████╗███████║   ██║   ██║  ██║   ██║   ██║  ██║", color: theme.textMuted },
    { text: "╚═╝  ╚═╝╚═╝╚══════╝╚══════╝╚══════╝   ╚═╝   ╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝", color: theme.border },
  ]

  return (
    <box flexDirection="column" alignItems="center" justifyContent="center">
      <For each={lines}>
        {(line) => (
          <text fg={line.color} attributes={TextAttributes.BOLD} selectable={false}>
            {line.text}
          </text>
        )}
      </For>
    </box>
  )
}
