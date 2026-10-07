// 进度行文案纯函数：锁死输出格式。
// 此前模板内联拼接在部分终端把「· 已用」渲染成「已已用」的视觉重叠（窄字符中点 + 空格），
// 改为全角逗号分隔，并把拼装收敛到这一个函数。独立成文件便于测试直接 import（不经过 JSX 转译）。
export function analysisProgressText(input: { label: string; elapsed: number; completed: boolean }) {
  return input.completed ? `已完成：${input.label}` : `正在${input.label}，已用 ${input.elapsed}s`
}
