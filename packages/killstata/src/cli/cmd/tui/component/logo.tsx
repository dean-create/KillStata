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
    // 第 4 行两个 A 由 ██╔══██║ 改为 ██║  ██║（去掉第二道横线）：原字形里 A 的下半部
    // 与 H 完全相同（4/6 行一模一样），横杠又正好落在视觉中心，导致 A 看起来像 H。
    // 让 A 只保留第 3 行那一道横杠、第 4 行留空腔，三角形轮廓才立得住。
    { text: "██╔═██╗ ██║██║     ██║     ╚════██║   ██║   ██║  ██║   ██║   ██║  ██║", color: theme.text },
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
