import { createMemo, createSignal, For } from "solid-js"
import { DEFAULT_THEMES, useTheme } from "@tui/context/theme"

const themeCount = Object.keys(DEFAULT_THEMES).length
const themeTip = `按 {highlight}Ctrl+X T{/highlight} 在 ${themeCount} 个内置主题间切换`

type TipPart = { text: string; highlight: boolean }

function parse(tip: string): TipPart[] {
  const parts: TipPart[] = []
  const regex = /\{highlight\}(.*?)\{\/highlight\}/g
  const found = Array.from(tip.matchAll(regex))
  const state = found.reduce(
    (acc, match) => {
      const start = match.index ?? 0
      if (start > acc.index) {
        acc.parts.push({ text: tip.slice(acc.index, start), highlight: false })
      }
      acc.parts.push({ text: match[1], highlight: true })
      acc.index = start + match[0].length
      return acc
    },
    { parts, index: 0 },
  )

  if (state.index < tip.length) {
    parts.push({ text: tip.slice(state.index), highlight: false })
  }

  return parts
}

export function Tips() {
  const theme = useTheme().theme
  const parts = parse(TIPS[Math.floor(Math.random() * TIPS.length)])

  return (
    <box width="100%" maxWidth="100%">
      <text width="100%" wrapMode="word">
        <span style={{ fg: theme.warning }}>● 提示 </span>
        <For each={parts}>
          {(part) => <span style={{ fg: part.highlight ? theme.text : theme.textMuted }}>{part.text}</span>}
        </For>
      </text>
    </box>
  )
}

const TIPS = [
  // 克制、专业、准确。每条只讲一件用户真正用得上的事。
  "在输入框键入 {highlight}@{/highlight} 加文件名，可直接把 excel / CSV / dta 载入分析",
  "导入后系统围绕 {highlight}datasetId / stageId{/highlight} 工作，不会反复重读原始表格",
  "回归前先跑 {highlight}QA{/highlight}：重复面板键会在估计前拦下来，缺失和异常值会标注出来供你判断",
  "面板双向固定效应基于 {highlight}linearmodels PanelOLS{/highlight}（个体+时间效应），默认聚类稳健标准误",
  "直接说需求即可，例如「用 firm 做个体、year 做时间，跑双向固定效应」",
  "结果数字来自 {highlight}results.json{/highlight} 等结构化产物，不是模型口算的",
  "直接问「现在走到哪一步了」「有哪些产物」，模型会读取当前分析状态回答",
  "命令面板里的{highlight}显示工具详情{/highlight}可展开工具的完整输出（默认只显示做了什么）",
  "分析引擎会自动准备；{highlight}/doctor{/highlight} 可查看当前状态",
  "在项目根目录放 {highlight}killstata.json{/highlight} 可覆盖全局配置",
  "{highlight}Ctrl+X N{/highlight} 开新会话，{highlight}/sessions{/highlight} 回到之前的分析",
  "{highlight}Ctrl+P{/highlight} 打开命令面板，查看全部可用操作",
  themeTip,
]
