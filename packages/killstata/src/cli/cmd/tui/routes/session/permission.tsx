import { createStore } from "solid-js/store"
import { createMemo, For, Match, Show, Switch } from "solid-js"
import { Portal, useKeyboard, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { useKeybind } from "../../context/keybind"
import { useTheme, selectedForeground } from "../../context/theme"
import type { PermissionRequest } from "@killstata/sdk/v2"
import { useSDK } from "../../context/sdk"
import { SplitBorder } from "../../component/border"
import { useSync } from "../../context/sync"
import { useTextareaKeybindings } from "../../component/textarea-keybindings"
import path from "path"
import { Keybind } from "@/util/keybind"
import { Global } from "@/global"

import { displayPath, isInternalWorkspacePath } from "@/tool/analysis-display"

type PermissionStage = "permission" | "always" | "reject"

function normalizePath(input?: string) {
  if (!input) return ""

  const cwd = process.cwd()
  const home = Global.Path.home
  const absolute = path.isAbsolute(input) ? input : path.resolve(cwd, input)
  // 内部工作区（.killstata）路径对用户隐身：权限提示里只显示文件名，不暴露内部目录结构。
  // absolute 由 input 解析而来，判定 absolute 即可覆盖两者。
  if (isInternalWorkspacePath(absolute)) return displayPath(absolute, "name")
  const relative = path.relative(cwd, absolute)

  if (!relative) return "."
  if (!relative.startsWith("..")) return relative

  // outside cwd - use ~ or absolute
  if (home && (absolute === home || absolute.startsWith(home + path.sep))) {
    return absolute.replace(home, "~")
  }
  return absolute
}

function EditBody(props: { request: PermissionRequest }) {
  const themeState = useTheme()
  const theme = themeState.theme

  const filepath = createMemo(() => (props.request.metadata?.filepath as string) ?? "")

  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" gap={1} paddingLeft={1}>
        <text fg={theme.textMuted}>{"→"}</text>
        <text fg={theme.textMuted}>编辑 {normalizePath(filepath())}</text>
      </box>
      <text fg={theme.textMuted}>确认后将写入该文件。</text>
    </box>
  )
}

function TextBody(props: { title: string; description?: string; icon?: string }) {
  const { theme } = useTheme()
  return (
    <>
      <box flexDirection="row" gap={1} paddingLeft={1}>
        <Show when={props.icon}>
          <text fg={theme.textMuted} flexShrink={0}>
            {props.icon}
          </text>
        </Show>
        <text fg={theme.textMuted}>{props.title}</text>
      </box>
      <Show when={props.description}>
        <box paddingLeft={1}>
          <text fg={theme.text}>{props.description}</text>
        </box>
      </Show>
    </>
  )
}

export function PermissionPrompt(props: { request: PermissionRequest }) {
  const sdk = useSDK()
  const sync = useSync()
  const [store, setStore] = createStore({
    stage: "permission" as PermissionStage,
  })

  const session = createMemo(() => sync.data.session.find((s) => s.id === props.request.sessionID))

  const input = createMemo(() => {
    const tool = props.request.tool
    if (!tool) return {}
    const parts = sync.data.part[tool.messageID] ?? []
    for (const part of parts) {
      if (part.type === "tool" && part.callID === tool.callID && part.state.status !== "pending") {
        return part.state.input ?? {}
      }
    }
    return {}
  })

  const { theme } = useTheme()

  return (
    <Switch>
      <Match when={store.stage === "always"}>
        <Prompt
          title="总是允许"
          body={
            <Switch>
              <Match when={props.request.always.length === 1 && props.request.always[0] === "*"}>
                <TextBody title={"将允许 " + props.request.permission + " 直到killstata重启。"} />
              </Match>
              <Match when={true}>
                <box paddingLeft={1} gap={1}>
                  <text fg={theme.textMuted}>将允许以下模式，直到killstata重启</text>
                  <box>
                    <For each={props.request.always}>
                      {(pattern) => (
                        <text fg={theme.text}>
                          {"- "}
                          {pattern}
                        </text>
                      )}
                    </For>
                  </box>
                </box>
              </Match>
            </Switch>
          }
          options={{ confirm: "确认", cancel: "取消" }}
          escapeKey="cancel"
          onSelect={(option) => {
            setStore("stage", "permission")
            if (option === "cancel") return
            sdk.client.permission.reply({
              reply: "always",
              requestID: props.request.id,
            })
          }}
        />
      </Match>
      <Match when={store.stage === "reject"}>
        <RejectPrompt
          onConfirm={(message) => {
            sdk.client.permission.reply({
              reply: "reject",
              requestID: props.request.id,
              message: message || undefined,
            })
          }}
          onCancel={() => {
            setStore("stage", "permission")
          }}
        />
      </Match>
      <Match when={store.stage === "permission"}>
        {(() => {
          const body = (
            <Prompt
              title="需要授权"
              body={
                <Switch>
                  <Match when={props.request.permission === "edit"}>
                    <EditBody request={props.request} />
                  </Match>
                  <Match when={props.request.permission === "read"}>
                    <TextBody icon="→" title={`读取 ` + normalizePath(input().filePath as string)} />
                  </Match>
                  <Match when={props.request.permission === "glob"}>
                    <TextBody icon="✱" title={`查找文件 "` + (input().pattern ?? "") + `"`} />
                  </Match>
                  <Match when={props.request.permission === "grep"}>
                    <TextBody icon="✱" title={`搜索内容 "` + (input().pattern ?? "") + `"`} />
                  </Match>
                  <Match when={props.request.permission === "list"}>
                    <TextBody icon="→" title={`列出目录 ` + normalizePath(input().path as string)} />
                  </Match>
                  <Match when={props.request.permission === "bash"}>
                    <TextBody
                      icon="#"
                      title={(input().description as string) ?? ""}
                      description={("$ " + input().command) as string}
                    />
                  </Match>
                  <Match when={props.request.permission === "task"}>
                    <TextBody
                      icon="#"
                      title={`${(input().subagent_type as string) ?? "unknown"} 子任务`}
                      description={"◉ " + input().description}
                    />
                  </Match>
                  <Match when={props.request.permission === "webfetch"}>
                    <TextBody icon="%" title={`联网获取 ` + (input().url ?? "")} />
                  </Match>
                  <Match when={props.request.permission === "websearch"}>
                    <TextBody icon="◈" title={`联网搜索 "` + (input().query ?? "") + `"`} />
                  </Match>
                  <Match when={props.request.permission === "codesearch"}>
                    <TextBody icon="◇" title={`代码搜索 "` + (input().query ?? "") + `"`} />
                  </Match>
                  <Match when={props.request.permission === "external_directory"}>
                    {(() => {
                      const meta = props.request.metadata ?? {}
                      const parent = typeof meta["parentDir"] === "string" ? meta["parentDir"] : undefined
                      const filepath = typeof meta["filepath"] === "string" ? meta["filepath"] : undefined
                      const pattern = props.request.patterns?.[0]
                      const derived =
                        typeof pattern === "string"
                          ? pattern.includes("*")
                            ? path.dirname(pattern)
                            : pattern
                          : undefined

                      const raw = parent ?? filepath ?? derived
                      const dir = normalizePath(raw)

                      return <TextBody icon="←" title={`访问外部目录 ` + dir} />
                    })()}
                  </Match>
                  <Match when={props.request.permission === "doom_loop"}>
                    <TextBody icon="⟳" title="连续失败后继续" />
                  </Match>
                  <Match when={true}>
                    <TextBody icon="⚙" title={`调用工具 ` + props.request.permission} />
                  </Match>
                </Switch>
              }
              options={{ once: "仅本次允许", always: "始终允许", reject: "拒绝" }}
              escapeKey="reject"
              fullscreen
              onSelect={(option) => {
                if (option === "always") {
                  setStore("stage", "always")
                  return
                }
                if (option === "reject") {
                  if (session()?.parentID) {
                    setStore("stage", "reject")
                    return
                  }
                  sdk.client.permission.reply({
                    reply: "reject",
                    requestID: props.request.id,
                  })
                  return
                }
                sdk.client.permission.reply({
                  reply: "once",
                  requestID: props.request.id,
                })
              }}
            />
          )

          return body
        })()}
      </Match>
    </Switch>
  )
}

function RejectPrompt(props: { onConfirm: (message: string) => void; onCancel: () => void }) {
  let input: TextareaRenderable
  const { theme } = useTheme()
  const keybind = useKeybind()
  const textareaKeybindings = useTextareaKeybindings()
  const dimensions = useTerminalDimensions()
  const narrow = createMemo(() => dimensions().width < 80)

  useKeyboard((evt) => {
    if (evt.name === "escape" || keybind.match("app_exit", evt)) {
      evt.preventDefault()
      props.onCancel()
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      props.onConfirm(input.plainText)
    }
  })

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.error}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <box flexDirection="row" gap={1} paddingLeft={1}>
          <text fg={theme.error}>{"△"}</text>
          <text fg={theme.text}>拒绝授权</text>
        </box>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>告诉killstata换种做法</text>
        </box>
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.backgroundElement}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
        gap={1}
      >
        <textarea
          ref={(val: TextareaRenderable) => (input = val)}
          focused
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.primary}
          keyBindings={textareaKeybindings()}
        />
        <box flexDirection="row" gap={2} flexShrink={0}>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>确认</span>
          </text>
          <text fg={theme.text}>
            esc <span style={{ fg: theme.textMuted }}>取消</span>
          </text>
        </box>
      </box>
    </box>
  )
}

function Prompt<const T extends Record<string, string>>(props: {
  title: string
  body: JSX.Element
  options: T
  escapeKey?: keyof T
  fullscreen?: boolean
  onSelect: (option: keyof T) => void
}) {
  const { theme } = useTheme()
  const keybind = useKeybind()
  const dimensions = useTerminalDimensions()
  const keys = Object.keys(props.options) as (keyof T)[]
  const [store, setStore] = createStore({
    selected: keys[0],
    expanded: false,
  })
  const diffKey = Keybind.parse("ctrl+f")[0]
  const narrow = createMemo(() => dimensions().width < 80)

  useKeyboard((evt) => {
    if (evt.name === "left" || evt.name == "h") {
      evt.preventDefault()
      const idx = keys.indexOf(store.selected)
      const next = keys[(idx - 1 + keys.length) % keys.length]
      setStore("selected", next)
    }

    if (evt.name === "right" || evt.name == "l") {
      evt.preventDefault()
      const idx = keys.indexOf(store.selected)
      const next = keys[(idx + 1) % keys.length]
      setStore("selected", next)
    }

    if (evt.name === "return") {
      evt.preventDefault()
      props.onSelect(store.selected)
    }

    if (props.escapeKey && (evt.name === "escape" || keybind.match("app_exit", evt))) {
      evt.preventDefault()
      props.onSelect(props.escapeKey)
    }

    if (props.fullscreen && diffKey && Keybind.match(diffKey, keybind.parse(evt))) {
      evt.preventDefault()
      evt.stopPropagation()
      setStore("expanded", (v) => !v)
    }
  })

  const hint = createMemo(() => (store.expanded ? "收起" : "全屏"))
  const renderer = useRenderer()

  const content = () => (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.warning}
      customBorderChars={SplitBorder.customBorderChars}
      {...(store.expanded
        ? { top: dimensions().height * -1 + 1, bottom: 1, left: 2, right: 2, position: "absolute" }
        : {
            top: 0,
            maxHeight: 15,
            bottom: 0,
            left: 0,
            right: 0,
            position: "relative",
          })}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1} flexGrow={1}>
        <box flexDirection="row" gap={1} paddingLeft={1} flexShrink={0}>
          <text fg={theme.warning}>{"△"}</text>
          <text fg={theme.text}>{props.title}</text>
        </box>
        {props.body}
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        gap={1}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.backgroundElement}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
      >
        <box flexDirection="row" gap={1} flexShrink={0}>
          <For each={keys}>
            {(option) => (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={option === store.selected ? theme.warning : theme.backgroundMenu}
                onMouseOver={() => setStore("selected", option)}
                onMouseUp={() => {
                  setStore("selected", option)
                  props.onSelect(option)
                }}
              >
                <text fg={option === store.selected ? selectedForeground(theme, theme.warning) : theme.textMuted}>
                  {props.options[option]}
                </text>
              </box>
            )}
          </For>
        </box>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <Show when={props.fullscreen}>
            <text fg={theme.text}>
              {"ctrl+f"} <span style={{ fg: theme.textMuted }}>{hint()}</span>
            </text>
          </Show>
          <text fg={theme.text}>
            {"⇆"} <span style={{ fg: theme.textMuted }}>选择</span>
          </text>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>确认</span>
          </text>
        </box>
      </box>
    </box>
  )

  return (
    <Show when={!store.expanded} fallback={<Portal>{content()}</Portal>}>
      {content()}
    </Show>
  )
}
