import { createMemo, createSignal, Show } from "solid-js"
import { useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { SplitBorder } from "@tui/component/border"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "../../context/keybind"
import { workflowAgentDisplayLabel, workflowStatusDisplayLabel } from "../../context/runtime-state"

export function SubagentFooter() {
  const route = useRouteData("session")
  const sync = useSync()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const command = useCommandDialog()
  const session = createMemo(() => sync.session.get(route.sessionID))
  const workflow = createMemo(() => sync.data.workflow[route.sessionID])
  const workflowLocale = createMemo(() => workflow()?.workflowLocale ?? "en")
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)

  const subagentInfo = createMemo(() => {
    const current = session()
    const workflowAgent = workflow()?.activeCoordinatorAgent
    if (!current && workflowAgent) {
      return { label: workflowAgentDisplayLabel(workflowAgent, workflowLocale()) ?? workflowAgent, index: 0, total: 0 }
    }
    if (!current) return { label: workflowAgentDisplayLabel("agent", workflowLocale()) ?? "agent", index: 0, total: 0 }
    const match = current.title.match(/@([\w-]+) subagent/)
    const rawLabel = workflowAgent ?? (match ? match[1] : current.parentID ? "subagent" : "coordinator")
    const label = workflowAgentDisplayLabel(rawLabel, workflowLocale()) ?? rawLabel
    if (!current.parentID) return { label, index: 0, total: 0 }
    const siblings = sync.data.session
      .filter((item) => item.parentID === current.parentID)
      .toSorted((a, b) => a.time.created - b.time.created)
    const index = siblings.findIndex((item) => item.id === current.id)
    return { label, index: index + 1, total: siblings.length }
  })

  const visible = createMemo(() => Boolean(session()?.parentID || workflow()?.activeCoordinatorAgent || workflow()?.repairOnly))

  return (
    <Show when={visible()}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={workflow()?.repairOnly ? theme.error : theme.border}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <box flexDirection="row" gap={1}>
            <text fg={workflow()?.repairOnly ? theme.error : theme.text}>
              <b>{subagentInfo().label}</b>
            </text>
            <Show when={subagentInfo().total > 0}>
              <text fg={theme.textMuted}>
                ({subagentInfo().index} of {subagentInfo().total})
              </text>
            </Show>
            <Show when={workflow()?.verifierStatus && !workflow()?.repairOnly}>
              <text fg={workflow()?.verifierStatus === "block" ? theme.error : theme.textMuted}>
                {workflowStatusDisplayLabel(workflow(), workflowLocale())}
              </text>
            </Show>
            <Show when={workflow()?.repairOnly}>
              <text fg={theme.error}>{workflowStatusDisplayLabel(workflow(), workflowLocale())}</text>
            </Show>
          </box>
          <Show when={session()?.parentID}>
            <box flexDirection="row" gap={2}>
              <box
                onMouseOver={() => setHover("parent")}
                onMouseOut={() => setHover(null)}
                onMouseUp={() => command.trigger("session.parent")}
                backgroundColor={hover() === "parent" ? theme.backgroundElement : theme.backgroundPanel}
              >
                <text fg={theme.text}>
                  Parent <span style={{ fg: theme.textMuted }}>{keybind.print("session_parent")}</span>
                </text>
              </box>
              <box
                onMouseOver={() => setHover("prev")}
                onMouseOut={() => setHover(null)}
                onMouseUp={() => command.trigger("session.child.previous")}
                backgroundColor={hover() === "prev" ? theme.backgroundElement : theme.backgroundPanel}
              >
                <text fg={theme.text}>
                  Prev <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle_reverse")}</span>
                </text>
              </box>
              <box
                onMouseOver={() => setHover("next")}
                onMouseOut={() => setHover(null)}
                onMouseUp={() => command.trigger("session.child.next")}
                backgroundColor={hover() === "next" ? theme.backgroundElement : theme.backgroundPanel}
              >
                <text fg={theme.text}>
                  Next <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle")}</span>
                </text>
              </box>
            </box>
          </Show>
        </box>
      </box>
    </Show>
  )
}
