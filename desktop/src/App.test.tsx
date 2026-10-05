import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import App, { CORE_ACTIVATION_TIMEOUT_MS, CREDENTIAL_OPERATION_TIMEOUT_MS, withTimeout } from "./App"
import type { CredentialStore } from "./credentials"
import type { EngineClient } from "./engine/client"
import type { EngineRunEvent, EngineRunRequest } from "./engine/client"
import type { SharedUiPreferences, UiPreferencesStore } from "./ui-preferences"
import { createMemoryWorkspaceStore, emptyWorkspaceSnapshot } from "./workspace-store"
import * as XLSX from "xlsx"

const mockDesktopInvoke = vi.hoisted(() => vi.fn(async (_command: string) => {}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockDesktopInvoke }))

function createMockEngine(overrides: Partial<EngineClient> = {}): EngineClient {
  return {
    cancelRun: async () => {},
    commands: async () => [],
    getResult: async () => ({ runId: "run-1", status: "completed", document: "回归完成" }),
    health: async () => ({ protocolVersion: "v1", engineVersion: "test", status: "ready" }),
    uploadDataset: async (file) => ({ id: "dataset-1", name: file.name, format: "CSV", bytes: file.size }),
    startRun: async () => ({ runId: "run-1" }),
    subscribe: () => () => {},
    ...overrides,
  }
}

function createMockCredentials(overrides: Partial<CredentialStore> = {}): CredentialStore {
  return {
    hasApiKey: async () => true,
    ...overrides,
  }
}

function selectCsvFile(name = "policy-study.csv", contents = "id,y\n1,2") {
  fireEvent.change(screen.getByLabelText("数据文件选择器"), {
    target: { files: [new File([contents], name, { type: "text/csv" })] },
  })
}

async function typeAndSend(text: string) {
  const user = userEvent.setup()
  await user.type(screen.getByRole("textbox"), text)
  await user.click(screen.getByRole("button", { name: "发送" }))
}

describe("KillStata Desktop Codex-style conversation UI", () => {
  test("不会无限等待无响应的系统凭据读取", async () => {
    await expect(withTimeout(new Promise<void>(() => {}), 5, "系统钥匙串读取超时")).rejects.toThrow("系统钥匙串读取超时")
  })

  test("managed Core activation budget covers the Keychain read plus Core cold start", () => {
    expect(CORE_ACTIVATION_TIMEOUT_MS).toBeGreaterThanOrEqual(CREDENTIAL_OPERATION_TIMEOUT_MS + 15_000)
  })

  let storage: Storage
  let objectURL: ReturnType<typeof vi.fn>

  beforeEach(() => {
    if (!File.prototype.arrayBuffer) {
      // jsdom 的 File 缺 arrayBuffer；用 FileReader 提供等价实现（浏览器/WebView 用原生）。
      File.prototype.arrayBuffer = function () {
        return new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as ArrayBuffer)
          reader.onerror = () => reject(reader.error)
          reader.readAsArrayBuffer(this)
        })
      }
    }
    const values = new Map<string, string>()
    storage = {
      get length() { return values.size },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => values.delete(key),
      setItem: (key, value) => values.set(key, value),
    }
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage })
    objectURL = vi.fn(() => "blob:mock")
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: objectURL })
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} })
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} })
  })

  afterEach(() => {
    cleanup()
    storage.clear()
    delete document.documentElement.dataset.theme
  })

  test("puts dataset selection on the left edge of the composer", async () => {
    const user = userEvent.setup()
    render(() => <App />)

    const chooser = screen.getByRole("button", { name: "选择数据文件" })
    expect(screen.getByRole("group", { name: "输入操作" }).firstElementChild).toBe(chooser)

    await user.click(chooser)
    expect(screen.getByLabelText("数据文件选择器")).toBeTruthy()
  })

  test("uses consistent decorative SVG icons without changing control names", () => {
    render(() => <App />)

    const chooser = screen.getByRole("button", { name: "选择数据文件" })
    const send = screen.getByRole("button", { name: "发送" })
    expect(chooser.querySelector('svg[data-icon="paperclip"]')).toBeTruthy()
    expect(send.querySelector('svg[data-icon="arrow-up"]')).toBeTruthy()
  })

  test("keeps empty-state suggestions in a secondary welcome group", () => {
    render(() => <App />)

    const welcome = screen.getByRole("heading", { name: "开始一项研究" }).closest(".thread-welcome")
    expect(welcome?.querySelector(".thread-secondary")).toBeTruthy()
    expect(welcome?.querySelector(".thread-starters")).toBeTruthy()
  })

  test("accepts a dropped dataset through the same local attachment flow", async () => {
    render(() => <App />)
    const dataset = new File(["id,y\n1,2"], "dropped-study.csv", { type: "text/csv" })
    const files = [dataset] as unknown as FileList
    const shell = document.querySelector("main")!

    fireEvent.dragEnter(shell, { dataTransfer: { types: ["Files"], files } })
    expect(screen.getByRole("status", { name: "松开以选择本地数据" })).toBeTruthy()

    fireEvent.drop(shell, { dataTransfer: { types: ["Files"], files } })
    await waitFor(() => expect(screen.getByRole("status", { name: "已选择数据文件" }).textContent).toContain("dropped-study.csv"))
    expect(screen.queryByRole("status", { name: "松开以选择本地数据" })).toBeNull()
  })

  test("ignores a non-file drag instead of treating it as data", () => {
    render(() => <App />)
    const shell = document.querySelector("main")!

    fireEvent.dragEnter(shell, { dataTransfer: { types: ["text/plain"] } })

    expect(screen.queryByRole("status", { name: "松开以选择本地数据" })).toBeNull()
    expect(screen.queryByRole("status", { name: "已选择数据文件" })).toBeNull()
    expect(fireEvent.drop(shell, { dataTransfer: { types: ["text/plain"], files: [] } })).toBe(false)
  })

  test("does not select a dropped file while settings are open", async () => {
    const user = userEvent.setup()
    render(() => <App />)
    const shell = document.querySelector("main")!
    const dataset = new File(["id,y\n1,2"], "settings-drop.csv", { type: "text/csv" })

    await user.click(screen.getByRole("button", { name: "设置" }))
    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy()
    expect(fireEvent.drop(shell, { dataTransfer: { types: ["Files"], files: [dataset] } })).toBe(false)

    expect(screen.queryByRole("status", { name: "已选择数据文件" })).toBeNull()
  })

  test("offers research starters that fill the composer without sending an analysis", async () => {
    const user = userEvent.setup()
    render(() => <App />)

    await user.click(screen.getByRole("button", { name: "政策前后变化" }))
    expect((screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement).value)
      .toContain("政策实施前后")
    expect(screen.getByRole("log", { name: "分析对话" }).textContent).not.toContain("研究信息已记录")
  })

  test("frames an empty conversation as a research entry instead of a generic chat", () => {
    render(() => <App workspacePicker={async () => undefined} />)

    expect(screen.getByRole("heading", { name: "开始一项研究" })).toBeTruthy()
    expect(screen.getByText("选择数据，或从一个问题开始。")).toBeTruthy()
    expect(screen.queryByText("从数据与问题开始")).toBeNull()
  })

  test("identifies the active research in the header instead of repeating product chrome", () => {
    render(() => <App />)

    expect(screen.getByRole("status", { name: "当前研究：未命名研究" })).toBeTruthy()
    expect(screen.queryByText("计量分析")).toBeNull()
  })

  test("shows the connected engine status as a quiet indicator, not spelled-out chrome", async () => {
    const health = vi.fn(async () => ({ protocolVersion: "v1" as const, engineVersion: "bridge-2026.08", status: "ready" as const }))
    render(() => <App engine={createMockEngine({ health })} mode="connected" />)

    await waitFor(() => expect(screen.getByRole("status", { name: "分析核心就绪" })).toBeTruthy())
    expect(screen.queryByText(/本地分析引擎 ·/)).toBeNull()
  })

  test("shows the shared status and composer policy controls in browser preview mode", () => {
    render(() => <App />)

    expect(screen.getByRole("status", { name: "本地体验模式，未连接分析核心" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "工具授权：工作区读写" })).toBeTruthy()
  })

  test("does not call engine or credential APIs before an explicit connection action", async () => {
    const user = userEvent.setup()
    const health = vi.fn(async () => ({ protocolVersion: "v1" as const, engineVersion: "test", status: "ready" as const }))
    const commands = vi.fn(async () => [])
    const subscribeVerification = vi.fn(() => () => {})
    const listProfiles = vi.fn(async () => ({ profiles: [], defaultProfileId: null }))
    const credentials = createMockCredentials({
      listProfiles,
      hasApiKey: vi.fn(async () => false),
    })
    render(() => <App
      engine={createMockEngine({ health, commands, subscribeVerification })}
      credentials={credentials}
      mode="frontend"
      connectionAvailable
    />)

    expect(health).not.toHaveBeenCalled()
    expect(commands).not.toHaveBeenCalled()
    expect(subscribeVerification).not.toHaveBeenCalled()
    expect(listProfiles).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "设置" }))
    await user.click(screen.getByRole("button", { name: "连接分析核心" }))

    await waitFor(() => expect(credentials.hasApiKey).toHaveBeenCalled())
    expect(screen.getByRole("heading", { name: "模型管理", level: 2 })).toBeTruthy()
    expect(health).not.toHaveBeenCalled()
    expect(subscribeVerification).not.toHaveBeenCalled()
  })

  test("keeps selected data and questions in the frontend until the researcher connects", async () => {
    const engine = createMockEngine({
      commands: vi.fn(async () => []),
      uploadDataset: vi.fn(async () => ({ id: "dataset-1", name: "policy-study.csv", format: "CSV", bytes: 10 })),
      startRun: vi.fn(async () => ({ runId: "run-1" })),
    })
    const credentials = createMockCredentials({
      hasApiKey: vi.fn(async () => false),
      listProfiles: vi.fn(async () => ({ profiles: [], defaultProfileId: null })),
    })
    render(() => <App engine={engine} credentials={credentials} mode="frontend" connectionAvailable />)

    selectCsvFile()
    await typeAndSend("对人均GDP做 OLS 回归")

    const thread = within(screen.getByRole("log", { name: "分析对话" }))
    expect(thread.getByText("对人均GDP做 OLS 回归")).toBeTruthy()
    expect(thread.getByText("研究信息已记录")).toBeTruthy()
    expect(engine.commands).not.toHaveBeenCalled()
    expect(engine.uploadDataset).not.toHaveBeenCalled()
    expect(engine.startRun).not.toHaveBeenCalled()
    expect(credentials.hasApiKey).not.toHaveBeenCalled()
    expect(credentials.listProfiles).not.toHaveBeenCalled()
  })

  test("activates the selected local profile only after the researcher connects", async () => {
    const user = userEvent.setup()
    const health = vi.fn(async () => ({ protocolVersion: "v1" as const, engineVersion: "test", status: "ready" as const }))
    const commands = vi.fn(async () => [])
    const subscribeVerification = vi.fn(() => () => {})
    const prepareEngineForAnalysis = vi.fn(async () => {})
    const credentials = createMockCredentials({
      listProfiles: async () => ({
        profiles: [{ id: "profile-1", provider: "deepseek", model: "deepseek/deepseek-v4-flash", configured: true, isDefault: true }],
        defaultProfileId: "profile-1",
      }),
      prepareEngineForAnalysis,
    })
    render(() => <App
      engine={createMockEngine({ health, commands, subscribeVerification })}
      credentials={credentials}
      mode="frontend"
      connectionAvailable
      requireApiKey
    />)

    expect(prepareEngineForAnalysis).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "设置" }))
    await user.click(screen.getByRole("button", { name: "连接分析核心" }))

    await waitFor(() => expect(screen.getByRole("status", { name: "分析核心就绪" })).toBeTruthy())
    expect(prepareEngineForAnalysis).toHaveBeenCalledOnce()
    expect(commands).toHaveBeenCalledOnce()
    expect(health).toHaveBeenCalledOnce()
    expect(subscribeVerification).toHaveBeenCalledOnce()
  })

  test("hides the connection action in a shared frontend-only preview", async () => {
    const user = userEvent.setup()
    render(() => <App connectionAvailable={false} />)

    await user.click(screen.getByRole("button", { name: "设置" }))
    expect(screen.queryByRole("button", { name: "连接分析核心" })).toBeNull()
  })

  test("requires a visitor workspace before connecting to the shared host", async () => {
    const user = userEvent.setup()
    const health = vi.fn(async () => ({ protocolVersion: "v1" as const, engineVersion: "host", status: "ready" as const }))
    const hasApiKey = vi.fn(async () => true)
    const workspacePicker = vi.fn(async () => ({ id: "visitor-workspace-1", name: "visitor-study" }))
    render(() => <App
      engine={createMockEngine({ health })}
      credentials={createMockCredentials({ hasApiKey })}
      workspacePicker={workspacePicker}
      mode="frontend"
      connectionAvailable
      sharedVisitor
      requireApiKey
    />)

    await user.click(screen.getByRole("button", { name: "设置" }))
    await user.click(screen.getByRole("button", { name: "连接分析核心" }))

    expect(screen.getByText("请先选择一个工作区。连接后，访客提交的文件会上传到主机，并保存在此工作区中。"))
    expect(hasApiKey).not.toHaveBeenCalled()
    expect(health).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "选择本地工作区" }))
    await waitFor(() => expect(workspacePicker).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole("status", { name: "分析核心就绪" })).toBeTruthy())
  })

  test("connects a shared visitor to the host profile and uploads data only on submit", async () => {
    const user = userEvent.setup()
    const health = vi.fn(async () => ({ protocolVersion: "v1" as const, engineVersion: "host", status: "ready" as const }))
    const uploadDataset = vi.fn(async (file: File) => ({ id: "dataset-visitor", name: file.name, format: "CSV", bytes: file.size }))
    const startRun = vi.fn(async () => ({ runId: "visitor-run" }))
    const prepareEngineForAnalysis = vi.fn(async () => {})
    const hasApiKey = vi.fn(async () => true)
    const credentials = createMockCredentials({
      hasApiKey,
      listProfiles: async () => ({
        profiles: [{ id: "host-default", provider: "deepseek", model: "deepseek/deepseek-v4-flash", configured: true, isDefault: true }],
        defaultProfileId: "host-default",
      }),
      prepareEngineForAnalysis,
    })
    const workspacePicker = vi.fn(async () => ({ id: "visitor-workspace-2", name: "visitor-study" }))
    render(() => <App
      engine={createMockEngine({ health, uploadDataset, startRun })}
      credentials={credentials}
      workspacePicker={workspacePicker}
      mode="frontend"
      connectionAvailable
      sharedVisitor
      requireApiKey
    />)

    await user.click(screen.getByRole("button", { name: "选择本地工作区" }))
    await waitFor(() => expect(workspacePicker).toHaveBeenCalledOnce())
    selectCsvFile()
    expect(hasApiKey).not.toHaveBeenCalled()
    expect(prepareEngineForAnalysis).not.toHaveBeenCalled()
    expect(uploadDataset).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "设置" }))
    await user.click(screen.getByRole("button", { name: "连接分析核心" }))
    await waitFor(() => expect(screen.getByRole("status", { name: "分析核心就绪" })).toBeTruthy())
    expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull()
    expect(prepareEngineForAnalysis).toHaveBeenCalledOnce()
    expect(uploadDataset).not.toHaveBeenCalled()
    expect(screen.getByRole("status", { name: "分享分析数据说明" })).toBeTruthy()

    await typeAndSend("估计这个访客样本的处理效应")
    await waitFor(() => expect(uploadDataset).toHaveBeenCalledOnce())
    expect(uploadDataset.mock.calls[0]?.[0].name).toBe("policy-study.csv")
    expect(startRun).toHaveBeenCalledOnce()
    expect(hasApiKey).toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "设置" }))
    await user.click(screen.getByRole("button", { name: "模型管理" }))
    expect(screen.getByText("主机模型由分享页面所有者管理。访客不能查看或修改 API Key。"))
    expect(screen.queryByRole("button", { name: /配置模型/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /编辑/ })).toBeNull()
  })

  test("tells a shared visitor when the host has not configured a model without opening credential editing", async () => {
    const user = userEvent.setup()
    const health = vi.fn(async () => ({ protocolVersion: "v1" as const, engineVersion: "host", status: "ready" as const }))
    const workspacePicker = vi.fn(async () => ({ id: "visitor-workspace-3", name: "visitor-study" }))
    const hasApiKey = vi.fn(async () => false)
    render(() => <App
      engine={createMockEngine({ health })}
      credentials={createMockCredentials({ hasApiKey, listProfiles: async () => ({ profiles: [], defaultProfileId: null }) })}
      workspacePicker={workspacePicker}
      mode="frontend"
      connectionAvailable
      sharedVisitor
      requireApiKey
    />)

    await user.click(screen.getByRole("button", { name: "选择本地工作区" }))
    await waitFor(() => expect(workspacePicker).toHaveBeenCalledOnce())
    await user.click(screen.getByRole("button", { name: "设置" }))
    await user.click(screen.getByRole("button", { name: "连接分析核心" }))

    expect(await screen.findByText("主机尚未配置模型。请联系分享页面所有者完成配置后重试。"))
    expect(screen.queryByRole("heading", { name: "模型管理" })).toBeNull()
    expect(health).not.toHaveBeenCalled()
  })

  test("keeps workspace selection disabled when the preview has no local adapter", () => {
    render(() => <App />)

    const workspacePicker = screen.getByRole("button", { name: "选择本地工作区" }) as HTMLButtonElement
    expect(workspacePicker.disabled).toBe(true)
    expect(workspacePicker.title).toContain("未连接本机工作区")
  })

  test("uses browser workspace and file adapters through the shared workspace controls", async () => {
    const user = userEvent.setup()
    const workspacePicker = vi.fn(async () => ({ id: "web-workspace-1", name: "panel-study" }))
    const workspaceFilePicker = vi.fn(async () => new File(["id,y\n1,2"], "sample.csv", { type: "text/csv" }))
    render(() => <App mode="connected" workspacePicker={workspacePicker} workspaceFilePicker={workspaceFilePicker} />)

    const addWorkspaceButton = screen.getByRole("button", { name: "选择本地工作区" }) as HTMLButtonElement
    expect(addWorkspaceButton.title).toContain("明确选择数据文件")
    await user.click(addWorkspaceButton)
    await waitFor(() => expect(screen.getByRole("status", { name: "当前工作区：panel-study" })).toBeTruthy())
    expect(workspacePicker).toHaveBeenCalledOnce()

    const prompt = screen.getByRole("textbox")
    await user.type(prompt, "@")
    await user.click(screen.getByRole("button", { name: "从工作区选择文件" }))

    expect(workspaceFilePicker).toHaveBeenCalledWith("web-workspace-1")
    await waitFor(() => expect((prompt as HTMLTextAreaElement).value).toBe("@sample.csv "))
  })

  test("shows the same settings categories in browser preview mode", async () => {
    const user = userEvent.setup()
    render(() => <App />)

    await user.click(screen.getByRole("button", { name: "设置" }))
    const navigation = screen.getByRole("navigation", { name: "设置分类" })
    expect(within(navigation).getByRole("button", { name: "模型管理" })).toBeTruthy()
    expect(within(navigation).getByRole("button", { name: "运行环境" })).toBeTruthy()

    await user.click(within(navigation).getByRole("button", { name: "模型管理" }))
    expect(screen.getByRole("heading", { name: "模型管理", level: 2 })).toBeTruthy()
    expect(screen.getByText("浏览器预览仅在当前页面展示模型配置；不会保存或发送 API Key。")).toBeTruthy()
    await user.click(within(navigation).getByRole("button", { name: "运行环境" }))
    expect(screen.getByRole("heading", { name: "运行环境", level: 2 })).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "检查本机环境" }))
    expect(await screen.findByText("仅桌面应用可检测本机运行环境。")).toBeTruthy()
  })

  test("does not advertise a configuration-file action without a platform implementation", async () => {
    const user = userEvent.setup()
    render(() => <App />)

    await user.click(screen.getByRole("button", { name: "设置" }))

    expect(screen.queryByRole("button", { name: "打开配置文件" })).toBeNull()
  })

  test("uses shared local credential wording in connected model settings", async () => {
    const user = userEvent.setup()
    render(() => <App
      mode="connected"
      credentials={createMockCredentials()}
    />)

    await user.click(screen.getByRole("button", { name: "设置" }))
    const navigation = screen.getByRole("navigation", { name: "设置分类" })
    await user.click(within(navigation).getByRole("button", { name: "模型管理" }))

    expect(screen.getByText("管理已保存的服务商、模型和默认项。API Key 只保存在 KillStata 本机凭据存储中。")).toBeTruthy()
  })

  test("uses platform-neutral wording for connected Web runtime errors", async () => {
    const user = userEvent.setup()
    render(() => <App
      mode="connected"
      credentials={createMockCredentials()}
      runtimeDiagnostics={{
        inspect: async () => ({
          python: { label: "Python 解释器", status: "error", detail: "未检测到", suggestion: "安装 Python 后重试。" },
          packages: [],
        }),
      }}
    />)

    await user.click(screen.getByRole("button", { name: "设置" }))
    const navigation = screen.getByRole("navigation", { name: "设置分类" })
    await user.click(within(navigation).getByRole("button", { name: "运行环境" }))
    await user.click(screen.getByRole("button", { name: "检查本机环境" }))

    expect(await screen.findByText(/当前本机未发现可用于分析的 Python 解释器/)).toBeTruthy()
  })

  test("uses the shared KillStata product label in browser settings", async () => {
    const user = userEvent.setup()
    render(() => <App />)

    await user.click(screen.getByRole("button", { name: "设置" }))
    expect(screen.getByText(/^KillStata v/)).toBeTruthy()
  })

  test("labels browser preview without claiming the analysis engine is ready", () => {
    render(() => <App />)

    expect(screen.getByRole("status", { name: "本地体验模式，未连接分析核心" })).toBeTruthy()
    expect(screen.queryByRole("status", { name: "分析核心就绪" })).toBeNull()
  })

  test("keeps unstructured progress and local timers out of the conversation", async () => {
    const startRun = vi.fn(async (_input: EngineRunRequest) => ({ runId: "run-1" }))
    const getResult = vi.fn(async () => ({ runId: "run-1", status: "completed" as const, document: "## 已回归" }))
    let emitEvent: ((event: EngineRunEvent) => void) | undefined
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      emitEvent = listener
      listener({ type: "progress", message: "计算系数" })
      return () => {}
    })
    render(() => <App engine={createMockEngine({ startRun, subscribe, getResult })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("估计处理效应")

    await waitFor(() => expect(startRun).toHaveBeenCalledOnce())
    expect(screen.queryByText("计算系数")).toBeNull()
    expect(screen.queryByText(/已用时/)).toBeNull()
    emitEvent?.({ type: "completed", message: "分析已完成。" })
    await waitFor(() => expect(screen.getByRole("heading", { name: "已回归" })).toBeTruthy())
    expect(screen.queryByText(/已用时/)).toBeNull()
  })

  test("独立核验在主回答结束后完成时，在原研究中补充状态且不重开分析", async () => {
    let emitEvent: ((event: EngineRunEvent) => void) | undefined
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      emitEvent = listener
      return () => {}
    })
    render(() => <App engine={createMockEngine({ subscribe })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("估计处理效应")
    await waitFor(() => expect(emitEvent).toBeTypeOf("function"))

    emitEvent?.({ type: "progress", message: "已完成基准回归", step: { id: "call_ols", label: "基准回归", phase: "analysis", status: "completed" } })
    emitEvent?.({ type: "assistant_delta", text: "回归结果已生成，等待独立核验。" })
    emitEvent?.({ type: "completed", message: "分析已完成。" })
    emitEvent?.({ type: "verification", callID: "call_ols", status: "pass", message: "独立核验通过。" })

    await waitFor(() => expect(screen.getByText("独立核验")).toBeTruthy())
    expect(screen.getAllByText("独立核验")).toHaveLength(1)
    expect(screen.getByRole("log", { name: "分析对话" }).textContent).toContain("回归结果已生成")
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy()
  })

  test("Core 的会话级核验早于 runID 和工具进度时暂存并补写原研究", async () => {
    let emitEvent: ((event: EngineRunEvent) => void) | undefined
    let emitVerification: ((update: { sessionID: string; messageID: string; callID: string; status: "pass" | "warn" | "block" | "pending"; message: string }) => void) | undefined
    const engine = createMockEngine({
      startRun: async () => {
        // Simulate Core's session-level event arriving before startRun has assigned the research.
        emitVerification?.({ sessionID: "run-1", messageID: "msg_ols", callID: "call_ols", status: "pass", message: "独立核验通过。" })
        return { runId: "run-1" }
      },
      subscribe: (_runId, listener) => { emitEvent = listener; return () => {} },
      subscribeVerification: (listener) => { emitVerification = listener; return () => {} },
    })
    render(() => <App engine={engine} mode="connected" />)
    selectCsvFile()
    await typeAndSend("估计处理效应")
    await waitFor(() => expect(emitEvent).toBeTypeOf("function"))
    emitEvent?.({ type: "progress", message: "已完成基准回归", step: { id: "call_ols", label: "基准回归", phase: "analysis", status: "completed" } })
    emitEvent?.({ type: "completed", message: "分析已完成。" })

    await waitFor(() => expect(screen.getByText("独立核验")).toBeTruthy())
    expect(screen.getByRole("log", { name: "分析对话" }).textContent).toContain("基准回归")
  })

  test("切换到另一项研究后，旧核验更新只回填原研究", async () => {
    let count = 0
    let emitVerification: ((update: { sessionID: string; messageID: string; callID: string; status: "pass" | "warn" | "block" | "pending"; message: string }) => void) | undefined
    const engine = createMockEngine({
      startRun: async () => ({ runId: `run-${++count}` }),
      subscribe: (_runID, listener) => {
        queueMicrotask(() => {
          if (_runID === "run-1") listener({ type: "progress", message: "已完成基准回归", step: { id: "call_old", label: "基准回归", phase: "analysis", status: "completed" } })
          listener({ type: "completed", message: "分析已完成。" })
        })
        return () => {}
      },
      subscribeVerification: (listener) => { emitVerification = listener; return () => {} },
    })
    const user = userEvent.setup()
    render(() => <App engine={engine} mode="connected" />)
    await typeAndSend("第一项研究")
    await waitFor(() => expect(screen.queryByRole("button", { name: "停止分析" })).toBeNull())
    await user.click(screen.getByRole("button", { name: "新对话" }))
    await typeAndSend("第二项研究")
    await waitFor(() => expect(count).toBe(2))
    await waitFor(() => expect(screen.queryByRole("button", { name: "停止分析" })).toBeNull())

    emitVerification?.({ sessionID: "run-1", messageID: "msg_old", callID: "call_old", status: "pass", message: "独立核验通过。" })
    expect(screen.queryByText("独立核验")).toBeNull()
    await user.click(screen.getByRole("button", { name: "打开研究：第一项研究" }))
    expect(screen.getByText("独立核验")).toBeTruthy()
  })

  test("keeps routine harness messages out of the conversation while streaming model text", async () => {
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      listener({ type: "progress", message: "正在读取数据…" })
      listener({ type: "assistant_delta", text: "模型正在说明数据与研究问题。" })
      return () => {}
    })
    render(() => <App engine={createMockEngine({ subscribe })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("请先概览这份数据")

    await waitFor(() => expect(screen.getByText("模型正在说明数据与研究问题。")).toBeTruthy())
    expect(screen.queryByText("正在准备数据…")).toBeNull()
    expect(screen.queryByText("正在读取数据…")).toBeNull()
    expect(screen.queryByText(/分析任务已建立/)).toBeNull()
    expect(screen.queryByText(/已用时/)).toBeNull()
  })

  test("resizes the composer when a starter fills it and a new research clears it", async () => {
    const user = userEvent.setup()
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "scrollHeight")
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get() { return this.value.length > 20 ? 144 : 24 },
    })
    try {
      render(() => <App />)
      const input = screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement
      await user.click(screen.getByRole("button", { name: "政策前后变化" }))
      await waitFor(() => expect(input.style.height).toBe("144px"))

      await user.click(screen.getByRole("button", { name: "新对话" }))
      await waitFor(() => expect(input.style.height).toBe("24px"))
    } finally {
      if (descriptor) Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", descriptor)
      else delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight
    }
  })

  test("keeps a selected native folder as the active read-only research workspace", async () => {
    const user = userEvent.setup()
    const pickWorkspace = vi.fn(async () => "/Users/cw/Documents/observatory")
    render(() => <App workspacePicker={pickWorkspace} />)

    expect(screen.getByRole("navigation", { name: "研究工作区" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "选择本地工作区" })).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "选择本地工作区" }))

    expect(screen.getByRole("status", { name: "当前工作区：observatory" })).toBeTruthy()
    expect(screen.getByRole("status", { name: "当前研究上下文：工作区 observatory；数据 未选择" })).toBeTruthy()
    expect(pickWorkspace).toHaveBeenCalledOnce()
  })

  test("lets a researcher change or clear the selected local workspace in place", async () => {
    const user = userEvent.setup()
    const pickWorkspace = vi.fn()
      .mockResolvedValueOnce("/Users/cw/Documents/observatory")
      .mockResolvedValueOnce("/Users/cw/Documents/policy-lab")
    render(() => <App workspacePicker={pickWorkspace} />)

    await user.click(screen.getByRole("button", { name: "选择本地工作区" }))
    expect(screen.getByRole("status", { name: "当前工作区：observatory" })).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "更换本地工作区" }))
    expect(pickWorkspace).toHaveBeenCalledTimes(2)
    expect(screen.getByRole("status", { name: "当前工作区：policy-lab" })).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "清除本地工作区" }))
    expect(screen.queryByRole("status", { name: /当前工作区/ })).toBeNull()
    expect(screen.getByRole("button", { name: "选择本地工作区" })).toBeTruthy()
  })

  test("publishes the active workspace ID to the connected engine adapter", async () => {
    const user = userEvent.setup()
    const onWorkspaceContextChange = vi.fn()
    const pickWorkspace = vi.fn(async () => ({ id: "workspace-server-1", name: "policy-lab" }))
    render(() => <App mode="connected" workspacePicker={pickWorkspace} workspaceContextChanged={onWorkspaceContextChange} />)

    await waitFor(() => expect(onWorkspaceContextChange).toHaveBeenLastCalledWith("__unassigned__"))
    await user.click(screen.getByRole("button", { name: "选择本地工作区" }))
    await waitFor(() => expect(onWorkspaceContextChange).toHaveBeenLastCalledWith("workspace-server-1"))

    await user.click(screen.getByRole("button", { name: "清除本地工作区" }))
    await waitFor(() => expect(onWorkspaceContextChange).toHaveBeenLastCalledWith("__unassigned__"))
  })

  test("uses @ to explicitly choose one file from the selected workspace", async () => {
    const user = userEvent.setup()
    const pickWorkspace = vi.fn(async () => "/Users/cw/Documents/policy-lab")
    const pickWorkspaceFile = vi.fn(async () => new File(["id,y\n1,2"], "policy.csv", { type: "text/csv" }))
    render(() => <App workspacePicker={pickWorkspace} workspaceFilePicker={pickWorkspaceFile} />)

    await user.click(screen.getByRole("button", { name: "选择本地工作区" }))
    const input = screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement
    await user.type(input, "@")
    await user.click(screen.getByRole("button", { name: "从工作区选择文件" }))

    await waitFor(() => expect(pickWorkspaceFile).toHaveBeenCalledOnce())
    expect(screen.getByRole("status", { name: "已选择数据文件" }).textContent).toContain("policy.csv")
    expect(input.value).toBe("@policy.csv ")
  })

  test("keeps the current attachment on @ cancellation and replaces it after an explicit workspace choice", async () => {
    const user = userEvent.setup()
    const pickWorkspace = vi.fn(async () => "/Users/cw/Documents/policy-lab")
    const pickWorkspaceFile = vi
      .fn<() => Promise<File | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(new File(["id,y\n3,4"], "replacement.csv", { type: "text/csv" }))
    render(() => <App workspacePicker={pickWorkspace} workspaceFilePicker={pickWorkspaceFile} />)

    await user.click(screen.getByRole("button", { name: "选择本地工作区" }))
    selectCsvFile("current.csv")
    const input = screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement
    await user.type(input, "请比较 @")

    await user.click(screen.getByRole("button", { name: "从工作区选择文件" }))
    await waitFor(() => expect(pickWorkspaceFile).toHaveBeenCalledOnce())
    expect(screen.getByRole("status", { name: "已选择数据文件" }).textContent).toContain("current.csv")
    expect(input.value).toBe("请比较 @")

    await user.click(screen.getByRole("button", { name: "从工作区选择文件" }))
    await waitFor(() => expect(pickWorkspaceFile).toHaveBeenCalledTimes(2))
    const attachment = screen.getByRole("status", { name: "已选择数据文件" })
    expect(attachment.textContent).toContain("replacement.csv")
    expect(attachment.textContent).not.toContain("current.csv")
    expect(input.value).toBe("请比较 @replacement.csv ")
  })

  test("keeps @ free of workspace file names until the researcher selects a workspace", async () => {
    const user = userEvent.setup()
    const pickWorkspace = vi.fn(async () => "/Users/cw/Documents/policy-lab")
    render(() => <App workspacePicker={pickWorkspace} />)

    await user.type(screen.getByRole("textbox", { name: "研究问题" }), "@")
    const reference = screen.getByRole("group", { name: "工作区文件引用" })
    expect(within(reference).getByRole("button", { name: /选择本地工作区/ })).toBeTruthy()
    expect(reference.textContent).not.toContain("policy.csv")

    await user.click(within(reference).getByRole("button", { name: /选择本地工作区/ }))
    expect(pickWorkspace).toHaveBeenCalledOnce()
  })

  test("keeps the empty research page free of context metadata", () => {
    render(() => <App />)
    expect(screen.queryByRole("status", { name: /当前研究上下文/ })).toBeNull()
    expect(screen.queryByRole("button", { name: "从研究起点选择本地工作区" })).toBeNull()
  })

  test("opens workspace controls from the compact header", async () => {
    const user = userEvent.setup()
    render(() => <App />)

    const toggle = screen.getByRole("button", { name: "打开工作区" })
    await user.click(toggle)
    const close = screen.getByRole("button", { name: "关闭工作区" })
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(document.activeElement).toBe(close)

    await user.keyboard("{Escape}")
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(document.activeElement).toBe(toggle)
  })

  test("closes the compact workspace drawer before opening settings", async () => {
    const user = userEvent.setup()
    render(() => <App />)

    await user.click(screen.getByRole("button", { name: "打开工作区" }))
    const workspaceDialog = screen.getByRole("dialog", { name: "研究工作区" })
    await user.click(within(workspaceDialog).getByRole("button", { name: "设置" }))

    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy()
    expect(screen.queryByRole("dialog", { name: "研究工作区" })).toBeNull()
  })

  test("shows the selected dataset as an attachment chip", async () => {
    render(() => <App />)
    selectCsvFile()
    const attachment = screen.getByRole("status", { name: "已选择数据文件" })
    expect(attachment).toBeTruthy()
    expect(screen.getByRole("status", { name: "当前研究上下文：工作区 未选择；数据 policy-study.csv" })).toBeTruthy()
    expect(within(attachment).getByText("policy-study.csv")).toBeTruthy()
  })

  test("removes the dataset from the attachment chip", async () => {
    const user = userEvent.setup()
    render(() => <App />)
    selectCsvFile()
    await user.click(screen.getByRole("button", { name: "移除数据文件" }))
    expect(screen.queryByText("policy-study.csv")).toBeNull()
    expect(screen.queryByRole("status", { name: /当前研究上下文/ })).toBeNull()
  })

  test("enables sending on a nonempty question alone, with or without data", async () => {
    const user = userEvent.setup()
    render(() => <App />)
    const send = screen.getByRole("button", { name: "发送" })
    expect(screen.getByRole("textbox", { name: "研究问题" }).getAttribute("placeholder"))
      .toBe("描述研究问题…（可 / 选命令、@ 引用工作区文件）")
    expect(send.hasAttribute("disabled")).toBe(true)

    await user.type(screen.getByRole("textbox"), "双重差分需要哪些前提假设")
    expect(send.hasAttribute("disabled")).toBe(false)

    selectCsvFile()
    expect(send.hasAttribute("disabled")).toBe(false)
    expect(screen.getByRole("textbox", { name: "研究问题" }).getAttribute("placeholder")).toBe("描述研究问题…")
  })

  test("sends a data-free question to the engine without uploading a dataset", async () => {
    const uploadDataset = vi.fn()
    const startRun = vi.fn(async (_input: EngineRunRequest) => ({ runId: "run-1" }))
    render(() => <App engine={createMockEngine({ startRun, uploadDataset })} mode="connected" />)

    await typeAndSend("双重差分需要哪些前提假设")

    await waitFor(() => expect(startRun).toHaveBeenCalledOnce())
    expect(uploadDataset).not.toHaveBeenCalled()
    expect(startRun.mock.calls[0]![0].dataset).toBeUndefined()
    expect(startRun.mock.calls[0]![0].prompt).toBe("双重差分需要哪些前提假设")
  })

  test("continues the same Core session for a follow-up in one research", async () => {
    let runNumber = 0
    const listeners: Array<(event: EngineRunEvent) => void> = []
    const startRun = vi.fn(async (input: EngineRunRequest) => ({ runId: input.sessionID ?? `run-${++runNumber}` }))
    const subscribe = vi.fn((_runID: string, listener: (event: EngineRunEvent) => void) => {
      listeners.push(listener)
      queueMicrotask(() => listener({ type: "completed", message: "完成" }))
      return () => {}
    })
    render(() => <App engine={createMockEngine({ startRun, subscribe })} mode="connected" />)

    await typeAndSend("先分析这项研究")
    await waitFor(() => expect(listeners).toHaveLength(1))
    await waitFor(() => expect(screen.queryByRole("button", { name: "停止分析" })).toBeNull())
    await typeAndSend("继续解释刚才的结果")
    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(2))

    expect(startRun.mock.calls[0]![0].sessionID).toBeUndefined()
    expect(startRun.mock.calls[1]![0].sessionID).toBe("run-1")
  })

  test("restores the Core session when switching back to an in-memory research", async () => {
    let runNumber = 0
    const startRun = vi.fn(async (input: EngineRunRequest) => ({ runId: input.sessionID ?? `run-${++runNumber}` }))
    const subscribe = vi.fn((_runID: string, listener: (event: EngineRunEvent) => void) => {
      queueMicrotask(() => listener({ type: "completed", message: "完成" }))
      return () => {}
    })
    const user = userEvent.setup()
    render(() => <App engine={createMockEngine({ startRun, subscribe })} mode="connected" />)

    await typeAndSend("第一项研究")
    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole("button", { name: "停止分析" })).toBeNull())
    await user.click(screen.getByRole("button", { name: "新对话" }))
    await typeAndSend("第二项研究")
    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole("button", { name: "停止分析" })).toBeNull())

    await user.click(screen.getByRole("button", { name: "打开研究：第一项研究" }))
    await typeAndSend("继续第一项研究")
    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(3))

    expect(startRun.mock.calls[2]![0].sessionID).toBe("run-1")
  })

  test("restores the in-memory dataset and Core session when switching workspaces", async () => {
    let runNumber = 0
    const startRun = vi.fn(async (input: EngineRunRequest) => ({ runId: input.sessionID ?? `run-${++runNumber}` }))
    const subscribe = vi.fn((_runID: string, listener: (event: EngineRunEvent) => void) => {
      queueMicrotask(() => listener({ type: "completed", message: "完成" }))
      return () => {}
    })
    const pickWorkspace = vi.fn()
      .mockResolvedValueOnce("/Users/cw/Documents/first-lab")
      .mockResolvedValueOnce("/Users/cw/Documents/second-lab")
    const user = userEvent.setup()
    render(() => <App engine={createMockEngine({ startRun, subscribe })} mode="connected" workspacePicker={pickWorkspace} />)

    await user.click(screen.getByRole("button", { name: "选择本地工作区" }))
    selectCsvFile("first-workspace.csv")
    await typeAndSend("第一工作区研究")
    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole("button", { name: "停止分析" })).toBeNull())

    await user.click(screen.getByRole("button", { name: "添加本地工作区" }))
    await typeAndSend("第二工作区研究")
    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole("button", { name: "停止分析" })).toBeNull())

    await user.click(screen.getByRole("button", { name: "切换工作区：first-lab" }))
    expect(screen.getByRole("status", { name: "已选择数据文件" }).textContent).toContain("first-workspace.csv")
    await typeAndSend("继续第一工作区研究")
    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(3))

    expect(startRun.mock.calls[2]![0].sessionID).toBe("run-1")
  })

  test("teaches the @ workspace reference in the placeholder once a workspace is selected but no data yet", async () => {
    const user = userEvent.setup()
    const pickWorkspace = vi.fn(async () => "/Users/cw/Documents/policy-lab")
    render(() => <App workspacePicker={pickWorkspace} />)

    await user.click(screen.getByRole("button", { name: "选择本地工作区" }))
    expect(screen.getByRole("textbox", { name: "研究问题" }).getAttribute("placeholder"))
      .toBe("描述研究问题…（@ 从工作区选择文件）")
  })

  test("records the user question and an honest local research receipt in the thread", async () => {
    render(() => <App />)
    selectCsvFile()
    await typeAndSend("对人均GDP做 OLS 回归")

    const thread = within(screen.getByRole("log", { name: "分析对话" }))
    expect(thread.getByText("对人均GDP做 OLS 回归")).toBeTruthy()
    expect(thread.getByText("研究信息已记录")).toBeTruthy()
    expect(thread.getByText("当前未执行统计分析，也未调用外部模型。")).toBeTruthy()
    expect(screen.getByRole("log", { name: "分析对话" })).toBeTruthy()
    expect(screen.getByRole("button", {
      name: "打开研究：对人均GDP做 OLS 回归",
      description: "数据：policy-study.csv；状态：研究信息已记录",
    })).toBeTruthy()
  })

  test("keeps recent research conversations and their in-memory dataset in the workspace rail", async () => {
    const user = userEvent.setup()
    render(() => <App />)

    selectCsvFile("first-study.csv")
    await typeAndSend("比较首轮政策前后的就业变化")
    const firstSession = screen.getByRole("button", { name: "打开研究：比较首轮政策前后的就业变化" })
    expect(firstSession.textContent).toContain("first-study.csv")
    expect(firstSession.textContent).toContain("研究信息已记录")

    await user.click(screen.getByRole("button", { name: "新对话" }))
    selectCsvFile("second-study.csv")
    await typeAndSend("估计第二个样本的处理效应")
    const secondSession = screen.getByRole("button", { name: "打开研究：估计第二个样本的处理效应" })
    expect(secondSession.textContent).toContain("second-study.csv")
    expect(secondSession.textContent).toContain("研究信息已记录")
    expect(screen.getByRole("status", { name: "当前研究：估计第二个样本的处理效应" })).toBeTruthy()
    expect(screen.getByRole("status", { name: "当前研究上下文：工作区 未选择；数据 second-study.csv" })).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "打开研究：比较首轮政策前后的就业变化" }))
    const thread = within(screen.getByRole("log", { name: "分析对话" }))
    expect(thread.getByText("比较首轮政策前后的就业变化")).toBeTruthy()
    expect(thread.queryByText("估计第二个样本的处理效应")).toBeNull()
    expect(screen.getByRole("status", { name: "当前研究：比较首轮政策前后的就业变化" })).toBeTruthy()
    expect(screen.queryByRole("status", { name: "数据选择提示" })).toBeNull()
    expect(screen.getByRole("status", { name: "已选择数据文件" }).textContent).toContain("first-study.csv")
    expect(screen.getByRole("status", { name: "当前研究上下文：工作区 未选择；数据 first-study.csv" })).toBeTruthy()
  })

  test("filters recent research by its recorded question or data file", async () => {
    const user = userEvent.setup()
    render(() => <App />)

    selectCsvFile("employment-panel.csv")
    await typeAndSend("比较就业政策实施前后对青年就业的影响，并补充地区异质性")
    await user.click(screen.getByRole("button", { name: "新对话" }))
    selectCsvFile("health-survey.csv")
    await typeAndSend("估计健康干预的处理效应")

    const search = screen.getByRole("searchbox", { name: "筛选最近研究" })
    await user.type(search, "employment")

    expect(screen.getByRole("button", { name: /打开研究：比较就业政策实施前后/ })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "打开研究：估计健康干预的处理效应" })).toBeNull()

    await user.clear(search)
    await user.type(search, "地区异质性")
    expect(screen.getByRole("button", { name: /打开研究：比较就业政策实施前后/ })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "打开研究：估计健康干预的处理效应" })).toBeNull()
  })

  test("clears the recent research filter before starting a new research", async () => {
    const user = userEvent.setup()
    render(() => <App />)

    selectCsvFile("employment-panel.csv")
    await typeAndSend("比较就业政策前后的变化")
    await user.click(screen.getByRole("button", { name: "新对话" }))
    selectCsvFile("health-survey.csv")
    await typeAndSend("估计健康干预的处理效应")

    const search = screen.getByRole("searchbox", { name: "筛选最近研究" }) as HTMLInputElement
    await user.type(search, "employment")
    expect(screen.queryByRole("button", { name: "打开研究：估计健康干预的处理效应" })).toBeNull()

    await user.click(screen.getByRole("button", { name: "新对话" }))
    expect(search.value).toBe("")
    expect(screen.getByRole("button", { name: "打开研究：估计健康干预的处理效应" })).toBeTruthy()
  })

  test("submits a research question with Enter from the composer", async () => {
    const user = userEvent.setup()
    render(() => <App />)
    selectCsvFile()
    await user.type(screen.getByRole("textbox"), "比较政策前后变化{Enter}")
    expect(within(screen.getByRole("log", { name: "分析对话" })).getByText("比较政策前后变化")).toBeTruthy()
  })

  test("inserts a newline instead of sending on Shift+Enter", async () => {
    const user = userEvent.setup()
    render(() => <App />)
    selectCsvFile()
    const input = screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement
    await user.type(input, "第一行{Shift>}{Enter}{/Shift}第二行")
    expect(input.value).toBe("第一行\n第二行")
    expect(screen.queryByText("第一行")).toBeNull()
  })

  test("does not choose a slash command while an IME composition is active", async () => {
    const user = userEvent.setup()
    render(() => <App />)
    selectCsvFile()
    const input = screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement
    await user.type(input, "/")
    expect(screen.getByRole("listbox", { name: "斜杠命令" })).toBeTruthy()

    fireEvent.keyDown(input, { key: "Enter", isComposing: true })

    expect(input.value).toBe("/")
    expect(screen.getByRole("listbox", { name: "斜杠命令" })).toBeTruthy()
  })

  test("does not submit on the legacy IME composition key code", async () => {
    const user = userEvent.setup()
    render(() => <App />)
    selectCsvFile()
    const input = screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement
    await user.type(input, "估计处理效应")

    fireEvent.keyDown(input, { key: "Enter", keyCode: 229, metaKey: true })

    expect(within(screen.getByRole("log", { name: "分析对话" })).queryByText("估计处理效应")).toBeNull()
  })

  test("takes over the composer for a structured engine question and resumes after answering", async () => {
    const answerInteraction = vi.fn(async () => {})
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      listener({
        type: "question",
        message: "分析等待你的回答。",
        question: {
          requestId: "question-1",
          title: "选择结果变量",
          prompt: "结果变量是哪一列？",
          mode: "single",
          options: [{ id: "outcome", label: "outcome" }, { id: "income", label: "income" }],
          allowSkip: false,
        },
      })
      return () => {}
    })
    const { container } = render(() => <App engine={createMockEngine({ subscribe, answerInteraction })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("估计处理效应")

    expect(await screen.findByRole("region", { name: "选择结果变量" })).toBeTruthy()
    expect(screen.getByText("结果变量是哪一列？")).toBeTruthy()
    expect(screen.getByRole("textbox", { name: "研究问题" }).hasAttribute("disabled")).toBe(true)
    expect(container.querySelector(".app-header .header-action.is-stop")).toBeNull()
    expect(container.querySelector(".composer-wrap[hidden]")).toBeNull()
    expect(container.querySelector(".composer-send.is-stop")).toBeTruthy()
    expect(screen.getByRole("button", { name: "继续分析" }).hasAttribute("disabled")).toBe(true)

    await userEvent.setup().click(screen.getByRole("button", { name: "outcome" }))
    expect(screen.getByRole("button", { name: "继续分析" }).hasAttribute("disabled")).toBe(false)
    await userEvent.setup().click(screen.getByRole("button", { name: "继续分析" }))

    await waitFor(() => expect(answerInteraction).toHaveBeenCalledWith("run-1", "question-1", { selected: ["outcome"] }))
    expect(screen.queryByRole("region", { name: "选择结果变量" })).toBeNull()
    expect(screen.getByRole("textbox", { name: "研究问题" })).toBeTruthy()
  })

  test("blocks default model changes while an analysis is waiting for a user answer", async () => {
    const user = userEvent.setup()
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      listener({
        type: "question",
        message: "分析等待你的回答。",
        question: { requestId: "question-profile-lock", title: "选择结果变量", prompt: "请选择结果变量", mode: "single", options: [{ id: "y", label: "y" }], allowSkip: false },
      })
      return () => {}
    })
    const snapshot = {
      profiles: [
        { id: "active", provider: "deepseek" as const, model: "deepseek/deepseek-v4-flash", configured: true, isDefault: true },
        { id: "other", provider: "custom" as const, model: "custom/other", baseURL: "https://example.com/v1", configured: true, isDefault: false },
      ],
      defaultProfileId: "active",
    }
    const credentials = createMockCredentials({ listProfiles: async () => snapshot })
    render(() => <App engine={createMockEngine({ subscribe })} mode="connected" credentials={credentials} />)
    selectCsvFile()
    await typeAndSend("估计处理效应")
    await screen.findByRole("region", { name: "选择结果变量" })
    await user.click(screen.getByRole("button", { name: "设置" }))
    await user.click(within(screen.getByRole("navigation", { name: "设置分类" })).getByRole("button", { name: "模型管理" }))

    expect((screen.getByRole("button", { name: "将 OpenAI-compatible · custom/other 设为默认" }) as HTMLButtonElement).disabled).toBe(true)
  })

  test("shows a structured permission request without exposing raw engine fields", async () => {
    const denyInteraction = vi.fn(async () => {})
    const subscribe = vi.fn((_runID: string, listener: (event: EngineRunEvent) => void) => {
      listener({
        type: "permission",
        message: "分析等待你的授权。",
        permission: {
          requestId: "permission-1",
          title: "读取选定数据",
          action: "读取选定数据副本",
          scope: "当前分析工作区",
        },
      })
      return () => {}
    })
    render(() => <App engine={createMockEngine({ subscribe, denyInteraction })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("估计处理效应")

    expect(await screen.findByRole("region", { name: "读取选定数据" })).toBeTruthy()
    expect(screen.getByText("读取选定数据副本")).toBeTruthy()
    expect(screen.getByText("影响范围：当前分析工作区")).toBeTruthy()
    expect(screen.queryByText(/raw|tool|command|\/Users/)).toBeNull()

    await userEvent.setup().click(screen.getByRole("button", { name: "拒绝并停止" }))
    await waitFor(() => expect(denyInteraction).toHaveBeenCalledWith("run-1", "permission-1", "研究者拒绝"))
  })

  test("allows a permission request once", async () => {
    const answerInteraction = vi.fn(async () => {})
    const subscribe = vi.fn((_runID: string, listener: (event: EngineRunEvent) => void) => {
      listener({ type: "permission", message: "分析等待你的授权。", permission: {
        requestId: "permission-allow",
        title: "读取选定数据",
        action: "读取选定数据副本",
        scope: "当前分析工作区",
      } })
      return () => {}
    })
    render(() => <App engine={createMockEngine({ subscribe, answerInteraction })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("估计处理效应")

    expect(await screen.findByRole("button", { name: "允许一次" })).toBeTruthy()
    await userEvent.setup().click(screen.getByRole("button", { name: "允许一次" }))
    await waitFor(() => expect(answerInteraction).toHaveBeenCalledWith("run-1", "permission-allow", { allowed: true }))
  })

  test("keeps the interaction panel open when answering fails", async () => {
    const answerInteraction = vi.fn(async () => { throw new Error("回答被引擎拒绝") })
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      listener({ type: "question", message: "分析等待你的回答。", question: {
        requestId: "question-fail",
        title: "补充信息",
        prompt: "请选择一项",
        mode: "single",
        options: [{ id: "a", label: "选项 A" }],
        allowSkip: false,
      } })
      return () => {}
    })
    render(() => <App engine={createMockEngine({ subscribe, answerInteraction })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("估计处理效应")
    await userEvent.setup().click(await screen.findByRole("button", { name: "选项 A" }))
    await userEvent.setup().click(screen.getByRole("button", { name: "继续分析" }))

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("回答被引擎拒绝"))
    expect(screen.getByRole("region", { name: "补充信息" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "继续分析" }).hasAttribute("disabled")).toBe(false)
  })

  test("cancels a waiting run through the existing stop action", async () => {
    const cancelRun = vi.fn(async () => {})
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      listener({ type: "permission", message: "分析等待你的授权。", permission: {
        requestId: "permission-cancel",
        title: "读取数据",
        action: "读取选定数据副本",
        scope: "当前分析工作区",
      } })
      return () => {}
    })
    render(() => <App engine={createMockEngine({ subscribe, cancelRun })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("估计处理效应")
    expect(await screen.findByRole("region", { name: "读取数据" })).toBeTruthy()
    await userEvent.setup().click(screen.getByRole("button", { name: "停止分析" }))

    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith("run-1"))
    expect(screen.queryByRole("region", { name: "读取数据" })).toBeNull()
  })

  test("shows connected progress and renders the completed result document in the thread", async () => {
    const events: EngineRunEvent[] = [
      { type: "progress", message: "正在读取数据…", step: { id: "read-data", label: "读取数据", phase: "analysis", status: "running" } },
      { type: "completed", message: "分析已完成。" },
    ]
    const startRun = vi.fn(async (_input: EngineRunRequest) => ({ runId: "run-1" }))
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      for (const event of events) listener(event)
      return () => {}
    })
    render(() => <App
      engine={createMockEngine({
        startRun,
        subscribe,
        getResult: async () => ({ runId: "run-1", status: "completed", document: "## 回归结果\n\n| 变量 | 系数 |\n|---|---|\n| did | 1.5 |" }),
      })}
      mode="connected"
    />)

    selectCsvFile()
    await typeAndSend("对人均GDP做 OLS 回归")

    expect(screen.getByText("读取数据")).toBeTruthy()
    await waitFor(() => expect(screen.getByRole("heading", { name: "回归结果" })).toBeTruthy())
    expect(screen.getByRole("cell", { name: "did" })).toBeTruthy()
    expect(screen.getByRole("cell", { name: "1.5" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "打开研究：对人均GDP做 OLS 回归" }).textContent).toContain("结果已就绪")
    expect(startRun).toHaveBeenCalledOnce()
    const request = startRun.mock.calls[0]?.[0] as EngineRunRequest
    expect(request.prompt).toBe("对人均GDP做 OLS 回归")
  })

  test("does not add copy or export controls to a connected result", async () => {
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      listener({ type: "completed", message: "分析已完成。" })
      return () => {}
    })
    render(() => <App engine={createMockEngine({
      subscribe,
      getResult: async () => ({ runId: "run-1", status: "completed", document: "## 回归结果\n\n结果正文" }),
    })} mode="connected" />)

    selectCsvFile("result.csv")
    await typeAndSend("估计处理效应")

    await waitFor(() => expect(screen.getByRole("heading", { name: "回归结果" })).toBeTruthy())
    expect(screen.queryByRole("button", { name: "复制结果" })).toBeNull()
    expect(screen.queryByRole("button", { name: "导出 Markdown" })).toBeNull()
    expect(screen.queryByRole("button", { name: "导出" })).toBeNull()
  })

  test("does not offer result actions for the local frontend receipt", async () => {
    render(() => <App />)
    selectCsvFile()
    await typeAndSend("记录本地研究问题")

    expect(screen.queryByRole("button", { name: "复制结果" })).toBeNull()
    expect(screen.queryByRole("button", { name: "导出 Markdown" })).toBeNull()
  })

  test("sends an attachment-free greeting through the connected model", async () => {
    const startRun = vi.fn(async (_input: EngineRunRequest) => ({ runId: "greeting-run" }))
    const hasApiKey = vi.fn(async () => true)
    const prepareEngineForAnalysis = vi.fn(async () => {})
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      listener({ type: "assistant_delta", text: "模型：你好，很高兴为你服务。" })
      listener({ type: "completed", message: "分析已完成。" })
      return () => {}
    })
    render(() => <App
      engine={createMockEngine({ startRun, subscribe })}
      credentials={createMockCredentials({ hasApiKey, prepareEngineForAnalysis })}
      mode="connected"
      requireApiKey
    />)

    await typeAndSend("你好")

    await waitFor(() => expect(startRun).toHaveBeenCalledOnce())
    expect(hasApiKey).toHaveBeenCalledOnce()
    expect(prepareEngineForAnalysis).toHaveBeenCalledOnce()
    expect(screen.getByText("模型：你好，很高兴为你服务。")).toBeTruthy()
    expect(screen.queryByText("你好，我是 KillStata，专注于计量分析。")).toBeNull()
    expect(screen.queryByText("正在准备…")).toBeNull()
    expect(screen.queryByText("分析任务已建立，正在等待返回…")).toBeNull()
  })

  test("keeps an attached-data greeting on the analysis path", async () => {
    const startRun = vi.fn(async (_input: EngineRunRequest) => ({ runId: "data-greeting-run" }))
    const uploadDataset = vi.fn(async (file: File) => ({ id: "dataset-greeting", name: file.name, format: "CSV", bytes: file.size }))
    render(() => <App engine={createMockEngine({ startRun, uploadDataset })} mode="connected" />)

    selectCsvFile("greeting-data.csv")
    await typeAndSend("你好")

    await waitFor(() => expect(startRun).toHaveBeenCalledOnce())
    expect(uploadDataset).toHaveBeenCalledOnce()
  })

  test("shows every structured execution step without local preparation messages", async () => {
    const progressEvents: EngineRunEvent[] = [
      { type: "progress", message: "正在读取数据…", step: { id: "read", label: "读取数据", phase: "analysis", status: "running" } },
      { type: "progress", message: "正在拟合模型…", step: { id: "fit", label: "拟合模型", phase: "analysis", status: "running" } },
      { type: "progress", message: "正在计算稳健标准误…", step: { id: "se", label: "计算稳健标准误", phase: "analysis", status: "running" } },
    ]
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      for (const event of progressEvents) listener(event)
      return () => {}
    })
    render(() => <App engine={createMockEngine({ subscribe })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("估计处理效应")

    expect(screen.queryByText("正在准备数据…")).toBeNull()
    expect(screen.getByText("读取数据")).toBeTruthy()
    expect(screen.getByText("拟合模型")).toBeTruthy()
    expect(screen.getByText("计算稳健标准误")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /查看前 \d+ 步/ })).toBeNull()
    expect(screen.queryByRole("button", { name: "收起进度" })).toBeNull()
  })

  test("uses structured tool status instead of guessing state from prose", async () => {
    const progressEvents: EngineRunEvent[] = [
      { type: "progress", message: "已完成读取数据", step: { id: "done", label: "读取数据", phase: "analysis", status: "completed" } },
      { type: "progress", message: "估计模型未成功", step: { id: "failed", label: "估计模型", phase: "analysis", status: "failed" } },
      { type: "progress", message: "正在计算诊断…", step: { id: "running", label: "计算诊断", phase: "analysis", status: "running" } },
    ]
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      for (const event of progressEvents) listener(event)
      return () => {}
    })
    render(() => <App engine={createMockEngine({ subscribe })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("估计处理效应")

    expect(screen.getByText("读取数据").closest("details")?.textContent).toContain("已完成")
    expect(screen.getByText("估计模型").closest("details")?.textContent).toContain("需要处理")
    expect(screen.getByText("计算诊断").closest("details")?.textContent).toContain("进行中")
  })

  test("stops following progress after the researcher scrolls up and offers a return control", async () => {
    let emitEvent: ((event: EngineRunEvent) => void) | undefined
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      emitEvent = listener
      return () => {}
    })
    render(() => <App engine={createMockEngine({ subscribe })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("估计处理效应")

    const thread = screen.getByRole("log", { name: "分析对话" })
    Object.defineProperties(thread, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, writable: true, value: 600 },
    })
    fireEvent.scroll(thread)
    thread.scrollTop = 200
    fireEvent.scroll(thread)

    await waitFor(() => expect(screen.getByRole("button", { name: "回到底部" })).toBeTruthy())
    emitEvent?.({ type: "progress", message: "正在计算系数…", step: { id: "coefficient", label: "计算系数", phase: "analysis", status: "running" } })
    await waitFor(() => expect(screen.getByText("计算系数")).toBeTruthy())

    expect(thread.scrollTop).toBe(200)
    await userEvent.setup().click(screen.getByRole("button", { name: "回到底部" }))
    expect(thread.scrollTop).toBe(600)
    expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull()
  })

  test("keeps following new progress while the researcher remains at the bottom", async () => {
    let emitEvent: ((event: EngineRunEvent) => void) | undefined
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      emitEvent = listener
      return () => {}
    })
    render(() => <App engine={createMockEngine({ subscribe })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("估计处理效应")

    const thread = screen.getByRole("log", { name: "分析对话" })
    Object.defineProperties(thread, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, writable: true, value: 600 },
    })
    fireEvent.scroll(thread)
    emitEvent?.({ type: "progress", message: "正在计算系数…", step: { id: "coefficient", label: "计算系数", phase: "analysis", status: "running" } })

    await waitFor(() => expect(screen.getByText("计算系数")).toBeTruthy())
    expect(thread.scrollTop).toBe(600)
    expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull()
  })

  test("renders a structured engine step as a collapsed safe detail", async () => {
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      listener({
        type: "progress",
        message: "正在估计 OLS 回归…",
        step: { id: "ols_regression", label: "估计 OLS 回归", phase: "analysis", status: "running" },
      })
      return () => {}
    })
    render(() => <App engine={createMockEngine({ subscribe })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("估计处理效应")

    const step = await screen.findByText("估计 OLS 回归")
    expect(step.closest("details")?.open).toBe(false)
    expect(screen.queryByText("正在估计 OLS 回归…")).toBeNull()

    await userEvent.setup().click(step)

    expect(screen.getByText("正在估计 OLS 回归…")).toBeTruthy()
    expect(screen.getByText("进行中")).toBeTruthy()
  })

  test("marks a completed run without a readable document as needing attention", async () => {
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      listener({ type: "completed", message: "分析已完成。" })
      return () => {}
    })
    render(() => <App engine={createMockEngine({
      subscribe,
      getResult: async () => ({ runId: "run-1", status: "completed", document: "" }),
    })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("估计处理效应")

    await waitFor(() => expect(screen.getByText("分析未生成可阅读的结果文档。")).toBeTruthy())
    expect(screen.getByRole("button", { name: "打开研究：估计处理效应" }).textContent).toContain("需要处理")
  })

  test("renders an engine failure as a system error message", async () => {
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      listener({ type: "failed", message: "分析引擎未能完成分析：API 余额不足。" })
      return () => {}
    })
    render(() => <App engine={createMockEngine({ subscribe })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("估计处理效应")
    await waitFor(() => expect(screen.getByText(/API 余额不足/)).toBeTruthy())
    expect(screen.getByRole("button", { name: "打开研究：估计处理效应" }).textContent).toContain("需要处理")
  })

  test("同步终态到达时不再追加过时的任务已建立提示", async () => {
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      listener({ type: "failed", message: "分析未能完成。" })
      return () => {}
    })
    render(() => <App engine={createMockEngine({ subscribe })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("估计处理效应")

    await waitFor(() => expect(screen.getByText("分析未能完成。")).toBeTruthy())
    expect(screen.queryByText("分析任务已建立，正在等待返回…")).toBeNull()
  })

  test("任务提交失败只显示一次用户可见错误", async () => {
    const startRun = vi.fn(async () => { throw new Error("模型服务暂时不可用") })
    const { container } = render(() => <App engine={createMockEngine({ startRun })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("估计处理效应")

    await waitFor(() => expect(screen.getByText("模型服务暂时不可用")).toBeTruthy())
    expect([...container.querySelectorAll(".message.is-system")]
      .filter((element) => element.textContent?.includes("模型服务暂时不可用"))).toHaveLength(1)
  })

  test("renders cancellation as a system message", async () => {
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      listener({ type: "progress", message: "分析任务已建立，正在等待返回…" })
      return () => {}
    })
    render(() => <App engine={createMockEngine({ subscribe })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("估计处理效应")
    const stop = await screen.findByRole("button", { name: "停止分析" })
    await userEvent.setup().click(stop)
    await waitFor(() => expect(screen.getByText("已停止分析。")).toBeTruthy())
  })

  test("keeps the Core session after stopping one turn so the researcher can correct and continue", async () => {
    let runNumber = 0
    const startRun = vi.fn(async (input: EngineRunRequest) => ({ runId: input.sessionID ?? `run-${++runNumber}` }))
    const subscribe = vi.fn(() => () => {})
    const cancelRun = vi.fn(async () => {})
    render(() => <App engine={createMockEngine({ startRun, subscribe, cancelRun })} mode="connected" />)

    await typeAndSend("先尝试基准回归")
    await userEvent.setup().click(await screen.findByRole("button", { name: "停止分析" }))
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith("run-1"))
    await typeAndSend("改用稳健标准误继续")
    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(2))

    expect(startRun.mock.calls[1]![0].sessionID).toBe("run-1")
  })

  test("streams reasoning and assistant text into a single bubble and finalizes on completion", async () => {
    let listen: ((event: EngineRunEvent) => void) | undefined
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      listen = listener
      return () => {}
    })
    // 若走了一次性 getResult 兜底，会 append 第二个气泡——用一个可分辨的文案来断言它没被用到。
    const getResult = vi.fn(async () => ({ runId: "run-1", status: "completed" as const, document: "一次性兜底文档" }))
    const { container } = render(() => <App engine={createMockEngine({ subscribe, getResult })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("估计处理效应")
    await waitFor(() => expect(listen).toBeTypeOf("function"))

    listen!({ type: "reasoning_delta", text: "先看数据结构" })
    listen!({ type: "assistant_delta", text: "## 结果" })
    listen!({ type: "assistant_delta", text: "## 结果\n\n处理效应显著。" })
    await waitFor(() => expect(screen.getByText("处理效应显著。")).toBeTruthy())
    // 思考过程在首个流式片段到达时保持折叠，不遮挡正在生成的回复正文。
    expect(screen.getByText("展开思考过程")).toBeTruthy()
    expect(screen.queryByText("先看数据结构")).toBeNull()
    expect(container.querySelector(".progress-spinner")).toBeNull()

    await userEvent.setup().click(screen.getByText("展开思考过程"))
    expect(screen.getByText("先看数据结构")).toBeTruthy()
    listen!({ type: "reasoning_delta", text: "先看数据结构，再说明识别策略" })
    expect(screen.getByText("先看数据结构，再说明识别策略")).toBeTruthy()
    await userEvent.setup().click(screen.getByText("收起思考过程"))
    expect(screen.queryByText("先看数据结构，再说明识别策略")).toBeNull()

    listen!({ type: "completed", message: "分析已完成。" })

    await waitFor(() => expect(container.querySelectorAll(".message.is-assistant")).toHaveLength(1))
    expect(screen.queryByText("一次性兜底文档")).toBeNull()
    expect(getResult).not.toHaveBeenCalled()

    // 终态继续保留用户刚才选择的折叠状态，助手正文仍可见。
    expect(screen.getByText("展开思考过程")).toBeTruthy()
    expect(screen.queryByText("先看数据结构，再说明识别策略")).toBeNull()
    expect(screen.getByText("处理效应显著。")).toBeTruthy()
  })

  test("releases the active engine subscription when the Desktop view unmounts", async () => {
    const off = vi.fn()
    const subscribe = vi.fn((_runId: string, _listener: (event: EngineRunEvent) => void) => off)
    const view = render(() => <App engine={createMockEngine({ subscribe })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("估计处理效应")
    await waitFor(() => expect(subscribe).toHaveBeenCalledOnce())

    view.unmount()

    expect(off).toHaveBeenCalledOnce()
  })

  test("keeps a completed result with its original research after switching away", async () => {
    let resolveResult: ((value: { runId: string; status: "completed"; document: string }) => void) | undefined
    const getResult = vi.fn(() => new Promise<{ runId: string; status: "completed"; document: string }>((resolve) => {
      resolveResult = resolve
    }))
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      listener({ type: "completed", message: "分析已完成。" })
      return () => {}
    })
    const user = userEvent.setup()
    render(() => <App engine={createMockEngine({ getResult, subscribe })} mode="connected" />)
    selectCsvFile("first-study.csv")
    await typeAndSend("比较首轮政策前后的就业变化")
    await waitFor(() => expect(getResult).toHaveBeenCalledOnce())

    await user.click(screen.getByRole("button", { name: "新对话" }))
    const result = { runId: "run-1", status: "completed" as const, document: "旧研究结果不得串入新研究" }
    resolveResult?.(result)
    await Promise.resolve()
    await Promise.resolve()

    expect(screen.queryByText(result.document)).toBeNull()
    await user.click(screen.getByRole("button", { name: "打开研究：比较首轮政策前后的就业变化" }))
    await waitFor(() => expect(screen.getByText(result.document)).toBeTruthy())
    expect(screen.queryByRole("button", { name: "导出" })).toBeNull()
  })

  test("ignores an old engine event after the dataset is replaced", async () => {
    const listeners: Array<(event: EngineRunEvent) => void> = []
    let runCounter = 0
    const startRun = vi.fn(async () => ({ runId: `run-${++runCounter}` }))
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      listeners.push(listener)
      listener({ type: "completed", message: "分析已完成。" })
      return () => {}
    })
    render(() => <App engine={createMockEngine({ subscribe, startRun })} mode="connected" />)
    selectCsvFile("first.csv")
    await typeAndSend("第一次分析")
    expect(listeners.length).toBe(1)

    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "移除数据文件" }))
    selectCsvFile("second.csv")
    await typeAndSend("第二次分析")
    await waitFor(() => expect(listeners.length).toBe(2))

    // 旧 run 的事件不应写入当前消息流
    listeners[0]?.({ type: "progress", message: "旧任务仍在运行" })
    expect(screen.queryByText("旧任务仍在运行")).toBeNull()
  })

  test("sends the selected Excel worksheet to the connected analysis run", async () => {
    const startRun = vi.fn(async (_input: EngineRunRequest) => ({ runId: "run-1" }))
    const user = userEvent.setup()
    render(() => <App engine={createMockEngine({ startRun })} mode="connected" />)

    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["region", "wage"], ["东部", "8"]]), "地区样本")
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["region", "wage"], ["西部", "9"]]), "全部样本")
    const file = new File([new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }))], "employment.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
    fireEvent.change(screen.getByLabelText("数据文件选择器"), { target: { files: [file] } })

    const sheet = await screen.findByRole("combobox", { name: "选择工作表" })
    await user.selectOptions(sheet, "地区样本")

    await user.type(screen.getByRole("textbox"), "比较地区工资变化")
    await user.click(screen.getByRole("button", { name: "发送" }))

    await waitFor(() => expect(startRun).toHaveBeenCalledOnce())
    const request = startRun.mock.calls[0]?.[0] as EngineRunRequest
    expect(request.worksheetName).toBe("地区样本")
  })

  test("blocks connected submission while the engine is unavailable and offers a retry", async () => {
    const health = vi.fn().mockResolvedValue({ protocolVersion: "v1", engineVersion: "test", status: "unavailable" })
    render(() => <App engine={createMockEngine({ health })} mode="connected" />)

    await waitFor(() => expect(screen.getByText("分析核心未能就绪")).toBeTruthy(), { timeout: 4000 })
    expect(screen.getByText(/启动等待期内没有响应/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy()
  })

  test("does not multiply the managed Core startup timeout into ten serial retries", async () => {
    const health = vi.fn(async () => { throw new Error("Core host did not start") })
    render(() => <App mode="connected" requireApiKey engine={createMockEngine({ health })} />)

    await waitFor(() => expect(screen.getByText("分析核心未能就绪")).toBeTruthy(), { timeout: 5_000 })
    expect(health).toHaveBeenCalledTimes(1)
  })

  test("lets a connected user retry the engine check after an unavailable state", async () => {
    const user = userEvent.setup()
    let healthCalls = 0
    const health = vi.fn(async (): Promise<import("./engine/client").EngineHealth> => {
      healthCalls += 1
      return healthCalls <= 10
        ? { protocolVersion: "v1", engineVersion: "test", status: "unavailable" }
        : { protocolVersion: "v1", engineVersion: "test", status: "ready" }
    })
    render(() => <App engine={createMockEngine({ health })} mode="connected" />)

    await waitFor(() => expect(screen.getByText("分析核心未能就绪")).toBeTruthy(), { timeout: 5000 })
    await user.click(screen.getByRole("button", { name: "重试" }))
    await waitFor(() => expect(screen.getByLabelText("分析核心就绪")).toBeTruthy(), { timeout: 5000 })
  })

  test("requires a configured API key before a desktop analysis can start", async () => {
    render(() => <App
      engine={createMockEngine()}
      mode="connected"
      requireApiKey
      credentials={createMockCredentials({ hasApiKey: async () => false })}
    />)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const dialogs = document.querySelectorAll("[role=dialog]")
    if (dialogs.length) {
        }
    expect(dialogs.length).toBe(1)
  })

  test("saves an API key through the injected secure credential store without rendering it again", async () => {
    const user = userEvent.setup()
    const saveProfile = vi.fn(async () => ({
      profileId: "first-profile",
      activeChanged: true,
      snapshot: {
        profiles: [{ id: "first-profile", provider: "deepseek" as const, model: "deepseek/deepseek-v4-flash", configured: true, isDefault: true }],
        defaultProfileId: "first-profile",
      },
    }))
    render(() => <App
      mode="connected"
      requireApiKey
      credentials={createMockCredentials({ hasApiKey: async () => false, saveProfile })}
    />)
    await waitFor(() => expect(screen.getByRole("heading", { name: "模型管理", level: 2 })).toBeTruthy())
    await user.click(screen.getByRole("button", { name: /＋ 配置模型/ }))
    await user.click(screen.getByRole("button", { name: "选择 DeepSeek" }))
    await user.type(screen.getByLabelText("API Key"), "sk-test-123")
    await user.click(screen.getByRole("button", { name: "保存模型配置" }))
    await waitFor(() => expect(saveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "deepseek", model: "deepseek/deepseek-v4-flash" }),
      "sk-test-123",
      expect.any(String),
      true,
      true,
      "",
    ))
    expect(screen.queryByDisplayValue("sk-test-123")).toBeNull()
  })

  test("defers native credential activation until a desktop user sends an analysis", async () => {
    const user = userEvent.setup()
    const callOrder: string[] = []
    const hasApiKey = vi.fn(async () => {
      callOrder.push("read-keychain")
      return true
    })
    const prepareEngineForAnalysis = vi.fn(async () => {
      callOrder.push("activate-engine")
    })
    render(() => <App
      engine={createMockEngine()}
      mode="connected"
      requireApiKey
      credentials={createMockCredentials({ hasApiKey, prepareEngineForAnalysis })}
    />)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hasApiKey).not.toHaveBeenCalled()
    expect(prepareEngineForAnalysis).not.toHaveBeenCalled()
    selectCsvFile()
    await user.type(screen.getByRole("textbox"), "估计处理效应")
    await user.click(screen.getByRole("button", { name: "发送" }))

    await waitFor(() => expect(prepareEngineForAnalysis).toHaveBeenCalledOnce())
    expect(hasApiKey).toHaveBeenCalledOnce()
    expect(callOrder).toEqual(["read-keychain", "activate-engine"])
  })

  test("locks the send action while native credentials are activating", async () => {
    const user = userEvent.setup()
    let activateEngine: (() => void) | undefined
    const prepareEngineForAnalysis = vi.fn(() => new Promise<void>((resolve) => {
      activateEngine = resolve
    }))
    const uploadDataset = vi.fn(async (file: File) => ({ id: "dataset-lock", name: file.name, format: "CSV", bytes: file.size }))
    render(() => <App
      engine={createMockEngine({ uploadDataset })}
      mode="connected"
      requireApiKey
      credentials={createMockCredentials({ prepareEngineForAnalysis })}
    />)

    selectCsvFile()
    await user.type(screen.getByRole("textbox"), "估计处理效应")
    const send = screen.getByRole("button", { name: "发送" })
    await user.click(send)

    await waitFor(() => expect(prepareEngineForAnalysis).toHaveBeenCalledOnce())
    expect(send.hasAttribute("disabled")).toBe(true)
    await user.click(send)
    expect(prepareEngineForAnalysis).toHaveBeenCalledOnce()

    activateEngine?.()
    await waitFor(() => expect(uploadDataset).toHaveBeenCalledOnce())
  })

  test("does not show an export control for a completed result", async () => {
    const subscribe = vi.fn((_runId: string, listener: (event: EngineRunEvent) => void) => {
      listener({ type: "completed", message: "分析已完成。" })
      return () => {}
    })
    render(() => <App engine={createMockEngine({
      subscribe,
      getResult: async () => ({ runId: "run-1", status: "completed", document: "## 回归结果" }),
    })} mode="connected" />)
    selectCsvFile()
    await typeAndSend("对人均GDP做 OLS 回归")

    await waitFor(() => expect(screen.getByRole("heading", { name: "回归结果" })).toBeTruthy())
    expect(screen.queryByRole("button", { name: "导出" })).toBeNull()
    expect(screen.queryByRole("button", { name: "导出 Markdown" })).toBeNull()
    expect(objectURL).not.toHaveBeenCalled()
  })

  test("keeps research history off until the researcher enables it in settings", async () => {
    const user = userEvent.setup()
    const store = createMemoryWorkspaceStore()
    const save = vi.spyOn(store, "save")
    render(() => <App workspaceStore={store} />)

    selectCsvFile("history-off.csv")
    await typeAndSend("检查默认关闭的历史")
    await waitFor(() => expect(screen.getByRole("button", { name: "打开研究：检查默认关闭的历史" })).toBeTruthy())
    expect(await store.load()).toBeUndefined()

    await user.keyboard("{Meta>}{,}{/Meta}")
    const toggle = screen.getByRole("checkbox", { name: "保存研究历史" }) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    await user.click(toggle)
    await user.keyboard("{Escape}")

    await waitFor(() => expect(save).toHaveBeenCalled())
    await waitFor(async () => expect((await store.load())?.workspaces.some((workspace) => workspace.researches.length > 0)).toBe(true))
  })

  test("restores the saved history when the researcher turns the setting back on", async () => {
    const user = userEvent.setup()
    const store = createMemoryWorkspaceStore()
    await store.setEnabled?.(true)
    await store.save({
      version: 1,
      activeWorkspaceID: "__unassigned__",
      workspaces: [{
        id: "__unassigned__",
        name: "未归档研究",
        lastOpenedAt: 1,
        researches: [{
          id: 7,
          title: "历史中的研究",
          messages: [{ kind: "user", id: 9, text: "历史中的研究问题" }],
          workbookSheetNames: [],
          resultDocument: "",
          resultExportable: false,
          runStatus: "completed",
        }],
      }],
    })
    await store.setEnabled?.(false)
    render(() => <App workspaceStore={store} />)

    expect(screen.queryByRole("button", { name: "打开研究：历史中的研究" })).toBeNull()

    await user.keyboard("{Meta>}{,}{/Meta}")
    await user.click(screen.getByRole("checkbox", { name: "保存研究历史" }))
    await user.keyboard("{Escape}")

    await waitFor(() => expect(screen.getByRole("button", { name: "打开研究：历史中的研究" })).toBeTruthy())
    await waitFor(async () => expect((await store.load())?.workspaces[0]?.researches[0]?.title).toBe("历史中的研究"))
  })

  test("renders the bootstrapped history setting before the Tauri IPC read completes", async () => {
    const user = userEvent.setup()
    let finishLoadEnabled!: (enabled: boolean) => void
    const loadEnabled = new Promise<boolean>((resolve) => { finishLoadEnabled = resolve })
    const workspaceStore = {
      load: async () => undefined,
      save: async () => {},
      isEnabled: () => false,
      loadEnabled: () => loadEnabled,
      setEnabled: async () => {},
    }
    render(() => <App
      engine={createMockEngine()}
      credentials={createMockCredentials()}
      workspaceStore={workspaceStore}
      initialWorkspaceHistoryEnabled
      mode="connected"
    />)

    await user.click(screen.getByRole("button", { name: "设置" }))
    const toggle = screen.getByRole("checkbox", { name: "保存研究历史" }) as HTMLInputElement
    expect(toggle.checked).toBe(true)

    finishLoadEnabled(true)
    await waitFor(() => expect(toggle.checked).toBe(true))
  })

  test("lists keyboard shortcuts in settings, adding @ only once a workspace is selected", async () => {
    const user = userEvent.setup()
    const pickWorkspace = vi.fn(async () => "/Users/cw/Documents/policy-lab")
    render(() => <App workspacePicker={pickWorkspace} />)

    await user.keyboard("{Meta>}{,}{/Meta}")
    const shortcuts = screen.getByRole("heading", { name: "快捷键" }).closest("section")!
    expect(within(shortcuts).getByText("选择数据文件")).toBeTruthy()
    expect(within(shortcuts).getByText("打开设置")).toBeTruthy()
    expect(within(shortcuts).getByText("发送")).toBeTruthy()
    expect(within(shortcuts).getByText("调出命令面板")).toBeTruthy()
    expect(within(shortcuts).queryByText("从工作区引用文件")).toBeNull()
    await user.keyboard("{Escape}")

    await user.click(screen.getByRole("button", { name: "选择本地工作区" }))
    await user.keyboard("{Meta>}{,}{/Meta}")
    const shortcutsWithWorkspace = screen.getByRole("heading", { name: "快捷键" }).closest("section")!
    expect(within(shortcutsWithWorkspace).getByText("从工作区引用文件")).toBeTruthy()
  })

  test("organizes settings into categories and only shows the selected category", async () => {
    const user = userEvent.setup()
    render(() => <App mode="connected" engine={createMockEngine()} />)

    await user.click(screen.getByRole("button", { name: "设置" }))
    const navigation = screen.getByRole("navigation", { name: "设置分类" })
    expect(within(navigation).getByRole("button", { name: "通用设置" })).toBeTruthy()
    expect(within(navigation).getByRole("button", { name: "模型管理" })).toBeTruthy()
    expect(within(navigation).getByRole("button", { name: "运行环境" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "通用设置", level: 2 })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "外观" })).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "模型管理" })).toBeNull()

    await user.click(within(navigation).getByRole("button", { name: "模型管理" }))
    expect(screen.getByRole("heading", { name: "模型管理", level: 2 })).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "外观" })).toBeNull()
    expect(within(navigation).getByRole("button", { name: "模型管理" }).getAttribute("aria-current")).toBe("page")
  })

  test("does not show an empty model list until the Keychain profile read finishes", async () => {
    const user = userEvent.setup()
    let resolveProfiles!: (snapshot: { profiles: []; defaultProfileId: null }) => void
    const profiles = new Promise<{ profiles: []; defaultProfileId: null }>((resolve) => { resolveProfiles = resolve })
    const credentials = createMockCredentials({
      getStatus: async () => ({ configured: false, provider: "deepseek", model: "deepseek/deepseek-v4-flash" }),
      listProfiles: async () => profiles,
    })
    render(() => <App mode="connected" engine={createMockEngine()} credentials={credentials} />)

    await user.click(screen.getByRole("button", { name: "设置" }))
    const navigation = screen.getByRole("navigation", { name: "设置分类" })
    await user.click(within(navigation).getByRole("button", { name: "模型管理" }))
    expect(screen.getByText("正在读取本机已保存模型…")).toBeTruthy()
    expect(screen.queryByText("还没有配置模型")).toBeNull()

    resolveProfiles({ profiles: [], defaultProfileId: null })
    expect(await screen.findByText("还没有配置模型")).toBeTruthy()
  })

  test("shows the canonical runtime dependency groups in connected settings", async () => {
    const user = userEvent.setup()
    render(() => <App mode="connected" engine={createMockEngine()} />)

    await user.click(screen.getByRole("button", { name: "设置" }))
    await user.click(screen.getByRole("button", { name: "运行环境" }))
    expect(screen.getByRole("heading", { name: "运行环境", level: 2 })).toBeTruthy()
    expect(screen.getByRole("button", { name: /核心回归/ }).getAttribute("aria-expanded")).toBe("false")
    expect(screen.getByRole("button", { name: /专用计量方法/ }).getAttribute("aria-expanded")).toBe("false")
    expect(screen.getByRole("button", { name: /数据读写/ }).getAttribute("aria-expanded")).toBe("false")

    await user.click(screen.getByRole("button", { name: /专用计量方法/ }))
    expect(screen.getByText("pyfixest")).toBeTruthy()
    expect(screen.getByText(/HDFE \/ DID/)).toBeTruthy()
    expect(screen.getByText("rdrobust")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: /数据读写/ }))
    expect(screen.getByText("Excel 读写引擎（.xlsx）")).toBeTruthy()
    expect(screen.getByText("Parquet 读写引擎")).toBeTruthy()
  })

  test("collapses Python package details by default and toggles a group on click", async () => {
    const user = userEvent.setup()
    render(() => <App mode="connected" engine={createMockEngine()} />)

    await user.click(screen.getByRole("button", { name: "设置" }))
    await user.click(screen.getByRole("button", { name: "运行环境" }))
    expect(await screen.findByText("有 13 项分析依赖未安装或无法读取。")).toBeTruthy()
    expect(screen.queryByText(/缺少分析依赖：.*pandas/)).toBeNull()
    const coreGroup = screen.getByRole("button", { name: /核心回归/ })

    expect(coreGroup.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText("pandas")).toBeNull()
    await user.click(coreGroup)
    expect(coreGroup.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("pandas")).toBeTruthy()
    expect(screen.getByText("statsmodels")).toBeTruthy()
    await user.click(coreGroup)
    expect(coreGroup.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText("pandas")).toBeNull()
  })

  test("requires the second Settings confirmation before installing runtime dependencies", async () => {
    const user = userEvent.setup()
    const report = {
      python: { label: "Python 解释器", status: "warning" as const, detail: "Python 3.12 · /usr/bin/python3 · 系统 Python", suggestion: "" },
      packages: [{ label: "pandas", status: "warning" as const, detail: "未安装。", suggestion: "固定依赖。" }],
    }
    const runtimeDiagnostics = {
      inspect: vi.fn(async () => report),
      installMissingPackages: vi.fn(async () => ({
        ...report,
        packages: [{ ...report.packages[0]!, status: "ready" as const, detail: "已安装。" }],
      })),
    }
    render(() => <App mode="connected" engine={createMockEngine()} runtimeDiagnostics={runtimeDiagnostics} />)

    await user.click(screen.getByRole("button", { name: "设置" }))
    await user.click(screen.getByRole("button", { name: "运行环境" }))
    expect(await screen.findByText("有 1 项分析依赖未安装或无法读取。")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "查看并确认安装" }))
    expect(screen.getByText(/已指定的 Python 接收缺失依赖；未指定时由 KillStata 创建或修复受管 Python 环境/)).toBeTruthy()
    expect(runtimeDiagnostics.installMissingPackages).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "取消" }))
    expect(runtimeDiagnostics.installMissingPackages).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "查看并确认安装" }))
    await user.click(screen.getByRole("button", { name: "确认安装" }))

    await waitFor(() => expect(runtimeDiagnostics.installMissingPackages).toHaveBeenCalledTimes(1))
    expect(await screen.findByText("依赖安装完成，已重新检查本机环境。")).toBeTruthy()
  })
  test("opens settings with Command Comma and closes with Escape", async () => {
    const user = userEvent.setup()
    render(() => <App />)
    await user.keyboard("{Meta>}{,}{/Meta}")
    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull()
  })

  test("opens the local data chooser with Command O", async () => {
    render(() => <App />)
    fireEvent.keyDown(window, { key: "o", metaKey: true })
    expect(screen.getByLabelText("数据文件选择器")).toBeTruthy()
  })

  test("persists the appearance choice from settings", async () => {
    const user = userEvent.setup()
    render(() => <App />)
    await user.keyboard("{Meta>}{,}{/Meta}")
    await user.click(screen.getByRole("button", { name: "浅色" }))
    expect(document.documentElement.dataset.theme).toBe("light")
    expect(storage.getItem("killstata-desktop-theme")).toBe("light")
    expect(screen.getByRole("button", { name: "浅色" }).getAttribute("aria-pressed")).toBe("true")
  })

  test("discloses that saved research history includes its session permission mode", async () => {
    const user = userEvent.setup()
    render(() => <App mode="connected" />)
    await user.keyboard("{Meta>}{,}{/Meta}")

    expect(screen.getByText("仅保存研究元数据（问题、文件名、状态和授权档位），不保存原始文件。")).toBeTruthy()
  })

  test("uses shared theme, reasoning, and permission values and persists later selections", async () => {
    const user = userEvent.setup()
    const preferences: UiPreferencesStore = {
      load: vi.fn(async () => ({ theme: "dark" as const, reasoningEffort: "high" as const, permissionMode: "read_only" } as unknown as SharedUiPreferences)),
      save: vi.fn(async () => true),
    }
    render(() => <App mode="connected" uiPreferences={preferences} />)

    await waitFor(() => expect(screen.getByRole("button", { name: "推理等级 High" })).toBeTruthy())
    await waitFor(() => expect(screen.getByRole("button", { name: "工具授权：只读分析" })).toBeTruthy())
    await user.keyboard("{Meta>}{,}{/Meta}")
    expect(screen.getByRole("button", { name: "深色" }).getAttribute("aria-pressed")).toBe("true")
    await user.click(screen.getByRole("button", { name: "浅色" }))
    expect(preferences.save).toHaveBeenCalledWith("theme", "light")

    await user.click(screen.getByRole("button", { name: "推理等级 High" }))
    await user.click(screen.getByRole("option", { name: "Medium" }))
    expect(preferences.save).toHaveBeenCalledWith("reasoningEffort", "medium")
    await user.click(screen.getByRole("button", { name: "工具授权：只读分析" }))
    await user.click(screen.getByRole("option", { name: /完全访问/ }))
    expect(preferences.save).toHaveBeenCalledWith("permissionMode", "full_access")
    expect(preferences.save).toHaveBeenCalledTimes(3)
  })

  test("migrates explicit legacy selections only when the shared preference is absent", async () => {
    storage.setItem("killstata-desktop-theme", "dark")
    storage.setItem("killstata-desktop-reasoning-effort", "high")
    storage.setItem("killstata-desktop-permission-mode", "full_access")
    const preferences: UiPreferencesStore = {
      load: vi.fn(async () => ({})),
      save: vi.fn(async () => true),
    }

    render(() => <App mode="connected" uiPreferences={preferences} />)
    await waitFor(() => expect(preferences.save).toHaveBeenCalledTimes(3))
    expect(preferences.save).toHaveBeenCalledWith("theme", "dark", { onlyIfAbsent: true })
    expect(preferences.save).toHaveBeenCalledWith("reasoningEffort", "high", { onlyIfAbsent: true })
    expect(preferences.save).toHaveBeenCalledWith("permissionMode", "full_access", { onlyIfAbsent: true })
  })

  test("keeps a running Core session pinned while the next research adopts the shared permission mode", async () => {
    const user = userEvent.setup()
    const runs: EngineRunRequest[] = []
    let shared: Record<string, unknown> = { permissionMode: "read_only" }
    const load = vi.fn(async () => ({ ...shared }) as unknown as SharedUiPreferences)
    const preferences: UiPreferencesStore = {
      load,
      save: vi.fn(async (key, value, options) => {
        if (options?.onlyIfAbsent && key in shared) return false
        shared = { ...shared, [key]: value }
        return true
      }),
    }
    const subscribe = vi.fn((_runID: string, listener: (event: EngineRunEvent) => void) => {
      queueMicrotask(() => listener({ type: "completed", message: "完成" }))
      return () => {}
    })
    const engine = createMockEngine({
      startRun: async (input) => {
        runs.push(input)
        return { runId: `run-${runs.length}` }
      },
      subscribe,
    })
    render(() => <App
      engine={engine}
      credentials={createMockCredentials()}
      uiPreferences={preferences}
      initialUiPreferences={{ permissionMode: "read_only" } as unknown as SharedUiPreferences}
      mode="connected"
    />)

    await waitFor(() => expect(screen.getByRole("button", { name: "工具授权：只读分析" })).toBeTruthy())
    await user.click(screen.getByRole("button", { name: "工具授权：只读分析" }))
    await user.click(screen.getByRole("option", { name: /完全访问/ }))
    await waitFor(() => expect(preferences.save).toHaveBeenCalledWith("permissionMode", "full_access"))

    await typeAndSend("第一轮授权模式测试")
    await waitFor(() => expect(runs).toHaveLength(1))
    expect(runs[0]?.permission).toEqual(expect.arrayContaining([
      expect.objectContaining({ permission: "edit", action: "allow" }),
      expect.objectContaining({ permission: "bash", action: "allow" }),
    ]))
    const pinnedControl = screen.getByRole("button", { name: "工具授权：完全访问" })
    await waitFor(() => expect(pinnedControl.hasAttribute("disabled")).toBe(true))

    const readsBeforeExternalChange = load.mock.calls.length
    shared = { permissionMode: "workspace_write" }
    fireEvent(window, new Event("focus"))
    await waitFor(() => expect(load).toHaveBeenCalledTimes(readsBeforeExternalChange + 1))
    expect(screen.getByRole("button", { name: "工具授权：完全访问" })).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "新对话" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "工具授权：工作区读写" })).toBeTruthy())
    await typeAndSend("第二轮读取共享授权")
    await waitFor(() => expect(runs).toHaveLength(2))
    expect(runs[1]?.permission).toEqual(expect.arrayContaining([
      expect.objectContaining({ permission: "edit", action: "allow" }),
      expect.objectContaining({ permission: "bash", action: "ask" }),
    ]))
  })

  test("does not relabel a permission mode after a new Core session has started but before it returns its ID", async () => {
    const runs: EngineRunRequest[] = []
    let shared: Record<string, unknown> = { permissionMode: "read_only" }
    let resolveStartRun: (() => void) | undefined
    const load = vi.fn(async () => ({ ...shared }) as unknown as SharedUiPreferences)
    const preferences: UiPreferencesStore = {
      load,
      save: vi.fn(async (key, value) => {
        shared = { ...shared, [key]: value }
        return true
      }),
    }
    const startRun = vi.fn(async (input: EngineRunRequest) => {
      runs.push(input)
      await new Promise<void>((resolve) => { resolveStartRun = resolve })
      return { runId: "run-delayed-start" }
    })
    render(() => <App
      engine={createMockEngine({ startRun })}
      credentials={createMockCredentials()}
      uiPreferences={preferences}
      initialUiPreferences={{ permissionMode: "read_only" } as unknown as SharedUiPreferences}
      mode="connected"
    />)

    await waitFor(() => expect(screen.getByRole("button", { name: "工具授权：只读分析" })).toBeTruthy())
    await typeAndSend("建立延迟会话")
    await waitFor(() => expect(startRun).toHaveBeenCalledOnce())
    expect(runs[0]?.permission).toEqual(expect.arrayContaining([
      expect.objectContaining({ permission: "edit", action: "ask" }),
      expect.objectContaining({ permission: "bash", action: "ask" }),
    ]))

    const readsBeforeExternalChange = load.mock.calls.length
    shared = { permissionMode: "full_access" }
    fireEvent(window, new Event("focus"))
    await waitFor(() => expect(load).toHaveBeenCalledTimes(readsBeforeExternalChange + 1))
    expect(screen.getByRole("button", { name: "工具授权：只读分析" })).toBeTruthy()

    resolveStartRun?.()
    const permissionControl = screen.getByRole("button", { name: "工具授权：只读分析" })
    await waitFor(() => expect(permissionControl.hasAttribute("disabled")).toBe(true))
  })

  test("restores the pinned permission mode when switching back to an existing in-memory research", async () => {
    const user = userEvent.setup()
    const runs: EngineRunRequest[] = []
    let shared: Record<string, unknown> = { permissionMode: "read_only" }
    const preferences: UiPreferencesStore = {
      load: vi.fn(async () => ({ ...shared }) as unknown as SharedUiPreferences),
      save: vi.fn(async (key, value, options) => {
        if (options?.onlyIfAbsent && key in shared) return false
        shared = { ...shared, [key]: value }
        return true
      }),
    }
    const subscribe = vi.fn((_runID: string, listener: (event: EngineRunEvent) => void) => {
      queueMicrotask(() => listener({ type: "completed", message: "完成" }))
      return () => {}
    })
    const engine = createMockEngine({
      startRun: async (input) => {
        runs.push(input)
        return { runId: `run-${runs.length}` }
      },
      subscribe,
    })
    render(() => <App
      engine={engine}
      credentials={createMockCredentials()}
      uiPreferences={preferences}
      initialUiPreferences={{ permissionMode: "read_only" } as unknown as SharedUiPreferences}
      mode="connected"
    />)

    await waitFor(() => expect(screen.getByRole("button", { name: "工具授权：只读分析" })).toBeTruthy())
    await typeAndSend("第一项只读研究")
    await waitFor(() => expect(runs).toHaveLength(1))
    await waitFor(() => expect(screen.getByRole("button", { name: "工具授权：只读分析" }).hasAttribute("disabled")).toBe(true))

    await user.click(screen.getByRole("button", { name: "新对话" }))
    shared = { permissionMode: "full_access" }
    fireEvent(window, new Event("focus"))
    await waitFor(() => expect(screen.getByRole("button", { name: "工具授权：完全访问" })).toBeTruthy())
    await typeAndSend("第二项完全访问研究")
    await waitFor(() => expect(runs).toHaveLength(2))
    await waitFor(() => expect(screen.getByRole("button", { name: "工具授权：完全访问" }).hasAttribute("disabled")).toBe(true))

    await user.click(screen.getByRole("button", { name: /打开研究：第一项只读研究/ }))
    expect(screen.getByRole("button", { name: "工具授权：只读分析" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "工具授权：只读分析" }).hasAttribute("disabled")).toBe(true)
  })

  test("does not seed defaults and refreshes shared preferences when the surface regains focus", async () => {
    const user = userEvent.setup()
    let shared: { theme?: "system" | "light" | "dark"; reasoningEffort?: "default" | "low" | "medium" | "high" } = {}
    const preferences: UiPreferencesStore = {
      load: vi.fn(async () => ({ ...shared })),
      save: vi.fn(async (key, value, options) => {
        if (options?.onlyIfAbsent && key in shared) return false
        shared = { ...shared, [key]: value }
        return true
      }),
    }
    render(() => <App mode="connected" uiPreferences={preferences} />)
    await waitFor(() => expect(preferences.load).toHaveBeenCalledOnce())
    expect(preferences.save).not.toHaveBeenCalled()

    shared = { theme: "dark", reasoningEffort: "high" }
    fireEvent(window, new Event("focus"))
    await waitFor(() => expect(screen.getByRole("button", { name: "推理等级 High" })).toBeTruthy())
    await user.keyboard("{Meta>}{,}{/Meta}")
    expect(screen.getByRole("button", { name: "深色" }).getAttribute("aria-pressed")).toBe("true")
  })

  test("keeps a local choice and reports when shared preference storage is unavailable", async () => {
    const user = userEvent.setup()
    const preferences: UiPreferencesStore = {
      load: vi.fn(async () => ({})),
      save: vi.fn(async () => { throw new Error("disk unavailable") }),
    }
    render(() => <App mode="connected" uiPreferences={preferences} />)
    await user.keyboard("{Meta>}{,}{/Meta}")
    await user.click(screen.getByRole("button", { name: "浅色" }))

    expect(await screen.findByRole("status", { name: "共享偏好同步失败" })).toBeTruthy()
    expect(document.documentElement.dataset.theme).toBe("light")
  })

  test("keeps a permission-mode choice visible when shared persistence fails", async () => {
    const user = userEvent.setup()
    const preferences: UiPreferencesStore = {
      load: vi.fn(async () => ({ permissionMode: "read_only" } as unknown as SharedUiPreferences)),
      save: vi.fn(async () => { throw new Error("disk unavailable") }),
    }
    render(() => <App
      engine={createMockEngine()}
      credentials={createMockCredentials()}
      uiPreferences={preferences}
      initialUiPreferences={{ permissionMode: "read_only" } as unknown as SharedUiPreferences}
      mode="connected"
    />)
    await waitFor(() => expect(screen.getByRole("button", { name: "工具授权：只读分析" })).toBeTruthy())
    await user.click(screen.getByRole("button", { name: "工具授权：只读分析" }))
    await user.click(screen.getByRole("option", { name: /完全访问/ }))
    expect(await screen.findByRole("button", { name: "工具授权：完全访问" })).toBeTruthy()

    await user.keyboard("{Meta>}{,}{/Meta}")
    expect(await screen.findByRole("status", { name: "共享偏好同步失败" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "工具授权：完全访问" })).toBeTruthy()
  })

  test("does not apply a stale shared value while the current surface is saving a newer choice", async () => {
    const user = userEvent.setup()
    let finishSave: (() => void) | undefined
    const preferences: UiPreferencesStore = {
      load: vi.fn(async () => ({ theme: "dark" as const })),
      save: vi.fn(async () => await new Promise<boolean>((resolve) => { finishSave = () => resolve(true) })),
    }
    render(() => <App mode="connected" uiPreferences={preferences} />)
    await waitFor(() => expect(preferences.load).toHaveBeenCalledOnce())
    await user.keyboard("{Meta>}{,}{/Meta}")
    await user.click(screen.getByRole("button", { name: "浅色" }))
    fireEvent(window, new Event("focus"))
    await waitFor(() => expect(preferences.load).toHaveBeenCalledTimes(2))

    expect(screen.getByRole("button", { name: "浅色" }).getAttribute("aria-pressed")).toBe("true")
    finishSave?.()
  })

  test("does not replace a newer permission choice with a stale focus read while its shared write is pending", async () => {
    const user = userEvent.setup()
    let finishSave: (() => void) | undefined
    const preferences: UiPreferencesStore = {
      load: vi.fn(async () => ({ permissionMode: "read_only" } as unknown as SharedUiPreferences)),
      save: vi.fn(async () => await new Promise<boolean>((resolve) => { finishSave = () => resolve(true) })),
    }
    render(() => <App
      engine={createMockEngine()}
      credentials={createMockCredentials()}
      uiPreferences={preferences}
      initialUiPreferences={{ permissionMode: "read_only" } as unknown as SharedUiPreferences}
      mode="connected"
    />)
    await waitFor(() => expect(screen.getByRole("button", { name: "工具授权：只读分析" })).toBeTruthy())
    await user.click(screen.getByRole("button", { name: "工具授权：只读分析" }))
    await user.click(screen.getByRole("option", { name: /完全访问/ }))
    fireEvent(window, new Event("focus"))
    await waitFor(() => expect(preferences.load).toHaveBeenCalledTimes(2))

    expect(screen.getByRole("button", { name: "工具授权：完全访问" })).toBeTruthy()
    finishSave?.()
  })

  test("renders bootstrapped shared preferences before an origin-local value while storage is slow", async () => {
    const user = userEvent.setup()
    let finishLoad: ((value: { theme: "dark"; reasoningEffort: "high"; permissionMode: "read_only" }) => void) | undefined
    const preferences: UiPreferencesStore = {
      load: vi.fn(async () => await new Promise<{ theme: "dark"; reasoningEffort: "high"; permissionMode: "read_only" }>((resolve) => { finishLoad = resolve })),
      save: vi.fn(async () => true),
    }
    storage.setItem("killstata-desktop-theme", "light")
    storage.setItem("killstata-desktop-reasoning-effort", "medium")
    storage.setItem("killstata-desktop-permission-mode", "full_access")
    render(() => <App
      mode="connected"
      uiPreferences={preferences}
      initialUiPreferences={{ theme: "dark", reasoningEffort: "high", permissionMode: "read_only" }}
    />)
    await waitFor(() => expect(preferences.load).toHaveBeenCalledOnce())
    await user.keyboard("{Meta>}{,}{/Meta}")

    expect(screen.getByRole("button", { name: "深色" }).getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByRole("button", { name: "浅色" }).getAttribute("aria-pressed")).toBe("false")
    expect(screen.getByRole("button", { name: "推理等级 High" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "工具授权：只读分析" })).toBeTruthy()
    finishLoad?.({ theme: "dark", reasoningEffort: "high", permissionMode: "read_only" })
  })

  test("shows the real CLI and TUI slash commands after connection", async () => {
    const user = userEvent.setup()
    render(() => <App mode="connected" />)
    selectCsvFile()
    const input = screen.getByRole("textbox", { name: "研究问题" })
    await user.type(input, "/")
    expect(screen.getByText("/progress")).toBeTruthy()
    expect(screen.getByText("/results")).toBeTruthy()
    expect(screen.getByText("/doctor")).toBeTruthy()
    expect(screen.getByText("/sessions")).toBeTruthy()
  })

  test("filters slash commands by description and shows argument hints", async () => {
    const user = userEvent.setup()
    const commands = vi.fn(async () => [{ name: "/doctor", description: "检查 Python 依赖", hints: ["$ARGUMENTS"] }])
    render(() => <App mode="connected" engine={createMockEngine({ commands })} />)
    await waitFor(() => expect(commands).toHaveBeenCalledOnce())
    const input = screen.getByRole("textbox", { name: "研究问题" })
    await user.type(input, "/依赖")
    expect(screen.getByRole("option", { name: /\/doctor 检查 Python 依赖/ })).toBeTruthy()
    expect(screen.getByText(/\$ARGUMENTS/)).toBeTruthy()
  })
  test("shows slash commands while typing a slash and executes /help", async () => {
    const user = userEvent.setup()
    render(() => <App />)
    selectCsvFile()
    const input = screen.getByRole("textbox")
    await user.type(input, "/")
    expect(screen.getByRole("listbox", { name: "斜杠命令" })).toBeTruthy()
    expect(screen.getByText("/settings")).toBeTruthy()
    expect(screen.getByText("/config")).toBeTruthy()
    await user.clear(input)
    await user.type(input, "/help")
    await user.keyboard("{Enter}")
    expect(screen.getByText(/可用命令：\/new/)).toBeTruthy()
  })

  test("/exit exits the application instead of closing only the current window", async () => {
    render(() => <App />)

    await typeAndSend("/exit")

    await waitFor(() => expect(mockDesktopInvoke).toHaveBeenCalledWith("exit_desktop"))
  })

  test("executes /themes by opening the real appearance settings", async () => {
    render(() => <App />)
    await typeAndSend("/themes")

    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy()
    expect(screen.getByRole("group", { name: "外观" })).toBeTruthy()
  })

  test("/sessions gives visible feedback when the recent-research list is empty", async () => {
    const startRun = vi.fn(async () => ({ runId: "run-unexpected" }))
    render(() => <App mode="connected" engine={createMockEngine({ startRun })} />)

    await typeAndSend("/sessions")

    expect(screen.getByText("最近研究列表已打开；当前没有已保存的研究。")).toBeTruthy()
    expect(startRun).not.toHaveBeenCalled()
  })

  test("/export explains when no completed result is available", async () => {
    render(() => <App mode="connected" engine={createMockEngine()} />)

    await typeAndSend("/export")

    expect(screen.getByText("当前研究尚未生成可导出的计量结果。")).toBeTruthy()
    expect(objectURL).not.toHaveBeenCalled()
  })

  test("does not silently discard arguments for a no-argument slash command", async () => {
    const startRun = vi.fn(async () => ({ runId: "run-unexpected" }))
    const user = userEvent.setup()
    render(() => <App mode="connected" engine={createMockEngine({ startRun })} />)
    const input = screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement

    await user.type(input, "/context ignored")
    await user.click(screen.getByRole("button", { name: "发送" }))

    expect(input.value).toBe("/context ignored")
    expect(screen.getByText("/context 不接受参数，请移除多余内容后重试。")).toBeTruthy()
    expect(startRun).not.toHaveBeenCalled()
  })

  test("/reasoning default and off restore the selected model's default reasoning policy", async () => {
    const startRun = vi.fn(async (_input: EngineRunRequest) => ({ runId: "run-reasoning-default" }))
    render(() => <App mode="connected" engine={createMockEngine({ startRun })} />)

    await typeAndSend("/reasoning high")
    expect(screen.getByRole("button", { name: "推理等级 High" })).toBeTruthy()
    await typeAndSend("/reasoning off")

    expect(screen.getByText("已恢复模型默认推理策略，下一轮请求生效。")).toBeTruthy()
    expect(screen.getByRole("button", { name: "推理等级 默认" })).toBeTruthy()

    await typeAndSend("下一轮使用模型默认推理")
    expect(startRun).toHaveBeenCalledOnce()
    expect(startRun.mock.calls[0]?.[0].effort).toBeUndefined()
  })

  test("routes /doctor as a Core command request instead of a model prompt", async () => {
    const startRun = vi.fn(async (_input: EngineRunRequest) => ({ runId: "run-doctor" }))
    const commands = vi.fn(async () => [{ name: "doctor", description: "检查分析环境" }])
    const user = userEvent.setup()
    render(() => <App mode="connected" engine={createMockEngine({ commands, startRun })} />)
    await waitFor(() => expect(commands).toHaveBeenCalledOnce())

    await user.type(screen.getByRole("textbox", { name: "研究问题" }), "/doctor")
    await user.click(screen.getByRole("button", { name: "发送" }))

    await waitFor(() => expect(startRun).toHaveBeenCalledOnce())
    expect(startRun.mock.calls[0]?.[0]).toMatchObject({
      prompt: "/doctor",
      command: { name: "doctor", arguments: "" },
      model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
    })
  })

  test("does not re-expose or execute a Core slash command blocked by the live catalogue", async () => {
    const startRun = vi.fn(async () => ({ runId: "run-blocked" }))
    const commands = vi.fn(async () => [{ name: "doctor", description: "检查分析环境", blockedReason: "当前会话不允许执行" }])
    const user = userEvent.setup()
    render(() => <App mode="connected" engine={createMockEngine({ commands, startRun })} />)
    await waitFor(() => expect(commands).toHaveBeenCalledOnce())

    const input = screen.getByRole("textbox", { name: "研究问题" })
    await user.type(input, "/")
    expect(screen.queryByText("/doctor")).toBeNull()
    await user.clear(input)
    await user.type(input, "/doctor")
    await user.click(screen.getByRole("button", { name: "发送" }))

    expect(startRun).not.toHaveBeenCalled()
    expect(screen.getByText("当前会话不允许执行")).toBeTruthy()
  })

  test("does not send an unavailable slash command as ordinary model text", async () => {
    const startRun = vi.fn(async () => ({ runId: "run-unknown-command" }))
    const user = userEvent.setup()
    render(() => <App mode="connected" engine={createMockEngine({ startRun })} />)
    const input = screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement

    await user.type(input, "/retired-command")
    await user.click(screen.getByRole("button", { name: "发送" }))

    expect(startRun).not.toHaveBeenCalled()
    expect(input.value).toBe("/retired-command")
    expect(screen.getByText("/retired-command 不在当前可用命令目录中，未发送请求。")).toBeTruthy()
  })

  test("does not send malformed slash syntax as ordinary model text", async () => {
    const startRun = vi.fn(async () => ({ runId: "run-malformed-command" }))
    const user = userEvent.setup()
    render(() => <App mode="connected" engine={createMockEngine({ startRun })} />)
    const input = screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement

    await user.type(input, "/ foo")
    await user.click(screen.getByRole("button", { name: "发送" }))

    expect(startRun).not.toHaveBeenCalled()
    expect(input.value).toBe("/ foo")
    expect(screen.getByText(/斜杠命令格式无效/)).toBeTruthy()
  })

  test("executes /context through the active Core session instead of sending it as research text", async () => {
    const user = userEvent.setup()
    const context = vi.fn(async () => ({
      usage: { usedTokens: 120, inputBudget: 1000, remainingTokens: 880, percentage: 12, compactionState: "none" },
      referenceContext: { activeStageId: "stage_000" },
    }))
    const subscribe = vi.fn((_runID: string, listener: (event: EngineRunEvent) => void) => {
      queueMicrotask(() => listener({ type: "completed", message: "分析已完成。" }))
      return () => {}
    })
    const startRun = vi.fn(async () => ({ runId: "run-context" }))
    render(() => <App mode="connected" engine={createMockEngine({ context, subscribe, startRun })} />)

    await user.type(screen.getByRole("textbox"), "先建立会话")
    await user.click(screen.getByRole("button", { name: "发送" }))
    await waitFor(() => expect(startRun).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeTruthy())

    await user.type(screen.getByRole("textbox"), "/context")
    await user.click(screen.getByRole("button", { name: "发送" }))
    await waitFor(() => expect(context).toHaveBeenCalledWith("run-context"))
    expect(screen.getByText(/上下文状态：已用 120/)).toBeTruthy()
  })

  test("executes the remaining TUI session commands through real Desktop operations", async () => {
    const user = userEvent.setup()
    const summarize = vi.fn(async () => {})
    const updateTitle = vi.fn(async () => {})
    const revertLatest = vi.fn(async () => {})
    const unrevert = vi.fn(async () => {})
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    const subscribe = vi.fn((_runID: string, listener: (event: EngineRunEvent) => void) => {
      queueMicrotask(() => listener({ type: "completed", message: "分析已完成。" }))
      return () => {}
    })
    const startRun = vi.fn(async () => ({ runId: "run-commands" }))
    render(() => <App mode="connected" engine={createMockEngine({ startRun, subscribe, summarize, updateTitle, revertLatest, unrevert })} />)

    await user.type(screen.getByRole("textbox"), "先建立会话")
    await user.click(screen.getByRole("button", { name: "发送" }))
    await waitFor(() => expect(startRun).toHaveBeenCalledOnce())

    const sendSlash = async (value: string) => {
      const input = screen.getByRole("textbox")
      await user.clear(input)
      await user.type(input, value)
      await user.click(screen.getByRole("button", { name: "发送" }))
    }
    await sendSlash("/rename 新标题")
    await sendSlash("/compact 保留当前数据阶段")
    await sendSlash("/undo")
    await sendSlash("/redo")
    await sendSlash("/copy")
    await sendSlash("/reasoning high")
    await sendSlash("/thinking")
    await sendSlash("/timestamps")

    await waitFor(() => expect(updateTitle).toHaveBeenCalledWith("run-commands", "新标题"))
    expect(summarize).toHaveBeenCalledWith(
      "run-commands",
      { providerID: "deepseek", modelID: "deepseek-v4-flash" },
      "保留当前数据阶段",
    )
    expect(revertLatest).toHaveBeenCalledWith("run-commands")
    expect(unrevert).toHaveBeenCalledWith("run-commands")
    expect(writeText).toHaveBeenCalled()
    expect(screen.getByText(/推理等级已设为 high/)).toBeTruthy()
  })

  test("/undo hides the reverted turn and /redo restores it in the conversation", async () => {
    const user = userEvent.setup()
    const subscribe = vi.fn((_runID: string, listener: (event: EngineRunEvent) => void) => {
      queueMicrotask(() => listener({ type: "assistant_delta", text: "这一轮助手回答" }))
      queueMicrotask(() => listener({ type: "completed", message: "分析已完成。" }))
      return () => {}
    })
    const startRun = vi.fn(async () => ({ runId: "run-undo" }))
    const revertLatest = vi.fn(async () => {})
    const unrevert = vi.fn(async () => {})
    render(() => <App mode="connected" engine={createMockEngine({ startRun, subscribe, revertLatest, unrevert })} />)

    await user.type(screen.getByRole("textbox", { name: "研究问题" }), "撤销目标问题")
    await user.click(screen.getByRole("button", { name: "发送" }))
    await waitFor(() => expect(screen.getByText("这一轮助手回答")).toBeTruthy())

    const input = screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement
    await user.type(input, "/undo")
    await user.click(screen.getByRole("button", { name: "发送" }))
    await waitFor(() => expect(revertLatest).toHaveBeenCalledOnce())

    const conversation = screen.getByRole("log", { name: "分析对话" })
    expect(within(conversation).queryByText("撤销目标问题")).toBeNull()
    expect(within(conversation).queryByText("这一轮助手回答")).toBeNull()
    expect(input.value).toBe("撤销目标问题")

    await user.clear(input)
    await user.type(input, "/redo")
    await user.click(screen.getByRole("button", { name: "发送" }))
    await waitFor(() => expect(unrevert).toHaveBeenCalledOnce())
    expect(within(conversation).getByText("撤销目标问题")).toBeTruthy()
    expect(within(conversation).getByText("这一轮助手回答")).toBeTruthy()
    expect(input.value).toBe("")
  })

  test("serializes /undo against new prompts so the Core revert cursor cannot race", async () => {
    const user = userEvent.setup()
    let finishRevert!: () => void
    const revertLatest = vi.fn(() => new Promise<void>((resolve) => { finishRevert = resolve }))
    const snapshot = emptyWorkspaceSnapshot()
    snapshot.workspaces[0]!.researches.push({
      id: 1,
      title: "已有研究",
      messages: [{ id: 1, kind: "user", text: "第一条研究问题" }],
      workbookSheetNames: [],
      resultDocument: "",
      resultExportable: false,
      runStatus: "completed",
      runID: "run-undo-race",
    })
    const workspaceStore = createMemoryWorkspaceStore(snapshot)
    await workspaceStore.setEnabled?.(true)
    const startRun = vi.fn(async () => ({ runId: "run-undo-race" }))
    render(() => <App mode="connected" workspaceStore={workspaceStore} engine={createMockEngine({ startRun, revertLatest })} />)

    await user.click(await screen.findByRole("button", { name: "打开研究：已有研究" }))

    const input = screen.getByRole("textbox", { name: "研究问题" })
    await user.type(input, "/undo")
    await user.click(screen.getByRole("button", { name: "发送" }))
    await waitFor(() => expect(revertLatest).toHaveBeenCalledOnce())
    expect(screen.getByRole("button", { name: "发送" }).hasAttribute("disabled")).toBe(true)
    expect(startRun).not.toHaveBeenCalled()

    finishRevert()
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" }).hasAttribute("disabled")).toBe(false))
    expect(startRun).not.toHaveBeenCalled()
  })

  test("inserts a selected KillStata command and sends it only after explicit submission", async () => {
    const user = userEvent.setup()
    const commands = vi.fn(async () => [{ name: "/describe", description: "查看数据结构" }])
    const startRun = vi.fn(async (_input: EngineRunRequest) => ({ runId: "run-command" }))
    render(() => <App mode="connected" engine={createMockEngine({ commands, startRun })} />)

    await waitFor(() => expect(commands).toHaveBeenCalledOnce())
    const input = screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement
    await user.type(input, "/des")
    await user.click(await screen.findByRole("option", { name: /\/describe 查看数据结构/ }))

    expect(input.value).toBe("/describe ")
    expect(startRun).not.toHaveBeenCalled()

    selectCsvFile()
    await user.type(input, "变量情况")
    await user.click(screen.getByRole("button", { name: "发送" }))

    await waitFor(() => expect(startRun).toHaveBeenCalledOnce())
    expect(startRun.mock.calls[0]?.[0]).toMatchObject({
      prompt: "/describe 变量情况",
      command: { name: "describe", arguments: "变量情况" },
    })
  })

  test("a Core /help collision does not hide or override the Desktop /help command", async () => {
    const user = userEvent.setup()
    const commands = vi.fn(async () => [{ name: "/help", description: "查看引擎帮助" }])
    const startRun = vi.fn(async () => ({ runId: "run-help-collision" }))
    render(() => <App mode="connected" engine={createMockEngine({ commands, startRun })} />)

    await waitFor(() => expect(commands).toHaveBeenCalledOnce())
    const input = screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement
    await user.type(input, "/")
    expect(await screen.findByRole("option", { name: /\/help 显示当前可用命令/ })).toBeTruthy()
    expect(screen.queryByRole("option", { name: /\/help 查看引擎帮助/ })).toBeNull()
    await user.clear(input)
    await user.type(input, "/help")
    await user.keyboard("{Enter}")

    expect(screen.getByText(/可用命令：\/new/)).toBeTruthy()
    expect(startRun).not.toHaveBeenCalled()
  })

  test("starts a new conversation with /new", async () => {
    const user = userEvent.setup()
    render(() => <App />)
    selectCsvFile()
    await typeAndSend("第一次提问")
    const thread = within(screen.getByRole("log", { name: "分析对话" }))
    expect(thread.getByText("第一次提问")).toBeTruthy()

    const input = screen.getByRole("textbox")
    await user.type(input, "/new")
    await user.keyboard("{Enter}")

    expect(thread.queryByText("第一次提问")).toBeNull()
    expect(thread.queryByText("policy-study.csv")).toBeNull()
    expect(screen.queryByRole("status", { name: /当前研究上下文/ })).toBeNull()
    expect(screen.getByRole("button", { name: "选择数据文件" })).toBeTruthy()
  })

  test("explains an unsupported dataset format without breaking the conversation", async () => {
    render(() => <App />)
    fireEvent.change(screen.getByLabelText("数据文件选择器"), {
      target: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] },
    })
    expect(screen.getByText("不支持此文件")).toBeTruthy()
    expect(screen.getByText(/改选 CSV、Excel、Stata 或 Parquet/)).toBeTruthy()
  })

  test("names the real cause of a failed submission instead of blaming the connection", async () => {
    const cases = [
      { thrown: "Unauthorized: missing api key", title: "尚未配置 API Key", action: /设置 → 模型/ },
      { thrown: "Insufficient Balance", title: "模型额度不足", action: /充值或更换可用模型/ },
      { thrown: "payload too large", title: "数据文件过大", action: /更小的数据文件/ },
    ]
    for (const scenario of cases) {
      const startRun = vi.fn(async () => { throw new Error(scenario.thrown) })
      render(() => <App engine={createMockEngine({ startRun })} mode="connected" />)

      await typeAndSend("估计处理效应")

      await waitFor(() => expect(screen.getByText(scenario.title)).toBeTruthy())
      expect(screen.getByText(scenario.action)).toBeTruthy()
      expect(screen.queryByText(/检查引擎连接/)).toBeNull()
      cleanup()
    }
  })

  test("keeps an unrecognized failure message verbatim rather than inventing a cause", async () => {
    const startRun = vi.fn(async () => { throw new Error("stage_003 已被占用") })
    render(() => <App engine={createMockEngine({ startRun })} mode="connected" />)

    await typeAndSend("估计处理效应")

    await waitFor(() => expect(screen.getByText("请求未能提交")).toBeTruthy())
    // 同一句原文既进消息流也进反馈面板；两处都必须保留引擎原话，不改写成通用连接故障。
    expect(screen.getAllByText(/stage_003 已被占用/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/检查引擎连接/)).toBeNull()
  })

  test("submits the chosen tool authorization and reasoning effort with the run", async () => {
    const user = userEvent.setup()
    const startRun = vi.fn(async (_input: EngineRunRequest) => ({ runId: "run-1" }))
    render(() => <App engine={createMockEngine({ startRun })} mode="connected" />)

    await user.click(screen.getByRole("button", { name: "工具授权：工作区读写" }))
    await user.click(screen.getByRole("option", { name: /只读分析/ }))
    await user.click(screen.getByRole("button", { name: /推理等级 默认/ }))
    await user.click(screen.getByRole("option", { name: "High" }))

    await typeAndSend("解释平行趋势检验")

    await waitFor(() => expect(startRun).toHaveBeenCalledOnce())
    const request = startRun.mock.calls[0]![0]
    expect(request.effort).toBe("high")
    const rule = (permission: string) => request.permission?.find((item) => item.permission === permission)?.action
    expect(rule("edit")).toBe("ask")
    expect(rule("bash")).toBe("ask")
    expect(rule("external_directory")).toBe("deny")
  })

  test("locks the displayed permission mode after the Core session is created", async () => {
    const subscribe = vi.fn((_runID: string, listener: (event: EngineRunEvent) => void) => {
      queueMicrotask(() => listener({ type: "completed", message: "完成" }))
      return () => {}
    })
    render(() => <App engine={createMockEngine({ subscribe })} mode="connected" />)

    const permission = screen.getByRole("button", { name: "工具授权：工作区读写" })
    expect(permission.hasAttribute("disabled")).toBe(false)
    await typeAndSend("建立研究会话")
    await waitFor(() => expect(screen.queryByRole("button", { name: "停止分析" })).toBeNull())

    expect(permission.hasAttribute("disabled")).toBe(true)
    expect(permission.getAttribute("title")).toContain("当前研究已使用此授权档位")
  })

  test("remembers the shared session policy across frontend restarts", async () => {
    const user = userEvent.setup()
    const { unmount } = render(() => <App engine={createMockEngine()} mode="connected" />)

    await user.click(screen.getByRole("button", { name: "工具授权：工作区读写" }))
    await user.click(screen.getByRole("option", { name: /完全访问/ }))
    expect(screen.getByRole("button", { name: "工具授权：完全访问" })).toBeTruthy()
    unmount()

    render(() => <App engine={createMockEngine()} mode="connected" />)
    expect(screen.getByRole("button", { name: "工具授权：完全访问" })).toBeTruthy()
    cleanup()

    render(() => <App />)
    expect(screen.getByRole("button", { name: "工具授权：完全访问" })).toBeTruthy()
  })

  test("closes an open policy menu with Escape instead of trapping the composer", async () => {
    const user = userEvent.setup()
    render(() => <App engine={createMockEngine()} mode="connected" />)

    await user.click(screen.getByRole("button", { name: "工具授权：工作区读写" }))
    expect(screen.getByRole("listbox", { name: "选择工具授权" })).toBeTruthy()

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("listbox", { name: "选择工具授权" })).toBeNull()
  })
})
