export type TuiModelRef = {
  providerID: string
  modelID: string
}

/**
 * 命令行显式模型必须压过异步加载的本地旧状态；没有显式参数时，保留用户在TUI
 * 中主动选择的模型，再回落到agent和配置默认值。
 */
export function selectTuiModel(
  candidates: {
    explicit?: TuiModelRef
    stored?: TuiModelRef
    agent?: TuiModelRef
    fallback?: TuiModelRef
  },
  isValid: (model: TuiModelRef) => boolean,
) {
  return [candidates.explicit, candidates.stored, candidates.agent, candidates.fallback].find(
    (model): model is TuiModelRef => Boolean(model && isValid(model)),
  )
}
