import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, test, vi } from "vitest"
import App from "./App"
import { createDemoEngine } from "./engine/client"
import type { ModelProfileMutation, ModelProfilesSnapshot } from "./credentials"
import { createTauriUiPreferencesStore } from "./tauri-ui-preferences"
import { createTauriCredentialStore } from "./tauri-credentials"
import { createTauriWorkspaceStore } from "./tauri-workspace-store"
import { createLocalWorkspaceStore } from "./workspace-store"
import { createWebUiPreferencesStore } from "./web/ui-preferences"
import { createWebCredentialStore } from "./web/credential-store"
import { PYTHON_RUNTIME_PACKAGES } from "./provider-config"
import { createCoreRuntimeDiagnosticsAdapter } from "./core/runtime-diagnostics"
import { createWebRuntimeDiagnostics } from "./web/runtime-diagnostics"
import type { Event } from "@killstata/sdk/v2/client"
import { createCoreEngineAdapter } from "./core/engine-adapter"
import type { CoreSessionClient } from "./core/client"
import { HttpEngineClient } from "./engine/client"

let restoreDownloadAPIs: (() => void) | undefined

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  restoreDownloadAPIs?.()
  restoreDownloadAPIs = undefined
})

function freshLocalStorage() {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() { return values.size },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    } as Storage,
  })
}

function captureSettingsSurface() {
  const settings = screen.getByRole("dialog", { name: "设置" })
  const content = settings.querySelector<HTMLElement>(".settings-content")!
  return {
    text: content.textContent?.replace(/\s+/g, " ").trim(),
    controls: [...content.querySelectorAll<HTMLElement>("button, input, select")].map((control) => {
      const input = control instanceof HTMLInputElement ? control : undefined
      const select = control instanceof HTMLSelectElement ? control : undefined
      return {
        tag: control.tagName.toLowerCase(),
        role: control.getAttribute("role"),
        name: control.getAttribute("aria-label") ?? control.textContent?.replace(/\s+/g, " ").trim(),
        disabled: "disabled" in control ? Boolean((control as HTMLButtonElement).disabled) : false,
        checked: input?.type === "checkbox" ? input.checked : undefined,
        value: input ? input.type === "password" ? Boolean(input.value) : input.value : select?.value,
        placeholder: input?.placeholder,
        pressed: control.getAttribute("aria-pressed"),
        current: control.getAttribute("aria-current"),
      }
    }),
  }
}

describe("Desktop and connected-Web shared App parity", () => {
  test("presents the same connected settings and composer controls through Tauri and Web preference adapters", async () => {
    const captures: Array<{ settingsControls: unknown[]; theme: string; reasoning: string; permission: string }> = []
    const savedPermissionModes: string[] = []
    const adapters = [
      createTauriUiPreferencesStore(async (command, args) => {
        if (command === "load_ui_preferences") return { theme: "dark", reasoningEffort: "high", permissionMode: "read_only" }
        if (command === "save_ui_preference") {
          if (args?.key === "permissionMode") savedPermissionModes.push(String(args.value))
          return { saved: true }
        }
        throw new Error(`unexpected native UI preference command ${command}`)
      }),
      createWebUiPreferencesStore(async (_input, init) => {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>
          if (body.key === "permissionMode") savedPermissionModes.push(String(body.value))
          return Response.json({ protocolVersion: "v2", saved: true })
        }
        return Response.json({ protocolVersion: "v2", preferences: { theme: "dark", reasoningEffort: "high", permissionMode: "read_only" } })
      }),
    ]

    for (const uiPreferences of adapters) {
      cleanup()
      freshLocalStorage()
      const user = userEvent.setup()
      render(() => <App
        engine={createDemoEngine()}
        credentials={{ hasApiKey: async () => true, prepareEngineForAnalysis: async () => {} }}
        uiPreferences={uiPreferences}
        mode="connected"
        requireApiKey
        workspacePicker={async () => undefined}
        workspaceFilePicker={async () => undefined}
      />)
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "推理等级 High" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "工具授权：只读分析" })).toBeTruthy()
      })
      await user.keyboard("{Meta>}{,}{/Meta}")
      const dialog = screen.getByRole("dialog", { name: "设置" })
      const settingsControls = [...dialog.querySelectorAll("button, [role='checkbox']")].map((control) => ({
        role: control.getAttribute("role") ?? "button",
        name: control.getAttribute("aria-label") ?? control.textContent?.trim(),
        disabled: control.hasAttribute("disabled"),
        pressed: control.getAttribute("aria-pressed"),
      }))
      expect(screen.getByRole("button", { name: "深色" }).getAttribute("aria-pressed")).toBe("true")
      await user.click(screen.getByRole("button", { name: "浅色" }))
      expect(document.documentElement.dataset.theme).toBe("light")
      await user.click(screen.getByRole("button", { name: "关闭设置" }))
      await user.click(screen.getByRole("button", { name: "推理等级 High" }))
      await user.click(screen.getByRole("option", { name: "Medium" }))
      await user.click(screen.getByRole("button", { name: "工具授权：只读分析" }))
      await user.click(screen.getByRole("option", { name: /完全访问/ }))
      captures.push({
        settingsControls,
        theme: document.documentElement.dataset.theme ?? "",
        reasoning: screen.getByRole("button", { name: "推理等级 Medium" }).getAttribute("aria-label") ?? "",
        permission: screen.getByRole("button", { name: "工具授权：完全访问" }).getAttribute("aria-label") ?? "",
      })
    }

    expect(captures).toHaveLength(2)
    expect(savedPermissionModes).toEqual(["full_access", "full_access"])
    expect(captures[0]).toEqual(captures[1])
  })

  test("shows the same retained local preference and sync warning when Tauri and Web saves fail", async () => {
    const captures: Array<{ settings: ReturnType<typeof captureSettingsSurface>; theme: string; warning: string }> = []
    const writes: Array<{ key: unknown; value: unknown }> = []
    const shared = { theme: "dark", reasoningEffort: "high", permissionMode: "read_only" }
    const adapters = [
      createTauriUiPreferencesStore(async (command, args) => {
        if (command === "load_ui_preferences") return shared
        if (command === "save_ui_preference") {
          writes.push({ key: args?.key, value: args?.value })
          throw new Error("disk unavailable")
        }
        throw new Error(`unexpected native UI preference command ${command}`)
      }),
      createWebUiPreferencesStore(async (_input, init) => {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>
          writes.push({ key: body.key, value: body.value })
          return Response.json({ protocolVersion: "v2", code: "ui_preferences_unavailable", message: "disk unavailable" }, { status: 500 })
        }
        return Response.json({ protocolVersion: "v2", preferences: shared })
      }),
    ]

    for (const uiPreferences of adapters) {
      cleanup()
      freshLocalStorage()
      const user = userEvent.setup()
      render(() => <App
        engine={createDemoEngine()}
        credentials={{ hasApiKey: async () => true, prepareEngineForAnalysis: async () => {} }}
        uiPreferences={uiPreferences}
        mode="connected"
        requireApiKey
      />)
      await waitFor(() => expect(screen.getByRole("button", { name: "推理等级 High" })).toBeTruthy())
      await user.keyboard("{Meta>}{,}{/Meta}")
      await user.click(screen.getByRole("button", { name: "浅色" }))
      const warning = await screen.findByRole("status", { name: "共享偏好同步失败" })
      captures.push({
        settings: captureSettingsSurface(),
        theme: document.documentElement.dataset.theme ?? "",
        warning: warning.textContent ?? "",
      })
    }

    expect(writes).toEqual([
      { key: "theme", value: "light" },
      { key: "theme", value: "light" },
    ])
    expect(captures).toHaveLength(2)
    expect(captures[0]).toEqual(captures[1])
    expect(captures[0]?.theme).toBe("light")
    expect(captures[0]?.warning).toBe("无法同步到另一个 KillStata 界面，本地设置已保留。")
  })

  test("keeps the model profile setup and lifecycle identical through Tauri and Web credential adapters", async () => {
    const captures: unknown[] = []
    const savedApiKeys: Array<string | undefined> = []

    for (const surface of ["tauri", "web"] as const) {
      cleanup()
      freshLocalStorage()
      const user = userEvent.setup()
      let snapshot: ModelProfilesSnapshot = { profiles: [], defaultProfileId: null }
      const save = (input: Record<string, unknown>): ModelProfileMutation => {
        const config = input.config as { provider: "deepseek"; model: string }
        const profileId = String(input.profileId)
        const apiKey = typeof input.apiKey === "string" ? input.apiKey : undefined
        if (apiKey) savedApiKeys.push(apiKey)
        const existing = snapshot.profiles.find((profile) => profile.id === profileId)
        const previousDefaultProfileId = snapshot.defaultProfileId
        const profile = {
          id: profileId,
          displayName: typeof input.displayName === "string" ? input.displayName : null,
          provider: config.provider,
          model: config.model,
          configured: apiKey ? true : existing?.configured ?? false,
          isDefault: false,
        }
        const profiles = existing
          ? snapshot.profiles.map((item) => item.id === profileId ? profile : item)
          : [...snapshot.profiles, profile]
        const defaultProfileId = input.makeDefault === true ? profileId : snapshot.defaultProfileId
        snapshot = {
          profiles: profiles.map((item) => ({ ...item, isDefault: item.id === defaultProfileId })),
          defaultProfileId,
        }
        return { profileId, snapshot, activeChanged: previousDefaultProfileId !== defaultProfileId }
      }
      const setDefault = (profileID: string): ModelProfileMutation => {
        const activeChanged = snapshot.defaultProfileId !== profileID
        snapshot = {
          profiles: snapshot.profiles.map((profile) => ({ ...profile, isDefault: profile.id === profileID })),
          defaultProfileId: profileID,
        }
        return { profileId: profileID, snapshot, activeChanged }
      }
      const removeProfile = (profileID: string): ModelProfileMutation => {
        const activeChanged = snapshot.defaultProfileId === profileID
        snapshot = {
          profiles: snapshot.profiles.filter((profile) => profile.id !== profileID),
          defaultProfileId: activeChanged ? null : snapshot.defaultProfileId,
        }
        return { profileId: profileID, snapshot, activeChanged }
      }

      const credentials = surface === "tauri"
        ? createTauriCredentialStore(async (command, args) => {
            if (command === "list_provider_profiles") return snapshot
            if (command === "save_provider_profile") return save(args ?? {})
            if (command === "set_default_provider_profile") return setDefault(String(args?.profileId))
            if (command === "delete_provider_profile") return removeProfile(String(args?.profileId))
            if (command === "refresh_core_credentials") return undefined
            throw new Error(`unexpected Tauri credential command ${command}`)
          })
        : createWebCredentialStore(async (input, init) => {
            const url = String(input)
            const method = init?.method ?? "GET"
            if (url === "/api/v2/credentials/profiles" && method === "GET") return Response.json(snapshot)
            if (url === "/api/v2/credentials/profiles" && method === "POST") {
              return Response.json(save(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>))
            }
            if (url === "/api/v2/credentials/default" && method === "POST") {
              const body = JSON.parse(String(init?.body ?? "{}")) as { profileId?: string }
              return Response.json(setDefault(String(body.profileId)))
            }
            const removeMatch = url.match(/^\/api\/v2\/credentials\/profiles\/([^/]+)$/)
            if (removeMatch && method === "DELETE") return Response.json(removeProfile(decodeURIComponent(removeMatch[1]!)))
            if (url === "/api/v2/credentials/activate" && method === "POST") return Response.json({ activated: true })
            throw new Error(`unexpected Web credential request ${method} ${url}`)
          })

      render(() => <App
        engine={createDemoEngine()}
        credentials={credentials}
        initialUiPreferences={{ theme: "dark", reasoningEffort: "high" }}
        mode="connected"
        requireApiKey
        workspacePicker={async () => undefined}
        workspaceFilePicker={async () => undefined}
      />)

      await waitFor(() => expect(screen.getByRole("button", { name: "推理等级 High" })).toBeTruthy())
      await user.keyboard("{Meta>}{,}{/Meta}")
      await user.click(screen.getByRole("button", { name: "模型管理" }))
      await screen.findByText("还没有配置模型")
      const emptyList = captureSettingsSurface()

      await user.click(screen.getByRole("button", { name: /配置模型/ }))
      await screen.findByRole("dialog", { name: "选择服务商协议" })
      const providerPicker = captureSettingsSurface()

      await user.click(screen.getByRole("button", { name: "选择 DeepSeek" }))
      await screen.findByRole("dialog", { name: "配置 DeepSeek" })
      await user.type(screen.getByLabelText("档案名称（可选）"), "Parity profile")
      const model = screen.getByLabelText("DeepSeek 模型") as HTMLSelectElement
      await user.selectOptions(model, model.options[1]!.value)
      await user.type(screen.getByLabelText("API Key"), "sk-parity-test")
      const configure = captureSettingsSurface()

      await user.click(screen.getByRole("button", { name: "保存模型配置" }))
      await screen.findByText("Parity profile")
      expect(document.body.textContent).not.toContain("sk-parity-test")
      const savedFirstProfile = captureSettingsSurface()

      await user.click(screen.getByRole("button", { name: /配置模型/ }))
      await user.click(screen.getByRole("button", { name: "选择 DeepSeek" }))
      await screen.findByRole("dialog", { name: "配置 DeepSeek" })
      await user.type(screen.getByLabelText("档案名称（可选）"), "Parity backup")
      const backupModel = screen.getByLabelText("DeepSeek 模型") as HTMLSelectElement
      await user.selectOptions(backupModel, backupModel.options[0]!.value)
      await user.type(screen.getByLabelText("API Key"), "sk-parity-backup")
      const backupConfiguration = captureSettingsSurface()
      await user.click(screen.getByRole("button", { name: "保存模型配置" }))
      await screen.findByText("Parity backup")
      expect(document.body.textContent).not.toContain("sk-parity-backup")
      const twoProfiles = captureSettingsSurface()

      await user.click(screen.getByRole("button", { name: /将 Parity backup .*设为默认/ }))
      await waitFor(() => expect(screen.getByRole("button", { name: /将 Parity profile .*设为默认/ })).toBeTruthy())
      const changedDefault = captureSettingsSurface()

      await user.click(screen.getByRole("button", { name: /编辑 Parity profile/ }))
      await screen.findByRole("dialog", { name: "编辑模型配置" })
      const nameInput = screen.getByLabelText("档案名称（可选）")
      await user.clear(nameInput)
      await user.type(nameInput, "Parity revised")
      const editingProfile = captureSettingsSurface()
      await user.click(screen.getByRole("button", { name: "保存模型配置" }))
      await screen.findByText("Parity revised")
      const editedProfile = captureSettingsSurface()

      await user.click(screen.getByRole("button", { name: /移除 Parity revised/ }))
      await screen.findByRole("group", { name: "确认移除模型" })
      const deleteConfirmation = captureSettingsSurface()
      await user.click(screen.getByRole("button", { name: "取消" }))
      const deleteCancelled = captureSettingsSurface()
      await user.click(screen.getByRole("button", { name: /移除 Parity revised/ }))
      await user.click(screen.getByRole("button", { name: "确认移除模型" }))
      await waitFor(() => expect(screen.queryByText("Parity revised")).toBeNull())
      const removedProfile = captureSettingsSurface()
      await user.click(screen.getByRole("button", { name: "关闭设置" }))
      const defaultModelControl = screen.getByRole("button", { name: "模型 deepseek-v4-flash" }).getAttribute("aria-label")

      captures.push({
        emptyList,
        providerPicker,
        configure,
        savedFirstProfile,
        backupConfiguration,
        twoProfiles,
        changedDefault,
        editingProfile,
        editedProfile,
        deleteConfirmation,
        deleteCancelled,
        removedProfile,
        defaultModelControl,
      })
    }

    expect(savedApiKeys).toEqual(["sk-parity-test", "sk-parity-backup", "sk-parity-test", "sk-parity-backup"])
    expect(captures[0]).toEqual(captures[1])
  })

  test("keeps Core-unavailable feedback and retry recovery identical through Core and Web health adapters", async () => {
    const captures: unknown[] = []
    const healthCalls = { tauri: 0, web: 0 }
    const eventSource = (url: URL) => ({
      url,
      onmessage: null as ((event: MessageEvent<string>) => void) | null,
      onerror: null as (() => void) | null,
      close() {},
    })

    for (const surface of ["tauri", "web"] as const) {
      cleanup()
      freshLocalStorage()
      const user = userEvent.setup()
      let ready = false
      const engine = surface === "tauri"
        ? createCoreEngineAdapter({
            subscribe: () => () => {},
            health: async () => {
              healthCalls.tauri += 1
              return { data: { version: "parity-core", healthy: ready } }
            },
            commands: async () => ({ data: [] }),
          } as unknown as CoreSessionClient)
        : new HttpEngineClient("/api", async (input) => {
            const url = new URL(String(input), "http://localhost")
            if (url.pathname === "/api/v2/health") {
              healthCalls.web += 1
              return Response.json({
                protocolVersion: "v2", engineVersion: "parity-core", status: ready ? "ready" : "unavailable",
                capabilities: { structuredSteps: true, interactive: true },
              })
            }
            if (url.pathname === "/api/v2/commands") return Response.json({ protocolVersion: "v2", commands: [] })
            return Response.json({ protocolVersion: "v2", code: "not_found", message: `Unhandled route ${url.pathname}` }, { status: 404 })
          }, undefined, eventSource, "v2")

      render(() => <App
        engine={engine}
        credentials={{ hasApiKey: async () => true }}
        initialUiPreferences={{ theme: "dark", reasoningEffort: "high" }}
        mode="connected"
        requireApiKey
      />)
      await screen.findByText("分析核心未能就绪")
      const unavailable = {
        statusClass: screen.getByRole("status", { name: "分析核心不可用" }).className,
        feedback: screen.getByRole("status", { name: "分析核心状态提示" }).textContent?.replace(/\s+/g, " ").trim(),
        retryLabel: screen.getByRole("button", { name: "重试" }).textContent?.trim(),
        composerButtons: [...document.querySelectorAll<HTMLButtonElement>(".composer button")].map((button) => ({
          label: button.getAttribute("aria-label") ?? button.textContent?.replace(/\s+/g, " ").trim(),
          disabled: button.disabled,
        })),
      }

      ready = true
      await user.click(screen.getByRole("button", { name: "重试" }))
      await screen.findByRole("status", { name: "分析核心就绪" })
      const recovered = {
        statusClass: screen.getByRole("status", { name: "分析核心就绪" }).className,
        feedback: screen.queryByRole("status", { name: "分析核心状态提示" })?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        composerButtons: [...document.querySelectorAll<HTMLButtonElement>(".composer button")].map((button) => ({
          label: button.getAttribute("aria-label") ?? button.textContent?.replace(/\s+/g, " ").trim(),
          disabled: button.disabled,
        })),
      }
      expect(healthCalls[surface]).toBe(2)
      captures.push({ unavailable, recovered })
    }

    expect(captures[0]).toEqual(captures[1])
  })

  test("keeps engine slash-command suggestions, keyboard highlight, and selection identical across adapters", async () => {
    const captures: unknown[] = []
    const commandCalls = { tauri: 0, web: 0 }
    const commands = [
      { name: "shared-diagnostic", description: "查看共享研究诊断" },
      { name: "shared-export", description: "导出共享研究结果" },
    ]

    for (const surface of ["tauri", "web"] as const) {
      cleanup()
      freshLocalStorage()
      const user = userEvent.setup()
      const engine = surface === "tauri"
        ? createCoreEngineAdapter({
            subscribe: () => () => {},
            health: async () => ({ data: { version: "slash-parity-core", healthy: true } }),
            commands: async () => {
              commandCalls.tauri += 1
              return { data: commands }
            },
          } as unknown as CoreSessionClient)
        : new HttpEngineClient("/api", async (input) => {
            const url = new URL(String(input), "http://localhost")
            if (url.pathname === "/api/v2/health") return Response.json({
              protocolVersion: "v2", engineVersion: "slash-parity-core", status: "ready",
              capabilities: { structuredSteps: true, interactive: true },
            })
            if (url.pathname === "/api/v2/commands") {
              commandCalls.web += 1
              return Response.json({ protocolVersion: "v2", commands })
            }
            return Response.json({ protocolVersion: "v2", code: "not_found", message: `Unhandled route ${url.pathname}` }, { status: 404 })
          }, undefined, (url) => ({
            url,
            onmessage: null,
            onerror: null,
            close() {},
          }), "v2")

      render(() => <App
        engine={engine}
        credentials={{ hasApiKey: async () => true }}
        initialUiPreferences={{ theme: "dark", reasoningEffort: "high" }}
        mode="connected"
        requireApiKey
      />)
      await screen.findByRole("status", { name: "分析核心就绪" })
      await waitFor(() => expect(commandCalls[surface]).toBeGreaterThan(0))
      const prompt = screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement
      await user.type(prompt, "/shared")
      await screen.findByRole("listbox", { name: "斜杠命令" })
      const commandMenu = () => {
        const menu = screen.getByRole("listbox", { name: "斜杠命令" })
        return [...menu.querySelectorAll<HTMLButtonElement>("[role='option']")].map((option) => ({
          name: option.querySelector(".slash-name")?.textContent?.trim(),
          description: option.querySelector(".slash-description")?.textContent?.replace(/\s+/g, " ").trim(),
          selected: option.getAttribute("aria-selected"),
        }))
      }
      const initialMenu = commandMenu()
      await user.keyboard("{ArrowDown}")
      const movedSelection = commandMenu()
      await user.keyboard("{ArrowUp}")
      const restoredSelection = commandMenu()
      await user.click(screen.getByRole("option", { name: /\/shared-diagnostic/ }))
      captures.push({
        initialMenu,
        movedSelection,
        restoredSelection,
        prompt: prompt.value,
        menuClosed: screen.queryByRole("listbox", { name: "斜杠命令" }) === null,
      })
    }

    expect(commandCalls).toEqual({ tauri: 1, web: 1 })
    expect(captures[0]).toEqual(captures[1])
  })

  test("projects the same oversized-file failure through Core submission and Web upload adapters", async () => {
    const captures: unknown[] = []
    let corePromptCalls = 0
    let webUploadCalls = 0
    let webRunCalls = 0

    for (const surface of ["tauri", "web"] as const) {
      cleanup()
      freshLocalStorage()
      let coreListener: ((event: Event) => void) | undefined
      const core = {
        subscribe(listener: (event: Event) => void) {
          coreListener = listener
          return () => { if (coreListener === listener) coreListener = undefined }
        },
        whenEventStreamReady: async () => {},
        health: async () => ({ data: { version: "upload-error-parity", healthy: true } }),
        commands: async () => ({ data: [] }),
        createSession: async () => ({ id: "core-upload-error" }),
        prompt: async () => {
          corePromptCalls += 1
          throw new Error("payload too large")
        },
      } as unknown as CoreSessionClient
      const engine = surface === "tauri"
        ? createCoreEngineAdapter(core)
        : new HttpEngineClient("/api", async (input, init) => {
            const url = new URL(String(input), "http://localhost")
            const method = init?.method ?? "GET"
            if (url.pathname === "/api/v2/health") return Response.json({
              protocolVersion: "v2", engineVersion: "upload-error-parity", status: "ready",
              capabilities: { structuredSteps: true, interactive: true },
            })
            if (url.pathname === "/api/v2/commands") return Response.json({ protocolVersion: "v2", commands: [] })
            if (url.pathname === "/api/v2/datasets" && method === "POST") {
              webUploadCalls += 1
              return Response.json({ protocolVersion: "v2", code: "dataset_too_large", message: "payload too large" }, { status: 413 })
            }
            if (url.pathname === "/api/v2/runs" && method === "POST") {
              webRunCalls += 1
              return Response.json({ protocolVersion: "v2", runId: "unexpected-run" })
            }
            return Response.json({ protocolVersion: "v2", code: "not_found", message: `Unhandled route ${url.pathname}` }, { status: 404 })
          }, undefined, (url) => ({
            url,
            onmessage: null,
            onerror: null,
            close() {},
          }), "v2")

      render(() => <App
        engine={engine}
        credentials={{ hasApiKey: async () => true, prepareEngineForAnalysis: async () => {} }}
        initialUiPreferences={{ theme: "dark", reasoningEffort: "high" }}
        mode="connected"
        requireApiKey
      />)
      await screen.findByRole("status", { name: "分析核心就绪" })
      const file = new File(["id,y\n1,2\n"], "too-large.csv", { type: "text/csv" })
      Object.defineProperty(file, "arrayBuffer", {
        value: async () => new TextEncoder().encode("id,y\n1,2\n").buffer as ArrayBuffer,
      })
      fireEvent.change(screen.getByLabelText("数据文件选择器"), { target: { files: [file] } })
      await userEvent.setup().type(screen.getByRole("textbox", { name: "研究问题" }), "估计处理效应")
      await userEvent.setup().click(screen.getByRole("button", { name: "发送" }))

      await screen.findByRole("status", { name: "分析提交提示" })
      const thread = screen.getByRole("log", { name: "分析对话" })
      captures.push({
        messages: [...thread.querySelectorAll<HTMLElement>(".message")].map((message) => ({
          className: message.className,
          text: message.textContent?.replace(/\s+/g, " ").trim(),
        })),
        attachment: screen.getByRole("status", { name: "已选择数据文件" }).textContent?.replace(/\s+/g, " ").trim(),
        feedback: screen.getByRole("status", { name: "分析提交提示" }).textContent?.replace(/\s+/g, " ").trim(),
        composerButtons: [...document.querySelectorAll<HTMLButtonElement>(".composer button")].map((button) => ({
          label: button.getAttribute("aria-label") ?? button.textContent?.replace(/\s+/g, " ").trim(),
          disabled: button.disabled,
        })),
      })
    }

    expect(corePromptCalls).toBe(1)
    expect(webUploadCalls).toBe(1)
    expect(webRunCalls).toBe(0)
    expect(captures[0]).toEqual(captures[1])
  })

  test("keeps workspace and file-reference UI identical when native and browser pickers return platform IDs", async () => {
    const captures: unknown[] = []
    const selectedWorkspaceIDs: string[] = []

    for (const surface of ["tauri", "web"] as const) {
      cleanup()
      freshLocalStorage()
      const user = userEvent.setup()
      const workspaceID = surface === "tauri" ? "native-workspace-7" : "browser-workspace-9"
      let filePickerCall = 0
      render(() => <App
        engine={createDemoEngine()}
        credentials={{ hasApiKey: async () => true }}
        initialUiPreferences={{ theme: "dark", reasoningEffort: "high" }}
        mode="connected"
        requireApiKey
        workspacePicker={async () => ({ id: workspaceID, name: "policy-lab" })}
        workspaceFilePicker={async (selectedWorkspaceID) => {
          selectedWorkspaceIDs.push(String(selectedWorkspaceID))
          filePickerCall += 1
          return filePickerCall === 1 ? undefined : new File(["id,y\n1,2"], "policy.csv", { type: "text/csv" })
        }}
      />)

      await waitFor(() => expect(screen.getByRole("button", { name: "推理等级 High" })).toBeTruthy())
      await user.click(screen.getByRole("button", { name: "选择本地工作区" }))
      expect(screen.getByRole("status", { name: "当前工作区：policy-lab" })).toBeTruthy()
      const initialFile = new File(["id,y\n1,3"], "initial.csv", { type: "text/csv" })
      fireEvent.change(screen.getByLabelText("数据文件选择器"), { target: { files: [initialFile] } })
      await waitFor(() => expect(screen.getByRole("status", { name: "已选择数据文件" }).textContent).toContain("initial.csv"))
      const workspacePickerCallOffset = selectedWorkspaceIDs.length
      expect(screen.getByRole("status", { name: "当前研究上下文：工作区 policy-lab；数据 initial.csv" })).toBeTruthy()

      const prompt = screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement
      await user.type(prompt, "请核对 @")
      const fileReferenceButton = screen.getByRole("button", { name: "从工作区选择文件" })
      const fileReferenceControl = fileReferenceButton.textContent?.replace(/\s+/g, " ").trim()
      await user.click(fileReferenceButton)
      await waitFor(() => expect(selectedWorkspaceIDs).toHaveLength(workspacePickerCallOffset + 1))
      expect(prompt.value).toBe("请核对 @")
      expect(screen.getByRole("status", { name: "已选择数据文件" }).textContent).toContain("initial.csv")
      expect(screen.getByRole("status", { name: "当前研究上下文：工作区 policy-lab；数据 initial.csv" })).toBeTruthy()
      const cancelled = {
        context: screen.getByRole("status", { name: "当前研究上下文：工作区 policy-lab；数据 initial.csv" }).getAttribute("aria-label"),
        attachment: screen.getByRole("status", { name: "已选择数据文件" }).textContent?.replace(/\s+/g, " ").trim(),
        prompt: prompt.value,
        workspaceControls: [
          screen.getByRole("button", { name: "更换本地工作区" }).textContent?.trim(),
          screen.getByRole("button", { name: "清除本地工作区" }).textContent?.trim(),
          fileReferenceControl,
        ],
      }

      await user.click(screen.getByRole("button", { name: "从工作区选择文件" }))
      await waitFor(() => expect(selectedWorkspaceIDs).toHaveLength(workspacePickerCallOffset + 2))
      await waitFor(() => expect(screen.getByRole("status", { name: "已选择数据文件" }).textContent).toContain("policy.csv"))
      expect(prompt.value).toBe("请核对 @policy.csv ")
      expect(screen.getByRole("status", { name: "当前研究上下文：工作区 policy-lab；数据 policy.csv" })).toBeTruthy()
      const selected = {
        workspace: screen.getByRole("status", { name: "当前工作区：policy-lab" }).textContent,
        context: screen.getByRole("status", { name: "当前研究上下文：工作区 policy-lab；数据 policy.csv" }).getAttribute("aria-label"),
        attachment: screen.getByRole("status", { name: "已选择数据文件" }).textContent?.replace(/\s+/g, " ").trim(),
        prompt: prompt.value,
        workspaceControls: [
          screen.getByRole("button", { name: "更换本地工作区" }).textContent?.trim(),
          screen.getByRole("button", { name: "清除本地工作区" }).textContent?.trim(),
          fileReferenceControl,
        ],
      }
      captures.push({ cancelled, selected })
    }

    expect(selectedWorkspaceIDs).toEqual([
      "native-workspace-7", "native-workspace-7",
      "browser-workspace-9", "browser-workspace-9",
    ])
    expect(captures[0]).toEqual(captures[1])
  })

  test("keeps runtime inspection and dependency disclosure identical through Core and Web adapters", async () => {
    const captures: unknown[] = []
    const runtimeReads = { tauri: 0, web: 0 }
    const runtimeInstalls = { tauri: 0, web: 0 }
    const report = {
      python: { label: "Python", status: "ready" as const, detail: "Python 3.12.1", suggestion: "" },
      packages: PYTHON_RUNTIME_PACKAGES.map(({ pip, purpose }, index) => ({
        label: pip,
        status: (index === 0 ? "error" : "ready") as "error" | "ready",
        detail: index === 0 ? "未安装" : "已安装",
        suggestion: purpose,
      })),
    }

    for (const surface of ["tauri", "web"] as const) {
      cleanup()
      freshLocalStorage()
      const user = userEvent.setup()
      const runtimeDiagnostics = surface === "tauri"
        ? createCoreRuntimeDiagnosticsAdapter(async () => ({
            runtimeDiagnostics: async () => {
              runtimeReads.tauri += 1
              return report
            },
            installRuntimePackages: async () => {
              runtimeInstalls.tauri += 1
              return report
            },
          }))
        : createWebRuntimeDiagnostics(async (input) => {
            if (String(input) === "/api/v2/runtime/install") {
              runtimeInstalls.web += 1
              return Response.json(report)
            }
            if (String(input) !== "/api/v2/runtime") throw new Error(`unexpected Web runtime request ${String(input)}`)
            runtimeReads.web += 1
            return Response.json(report)
          })

      render(() => <App
        engine={createDemoEngine()}
        credentials={{ hasApiKey: async () => true }}
        runtimeDiagnostics={runtimeDiagnostics}
        initialUiPreferences={{ theme: "dark", reasoningEffort: "high" }}
        mode="connected"
        requireApiKey
      />)

      await waitFor(() => expect(screen.getByRole("button", { name: "推理等级 High" })).toBeTruthy())
      await user.keyboard("{Meta>}{,}{/Meta}")
      await user.click(screen.getByRole("button", { name: "运行环境" }))
      await user.click(screen.getByRole("button", { name: "检查本机环境" }))
      await screen.findByText("Python 3.12.1")
      const settings = screen.getByRole("dialog", { name: "设置" })
      const content = settings.querySelector<HTMLElement>(".settings-content")!
      const groups = [...content.querySelectorAll<HTMLButtonElement>(".runtime-package-group-toggle")]
      expect(groups.length).toBeGreaterThan(0)
      expect(groups.every((group) => group.getAttribute("aria-expanded") === "false")).toBe(true)
      const collapsed = captureSettingsSurface()

      const firstGroup = groups[0]!
      const groupContentID = firstGroup.getAttribute("aria-controls")!
      await user.click(firstGroup)
      await waitFor(() => expect(content.querySelector(`#${groupContentID}`)).toBeTruthy())
      expect(firstGroup.getAttribute("aria-expanded")).toBe("true")
      const expanded = captureSettingsSurface()

      await user.click(firstGroup)
      await waitFor(() => expect(content.querySelector(`#${groupContentID}`)).toBeNull())
      await user.click(screen.getByRole("button", { name: "查看并确认安装" }))
      await screen.findByText(/确认安装/)
      const installConfirmation = captureSettingsSurface()
      await user.click(screen.getByRole("button", { name: "取消" }))
      await waitFor(() => expect(screen.getByRole("button", { name: "查看并确认安装" })).toBeTruthy())
      captures.push({
        collapsed,
        expanded,
        collapsedAgain: captureSettingsSurface(),
        installConfirmation,
      })
    }

    expect(runtimeReads.tauri).toBeGreaterThan(0)
    expect(runtimeReads.web).toBeGreaterThan(0)
    expect(runtimeInstalls).toEqual({ tauri: 0, web: 0 })
    expect(captures[0]).toEqual(captures[1])
  })

  test("keeps research-history opt-in, restoration, and clearing identical through Tauri and Web stores", async () => {
    const captures: unknown[] = []
    const researchTitle = "研究历史跨端对照"

    for (const surface of ["tauri", "web"] as const) {
      cleanup()
      freshLocalStorage()
      const user = userEvent.setup()
      let nativeEnabled = false
      let nativeSnapshot: string | null = null
      const workspaceStore = surface === "tauri"
        ? createTauriWorkspaceStore(async (command, args) => {
            if (command === "workspace_history_enabled_command") return nativeEnabled
            if (command === "set_workspace_history_enabled") {
              nativeEnabled = args?.enabled === true
              if (!nativeEnabled) nativeSnapshot = null
              return undefined
            }
            if (command === "load_workspace_snapshot") return nativeEnabled ? nativeSnapshot : null
            if (command === "save_workspace_snapshot") {
              if (nativeEnabled) nativeSnapshot = String(args?.snapshot)
              return undefined
            }
            throw new Error(`unexpected Tauri workspace command ${command}`)
          })
        : createLocalWorkspaceStore()
      const mount = () => render(() => <App
        engine={createDemoEngine()}
        credentials={{ hasApiKey: async () => true }}
        workspaceStore={workspaceStore}
        initialUiPreferences={{ theme: "dark", reasoningEffort: "high" }}
        mode="connected"
        requireApiKey
      />)
      const recentResearch = () => [...document.querySelectorAll<HTMLButtonElement>(".research-session")].map((button) => ({
        label: button.getAttribute("aria-label"),
        current: button.getAttribute("aria-current"),
        text: button.textContent?.replace(/\s+/g, " ").trim(),
      }))

      mount()
      await waitFor(() => expect(screen.getByRole("status", { name: "分析核心就绪" })).toBeTruthy())
      await user.type(screen.getByRole("textbox", { name: "研究问题" }), researchTitle)
      await user.click(screen.getByRole("button", { name: "发送" }))
      await screen.findByRole("heading", { name: "分析结果" })
      await screen.findByRole("button", { name: `打开研究：${researchTitle}` })
      const memoryOnlyRows = recentResearch()

      await user.click(screen.getByRole("button", { name: "设置" }))
      const historyToggle = screen.getByRole("checkbox", { name: "保存研究历史" }) as HTMLInputElement
      expect(historyToggle.checked).toBe(false)
      await user.click(historyToggle)
      await waitFor(() => expect(historyToggle.checked).toBe(true))
      await waitFor(async () => expect((await workspaceStore.load())?.workspaces.some((workspace) => workspace.researches.length > 0)).toBe(true))
      const enabled = { settings: captureSettingsSurface(), researchRows: recentResearch() }

      await user.keyboard("{Escape}")
      cleanup()
      mount()
      await screen.findByRole("button", { name: `打开研究：${researchTitle}` })
      await user.click(screen.getByRole("button", { name: "设置" }))
      const restoredToggle = screen.getByRole("checkbox", { name: "保存研究历史" }) as HTMLInputElement
      expect(restoredToggle.checked).toBe(true)
      const restored = { settings: captureSettingsSurface(), researchRows: recentResearch() }

      await user.click(restoredToggle)
      await waitFor(() => expect(restoredToggle.checked).toBe(false))
      await waitFor(async () => expect(await workspaceStore.load()).toBeUndefined())
      const disabled = { settings: captureSettingsSurface(), researchRows: recentResearch() }
      expect(disabled.researchRows).toEqual([])

      await user.keyboard("{Escape}")
      cleanup()
      mount()
      await waitFor(() => expect(screen.getByRole("status", { name: "分析核心就绪" })).toBeTruthy())
      expect(screen.queryByRole("button", { name: `打开研究：${researchTitle}` })).toBeNull()
      await user.click(screen.getByRole("button", { name: "设置" }))
      const disabledAfterReload = captureSettingsSurface()
      expect((screen.getByRole("checkbox", { name: "保存研究历史" }) as HTMLInputElement).checked).toBe(false)
      captures.push({ memoryOnlyRows, enabled, restored, disabled, disabledAfterReload })
    }

    expect(captures[0]).toEqual(captures[1])
  })

  test("keeps model-store error, retry, and recovery interactions identical through Tauri and Web adapters", async () => {
    const captures: unknown[] = []
    const attempts = { tauri: 0, web: 0 }
    const failureMessage = "本机模型档案暂时不可用，请重试。"
    const emptySnapshot: ModelProfilesSnapshot = { profiles: [], defaultProfileId: null }

    for (const surface of ["tauri", "web"] as const) {
      cleanup()
      freshLocalStorage()
      const user = userEvent.setup()
      const credentials = surface === "tauri"
        ? createTauriCredentialStore(async (command) => {
            if (command !== "list_provider_profiles") throw new Error(`unexpected Tauri credential command ${command}`)
            attempts.tauri += 1
            if (attempts.tauri <= 2) throw new Error(failureMessage)
            return emptySnapshot
          })
        : createWebCredentialStore(async (input, init) => {
            if (String(input) !== "/api/v2/credentials/profiles" || (init?.method ?? "GET") !== "GET") {
              throw new Error(`unexpected Web credential request ${init?.method ?? "GET"} ${String(input)}`)
            }
            attempts.web += 1
            if (attempts.web <= 2) {
              return Response.json({ protocolVersion: "v2", code: "credential_store_unavailable", message: failureMessage }, { status: 503 })
            }
            return Response.json(emptySnapshot)
          })

      render(() => <App
        engine={createDemoEngine()}
        credentials={credentials}
        initialUiPreferences={{ theme: "dark", reasoningEffort: "high" }}
        mode="connected"
        requireApiKey
      />)

      await waitFor(() => expect(screen.getByRole("button", { name: "推理等级 High" })).toBeTruthy())
      await user.keyboard("{Meta>}{,}{/Meta}")
      await user.click(screen.getByRole("button", { name: "模型管理" }))
      await screen.findByText("无法读取模型列表")
      expect(screen.getByRole("alert").textContent).toContain(failureMessage)
      const failed = captureSettingsSurface()
      expect(screen.getByRole("button", { name: /配置模型/ }).hasAttribute("disabled")).toBe(true)

      await user.click(screen.getByRole("button", { name: "重试" }))
      await screen.findByText("还没有配置模型")
      await waitFor(() => expect(screen.getByRole("button", { name: /配置模型/ }).hasAttribute("disabled")).toBe(false))
      const recovered = captureSettingsSurface()
      await user.click(screen.getByRole("button", { name: /配置模型/ }))
      await screen.findByRole("dialog", { name: "选择服务商协议" })
      const providerPicker = captureSettingsSurface()
      captures.push({ failed, recovered, providerPicker })
    }

    expect(attempts).toEqual({ tauri: 3, web: 3 })
    expect(captures[0]).toEqual(captures[1])
  })

  test("renders identical streaming reasoning and question states through Core and Web engine adapters", async () => {
    const captures: unknown[] = []
    const resultDocument = "## 回归结果\n\n| 变量 | 系数 |\n|---|---:|\n| outcome | 1.25 |"
    const downloadedFiles: string[] = []
    const createObjectURL = vi.fn(() => "blob:surface-parity-result")
    const revokeObjectURL = vi.fn()
    const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL")
    const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL")
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL })
    restoreDownloadAPIs = () => {
      if (originalCreateObjectURL) Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL)
      else Reflect.deleteProperty(URL, "createObjectURL")
      if (originalRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL)
      else Reflect.deleteProperty(URL, "revokeObjectURL")
    }
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloadedFiles.push(this.download)
    })

    for (const surface of ["tauri", "web"] as const) {
      cleanup()
      freshLocalStorage()
      const user = userEvent.setup()
      let coreListener: ((event: Event) => void) | undefined
      const eventSources: Array<{
        url: URL
        onmessage: ((event: MessageEvent<string>) => void) | null
        onerror: (() => void) | null
        close(): void
      }> = []
      const publishCore = (event: unknown) => coreListener?.(event as Event)
      const coreMessages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = []
      const coreAnswers: Array<{ requestID: string; answers: string[][] }> = []
      const corePermissionReplies: Array<{ requestID: string; decision: string }> = []
      const coreCancellations: string[] = []
      const coreAttachments: string[] = []
      const webAnswers: Array<{ runID: string; requestID: string; body: unknown }> = []
      const webDenials: Array<{ runID: string; requestID: string; body: unknown }> = []
      const webCancellations: string[] = []
      const webAttachments: string[] = []
      let runSequence = 0
      let webRunSequence = 0
      const publishPermissionCore = (sessionID: string, requestID: string) => publishCore({
        type: "permission.asked",
        properties: { id: requestID, sessionID, permission: "读取工作区文件", patterns: ["workspace/**"] },
      })
      const core = {
        subscribe(listener: (event: Event) => void) {
          coreListener = listener
          return () => { if (coreListener === listener) coreListener = undefined }
        },
        whenEventStreamReady: async () => {},
        health: async () => ({ data: { version: "surface-parity-core", healthy: true } }),
        commands: async () => ({ data: [] }),
        createSession: async () => ({ id: `core-session-${++runSequence}` }),
        prompt: async (input: Record<string, unknown>) => {
          const sessionID = String(input.sessionID)
          if (input.text === "检查授权与取消" || input.text === "拒绝权限") {
            publishPermissionCore(sessionID, input.text === "拒绝权限" ? "permission-deny-parity" : "permission-parity")
            return
          }
          if (input.text === "检查下一轮取消") return
          const files = input.files as Array<{ filename?: string }> | undefined
          if (files?.[0]?.filename) coreAttachments.push(files[0].filename)
          const messageID = "assistant-parity"
          const info = { id: messageID, sessionID, role: "assistant", mode: "analyst", summary: false }
          const reasoning = { id: "reasoning-parity", sessionID, messageID, type: "reasoning", text: "先检查数据结构" }
          const text = { id: "text-parity", sessionID, messageID, type: "text", text: "已整理分析思路。", synthetic: false, ignored: false }
          coreMessages.push({ info, parts: [reasoning, text] })
          publishCore({ type: "message.updated", properties: { info } })
          publishCore({ type: "message.part.updated", properties: { part: reasoning } })
          publishCore({ type: "message.part.updated", properties: { part: text } })
        },
        replyQuestion: async (requestID: string, answers: string[][]) => {
          const sessionID = "core-session-1"
          const info = { id: "assistant-result-parity", sessionID, role: "assistant", mode: "analyst", summary: false }
          const text = { id: "text-result-parity", sessionID, messageID: info.id, type: "text", text: resultDocument, synthetic: false, ignored: false }
          coreMessages.push({ info, parts: [text] })
          coreAnswers.push({ requestID, answers })
          publishCore({ type: "message.updated", properties: { info } })
          publishCore({ type: "message.part.updated", properties: { part: text } })
          publishCore({ type: "session.idle", properties: { sessionID } })
        },
        replyPermission: async (requestID: string, decision: string) => {
          corePermissionReplies.push({ requestID, decision })
        },
        rejectQuestion: async () => {},
        loadSession: async (sessionID: string) => coreMessages.filter((message) => message.info.sessionID === sessionID),
        abort: async (sessionID: string) => { coreCancellations.push(sessionID) },
      } as unknown as CoreSessionClient

      const engine = surface === "tauri"
        ? createCoreEngineAdapter(core)
        : new HttpEngineClient("/api", async (input, init) => {
            const url = new URL(String(input), "http://localhost")
            const method = init?.method ?? "GET"
            if (url.pathname === "/api/v2/health") return Response.json({
              protocolVersion: "v2", engineVersion: "surface-parity-core", status: "ready",
              capabilities: { structuredSteps: true, interactive: true },
            })
            if (url.pathname === "/api/v2/commands") return Response.json({ protocolVersion: "v2", commands: [] })
            if (url.pathname === "/api/v2/datasets" && method === "POST") {
              const file = (init?.body as FormData).get("file") as File
              webAttachments.push(file.name)
              return Response.json({ protocolVersion: "v2", id: "dataset-web-parity", name: file.name, format: "CSV", bytes: file.size })
            }
            if (url.pathname === "/api/v2/runs" && method === "POST") {
              return Response.json({ protocolVersion: "v2", runId: `web-run-${++webRunSequence}` })
            }
            const answerMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/interactions\/([^/]+)\/answer$/)
            if (answerMatch && method === "POST") {
              webAnswers.push({ runID: answerMatch[1]!, requestID: answerMatch[2]!, body: JSON.parse(String(init?.body ?? "{}")) })
              return Response.json({ protocolVersion: "v2" })
            }
            const denyMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/interactions\/([^/]+)\/deny$/)
            if (denyMatch && method === "POST") {
              webDenials.push({ runID: denyMatch[1]!, requestID: denyMatch[2]!, body: JSON.parse(String(init?.body ?? "{}")) })
              return Response.json({ protocolVersion: "v2" })
            }
            const resultMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/result$/)
            if (resultMatch && method === "GET") {
              return Response.json({ protocolVersion: "v2", runId: resultMatch[1], status: "completed", document: resultDocument })
            }
            const cancelMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/cancel$/)
            if (cancelMatch && method === "POST") {
              webCancellations.push(cancelMatch[1]!)
              return Response.json({ protocolVersion: "v2", cancelled: true })
            }
            return Response.json({ protocolVersion: "v2", code: "not_found", message: `Unhandled route ${url.pathname}` }, { status: 404 })
          }, undefined, (url) => {
            const source = { url, onmessage: null as ((event: MessageEvent<string>) => void) | null, onerror: null as (() => void) | null, close() {} }
            eventSources.push(source)
            return source
          }, "v2")

      const sendWebEvent = (runID: string, event: Record<string, unknown>) => {
        const source = eventSources.find((item) => item.url.pathname.endsWith(`/runs/${runID}/events`))
        if (!source?.onmessage) throw new Error(`SSE source for ${runID} is not attached`)
        source.onmessage(new MessageEvent("message", { data: JSON.stringify({ protocolVersion: "v2", ...event }) }))
      }

      render(() => <App
        engine={engine}
        credentials={{ hasApiKey: async () => true, prepareEngineForAnalysis: async () => {} }}
        initialUiPreferences={{ theme: "dark", reasoningEffort: "high" }}
        mode="connected"
        requireApiKey
      />)
      await waitFor(() => expect(screen.getByRole("status", { name: "分析核心就绪" })).toBeTruthy())
      const datasetContents = "id,outcome\n1,2\n"
      const datasetFile = new File([datasetContents], "panel.csv", { type: "text/csv" })
      Object.defineProperty(datasetFile, "arrayBuffer", {
        value: async () => new TextEncoder().encode(datasetContents).buffer as ArrayBuffer,
      })
      fireEvent.change(screen.getByLabelText("数据文件选择器"), { target: { files: [datasetFile] } })
      await waitFor(() => expect(screen.getByRole("status", { name: "已选择数据文件" }).textContent).toContain("panel.csv"))
      await user.type(screen.getByRole("textbox", { name: "研究问题" }), "解释变量关系")
      await user.click(screen.getByRole("button", { name: "发送" }))
      if (surface === "tauri") await waitFor(() => expect(coreAttachments).toEqual(["panel.csv"]))

      if (surface === "web") {
        await waitFor(() => expect(eventSources.some((source) => source.url.pathname.endsWith("/runs/web-run-1/events"))).toBe(true))
        sendWebEvent("web-run-1", { type: "reasoning_delta", text: "先检查数据结构" })
        sendWebEvent("web-run-1", { type: "assistant_delta", text: "已整理分析思路。" })
      }

      await screen.findByRole("button", { name: "停止分析" })
      const liveThread = screen.getByRole("log", { name: "分析对话" })
      await waitFor(() => expect(liveThread.textContent, `${surface} stream projection`).toContain("已整理分析思路。"))
      const captureConversation = () => {
        const thread = screen.getByRole("log", { name: "分析对话" })
        const reasoning = thread.querySelector<HTMLDetailsElement>(".reasoning-block")
        const question = screen.queryByRole("region", { name: "选择结果变量" })
        const permission = screen.queryByRole("region", { name: "分析需要授权" })
        const interaction = question ?? permission
        const prompt = screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement
        return {
          messages: [...thread.querySelectorAll<HTMLElement>(".message")].map((message) => ({
            className: message.className,
            text: message.textContent?.replace(/\s+/g, " ").trim(),
          })),
          reasoning: {
            label: reasoning?.querySelector("summary")?.textContent?.trim(),
            open: reasoning?.open ?? false,
            content: thread.querySelector(".reasoning-content")?.textContent ?? null,
          },
          question: question?.textContent?.replace(/\s+/g, " ").trim() ?? null,
          permission: permission?.textContent?.replace(/\s+/g, " ").trim() ?? null,
          interactionButtons: [...(interaction?.querySelectorAll<HTMLButtonElement>("button") ?? [])].map((button) => ({
            label: button.getAttribute("aria-label") ?? button.textContent?.replace(/\s+/g, " ").trim(),
            disabled: button.disabled,
            pressed: button.getAttribute("aria-pressed"),
          })),
          composer: {
            value: prompt.value,
            disabled: prompt.disabled,
            buttons: [...document.querySelectorAll<HTMLButtonElement>(".composer button")].map((button) => ({
              label: button.getAttribute("aria-label") ?? button.textContent?.replace(/\s+/g, " ").trim(),
              disabled: button.disabled,
            })),
          },
        }
      }

      const collapsed = captureConversation()
      expect(collapsed.reasoning).toEqual({ label: "展开思考过程", open: false, content: null })
      expect(collapsed.messages.map((message) => message.text)).toEqual(["panel.csv解释变量关系", "展开思考过程已整理分析思路。"])

      await user.click(screen.getByText("展开思考过程"))
      const expanded = captureConversation()
      expect(expanded.reasoning).toEqual({ label: "收起思考过程", open: true, content: "先检查数据结构" })

      if (surface === "tauri") {
        const sessionID = "core-session-1"
        publishCore({
          type: "question.asked",
          properties: {
            id: "question-parity",
            sessionID,
            questions: [{ header: "选择结果变量", question: "结果变量是哪一列？", options: [{ label: "outcome" }], multiple: false, custom: false }],
          },
        })
      } else {
        sendWebEvent("web-run-1", {
            type: "question",
            message: "分析需要你的回答。",
            interaction: {
              kind: "question",
              question: {
                requestId: "question-parity",
                title: "选择结果变量",
                prompt: "结果变量是哪一列？",
                mode: "single",
                options: [{ id: "0", label: "outcome" }],
                allowSkip: false,
              },
            },
          })
      }
      await screen.findByRole("region", { name: "选择结果变量" })
      const waiting = captureConversation()
      await user.click(screen.getByRole("button", { name: "outcome" }))
      const selected = captureConversation()
      await user.click(screen.getByRole("button", { name: "继续分析" }))

      if (surface === "web") {
        await waitFor(() => expect(webAnswers).toEqual([{ runID: "web-run-1", requestID: "question-parity", body: { selected: ["0"] } }]))
        sendWebEvent("web-run-1", { type: "assistant_delta", text: resultDocument })
        sendWebEvent("web-run-1", { type: "completed", message: "分析已完成。" })
      } else {
        await waitFor(() => expect(coreAnswers).toEqual([{ requestID: "question-parity", answers: [["outcome"]] }]))
      }
      await screen.findByRole("heading", { name: "回归结果" })
      const completed = captureConversation()
      const downloadsBeforeExport = downloadedFiles.length
      await user.type(screen.getByRole("textbox", { name: "研究问题" }), "/export")
      await user.click(screen.getByRole("button", { name: "发送" }))
      await waitFor(() => expect(downloadedFiles).toHaveLength(downloadsBeforeExport + 1))
      expect(downloadedFiles.at(-1)).toBe("killstata-analysis-result.md")
      if (surface === "web") expect(webAttachments).toEqual(["panel.csv"])
      const exported = captureConversation()

      await user.click(screen.getByRole("button", { name: "新对话" }))
      await user.type(screen.getByRole("textbox", { name: "研究问题" }), "检查授权与取消")
      await user.click(screen.getByRole("button", { name: "发送" }))
      await screen.findByRole("button", { name: "停止分析" })
      if (surface === "web") {
        await waitFor(() => expect(eventSources.some((source) => source.url.pathname.endsWith("/runs/web-run-2/events"))).toBe(true))
        sendWebEvent("web-run-2", {
          type: "permission",
          message: "分析等待你的授权。",
          interaction: {
            kind: "permission",
            permission: {
              requestId: "permission-parity",
              title: "分析需要授权",
              action: "读取工作区文件",
              scope: "workspace/**",
            },
          },
        })
      }
      await screen.findByRole("region", { name: "分析需要授权" })
      const permissionRequested = captureConversation()
      await user.click(screen.getByRole("button", { name: "允许一次" }))
      if (surface === "web") {
        await waitFor(() => expect(webAnswers).toHaveLength(2))
        expect(webAnswers[1]).toMatchObject({ runID: "web-run-2", requestID: "permission-parity", body: { allowed: true } })
      } else {
        await waitFor(() => expect(corePermissionReplies).toEqual([{ requestID: "permission-parity", decision: "once" }]))
      }
      const permissionAllowed = captureConversation()
      await screen.findByRole("button", { name: "停止分析" })
      await user.click(screen.getByRole("button", { name: "停止分析" }))
      if (surface === "web") await waitFor(() => expect(webCancellations).toEqual(["web-run-2"]))
      else await waitFor(() => expect(coreCancellations).toEqual(["core-session-2"]))
      await screen.findByText("已停止分析。", { exact: true })
      const cancelled = captureConversation()

      await user.click(screen.getByRole("button", { name: "新对话" }))
      await user.type(screen.getByRole("textbox", { name: "研究问题" }), "拒绝权限")
      await user.click(screen.getByRole("button", { name: "发送" }))
      await screen.findByRole("button", { name: "停止分析" })
      if (surface === "web") {
        await waitFor(() => expect(eventSources.some((source) => source.url.pathname.endsWith("/runs/web-run-3/events"))).toBe(true))
        sendWebEvent("web-run-3", {
          type: "permission",
          message: "分析等待你的授权。",
          interaction: {
            kind: "permission",
            permission: {
              requestId: "permission-deny-parity",
              title: "分析需要授权",
              action: "读取工作区文件",
              scope: "workspace/**",
            },
          },
        })
      }
      await screen.findByRole("region", { name: "分析需要授权" })
      const permissionDeniedPrompt = captureConversation()
      await user.click(screen.getByRole("button", { name: "拒绝并停止" }))
      if (surface === "web") {
        await waitFor(() => expect(webDenials).toEqual([{
          runID: "web-run-3", requestID: "permission-deny-parity", body: { reason: "研究者拒绝" },
        }]))
      } else {
        await waitFor(() => expect(corePermissionReplies).toEqual([
          { requestID: "permission-parity", decision: "once" },
          { requestID: "permission-deny-parity", decision: "reject" },
        ]))
      }
      await screen.findByText("已拒绝该请求并停止分析。", { exact: true })
      const permissionDenied = captureConversation()
      captures.push({
        collapsed, expanded, waiting, selected, completed, exported,
        permissionRequested, permissionAllowed, cancelled,
        permissionDeniedPrompt, permissionDenied,
      })
    }

    expect(downloadedFiles).toEqual(["killstata-analysis-result.md", "killstata-analysis-result.md"])
    expect(createObjectURL).toHaveBeenCalledTimes(2)
    expect(revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(captures[0]).toEqual(captures[1])
  })
})
