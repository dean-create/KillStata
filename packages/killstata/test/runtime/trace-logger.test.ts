import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Instance } from "@/project/instance"
import { RuntimeHooks } from "@/runtime/hooks"
import { TraceLogger } from "@/runtime/trace-logger"

// trace logger：每会话工具调用闭环 JSONL。测试用独立临时目录，避免污染
// cwd/test/sandbox/logs 真实产物。

let tmpDir: string
const SID = "ses_test_abc123"

function register(options: Parameters<typeof TraceLogger.register>[0] = {}) {
  // Bus.subscribe 需要 instance context（AsyncLocalStorage），register 必须在 Instance.provide 内。
  return Instance.provide({
    directory: tmpDir,
    fn: () => {
      TraceLogger.register({ sessionID: SID, dirOverride: tmpDir, ...options })
    },
  })
}

/** hook 调用必须包在 Instance.provide 内：全量测试下 default-hooks 的 postTool 已全局注册，
 * 它内部走 workflowRoot → Instance.worktree 需要 ALS context，缺了会抛 "No context found"。
 * 生产环境工具调用本来就在 instance context 内，这里只是还原。 */
function runInInstance<T>(fn: () => Promise<T> | T): Promise<T> {
  return Promise.resolve(Instance.provide({ directory: tmpDir, fn: () => fn() })).then((result) => result)
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(process.cwd(), "test", "sandbox", "trace-test-"))
  TraceLogger.resetForTests()
})

afterEach(() => {
  TraceLogger.resetForTests()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("TraceLogger", () => {
  test("counts existing file bytes before enforcing maxFileBytes", async () => {
    const file = path.join(tmpDir, `${SID}.jsonl`)
    fs.writeFileSync(file, `${"x".repeat(190)}\n`, "utf-8")
    const before = fs.statSync(file).size

    await register({ maxFileBytes: 220 })
    await runInInstance(() =>
      RuntimeHooks.preTool({ sessionID: SID, toolName: "some_tool", args: {}, callID: "tc_existing_cap" }),
    )

    expect(fs.statSync(file).size).toBe(before)
  })

  test("binds each session to its own configured log directory", async () => {
    const secondDir = fs.mkdtempSync(path.join(process.cwd(), "test", "sandbox", "trace-test-second-"))
    const secondSID = "ses_test_second"
    try {
      await register()
      await Instance.provide({
        directory: secondDir,
        fn: () => TraceLogger.register({ sessionID: secondSID, dirOverride: secondDir }),
      })

      await runInInstance(() =>
        RuntimeHooks.preTool({ sessionID: SID, toolName: "some_tool", args: {}, callID: "tc_first_dir" }),
      )
      await Instance.provide({
        directory: secondDir,
        fn: () => RuntimeHooks.preTool({ sessionID: secondSID, toolName: "some_tool", args: {}, callID: "tc_second_dir" }),
      })

      expect(fs.existsSync(path.join(tmpDir, `${SID}.jsonl`))).toBe(true)
      expect(fs.existsSync(path.join(secondDir, `${secondSID}.jsonl`))).toBe(true)
      expect(fs.existsSync(path.join(tmpDir, `${secondSID}.jsonl`))).toBe(false)
    } finally {
      fs.rmSync(secondDir, { recursive: true, force: true })
    }
  })

  test("moves a writer created before session config binding into the configured directory", async () => {
    const secondDir = fs.mkdtempSync(path.join(process.cwd(), "test", "sandbox", "trace-test-late-bind-"))
    const secondSID = "ses_test_late_bind"
    try {
      await register()
      // 模拟 session.created 比 SessionProcessor.process/register 更早到达：先按默认目录写一行。
      await runInInstance(() =>
        RuntimeHooks.preTool({ sessionID: secondSID, toolName: "some_tool", args: {}, callID: "before_bind" }),
      )
      expect(fs.existsSync(path.join(tmpDir, `${secondSID}.jsonl`))).toBe(true)

      await Instance.provide({
        directory: secondDir,
        fn: () => TraceLogger.register({ sessionID: secondSID, dirOverride: secondDir }),
      })
      await Instance.provide({
        directory: secondDir,
        fn: () => RuntimeHooks.preTool({ sessionID: secondSID, toolName: "some_tool", args: {}, callID: "after_bind" }),
      })

      expect(fs.existsSync(path.join(tmpDir, `${secondSID}.jsonl`))).toBe(false)
      expect(TraceLogger.readSession(secondSID).map((line) => line.callID)).toEqual(["before_bind", "after_bind"])
    } finally {
      fs.rmSync(secondDir, { recursive: true, force: true })
    }
  })

  test("PreTool + PostTool 同 callID 成对落盘，带 durationMs", async () => {
    await register()
    // 用非 workflow tracked 工具名：全量测试时 default-hooks 已注册，postTool 撞上
    // tracked 工具会走 recordWorkflowStageSuccess/verifier 分支，本测试只想验证 trace 落盘。
    await runInInstance(() =>
      RuntimeHooks.preTool({
        sessionID: SID,
        toolName: "some_tool",
        args: { inputpath: "/data/did.xlsx" },
        callID: "tc_1",
      }),
    )
    await runInInstance(() =>
      RuntimeHooks.postTool({
        sessionID: SID,
        messageID: "msg_1",
        agent: "general",
        model: { providerID: "deepseek", modelID: "deepseek-v4" },
        toolName: "some_tool",
        args: { inputpath: "/data/did.xlsx" },
        callID: "tc_1",
        result: {
          title: "import ok",
          metadata: { datasetId: "ds_1" },
          output: "columns: did, year, treat, policy\n",
        },
      }),
    )

    const lines = TraceLogger.readSession(SID)
    expect(lines).toHaveLength(2)
    expect(lines[0]!.kind).toBe("tool.pre")
    expect(lines[1]!.kind).toBe("tool.post")
    expect(lines[0]!.callID).toBe("tc_1")
    expect(lines[1]!.callID).toBe("tc_1")
    expect(lines[1]!.messageID).toBe("msg_1")
    expect(typeof lines[1]!.durationMs).toBe("number")
    expect((lines[1]!.result as { title: string }).title).toBe("import ok")
    expect((lines[1]!.result as { output: string }).output).toContain("columns: did")
  })

  test("args 中的 apiKey 被脱敏为 [已脱敏]", async () => {
    await register()
    await runInInstance(() =>
      RuntimeHooks.preTool({
        sessionID: SID,
        toolName: "some_tool",
        args: { apiKey: "sk-abc123", model: "gpt" },
        callID: "tc_2",
      }),
    )
    const lines = TraceLogger.readSession(SID)
    expect((lines[0]!.args as Record<string, unknown>).apiKey).toBe("[已脱敏]")
  })

  test("项目内绝对路径折叠为相对形式，项目外路径整体隐藏", async () => {
    await register()
    // 项目内：stripProjectRoots 折叠为项目相对形式，保留文件名（模型修复时还要能看见自己传的路径）。
    await runInInstance(() =>
      RuntimeHooks.preTool({
        sessionID: SID,
        toolName: "data_import",
        args: { inputpath: path.join(process.cwd(), "test", "fixtures", "did.csv") },
        callID: "tc_3",
      }),
    )
    // 项目外：hidePrivatePaths 整体替换，不泄漏本机目录结构。
    await runInInstance(() =>
      RuntimeHooks.preTool({
        sessionID: SID,
        toolName: "data_import",
        args: { inputpath: "/Users/cw/Desktop/private.xlsx" },
        callID: "tc_3b",
      }),
    )
    const text = fs.readFileSync(path.join(tmpDir, `${SID}.jsonl`), "utf-8")
    expect(text).not.toContain("private.xlsx")
    const lines = TraceLogger.readSession(SID)
    // 项目内：折叠为项目相对形式（根是仓库根 KillStata-main），保留文件名供模型修复时辨认。
    const inside = lines[0]!.args as Record<string, unknown>
    expect(String(inside.inputpath)).toContain("did.csv")
    expect(String(inside.inputpath)).not.toContain("/Users/")
    // 项目外：整体替换，不泄漏本机目录结构。
    expect(String((lines[1]!.args as Record<string, unknown>).inputpath)).toBe("[本机路径已隐藏]")
  })

  test("LRU：超过 maxFiles 时最久未用的 session 文件被删除", async () => {
    await register({ maxFiles: 3 })
    for (const [index, sid] of ["ses_a", "ses_b", "ses_c", "ses_d"].entries()) {
      await runInInstance(() => RuntimeHooks.preTool({ sessionID: sid, toolName: "t", args: {}, callID: `tc_l${index}` }))
    }
    const files = fs.readdirSync(tmpDir).filter((file) => file.endsWith(".jsonl"))
    expect(files.sort()).toEqual(["ses_b.jsonl", "ses_c.jsonl", "ses_d.jsonl"])
  })

  test("writer 写失败不冒泡到 hook 调用方，只禁用该 session", async () => {
    const origFile = Bun.file
    // 测试替换全局 Bun.file：stat 是 Instance.provide 内部 filesystem 检查要用的，
    // writer().write 才是我们要让它抛错的地方。
    Bun.file = (() => ({
      stat: () => Promise.resolve({ size: 0 }),
      writer: () => ({
        write() {
          throw new Error("ENOSPC: no space left on device")
        },
        flush() {},
        end() {},
      }),
    })) as unknown as typeof Bun.file
    try {
      await register()
      await expect(
        runInInstance(() => RuntimeHooks.preTool({ sessionID: SID, toolName: "t", args: {}, callID: "tc_fail" })),
      ).resolves.toBeDefined()
      // 同一 session 后续写入被禁用（dead 标记），不会重试风暴
      await runInInstance(() => RuntimeHooks.preTool({ sessionID: SID, toolName: "t", args: {}, callID: "tc_fail2" }))
      expect(TraceLogger.readSession(SID)).toHaveLength(0)
    } finally {
      Bun.file = origFile
    }
  })

  test("enabled=false 不订阅也不写文件", async () => {
    await register({ enabled: false })
    await runInInstance(() => RuntimeHooks.preTool({ sessionID: SID, toolName: "t", args: {}, callID: "tc_off" }))
    expect(fs.existsSync(path.join(tmpDir, `${SID}.jsonl`))).toBe(false)
    expect(fs.readdirSync(tmpDir)).toHaveLength(0)
  })
})
