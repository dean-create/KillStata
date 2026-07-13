import fs from "fs"
import { createMemo, createSignal } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { DATA_FILE_EXTENSIONS, isDataFile } from "@/tool/data-file"
import {
  type BrowserEntry,
  expandPath,
  formatSize,
  listDataDir,
  looksLikePath,
  parentDir,
} from "./data-file-browser"

// 超过这个大小，导入时 Python 解析会明显等一会儿，先把话说在前面。
const SLOW_IMPORT_BYTES = 20 * 1024 * 1024

/**
 * 数据文件浏览器。终端没有系统级文件对话框，所以这里自己实现一个：
 * 可以进出任意目录（不限于当前工作目录），也可以直接把绝对路径打/粘进筛选框。
 */
export function DialogDataFile(props: { onPick: (filePath: string) => void }) {
  const dialog = useDialog()
  const [cwd, setCwd] = createSignal(process.cwd())
  const [query, setQuery] = createSignal("")

  const options = createMemo(() => {
    const dir = cwd()
    const rows: { title: string; value: BrowserEntry; category?: string; description?: string }[] = []

    // 用户直接指了一个路径：给一个「直接跳过去 / 直接选它」的行，省得一层层点进去。
    const typed = query()
    if (looksLikePath(typed)) {
      const target = expandPath(typed)
      try {
        const stat = fs.statSync(target)
        if (stat.isDirectory()) {
          rows.push({
            title: `进入 ${target}`,
            value: { kind: "dir", path: target, name: target },
            category: "输入的路径",
          })
        } else if (isDataFile(target)) {
          rows.push({
            title: `选择 ${target}`,
            value: { kind: "file", path: target, name: target, size: stat.size },
            category: "输入的路径",
            description: formatSize(stat.size),
          })
        }
      } catch {
        // 路径还没打完 / 不存在，正常情况，不打扰用户。
      }
    }

    const parent = parentDir(dir)
    if (parent) {
      rows.push({ title: "..  返回上级", value: { kind: "dir", path: parent, name: ".." }, category: dir })
    }

    const { entries, error } = listDataDir(dir)
    if (error) {
      rows.push({
        title: "(无法读取该目录)",
        value: { kind: "dir", path: parent ?? dir, name: ".." },
        category: dir,
        description: error,
      })
      return rows
    }

    for (const entry of entries) {
      if (entry.kind === "dir") {
        rows.push({ title: `${entry.name}/`, value: entry, category: dir })
        continue
      }
      const slow = entry.size !== undefined && entry.size > SLOW_IMPORT_BYTES
      rows.push({
        title: entry.name,
        value: entry,
        category: dir,
        description:
          entry.size === undefined
            ? undefined
            : `${formatSize(entry.size)}${slow ? " · 较大，导入需要一些时间" : ""}`,
      })
    }

    return rows
  })

  return (
    <DialogSelect
      title={`选择数据文件（${DATA_FILE_EXTENSIONS.join(" / ")}）`}
      placeholder="按名称筛选，或直接粘贴一个路径"
      options={options()}
      onFilter={(value) => setQuery(value)}
      onSelect={(opt) => {
        const entry = opt.value
        // 进目录不关弹窗，继续浏览；选中文件才收工。
        if (entry.kind === "dir") {
          setCwd(entry.path)
          return
        }
        props.onPick(entry.path)
        dialog.clear()
      }}
    />
  )
}
