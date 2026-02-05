export const Mark = (props: { class?: string }) => {
  // killstata的K字母图标
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-mark-shadow" d="M12 16H4V8H12V16Z" fill="var(--icon-weak-base)" />
      <path data-slot="logo-mark-k" d="M4 0H8V8H12V0H16V8H12V12H16V20H12V12H8V20H4V0Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: { class?: string }) => {
  // 启动画面图标
  return (
    <svg
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M60 80H20V40H60V80Z" fill="var(--icon-base)" />
      <path d="M20 0H40V40H60V0H80V40H60V60H80V100H60V60H40V100H20V0Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  // killstata 文字 logo
  // 使用文本渲染而不是复杂的SVG路径
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 280 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g>
        {/* K */}
        <path d="M0 6H6V18H12V6H18V18H12V24H18V36H12V24H6V36H0V6Z" fill="var(--icon-base)" />
        {/* I */}
        <path d="M24 6H30V36H24V6Z" fill="var(--icon-base)" />
        {/* L */}
        <path d="M36 6H42V30H54V36H36V6Z" fill="var(--icon-base)" />
        {/* L */}
        <path d="M60 6H66V30H78V36H60V6Z" fill="var(--icon-base)" />
        {/* S */}
        <path d="M84 6H108V12H90V18H108V36H84V30H102V24H84V6Z" fill="var(--icon-strong-base)" />
        {/* T */}
        <path d="M114 6H138V12H132V36H120V12H114V6Z" fill="var(--icon-strong-base)" />
        {/* A */}
        <path d="M144 6H168V36H162V24H150V36H144V6ZM150 18H162V12H150V18Z" fill="var(--icon-strong-base)" />
        {/* T */}
        <path d="M174 6H198V12H192V36H180V12H174V6Z" fill="var(--icon-strong-base)" />
        {/* A */}
        <path d="M204 6H228V36H222V24H210V36H204V6ZM210 18H222V12H210V18Z" fill="var(--icon-strong-base)" />
      </g>
    </svg>
  )
}
