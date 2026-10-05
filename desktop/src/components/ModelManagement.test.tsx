import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { CredentialStore, ModelProfilesSnapshot } from "../credentials"
import type { ProviderSettings } from "../provider-config"
import { createDemoCredentialStore } from "../credentials"
import { ModelManagement } from "./ModelManagement"

afterEach(() => cleanup())

const emptySnapshot: ModelProfilesSnapshot = { profiles: [], defaultProfileId: null }

function credentials(overrides: Partial<CredentialStore> = {}): CredentialStore {
  return { ...createDemoCredentialStore(), ...overrides }
}

describe("ModelManagement", () => {
  test("shows host model status without exposing credential mutations to shared visitors", () => {
    const profile = { id: "host-default", provider: "deepseek" as const, model: "deepseek/deepseek-v4-flash", configured: true, isDefault: true }
    const snapshot = { profiles: [profile], defaultProfileId: profile.id }
    render(() => <ModelManagement
      snapshot={snapshot}
      credentials={credentials()}
      onSnapshot={() => {}}
      readOnly={true}
    />)

    expect(screen.getByText("主机模型由分享页面所有者管理。访客不能查看或修改 API Key。"))
    expect(screen.queryByRole("button", { name: /配置模型/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /编辑/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /移除/ })).toBeNull()
    expect(screen.getAllByText("默认模型")).toHaveLength(2)
    expect(screen.getByText("deepseek-v4-flash")).toBeTruthy()
  })

  test("empty state opens a protocol-card picker with only the four supported connection types", async () => {
    const user = userEvent.setup()
    render(() => <ModelManagement snapshot={emptySnapshot} credentials={credentials()} onSnapshot={() => {}} />)

    expect(screen.getByText("还没有配置模型")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: /＋ 配置模型/ }))

    expect(screen.getByRole("button", { name: "选择 DeepSeek" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "选择 OpenAI 兼容协议" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "选择 Anthropic" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "选择 Google Gemini" })).toBeTruthy()
    expect(screen.queryByText("腾讯云" )).toBeNull()
  })

  test("adds an Anthropic model profile only after discovery and preserves the draft key in the profile call", async () => {
    const user = userEvent.setup()
    const saveProfile = vi.fn(async () => ({
      profileId: "profile-1",
      activeChanged: true,
      snapshot: {
        profiles: [{ id: "profile-1", provider: "anthropic" as const, model: "anthropic/claude-sonnet-4", baseURL: "https://api.anthropic.com/v1", configured: true, isDefault: true }],
        defaultProfileId: "profile-1",
      },
    }))
    const discoverModels = vi.fn(async () => [{ id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" }])
    const onSnapshot = vi.fn()
    render(() => <ModelManagement snapshot={emptySnapshot} credentials={credentials({ saveProfile, discoverModels })} onSnapshot={onSnapshot} />)

    await user.click(screen.getByRole("button", { name: /＋ 配置模型/ }))
    await user.click(screen.getByRole("button", { name: "选择 Anthropic" }))
    expect((screen.getByRole("textbox", { name: "模型服务 Base URL" }) as HTMLInputElement).value).toBe("https://api.anthropic.com/v1")
    expect(screen.queryByRole("combobox", { name: "可用模型" })).toBeNull()
    await user.type(screen.getByLabelText("档案名称"), "实验室中转")
    await user.type(screen.getByLabelText("API Key"), "anthropic-secret")
    await user.click(screen.getByRole("button", { name: "读取可用模型" }))
    await screen.findByRole("combobox", { name: "可用模型" })
    await user.selectOptions(screen.getByRole("combobox", { name: "可用模型" }), "anthropic/claude-sonnet-4")
    await user.click(screen.getByRole("button", { name: "保存模型配置" }))

    await waitFor(() => expect(saveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", model: "anthropic/claude-sonnet-4" }),
      "anthropic-secret",
      expect.any(String),
      true,
      true,
      "实验室中转",
    ))
    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ defaultProfileId: "profile-1" }))
  })

  test("shows multiple profiles and changes the default without exposing API keys", async () => {
    const user = userEvent.setup()
    const snapshot: ModelProfilesSnapshot = {
      profiles: [
        { id: "one", provider: "custom", model: "custom/model-one", baseURL: "https://one.example/v1", configured: true, isDefault: true },
        { id: "two", provider: "custom", model: "custom/model-two", baseURL: "https://two.example/v1", configured: true, isDefault: false },
      ],
      defaultProfileId: "one",
    }
    const nextSnapshot = { ...snapshot, profiles: snapshot.profiles.map((item) => ({ ...item, isDefault: item.id === "two" })), defaultProfileId: "two" }
    const setDefaultProfile = vi.fn(async () => ({ profileId: "two", activeChanged: true, snapshot: nextSnapshot }))
    const onSnapshot = vi.fn()
    render(() => <ModelManagement snapshot={snapshot} credentials={credentials({ setDefaultProfile })} onSnapshot={onSnapshot} />)

    expect(screen.getByText("model-one")).toBeTruthy()
    expect(screen.getByText("model-two")).toBeTruthy()
    expect(screen.queryByText(/key-one|key-two|must-not-leak/i)).toBeNull()
    await user.click(screen.getByRole("button", { name: "将 OpenAI-compatible · custom/model-two 设为默认" }))
    expect(setDefaultProfile).toHaveBeenCalledWith("two")
    expect(onSnapshot).toHaveBeenCalledWith(nextSnapshot)
  })

  test("serializes default switches so an older response cannot overwrite a newer choice", async () => {
    const user = userEvent.setup()
    const snapshot: ModelProfilesSnapshot = {
      profiles: [
        { id: "one", provider: "deepseek", model: "deepseek/deepseek-v4-flash", configured: true, isDefault: true },
        { id: "two", provider: "custom", model: "custom/two", configured: true, isDefault: false },
        { id: "three", provider: "custom", model: "custom/three", configured: true, isDefault: false },
      ],
      defaultProfileId: "one",
    }
    let finishFirst!: (value: unknown) => void
    const first = new Promise<unknown>((resolve) => { finishFirst = resolve })
    const setDefaultProfile = vi.fn(async () => first as Promise<any>)
    const onSnapshot = vi.fn()
    render(() => <ModelManagement snapshot={snapshot} credentials={credentials({ setDefaultProfile })} onSnapshot={onSnapshot} />)

    await user.click(screen.getByRole("button", { name: "将 OpenAI-compatible · custom/two 设为默认" }))
    const second = screen.getByRole("button", { name: "将 OpenAI-compatible · custom/three 设为默认" }) as HTMLButtonElement
    expect(second.disabled).toBe(true)
    await user.click(second)
    expect(setDefaultProfile).toHaveBeenCalledTimes(1)
    finishFirst({ profileId: "two", activeChanged: true, snapshot: { ...snapshot, defaultProfileId: "two" } })
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1))
  })

  test("does not allow another mutation after an uncertain default switch until profiles are refreshed", async () => {
    const user = userEvent.setup()
    const snapshot: ModelProfilesSnapshot = {
      profiles: [
        { id: "one", provider: "deepseek", model: "deepseek/deepseek-v4-flash", configured: true, isDefault: true },
        { id: "two", provider: "custom", model: "custom/two", configured: true, isDefault: false },
      ],
      defaultProfileId: "one",
    }
    const next = { profileId: "two", activeChanged: true, snapshot: { ...snapshot, defaultProfileId: "two" } }
    const setDefaultProfile = vi.fn().mockRejectedValueOnce(new Error("切换默认模型超时")).mockResolvedValueOnce(next)
    const onRetryLoad = vi.fn(async () => undefined)
    render(() => <ModelManagement snapshot={snapshot} credentials={credentials({ setDefaultProfile })} onSnapshot={() => {}} onRetryLoad={onRetryLoad} />)

    const switchButton = screen.getByRole("button", { name: "将 OpenAI-compatible · custom/two 设为默认" }) as HTMLButtonElement
    await user.click(switchButton)
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("超时"))
    expect(switchButton.disabled).toBe(true)
    await user.click(switchButton)
    expect(setDefaultProfile).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole("button", { name: "刷新档案列表" }))
    await waitFor(() => expect(onRetryLoad).toHaveBeenCalledOnce())
    expect(switchButton.disabled).toBe(false)
    await user.click(switchButton)
    await waitFor(() => expect(setDefaultProfile).toHaveBeenCalledTimes(2))
  })

  test("distinguishes same endpoint and model profiles by their non-secret display names", () => {
    const snapshot: ModelProfilesSnapshot = {
      profiles: [
        { id: "work", displayName: "工作账户", provider: "custom", model: "custom/shared-model", baseURL: "https://same.example/v1", configured: true, isDefault: true },
        { id: "personal", displayName: "个人账户", provider: "custom", model: "custom/shared-model", baseURL: "https://same.example/v1", configured: true, isDefault: false },
      ],
      defaultProfileId: "work",
    }
    render(() => <ModelManagement snapshot={snapshot} credentials={credentials()} onSnapshot={() => {}} />)

    expect(screen.getByText("工作账户")).toBeTruthy()
    expect(screen.getByText("个人账户")).toBeTruthy()
    expect(screen.getAllByText("shared-model")).toHaveLength(2)
  })

  test("a failed directory lookup cannot save a new profile", async () => {
    const user = userEvent.setup()
    const saveProfile = vi.fn()
    const discoverModels = vi.fn(async () => { throw new Error("API Key 无效") })
    render(() => <ModelManagement snapshot={emptySnapshot} credentials={credentials({ saveProfile, discoverModels })} onSnapshot={() => {}} />)
    await user.click(screen.getByRole("button", { name: /＋ 配置模型/ }))
    await user.click(screen.getByRole("button", { name: "选择 Google Gemini" }))
    await user.type(screen.getByLabelText("API Key"), "wrong-key")
    await user.click(screen.getByRole("button", { name: "读取可用模型" }))

    expect((await screen.findByRole("alert")).textContent).toContain("API Key 无效")
    expect(screen.queryByRole("combobox", { name: "可用模型" })).toBeNull()
    expect(saveProfile).not.toHaveBeenCalled()
  })

  test("editing a saved profile can discover models with its own Key without returning that Key to the UI", async () => {
    const user = userEvent.setup()
    const snapshot: ModelProfilesSnapshot = {
      profiles: [{ id: "profile-custom", provider: "custom", model: "custom/model-old", baseURL: "https://endpoint.example/v1", configured: true, isDefault: true }],
      defaultProfileId: "profile-custom",
    }
    const discoverModels = vi.fn(async () => [
      { id: "custom/model-old", label: "model-old" },
      { id: "custom/model-new", label: "model-new" },
    ])
    const saveProfile = vi.fn(async () => ({ profileId: "profile-custom", activeChanged: true, snapshot }))
    render(() => <ModelManagement snapshot={snapshot} credentials={credentials({ discoverModels, saveProfile })} onSnapshot={() => {}} />)
    await user.click(screen.getByRole("button", { name: "编辑 OpenAI-compatible · custom/model-old" }))
    expect(screen.getByLabelText("API Key")).toHaveProperty("value", "")
    await user.click(screen.getByRole("button", { name: "读取可用模型" }))
    await screen.findByRole("combobox", { name: "可用模型" })
    expect(discoverModels).toHaveBeenCalledWith("custom", "https://endpoint.example/v1", undefined, "profile-custom")
    await user.selectOptions(screen.getByRole("combobox", { name: "可用模型" }), "custom/model-new")
    await user.click(screen.getByRole("button", { name: "保存模型配置" }))
    await waitFor(() => expect(saveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ model: "custom/model-new" }),
      undefined,
      "profile-custom",
      true,
      false,
      "",
    ))
  })

  test("retries an uncertain save with the same profile ID instead of creating a duplicate", async () => {
    const user = userEvent.setup()
    let attempt = 0
    const saveProfile = vi.fn(async (_settings: ProviderSettings, _apiKey: string | undefined, profileID: string | undefined, makeDefault: boolean | undefined, createIfMissing: boolean | undefined) => {
      expect(createIfMissing).toBe(true)
      attempt += 1
      if (attempt === 1) throw new Error("保存模型档案超时")
      return {
        profileId: profileID!,
        activeChanged: false,
        snapshot: {
          profiles: [{ id: profileID!, provider: "anthropic" as const, model: "anthropic/claude-sonnet", configured: true, isDefault: Boolean(makeDefault) }],
          defaultProfileId: makeDefault ? profileID! : null,
        },
      }
    })
    const discoverModels = vi.fn(async () => [{ id: "anthropic/claude-sonnet", label: "Claude Sonnet" }])
    const onRetryLoad = vi.fn()
    render(() => <ModelManagement snapshot={emptySnapshot} credentials={credentials({ saveProfile, discoverModels })} onSnapshot={() => {}} onRetryLoad={onRetryLoad} />)
    await user.click(screen.getByRole("button", { name: /＋ 配置模型/ }))
    await user.click(screen.getByRole("button", { name: "选择 Anthropic" }))
    await user.type(screen.getByLabelText("API Key"), "anthropic-key")
    await user.click(screen.getByRole("button", { name: "读取可用模型" }))
    await user.selectOptions(await screen.findByRole("combobox", { name: "可用模型" }), "anthropic/claude-sonnet")
    await user.click(screen.getByRole("button", { name: "保存模型配置" }))
    expect((await screen.findByRole("alert")).textContent).toContain("不会重复添加")
    const firstProfileID = saveProfile.mock.calls[0]?.[2]
    await user.click(screen.getByRole("button", { name: "刷新档案列表" }))
    expect(onRetryLoad).toHaveBeenCalledOnce()
    await user.click(screen.getByRole("button", { name: "保存模型配置" }))
    await waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(2))
    expect(saveProfile.mock.calls[1]?.[2]).toBe(firstProfileID)
    expect(saveProfile.mock.calls[1]?.[4]).toBe(true)
  })

  test("requires a new API Key before sending requests to a changed Base URL", async () => {
    const user = userEvent.setup()
    const snapshot: ModelProfilesSnapshot = {
      profiles: [{ id: "profile-custom", provider: "custom", model: "custom/model-old", baseURL: "https://old.example/v1", configured: true, isDefault: true }],
      defaultProfileId: "profile-custom",
    }
    const discoverModels = vi.fn(async () => [{ id: "custom/model-new", label: "model-new" }])
    render(() => <ModelManagement snapshot={snapshot} credentials={credentials({ discoverModels })} onSnapshot={() => {}} />)
    await user.click(screen.getByRole("button", { name: "编辑 OpenAI-compatible · custom/model-old" }))
    const baseURL = screen.getByRole("textbox", { name: "模型服务 Base URL" })
    await user.clear(baseURL)
    await user.type(baseURL, "https://new.example/v1")
    await user.click(screen.getByRole("button", { name: "读取可用模型" }))

    expect((await screen.findByRole("alert")).textContent).toContain("重新输入该服务商的 API Key")
    expect(discoverModels).not.toHaveBeenCalled()
  })

  test("requires confirmation before deleting a profile", async () => {
    const user = userEvent.setup()
    const snapshot: ModelProfilesSnapshot = {
      profiles: [{ id: "profile-1", provider: "anthropic", model: "anthropic/claude-test", configured: true, isDefault: true }],
      defaultProfileId: "profile-1",
    }
    const deleteProfile = vi.fn(async () => ({ profileId: "profile-1", activeChanged: true, snapshot: emptySnapshot }))
    render(() => <ModelManagement snapshot={snapshot} credentials={credentials({ deleteProfile })} credentialStoreLabel="KillStata 本机凭据文件" onSnapshot={() => {}} />)
    await user.click(screen.getByRole("button", { name: "移除 Anthropic · anthropic/claude-test" }))
    expect(screen.getByRole("group", { name: "确认移除模型" }).textContent).toContain("API Key 也会从 KillStata 本机凭据文件移除")
    expect(deleteProfile).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "确认移除模型" }))
    await waitFor(() => expect(deleteProfile).toHaveBeenCalledWith("profile-1"))
  })

  test("uses the shared local credential label when confirming profile removal", async () => {
    const user = userEvent.setup()
    const snapshot: ModelProfilesSnapshot = {
      profiles: [{ id: "profile-1", provider: "anthropic", model: "anthropic/claude-test", configured: true, isDefault: true }],
      defaultProfileId: "profile-1",
    }
    render(() => <ModelManagement snapshot={snapshot} credentials={credentials()} onSnapshot={() => {}} />)

    await user.click(screen.getByRole("button", { name: "移除 Anthropic · anthropic/claude-test" }))

    expect(screen.getByRole("group", { name: "确认移除模型" }).textContent)
      .toContain("API Key 也会从 KillStata 本机凭据存储移除")
  })

  test("prevents switching or removing the active profile during an analysis", () => {
    const snapshot: ModelProfilesSnapshot = {
      profiles: [
        { id: "active", provider: "deepseek", model: "deepseek/deepseek-v4-flash", configured: true, isDefault: true },
        { id: "other", provider: "custom", model: "custom/other", baseURL: "https://example.com/v1", configured: true, isDefault: false },
      ],
      defaultProfileId: "active",
    }
    render(() => <ModelManagement snapshot={snapshot} credentials={credentials()} busy onSnapshot={() => {}} />)

    expect((screen.getByRole("button", { name: "将 OpenAI-compatible · custom/other 设为默认" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "编辑 DeepSeek · deepseek/deepseek-v4-flash" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "移除 DeepSeek · deepseek/deepseek-v4-flash" }) as HTMLButtonElement).disabled).toBe(true)
  })

  test("keeps an unconfigured legacy profile visible but not selectable as the active model", () => {
    const snapshot: ModelProfilesSnapshot = {
      profiles: [
        { id: "active", provider: "deepseek", model: "deepseek/deepseek-v4-flash", configured: true, isDefault: true },
        { id: "legacy", provider: "custom", model: "custom/old-model", baseURL: "https://old.example/v1", configured: false, isDefault: false },
      ],
      defaultProfileId: "active",
    }
    render(() => <ModelManagement snapshot={snapshot} credentials={credentials()} onSnapshot={() => {}} />)

    expect(screen.getByText("尚未配置 API Key")).toBeTruthy()
    expect((screen.getByRole("button", { name: "将 OpenAI-compatible · custom/old-model 设为默认" }) as HTMLButtonElement).disabled).toBe(true)
  })

  test("offers the first configured profile as default when saved legacy profiles have no keys", async () => {
    const user = userEvent.setup()
    const snapshot: ModelProfilesSnapshot = {
      profiles: [{ id: "legacy", provider: "custom", model: "custom/old-model", baseURL: "https://old.example/v1", configured: false, isDefault: false }],
      defaultProfileId: null,
    }
    render(() => <ModelManagement snapshot={snapshot} credentials={credentials()} onSnapshot={() => {}} />)
    await user.click(screen.getByRole("button", { name: /＋ 配置模型/ }))
    await user.click(screen.getByRole("button", { name: "选择 Anthropic" }))
    expect((screen.getByRole("checkbox", { name: "设为默认模型" }) as HTMLInputElement).checked).toBe(true)
  })
})
