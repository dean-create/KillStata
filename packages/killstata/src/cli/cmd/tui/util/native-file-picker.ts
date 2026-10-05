import { $ } from "bun"
import { platform } from "os"
import { DATA_FILE_EXTENSIONS } from "@/tool/data-file"

/**
 * 唤起操作系统原生的文件选择对话框。终端本身没有文件选择器，但 macOS/Windows
 * 都能通过脚本宿主唤起真正的系统级对话框；KillStata 只打包 darwin/win32
 * （见 script/build.ts 的构建矩阵），所以不需要 Linux 分支。
 *
 * `available=false` 表示当前平台/环境没有可用脚本宿主，调用方应静默回退到内置的
 * DialogDataFile 目录浏览器。`available=true, path=undefined` 表示原生对话框
 * 真的弹出过，但用户主动取消了——这种情况不该再弹一个回退对话框，那会让用户
 * 困惑"明明点了取消，为什么又跳出一个选择器"。
 */
export type NativeFilePickerResult = { available: false } | { available: true; path: string | undefined }

export namespace NativeFilePicker {
  export async function pick(): Promise<NativeFilePickerResult> {
    const os = platform()

    if (os === "darwin") {
      if (!Bun.which("osascript")) return { available: false }
      const typeList = DATA_FILE_EXTENSIONS.map((ext) => `"${ext.replace(/^\./, "")}"`).join(", ")
      const script = `set thePath to POSIX path of (choose file with prompt "选择数据文件" of type {${typeList}})`
      const result = await $`osascript -e ${script}`.nothrow().quiet().text()
      const trimmed = result.trim()
      return { available: true, path: trimmed.length > 0 ? trimmed : undefined }
    }

    if (os === "win32") {
      const filterExts = DATA_FILE_EXTENSIONS.map((ext) => `*${ext}`).join(";")
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
        `$dialog.Filter = "数据文件 (${filterExts})|${filterExts}|所有文件 (*.*)|*.*"`,
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.FileName }",
      ].join("; ")
      const result = await $`powershell.exe -NonInteractive -NoProfile -Command ${script}`.nothrow().quiet().text()
      const trimmed = result.trim()
      return { available: true, path: trimmed.length > 0 ? trimmed : undefined }
    }

    return { available: false }
  }
}
