import path from "path"

const MAX_RULE_FILE_BYTES = 32 * 1024
const MAX_RULE_BYTES = 64 * 1024

export type CustomRule = {
  path: string
  content: string
}

/**
 * 规则只来自项目内两个固定位置，避免递归扫描其他 AGENTS.md/CONTEXT.md、glob 或远程 URL
 * 将无关项目约束偷偷塞进计量会话。每次调用均重新读取，因此下一轮对话自然生效，
 * 不需要常驻目录监听器。
 */
export async function loadCustomRules(input: { project: string }): Promise<CustomRule[]> {
  const candidates = [
    path.join(input.project, ".killstata", "AGENTS.md"),
    path.join(input.project, "AGENTS.md"),
  ].map((item) => path.resolve(item))
  const rules: CustomRule[] = []
  let total = 0

  for (const filePath of candidates) {
    const file = Bun.file(filePath)
    const stat = await file.stat().catch(() => undefined)
    if (!stat || stat.size === 0 || stat.size > MAX_RULE_FILE_BYTES || total + stat.size > MAX_RULE_BYTES) continue
    const content = await file.text().catch(() => "")
    if (!content.trim()) continue
    rules.push({ path: filePath, content })
    total += stat.size
  }

  return rules
}
