import path from "path"

/**
 * 本产品能真正处理的数据格式，唯一真相源。
 * 与 data-import 内联 Python 的 `read_table` 分支保持一致（.csv / .xlsx / .xls / .dta）。
 * .parquet 是内部 canonical stage 格式，用户不该手工挑它，所以不在这里。
 */
export const DATA_FILE_EXTENSIONS = [".csv", ".xlsx", ".xls", ".dta"] as const

export function isDataFile(filePath: string) {
  const ext = path.extname(filePath).toLowerCase()
  return (DATA_FILE_EXTENSIONS as readonly string[]).includes(ext)
}

/** 给用户看的拒绝文案：说清楚支持什么，而不是只说「不支持」。 */
export function unsupportedDataFileMessage(filePath: string) {
  const ext = path.extname(filePath) || "(无扩展名)"
  return `不支持的数据格式 ${ext}。killstata 只能分析 ${DATA_FILE_EXTENSIONS.join(" / ")} 文件。`
}
