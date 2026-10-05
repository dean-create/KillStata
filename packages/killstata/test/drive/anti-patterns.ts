/**
 * 反模式静态扫描（anti-patterns）：修复真实交互 bug 后，自动检查"有没有类似问题"。
 *
 * 把历轮修复沉淀成四类可 grep 的模式，扫源码树（工具描述 / Python runner / 提示词），
 * 命中即输出文件+行号+修复建议。不是 lint，是"同类问题"的快速网。
 */
import fs from "fs"
import path from "path"

const PKG_ROOT = path.resolve(path.dirname(import.meta.dir), "..")

export interface AntiPatternHit {
  pattern: string
  file: string
  line: number
  text: string
  /** 历史 bug 出处 */
  origin: string
  fixHint: string
}

function walkFiles(dir: string, ext: string[], acc: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === "test") continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(p, ext, acc)
    else if (ext.some((e) => p.endsWith(e))) acc.push(p)
  }
  return acc
}

function scanFile(file: string, patterns: Array<{ id: string; re: RegExp; origin: string; fixHint: string }>, hits: AntiPatternHit[]) {
  const lines = fs.readFileSync(file, "utf-8").split("\n")
  lines.forEach((text, index) => {
    for (const p of patterns) {
      if (p.re.test(text)) {
        hits.push({
          pattern: p.id,
          file: path.relative(PKG_ROOT, file),
          line: index + 1,
          text: text.trim().slice(0, 120),
          origin: p.origin,
          fixHint: p.fixHint,
        })
      }
    }
  })
}

/** 扫描 src/tool/*.txt 工具描述与 src/ 下 Python runner 与提示词 */
export function scanAntiPatterns(): AntiPatternHit[] {
  const hits: AntiPatternHit[] = []

  // 1. 鼓励性工具描述（第十三轮 glob 越权）："speculatively/always better" 作为**建议**出现。
  //    排除 DO NOT/NEVER 禁令行——那些是第十三轮的正确修复，不是问题。
  const speculative = {
    id: "encouraging-description",
    re: /^(?!.*\b(?:DO NOT|NEVER|never)\b).*\b(speculatively|always better|it is always)\b/i,
    origin: "第十三轮：glob.txt 'always better to speculatively search' 让模型主动搜目录找数据",
    fixHint: "改为 DO NOT 禁令或去掉；用户没给路径时应追问而不是主动搜索",
  }
  for (const file of walkFiles(path.join(PKG_ROOT, "src", "tool"), [".txt"])) scanFile(file, [speculative], hits)

  // 2. 硬阈值硬阻断（第十二轮 IV F<10 / RDD rows<30）：Python runner 里 blocking_errors 直接上数字阈值。
  //    排除注释行（以 # 开头）；Hausman p<0.05 之类的方法学注释不是硬阻断。
  const hardThreshold = {
    id: "hard-threshold-block",
    re: /^(?!\s*[#/]).*blocking_errors\.append\([^)]*[<>=]\s*\d+\b/,
    origin: "第十二轮：IV first-stage F<10 与 RDD rowsUsed<30 硬阻断，已降级为 warn 交模型判断",
    fixHint: "阈值判断应交模型（参考信号 + 中文 notes），不硬阻断；参见 iv.ts/rdd.ts 修复",
  }
  for (const file of walkFiles(path.resolve(PKG_ROOT, "..", "killstata-econometrics-engine", "python"), [".py"])) scanFile(file, [hardThreshold], hits)

  // 3. .txt 与 schema 不一致（第九轮 data_import filter/preprocess 旧接口）：描述**把已下线
  //    action 列进 action 枚举**（如 "action: import | ... | filter"）。"没有 filter/preprocess"的
  //    警告文本是正确的修复，不算命中。
  const staleAction = {
    id: "stale-action-in-description",
    re: /^(?!.*没有).*action\s*[:：].*(?:filter|preprocess)\b/i,
    origin: "第九轮：data-import.txt 仍列 filter/preprocess action，模型照旧接口调用被拒",
    fixHint: "从工具描述删除已下线 action/参数；描述与 schema.ts 对齐",
  }
  for (const file of walkFiles(path.join(PKG_ROOT, "src", "tool"), [".txt"])) scanFile(file, [staleAction], hits)

  // 4. 硬编码修复指令（第十二轮 failure-reflection）：失败修复文案里的绝对禁令措辞。
  //    只扫失败反思/修复指令相关目录，排除通用安全校验（路径穿越、explore 模式等正当禁令）。
  const hardDirective = {
    id: "hardcoded-directive",
    re: /\b(?:do not report|must not report|never report|禁止报告|不得报告)\b/i,
    origin: "第十二轮：'do not report the DID estimate until...' 硬指令已放宽为参考建议",
    fixHint: "诊断结果交模型措辞判断，用'可考虑…由你判断'而非绝对禁令",
  }
  for (const file of walkFiles(path.join(PKG_ROOT, "src", "runtime", "failure-reflection.ts"), [".ts"])) scanFile(file, [hardDirective], hits)
  for (const file of walkFiles(path.join(PKG_ROOT, "src", "tool", "analysis-reflection.ts"), [".ts"])) scanFile(file, [hardDirective], hits)

  return hits
}

/** 汇总命中，按文件排序 */
export function summarizeAntiPatterns(hits: AntiPatternHit[]): string {
  if (hits.length === 0) return "反模式扫描：0 命中 ✅"
  const byFile = new Map<string, AntiPatternHit[]>()
  for (const hit of hits) {
    const list = byFile.get(hit.file) ?? []
    list.push(hit)
    byFile.set(hit.file, list)
  }
  const lines: string[] = ["反模式扫描命中："]
  for (const [file, list] of byFile) {
    lines.push(`  ${file}`)
    for (const hit of list) lines.push(`    L${hit.line} [${hit.pattern}] ${hit.text}`)
  }
  lines.push(`  → 对应历史 bug：${[...new Set(hits.map((h) => h.origin))].join("；")}`)
  return lines.join("\n")
}
