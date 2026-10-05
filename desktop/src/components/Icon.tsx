import type { JSX } from "solid-js"

type IconName = "paperclip" | "close" | "arrow-up" | "arrow-down" | "plus" | "workspace" | "settings" | "check" | "ellipsis" | "shield" | "chevron-down" | "chevron-up" | "stop" | "trend" | "compare" | "scatter" | "folder" | "file" | "search" | "filter" | "more" | "database" | "puzzle" | "sun" | "moon" | "monitor" | "user"

type IconProps = {
  name: IconName
  size?: number
  class?: string
}

const paths: Record<IconName, JSX.Element> = {
  paperclip: <path d="m20.5 11.5-8.8 8.8a5 5 0 0 1-7.1-7.1l9.2-9.2a3.5 3.5 0 0 1 5 5l-9.3 9.3a2 2 0 0 1-2.8-2.8l8.7-8.7" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  "arrow-up": <path d="M12 19V5m0 0L6.5 10.5M12 5l5.5 5.5" />,
  "arrow-down": <path d="M12 5v14m0 0 5.5-5.5M12 19l-5.5-5.5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  workspace: <path d="M3.5 9.5h17M5 9.5V19h14V9.5M7 9.5V5h10v4M9 13h6" />,
  settings: <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm0-5v2m0 13v2M3 12h2m13 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />,
  check: <path d="m5 12 4.2 4.2L19 6.5" />,
  ellipsis: <path d="M6 12h.01M12 12h.01M18 12h.01" />,
  shield: <path d="M12 3.5 5 6.2v5.1c0 4.3 2.9 7.5 7 9.2 4.1-1.7 7-4.9 7-9.2V6.2L12 3.5Z" />,
  "chevron-down": <path d="m7 10 5 5 5-5" />,
  "chevron-up": <path d="m7 14 5-5 5 5" />,
  // 实心圆角方块：运行中作为"停止"图标，与发送箭头在同一按钮位切换。
  stop: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,
  // 研究起步卡片：政策前后的水平变化、两组对比、变量间关系。
  trend: <path d="M4 18V6m0 12h16M7.5 14.5l3.5-4 3 2.5 4.5-5.5" />,
  compare: <path d="M4 20V4m0 16h16M8.5 20v-6.5h3.5V20m3.5 0V8.5H19V20" />,
  scatter: <path d="M4 18V6m0 12h16M8 14.5h.01M11.5 10h.01M14.5 12.5h.01M18 7.5h.01" />,
  folder: <><path d="M3 8a1.5 1.5 0 0 1 1.5-1.5H9l2 2H18a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5H4.5A1.5 1.5 0 0 1 3 18V8Z" /><path d="M3 9.5h16" opacity=".5" /></>,
  file: <><path d="M7 3.5H12.5L17 8V19.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" /><path d="M12.5 3.5V8H17" /></>,
  search: <><circle cx="11" cy="11" r="5.5" /><path d="m15 15 3.2 3.2" /></>,
  filter: <><path d="M4 6h16M6 12h12M9 18h6" /><circle cx="15" cy="6" r="1.8" fill="currentColor" stroke="none" /><circle cx="9" cy="12" r="1.8" fill="currentColor" stroke="none" /><circle cx="13" cy="18" r="1.8" fill="currentColor" stroke="none" /></>,
  more: <><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none" /></>,
  database: <><ellipse cx="12" cy="7" rx="7" ry="3.5" /><path d="M5 7v6c0 1.9 3.1 3.5 7 3.5s7-1.6 7-3.5V7" /><path d="M5 12.5v5c0 1.9 3.1 3.5 7 3.5s7-1.6 7-3.5v-5" /></>,
  puzzle: <><path d="M9 9H7a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-2a2 2 0 0 1 2-2h2a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2h-2a2 2 0 0 1-2-2V7a2 2 0 0 0-2-2H13a2 2 0 0 0-2 2v2a2 2 0 0 1-2 2Z" /><path d="M11 9a1 1 0 1 0 2 0 1 1 0 0 0-2 0Z" fill="currentColor" stroke="none" /></>,
  sun: <><circle cx="12" cy="12" r="4.5" /><path d="M12 3v1.5M12 19.5V21M4.2 4.2 5.3 5.3M18.7 18.7 19.8 19.8M3 12h1.5M19.5 12H21M4.2 19.8 5.3 18.7M18.7 5.3 19.8 4.2" /></>,
  moon: <path d="M14.5 12.5a5.5 5.5 0 1 1-5-7.5 6.5 6.5 0 1 0 5 7.5Z" />,
  monitor: <><rect x="4" y="5" width="16" height="10" rx="1.5" /><path d="M9 18h6M12 15v3" /></>,
  user: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 19a7 7 0 0 1 14 0" /></>,
}

export function Icon(props: IconProps) {
  return (
    <svg
      class={props.class}
      data-icon={props.name}
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {paths[props.name]}
    </svg>
  )
}
