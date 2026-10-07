import { createMemo } from "solid-js"
import { useLocal } from "@tui/context/local"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { DialogModel } from "./dialog-model"
import { DialogReasoning } from "./dialog-reasoning"

const REASONING_LABELS: Record<string, string> = {
  off: "关闭",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
}

/**
 * 输入框右侧模型信息胶囊的入口菜单：只列两档可调节项——模型、推理强度——
 * 点击任意一行钻进对应的已有选择器（DialogModel / DialogReasoning）。
 * 不在这里重新实现选择逻辑，只是把两个入口收进一个统一的小面板。
 */
export function DialogModelSettings() {
  const local = useLocal()
  const dialog = useDialog()

  const modelLabel = createMemo(() => {
    const current = local.model.current()
    return current?.modelID ?? "未选择"
  })

  const reasoningLabel = createMemo(() => {
    const level = local.model.reasoningLevel.current()
    if (!level) return "关闭"
    return REASONING_LABELS[level] ?? level
  })

  return (
    <DialogSelect
      title="模型设置"
      skipFilter={true}
      options={[
        {
          value: "model",
          title: "模型",
          footer: `${modelLabel()} ›`,
          onSelect: () => dialog.replace(() => <DialogModel />),
        },
        {
          value: "reasoning",
          title: "推理强度",
          footer: `${reasoningLabel()} ›`,
          onSelect: () => dialog.replace(() => <DialogReasoning />),
        },
      ]}
    />
  )
}
