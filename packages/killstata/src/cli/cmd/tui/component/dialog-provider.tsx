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
        providers.filter((provider) => provider.id !== "killstata").filter((provider) => {
          if (!isUserSelectableProvider(provider)) return false
          const methods = sync.data.provider_auth[provider.id] ?? []
          return supportsApiKeyProvider(provider, methods)
        }),
      sortBy(
        (x) => providerPriority(x.id),
        (x) => x.name,
      ),
      map((provider) => {
        const isConnected = connected().has(provider.id)
        return {
          title: provider.name,
          value: provider.id,
          description: "(API key)",
          category: isPopularProvider(provider.id) ? "Popular" : "Other",
          footer: isConnected ? "Connected" : undefined,
          async onSelect() {
            const methods = (sync.data.provider_auth[provider.id] ?? []).filter((method) => method.type === "api")
            const apiMethods = methods.length
              ? methods
              : [
              {
                type: "api",
                label: "API key",
              },
            ]
            let index: number | null = 0
            if (apiMethods.length > 1) {
              index = await new Promise<number | null>((resolve) => {
                dialog.replace(
                  () => (
                    <DialogSelect
                      title="Select auth method"
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
              return dialog.replace(() => <ApiMethod providerID={provider.id} title={method.label} />)
            }
          },
        }
      }),
    )
    listed.push({
      title: "Custom OpenAI-compatible provider",
      value: "__custom__",
      description: "(API key + base URL)",
      category: "Other",
      footer: undefined,
      async onSelect() {
        const providerName = await DialogPrompt.show(dialog, "Provider name", {
          placeholder: "My Provider",
        })
        if (!providerName?.trim()) return

        const providerID = await DialogPrompt.show(dialog, "Provider id", {
          value: normalizeProviderID(providerName),
          placeholder: "my-provider",
          description: () => <text>Use lowercase letters, numbers, and hyphens.</text>,
        })
        const normalizedProviderID = normalizeProviderID(providerID ?? "")
        if (!normalizedProviderID) return

        const baseURL = await DialogPrompt.show(dialog, "Provider base URL", {
          placeholder: "https://api.example.com/v1",
          description: () => <text>Killstata treats this as an OpenAI-compatible API endpoint.</text>,
        })
        if (!baseURL?.trim()) return

        try {
          const url = new URL(normalizeBaseURL(baseURL))
          if (!/^https?:$/.test(url.protocol)) return
        } catch {
          return
        }

        const modelID = await DialogPrompt.show(dialog, "Default model id", {
          placeholder: "gpt-4.1-mini",
          description: () => <text>Use the exact model id provided by this vendor.</text>,
        })
        if (!modelID?.trim()) return

        const key = await DialogPrompt.show(dialog, "API key", {
          placeholder: "sk-...",
          description: () => <text>Subscription logins are disabled here. API key only.</text>,
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
      title={`Connect a provider (API key only, ${options().length} options)`}
      placeholder="Search all providers"
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
        .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
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
      placeholder="Authorization code"
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
}
function ApiMethod(props: ApiMethodProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()

  return (
    <DialogPrompt
      title={props.title}
      placeholder="API key"
      description={() => <text>Paste your API key. Subscription logins are not supported in this build.</text>}
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
