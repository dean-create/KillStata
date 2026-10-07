export type WorkspaceMode = "frontend" | "connected"

/** 两个平台默认都进入本地工作台；只有显式连接时才使用分析核心。 */
export function workspaceMode(input: { isTauri: boolean; requestedMode?: string }): WorkspaceMode {
  return input.requestedMode === "connected" ? "connected" : "frontend"
}
