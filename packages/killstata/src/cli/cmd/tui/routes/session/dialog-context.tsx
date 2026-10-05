import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { useSync } from "@tui/context/sync"
import { useRouteData } from "@tui/context/route"
import { contextUsageFromRuntime, formatContextUsage, formatTokens, formatUpdatedAt } from "./context-usage"

export function DialogContext() {
  const sync = useSync()
  const route = useRouteData("session")
  const { theme } = useTheme()
  const state = () => sync.data.runtimeContext[route.sessionID]
  const usage = () => contextUsageFromRuntime(state())

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>上下文</text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      {(() => {
        const item = usage()
        if (!item) {
          return <text fg={theme.textMuted}>本会话还没有完成模型请求，暂无上下文用量。</text>
        }
        const snapshot = state()!.usage!
        return (
          <box gap={1}>
            <text fg={theme.primary}>{formatContextUsage(item)}</text>
            <text fg={theme.textMuted}>模型：{snapshot.providerID}/{snapshot.modelID}</text>
            <text fg={theme.text}>已用：{formatTokens(snapshot.usedTokens)} tokens</text>
            <text fg={theme.text}>输入预算：{formatTokens(snapshot.inputBudget)} tokens</text>
            <text fg={theme.text}>剩余：{formatTokens(snapshot.remainingTokens)} tokens</text>
            <text fg={theme.textMuted}>输出预留：{formatTokens(snapshot.reserveTokens)} tokens</text>
            <text fg={theme.textMuted}>
              估算组成：system {snapshot.estimatedSystemTokens.toLocaleString()} · tools {snapshot.estimatedToolTokens.toLocaleString()} · history {snapshot.estimatedMessageTokens.toLocaleString()}
            </text>
            {state()?.capsule && (
              <box gap={1}>
                <text fg={theme.text}>事实胶囊：{state()!.capsule!.datasetId ?? "未知数据集"} / {state()!.capsule!.stageId ?? "未知阶段"}</text>
                <text fg={theme.textMuted}>
                  scope：{state()!.capsule!.scope} · rows：{formatTokens(state()!.capsule!.rowCount)} · rowsUsed：{formatTokens(state()!.capsule!.rowsUsed)} · QA：{state()!.capsule!.qualityGate}
                </text>
                <text fg={state()!.capsule!.conflicts.length > 0 ? theme.warning : theme.textMuted}>
                  面板：{state()!.capsule!.panelStatus} · 观察到的设定：{state()!.capsule!.observedSpecifications} · 冲突：{state()!.capsule!.conflicts.length || "无"}
                </text>
              </box>
            )}
            {snapshot.actual && (
              <text fg={theme.textMuted}>
                实际输入：{snapshot.actual.inputTokens.toLocaleString()} · 输出：{snapshot.actual.outputTokens.toLocaleString()} · reasoning：{snapshot.actual.reasoningTokens.toLocaleString()} · cache read：{snapshot.actual.cacheReadTokens.toLocaleString()}
              </text>
            )}
            {snapshot.cache && (
              <box gap={1}>
                <text fg={theme.text}>缓存命中率：{(snapshot.cache.hitRatio * 100).toFixed(1)}%</text>
                <text fg={theme.textMuted}>
                  缓存请求：{snapshot.cache.observationCount}{snapshot.cache.truncated ? "+" : ""} · read：{snapshot.cache.cacheReadTokens.toLocaleString()} · write：{snapshot.cache.cacheWriteTokens.toLocaleString()}
                </text>
                <text fg={theme.textMuted}>
                  断裂原因：{Object.entries(snapshot.cache.breakReasons).map(([reason, count]) => `${reason}×${count}`).join("、") || "无"}
                </text>
                <text fg={snapshot.cache.breakCount > 0 ? theme.warning : theme.textMuted}>
                  缓存断裂：{snapshot.cache.breakCount} 次
                  {snapshot.cache.lastBreakReason ? ` · 最近：${snapshot.cache.lastBreakReason}` : ""}
                </text>
              </box>
            )}
            <text fg={theme.textMuted}>状态：{snapshot.compactionState === "none" ? "正常" : snapshot.compactionState}</text>
            {state()?.lastAction && (
              <text fg={theme.textMuted}>
                最近动作：{state()!.lastAction!.action} · 节省约 {formatTokens(state()!.lastAction!.savedEstimate)} tokens · 恢复引用 {state()!.lastAction!.restoredReferences ?? 0}
              </text>
            )}
            <text fg={theme.textMuted}>更新时间：{formatUpdatedAt(snapshot.updatedAt)}</text>
          </box>
        )
      })()}
    </box>
  )
}
