import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"

// KILLSTATA Logo - 纯文本高亮显示
export function Logo() {
  const { theme } = useTheme()

  return (
    <box flexDirection="row" height={1} alignItems="center" justifyContent="center">
      <text fg={theme.textMuted} attributes={TextAttributes.BOLD} selectable={false}>
        KILL
      </text>
      <text fg={theme.text} attributes={TextAttributes.BOLD} selectable={false}>
        STATA
      </text>
    </box>
  )
}
