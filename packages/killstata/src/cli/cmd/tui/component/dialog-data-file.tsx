import fs from "fs"
import path from "path"
import { createMemo } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { DATA_FILE_EXTENSIONS, isDataFile } from "@/tool/data-file"

const MAX_ENTRIES = 200
const IGNORED_DIRS = new Set([".git", "node_modules", ".killstata", "__pycache__", ".venv", "venv", "trash"])

type Entry = {
  title: string
  value: string
  hint?: string
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// 递归扫目录找数据文件。深度限制 3 层：再深就不是「用户想分析的那份数据」了，
// 而且深扫在大仓库里会明显卡住 TUI。
function findDataFiles(root: string, depth = 0, out: Entry[] = []): Entry[] {
  if (out.length >= MAX_ENTRIES || depth > 3) return out

  let items: fs.Dirent[]
  try {
    items = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }

  for (const item of items) {
    if (out.length >= MAX_ENTRIES) break
    if (item.name.startsWith(".") && item.name !== ".") continue

    const full = path.join(root, item.name)
    if (item.isDirectory()) {
      if (IGNORED_DIRS.has(item.name)) continue
      findDataFiles(full, depth + 1, out)
      continue
    }
    if (!item.isFile() || !isDataFile(item.name)) continue

    let hint: string | undefined
    try {
      hint = formatSize(fs.statSync(full).size)
    } catch {
      hint = undefined
    }
    out.push({ title: path.relative(process.cwd(), full) || item.name, value: full, hint })
  }

  return out
}

/**
 * 数据文件选择器。终端没有系统级文件对话框，所以这里自己扫工作目录，
 * 且**只列 Excel / CSV / DTA** —— 其他格式这个产品根本处理不了，
 * 让它们出现在列表里只会诱导用户选中然后失败。
 */
export function DialogDataFile(props: { onPick: (filePath: string) => void }) {
  const dialog = useDialog()
  const options = createMemo(() => findDataFiles(process.cwd()))

  return (
    <DialogSelect
      title={`选择数据文件（${DATA_FILE_EXTENSIONS.join(" / ")}）`}
      placeholder="按名称筛选，回车插入路径"
      options={options()}
      onSelect={(opt) => {
        // 空列表时 DialogSelect 不会触发 onSelect，所以这里不必再防守空值。
        props.onPick(opt.value)
        dialog.clear()
      }}
    />
  )
}
