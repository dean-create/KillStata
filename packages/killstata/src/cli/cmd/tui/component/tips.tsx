import { createMemo, createSignal, For } from "solid-js"
import { DEFAULT_THEMES, useTheme } from "@tui/context/theme"

const themeCount = Object.keys(DEFAULT_THEMES).length
const themeTip = `Use {highlight}/theme{/highlight} or {highlight}Ctrl+X T{/highlight} to switch between ${themeCount} built-in themes`

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
        <span style={{ fg: theme.warning }}>● Tip </span>
        <For each={parts}>
          {(part) => <span style={{ fg: part.highlight ? theme.text : theme.textMuted }}>{part.text}</span>}
        </For>
      </text>
    </box>
  )
}

const TIPS = [
  "Use {highlight}killstata init{/highlight} to quickly set up your Python econometrics environment",
  "使用{highlight}killstata init{/highlight}快速配置专属的Python实证分析虚拟环境",
  "Use {highlight}@{/highlight} followed by an Excel or CSV filename to load a dataset directly",
  "在对话框键入{highlight}@{/highlight}跟上你的Excel文件名，即可将数据集无缝加载进终端进行运算",
  "Ask Killstata to run {highlight}OLS regression{/highlight} and it will handle pandas/statsmodels automatically",
  "你可以直接对我说请求：帮我跑一个混合OLS回归，我会全自动调度Pandas与Statsmodels完成代码生成",
  "Create {highlight}killstata.json{/highlight} in your project root to override global settings",
  "在当前项目根目录创建{highlight}killstata.json{/highlight}，即可定义专属的偏好设置与个性化配置",
  "Switch to the {highlight}data{/highlight} or {highlight}metrics{/highlight} agent to use specialized algorithms",
  "可以通过{highlight}/agent{/highlight}切换到专属智能体，来高效处理极度复杂的实证算法和数据清洗要求",
  "Start a message with {highlight}!{/highlight} to run shell commands (e.g., {highlight}!pip list{/highlight})",
  "以{highlight}!{/highlight}字符开头可直接让大模型以终端执行命令，例如使用{highlight}!pip install arch{/highlight}",
  themeTip,
  "Killstata supports advanced Panel Data operations via {highlight}linearmodels{/highlight}",
  "不论是单向的固定效应、随机效应还是GMM，我底层支持了大量的高级计量黑客级用法",
  "Press {highlight}Ctrl+X M{/highlight} or run {highlight}/models{/highlight} to switch AI models",
  "需要更高智力的思考引擎解决难题？使用{highlight}Ctrl+X M{/highlight}随便切换行业顶尖大模型为我附体",
  "Press {highlight}Ctrl+X N{/highlight} or run {highlight}/new{/highlight} to start a fresh analysis session",
  "上次分析搞乱了变量逻辑？只要按下{highlight}Ctrl+X N{/highlight}即可光速清空原会话记忆重新开始新课题",
  "Run {highlight}/sessions{/highlight} or {highlight}Ctrl+X L{/highlight} to continue previous data analyses",
  "通过{highlight}/sessions{/highlight}能够进行时光回溯，一秒恢复你三天前做了一半的实证数据操作流",
  "Killstata dynamically translates your intent into secure Python execution",
  "你负责给专业领域的意图和需求，我来帮你转译为极度严谨无错的脚本化Python代码运行序列",
  "If an error occurs, Killstata will automatically attempt to debug and retry",
  "哪怕代码真的发生红字故障也别恐慌，系统的自我修复反馈机制会自动定位BUG并快速挽救！",
  "You can export your analysis history as Markdown using {highlight}Ctrl+X X{/highlight}",
  "全套分析成果打磨完毕后，利用快捷键{highlight}Ctrl+X X{/highlight}将此分析流一键导出为极致的Markdown论文笔记",
  "Press {highlight}Ctrl+P{/highlight} to open the command palette and view all actions",
  "当你不记得都有啥快捷键时，万能操作就是按下{highlight}Ctrl+P{/highlight}呼出中央命令调度面板",
  "Need to format data? Just ask 'Clean the missing values in my dataset.'",
  "不用再自己苦哈哈地敲代码了，遇到空值、脏数据或者异常数据，直接自然语言命令我来处理就好了",
  "Ask to generate a {highlight}correlation matrix{/highlight} or plot data distribution curves",
  "无论是核密度估计图还是相关热力矩阵图，你都可以随时命令我去完成高端的数据图像可视化",
  "Run {highlight}killstata upgrade{/highlight} to get the latest features and bug fixes",
  "经常试试{highlight}killstata upgrade{/highlight}会带给你出乎意料的算法新特性",
  "Use the {highlight}/help{/highlight} command or press {highlight}Ctrl+X H{/highlight} for the help dialog",
  "按下{highlight}Ctrl+X H{/highlight}，系统就会为你翻开这本厚重但也极简的Killstata生存命令图鉴"
]
