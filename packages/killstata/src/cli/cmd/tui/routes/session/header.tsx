import { type Accessor, createMemo, createSignal, Match, Show, Switch } from "solid-js"
import { useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { pipe, sumBy } from "remeda"
import { useTheme } from "@tui/context/theme"
import { SplitBorder } from "@tui/component/border"
import type { Session } from "@killstata/sdk/v2"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "../../context/keybind"
import { Installation } from "@/installation"
import { useTerminalDimensions } from "@opentui/solid"
import { formatContextUsage, getContextUsage, type ContextUsage } from "./context-usage"

const Title = (props: { session: Accessor<Session> }) => {
  const { theme } = useTheme()
  return (
    <text fg={theme.text}>
      <span style={{ bold: true }}>#</span> <span style={{ bold: true }}>{props.session().title}</span>
    </text>
  )
}

const ContextInfo = (props: { context: Accessor<ContextUsage | undefined>; cost: Accessor<string> }) => {
  const { theme } = useTheme()
  const color = createMemo(() => {
    const usage = props.context()
    if (usage?.level === "danger") return theme.error
    if (usage?.level === "watch") return theme.warning
    return theme.textMuted
  })
  return (
    <Show when={props.context()}>
      {(usage) => (
        <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
          <span style={{ fg: color() }}>{formatContextUsage(usage())}</span> ({props.cost()})
        </text>
      )}
    </Show>
  )
}

export function Header() {
  const route = useRouteData("session")
  const sync = useSync()
  const session = createMemo(() => sync.session.get(route.sessionID)!)
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])

  const cost = createMemo(() => {
    const total = pipe(
      messages(),
      sumBy((x) => (x.role === "assistant" ? x.cost : 0)),
    )
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(total)
  })

  const context = createMemo(() => getContextUsage(messages(), sync.data.provider))

  const { theme } = useTheme()
  const keybind = useKeybind()
  const command = useCommandDialog()
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)
  const dimensions = useTerminalDimensions()
  const narrow = createMemo(() => dimensions().width < 80)

  return (
    <box flexShrink={0}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={theme.border}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        <Switch>
          <Match when={session()?.parentID}>
            <box flexDirection="column" gap={1}>
              <box flexDirection={narrow() ? "column" : "row"} justifyContent="space-between" gap={narrow() ? 1 : 0}>
                <text fg={theme.text}>
                  <b>Subagent session</b>
                </text>
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <ContextInfo context={context} cost={cost} />
                  <text fg={theme.textMuted}>v{Installation.VERSION}</text>
                </box>
              </box>
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
            </box>
          </Match>
          <Match when={true}>
            <box flexDirection={narrow() ? "column" : "row"} justifyContent="space-between" gap={1}>
              <Title session={session} />
              <box flexDirection="row" gap={1} flexShrink={0}>
                <ContextInfo context={context} cost={cost} />
                <text fg={theme.textMuted}>v{Installation.VERSION}</text>
              </box>
            </box>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
