type MarkdownReportInput = {
  datasetName: string
  prompt: string
  document: string
  generatedAt: Date
}

/** 将面向用户的分析结论导出为可复核的最小研究记录，不包含工作区路径或运行日志。 */
export function createMarkdownReport(input: MarkdownReportInput) {
  return [
    "# KillStata 分析结果",
    "",
    `- 数据：${input.datasetName}`,
    `- 研究问题：${input.prompt}`,
    `- 导出时间：${input.generatedAt.toISOString()}`,
    "",
    "## 结果",
    "",
    input.document.trim(),
    "",
  ].join("\n")
}
