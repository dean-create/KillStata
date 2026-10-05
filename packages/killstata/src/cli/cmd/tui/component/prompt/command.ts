export function shouldSubmitImmediateCommand(
  inputText: string,
  option: { value?: string; immediate?: boolean },
): boolean {
  return Boolean(option.immediate && option.value && inputText.trim().toLowerCase() === option.value.trim().toLowerCase())
}
