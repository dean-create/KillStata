import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"

// 克制的品牌标识：一行字标 + 一句定位。
// 刻意不用大块 ASCII art——启动屏应该让用户马上看到输入框，而不是一面招牌。
export function Logo() {
  const { theme } = useTheme()

  return (
    <box flexDirection="column" alignItems="center" justifyContent="center" gap={0}>
      <text selectable={false}>
        <span style={{ fg: theme.primary, attributes: TextAttributes.BOLD }}>◆ </span>
        <span style={{ fg: theme.text, attributes: TextAttributes.BOLD }}>killstata</span>
      </text>
      <text fg={theme.textMuted} selectable={false}>
        econometric analysis, from raw table to paper-ready table
      </text>
    </box>
  )
}
