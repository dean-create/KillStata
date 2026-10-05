import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useSync } from "@tui/context/sync"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { ProviderAuthAuthorization } from "@killstata/sdk/v2"
import { DialogModel } from "./dialog-model"
import { useKeyboard } from "@opentui/solid"
import { Clipboard } from "@tui/util/clipboard"
import { useToast } from "../ui/toast"
import {
  buildCustomProviderConfig,
  isPopularProvider,
  normalizeApiKey,
  normalizeBaseURL,
  normalizeProviderID,
  providerDisplayDescription,
  providerDisplayName,
  providerDisplayNote,
  providerPriority,
  supportsApiKeyProvider,
  isUserSelectableProvider,
} from "../../../../provider/provider-catalog"

export function createDialogProviderOptions() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const connected = createMemo(() => new Set(sync.data.provider_next.connected))
  const options = createMemo(() => {
    const listed = pipe(
      sync.data.provider_next.all,
      (providers) =>
        providers
          .filter((provider) => provider.id !== "killstata")
          .filter((provider) => {
            if (!isUserSelectableProvider(provider)) return false
            const methods = sync.data.provider_auth[provider.id] ?? []
            return supportsApiKeyProvider(provider, methods)
          }),
      sortBy(
        (x) => providerPriority(x.id),
        (x) => providerDisplayName(x),
      ),
      map((provider) => {
        const isConnected = connected().has(provider.id)
        const note = providerDisplayNote(provider)
        return {
          title: providerDisplayName(provider),
          value: provider.id,
          description: providerDisplayDescription(provider),
          category: isPopularProvider(provider.id) ? "常用" : "其他",
          footer: isConnected ? `已连接${note ? ` | ${note}` : ""}` : note,
          async onSelect() {
            const methods = (sync.data.provider_auth[provider.id] ?? []).filter((method) => method.type === "api")
            const apiMethods = methods.length
              ? methods
              : [
                  {
                    type: "api",
                    label: "api key",
                  },
                ]
            let index: number | null = 0
            if (apiMethods.length > 1) {
              index = await new Promise<number | null>((resolve) => {
                dialog.replace(
                  () => (
                    <DialogSelect
                      title="选择认证方式"
                      options={apiMethods.map((x, index) => ({
                        title: x.label,
                        value: index,
                      }))}
                      onSelect={(option) => resolve(option.value)}
                    />
                  ),
                  () => resolve(null),
                )
              })
            }
            if (index == null) return
            const method = apiMethods[index]
            if (method.type === "api") {
              return dialog.replace(() => (
                <ApiMethod
                  providerID={provider.id}
                  title={`${providerDisplayName(provider)} ${method.label}`}
                  description={providerDisplayDescription(provider)}
                  note={providerDisplayNote(provider)}
                />
              ))
            }
          },
        }
      }),
    )
    listed.push({
      title: "自定义 OpenAI 兼容提供商",
      value: "__custom__",
      description: "(API key + base URL)",
      category: "其他",
      footer: "",
      async onSelect() {
        const providerName = await DialogPrompt.show(dialog, "提供商名称", {
          placeholder: "我的提供商",
        })
        if (!providerName?.trim()) return

        const providerID = await DialogPrompt.show(dialog, "Provider id", {
          value: normalizeProviderID(providerName),
          placeholder: "my-provider",
          description: () => <text>只能用小写字母、数字和连字符。</text>,
        })
        const normalizedProviderID = normalizeProviderID(providerID ?? "")
        if (!normalizedProviderID) return

        const baseURL = await DialogPrompt.show(dialog, "提供商 base URL", {
          placeholder: "https://api.example.com/v1",
          description: () => <text>killstata 会把它当作 OpenAI 兼容的 API 端点。</text>,
        })
        if (!baseURL?.trim()) return

        try {
          const url = new URL(normalizeBaseURL(baseURL))
          if (!/^https?:$/.test(url.protocol)) return
        } catch {
          return
        }

        const modelID = await DialogPrompt.show(dialog, "默认模型 id", {
          placeholder: "gpt-4.1-mini",
          description: () => <text>填写该厂商提供的准确模型 id。</text>,
        })
        if (!modelID?.trim()) return

        const key = await DialogPrompt.show(dialog, "api key", {
          placeholder: "sk-...",
          description: () => <text>这里不支持订阅登录，只能用 api key。</text>,
        })
        const normalizedKey = normalizeApiKey(key ?? "")
        if (!normalizedKey) return

        await sdk.client.config.update({
          config: {
            provider: buildCustomProviderConfig({
              providerID: normalizedProviderID,
              providerName: providerName.trim(),
              baseURL,
              modelID: modelID.trim(),
            }),
          },
        })
        await sdk.client.auth.set({
          providerID: normalizedProviderID,
          auth: {
            type: "api",
            key: normalizedKey,
          },
        })
        await sdk.client.instance.dispose()
        await sync.bootstrap()
        dialog.replace(() => <DialogModel providerID={normalizedProviderID} />)
      },
    })
    return listed
  })
  return options
}

export function DialogProvider() {
  const options = createDialogProviderOptions()
  return (
    <DialogSelect
      title={`高级提供商设置（${options().length} 项）`}
      placeholder="选择提供商"
      options={options()}
      scrollbarVisible
    />
  )
}

interface AutoMethodProps {
  index: number
  providerID: string
  title: string
  authorization: ProviderAuthAuthorization
}
function AutoMethod(props: AutoMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const sync = useSync()
  const toast = useToast()

  useKeyboard((evt) => {
    if (evt.name === "c" && !evt.ctrl && !evt.meta) {
      const code = props.authorization.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/)?.[0] ?? props.authorization.url
      Clipboard.copy(code)
        .then(() => toast.show({ message: "已复制到剪贴板", variant: "info" }))
        .catch(toast.error)
    }
  })

  onMount(async () => {
    const result = await sdk.client.provider.oauth.callback({
      providerID: props.providerID,
      method: props.index,
    })
    if (result.error) {
      dialog.clear()
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.replace(() => <DialogModel providerID={props.providerID} />)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <box gap={1}>
        <Link href={props.authorization.url} fg={theme.primary} />
        <text fg={theme.textMuted}>{props.authorization.instructions}</text>
      </box>
      <text fg={theme.textMuted}>Waiting for authorization...</text>
      <text fg={theme.text}>
        c <span style={{ fg: theme.textMuted }}>copy</span>
      </text>
    </box>
  )
}

interface CodeMethodProps {
  index: number
  title: string
  providerID: string
  authorization: ProviderAuthAuthorization
}
function CodeMethod(props: CodeMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const [error, setError] = createSignal(false)

  return (
    <DialogPrompt
      title={props.title}
      placeholder="授权码"
      onConfirm={async (value) => {
        const { error } = await sdk.client.provider.oauth.callback({
          providerID: props.providerID,
          method: props.index,
          code: value,
        })
        if (!error) {
          await sdk.client.instance.dispose()
          await sync.bootstrap()
          dialog.replace(() => <DialogModel providerID={props.providerID} />)
          return
        }
        setError(true)
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>{props.authorization.instructions}</text>
          <Link href={props.authorization.url} fg={theme.primary} />
          <Show when={error()}>
            <text fg={theme.error}>Invalid code</text>
          </Show>
        </box>
      )}
    />
  )
}

interface ApiMethodProps {
  providerID: string
  title: string
  description?: string
  note?: string
}
function ApiMethod(props: ApiMethodProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()

  return (
    <DialogPrompt
      title={props.title}
      placeholder="api key"
      description={() => (
        <box gap={1}>
          <text>粘贴你的 api key。此版本不支持订阅登录。</text>
          <Show when={props.description}>
            <text>{props.description}</text>
          </Show>
          <Show when={props.note}>
            <text>{props.note}</text>
          </Show>
        </box>
      )}
      onConfirm={async (value) => {
        const key = normalizeApiKey(value)
        if (!key) return
        await sdk.client.auth.set({
          providerID: props.providerID,
          auth: {
            type: "api",
            key,
          },
        })
        await sdk.client.instance.dispose()
        await sync.bootstrap()
        dialog.replace(() => <DialogModel providerID={props.providerID} />)
      }}
    />
  )
}
