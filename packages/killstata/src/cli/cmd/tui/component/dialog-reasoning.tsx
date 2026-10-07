import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useLocal } from "@tui/context/local"

const LABELS: Record<string, string> = {
  off: "关闭",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
}

export function DialogReasoning() {
  const local = useLocal()
  const dialog = useDialog()
  const levels = () => local.model.reasoningLevel.list()
  const current = () => local.model.reasoningLevel.current()

  return (
    <DialogSelect
      title="选择推理等级"
      current={current() ?? "off"}
      options={levels().map((level) => ({
        value: level,
        title: LABELS[level] ? `${LABELS[level]}(${level})` : level,
        onSelect: () => {
          local.model.reasoningLevel.set(level === "off" ? undefined : level)
          dialog.clear()
        },
      }))}
    />
  )
}
