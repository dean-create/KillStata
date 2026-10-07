import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import z from "zod"
import {
  prepareToolMetadata,
  prepareToolOutput,
  sanitizeToolErrorLog,
  sanitizeToolRecord,
  summarizeToolError,
} from "@/runtime/tool-result-policy"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncation"

function context(): Tool.Context {
  return {
    sessionID: "session_test",
    messageID: "message_test",
    agent: "analyst",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}

describe("tool result policy", () => {
  test("removes terminal noise, redacts secrets, folds repeated lines, and preserves statistics", () => {
    const longLine = `矩阵=${"1".repeat(10_000)}`
    const prepared = prepareToolOutput(
      [
        "\u001b[31m估计完成\u001b[0m",
        "迭代进度 100%",
        "迭代进度 100%",
        "迭代进度 100%",
        "Authorization: Bearer secret-bearer-value",
        "api_key=sk-deepseek-secret-value",
        "password: do-not-show-me",
        "系数 1.2345，标准误 0.2000，p 值 0.0010，N=820",
        longLine,
      ].join("\n"),
    )

    expect(prepared.text).not.toContain("\u001b[")
    expect(prepared.text).not.toContain("secret-bearer-value")
    expect(prepared.text).not.toContain("sk-deepseek-secret-value")
    expect(prepared.text).not.toContain("do-not-show-me")
    expect(prepared.text).toContain("[已脱敏]")
    expect(prepared.text).toContain("迭代进度 100%\n[相同行重复 2 次，已折叠]")
    expect(prepared.text).toContain("系数 1.2345，标准误 0.2000，p 值 0.0010，N=820")
    expect(prepared.redactions).toBeGreaterThanOrEqual(3)
    expect(prepared.collapsedLines).toBe(2)
    expect(prepared.shortenedLines).toBe(1)
  })

  test("summarizes an error without stack, cause, secrets, or unbounded text", () => {
    const cause = new Error("cause with sk-cause-secret-value")
    const error = new Error(`回归失败 api_key=sk-error-secret-value ${"x".repeat(20_000)}`, { cause })
    const summary = summarizeToolError(error, 1_024)

    expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(1_024)
    expect(summary).toContain("回归失败")
    expect(summary).toContain("[已脱敏]")
    expect(summary).not.toContain("sk-error-secret-value")
    expect(summary).not.toContain("sk-cause-secret-value")
    expect(summary).not.toContain("at ")
  })

  test("将常见的完全共线后端错误翻译成可行动的中文", () => {
    const summary = summarizeToolError(new Error(
      "exog does not have full column rank. If you wish to proceed with model estimation irrespective of the numerical accuracy of coefficient estimates, you can set check_rank=False.",
    ))

    expect(summary).toContain("设计矩阵不满秩")
    expect(summary).toContain("完全共线性")
    expect(summary).toContain("不建议关闭秩检查")
    expect(summary).not.toContain("full column rank")
  })

  // 2026-08-16 drive harness 组 B 真实实测复现：内部产物目录名（如
  // stage_000_logit_regression_20260816-170300）常年超过 LONG_TOKEN_PATTERN 的
  // 40 字符阈值。sanitizeToolRecord（喂 metadata）在 2026-08-14 已经加了 .killstata
  // 保护，但 summarizeToolError（喂错误消息文本，query-runtime 里直接喂模型）走的是
  // 完全独立的 redact() 管线，没有同一份保护——模型看到 [已脱敏] 代替真实路径，
  // 对着一个打了码的字符串 read/list 必然 ENOENT，只能满目录瞎找。
  test("preserves long .killstata artifact paths inside error text instead of redacting them", () => {
    const longStageDir = "stage_000_logit_regression_20260816-170300"
    expect(longStageDir.length).toBeGreaterThan(40) // 前提：确实会撞上 LONG_TOKEN_PATTERN

    const posix = summarizeToolError(
      new Error(`ENOENT: no such file or directory, scandir '.killstata/datasets/did_659a8a02/reports/main/${longStageDir}'`),
    )
    expect(posix).toContain(`.killstata/datasets/did_659a8a02/reports/main/${longStageDir}`)
    expect(posix).not.toContain("已脱敏")

    const backslash = String.fromCharCode(92)
    const winPath = [".killstata", "datasets", "did_659a8a02", "reports", "main", longStageDir].join(backslash)
    const windows = summarizeToolError(new Error(`ENOENT: scandir '${winPath}'`))
    expect(windows).toContain(winPath)
    expect(windows).not.toContain("已脱敏")

    // 对照组：不含 .killstata 的普通超长字符串必须仍被脱敏，确认没有意外放宽保护范围。
    const unrelated = summarizeToolError(new Error(`Unexpected value ${"a".repeat(45)} in response`))
    expect(unrelated).toContain("已脱敏")
    expect(unrelated).not.toContain("a".repeat(45))

    // 混合场景：同一条错误里 .killstata 路径与真实密钥并存，两者必须分别正确处理。
    const mixed = summarizeToolError(
      new Error(`Failed reading .killstata/datasets/did_659a8a02/reports/main/${longStageDir} with token ${"b".repeat(45)}`),
    )
    expect(mixed).toContain(`.killstata/datasets/did_659a8a02/reports/main/${longStageDir}`)
    expect(mixed).toContain("已脱敏")
    expect(mixed).not.toContain("b".repeat(45))
  })

  test("redacts short secrets behind quoted JSON keys", () => {
    const prepared = prepareToolOutput(
      JSON.stringify({
        password: "short secret",
        api_key: "sk-short",
        nested: { access_token: "tiny-token" },
      }),
    )

    expect(prepared.redactions).toBe(3)
    expect(prepared.text).not.toContain("short secret")
    expect(prepared.text).not.toContain("sk-short")
    expect(prepared.text).not.toContain("tiny-token")
  })

  test("redacts short secrets behind camelCase record keys", () => {
    const stored = JSON.stringify(
      sanitizeToolRecord({
        accessToken: "tiny-token",
        refreshToken: "refresh-short",
        clientSecret: "small-secret",
        apiKey: "short-api",
        credentials: "short-credentials",
      }),
    )

    expect(stored).not.toContain("tiny-token")
    expect(stored).not.toContain("refresh-short")
    expect(stored).not.toContain("small-secret")
    expect(stored).not.toContain("short-api")
    expect(stored).not.toContain("short-credentials")
    expect(stored.match(/\[已脱敏\]/g)).toHaveLength(5)
  })

  test("redacts short camelCase secrets from visible tool text", () => {
    const prepared = prepareToolOutput(
      JSON.stringify({
        clientSecret: "small-secret",
        cookie: "sid=short",
        privateKey: "tiny-key",
        credential: "tiny-credential",
        providerAccessToken: "short-access-token",
      }),
    )

    for (const secret of ["small-secret", "sid=short", "tiny-key", "tiny-credential", "short-access-token"]) {
      expect(prepared.text).not.toContain(secret)
    }
    expect(prepared.redactions).toBe(5)
  })

  test("保留 Harness 内部血缘字段供工作流继续执行，而不把它们当长 token 脱敏", () => {
    const out = sanitizeToolRecord({
      datasetId: "prt_0bf9aea5b001zzyCV7onra4fCF-did_fa81726a",
      stageId: "stage_000",
      runId: "run_20260921-001747257_e730qe",
    }) as Record<string, unknown>

    expect(out.datasetId).toBe("prt_0bf9aea5b001zzyCV7onra4fCF-did_fa81726a")
    expect(out.stageId).toBe("stage_000")
    expect(out.runId).toBe("run_20260921-001747257_e730qe")
  })

  test("removes an embedded Python traceback while keeping the final exception", () => {
    const summary = summarizeToolError(
      new Error(
        [
          "数据导入失败",
          "Traceback (most recent call last):",
          '  File "/Users/example/private/worker.py", line 12, in <module>',
          "    run()",
          "FileNotFoundError: /Users/alice/Secret/payroll.csv: treatment 列不存在",
          "OSError: C:\\Users\\alice\\Secret\\panel.xlsx 不可读",
          "FileNotFoundError: '/Users/alice/My Project/private data.csv'",
          'OSError: "C:\\Users\\alice\\My Project\\private data.xlsx"',
          "ValueError: treatment 列不存在",
        ].join("\n"),
      ),
    )

    expect(summary).toContain("数据导入失败")
    expect(summary).toContain("treatment 列不存在")
    expect(summary).not.toContain("Traceback")
    expect(summary).not.toContain("/Users/example")
    expect(summary).not.toContain("worker.py")
    expect(summary).not.toContain("/Users/alice")
    expect(summary).not.toContain("C:\\Users\\alice")
    expect(summary).not.toContain("My Project")
    expect(summary).not.toContain("private data")
    expect(summary).toContain("[本机路径已隐藏]")
  })

  test("Tool.define saves only sanitized text when a result is too large for context", async () => {
    const SampleTool = Tool.define("sample_output_policy", Tool.Execution.readOnly, {
      namespace: "filesystem",
      useWhen: "测试输出策略。",
      doNotUseWhen: "非测试场景不要使用。",
      returns: "策略处理后的输出。",
      failureRecovery: "检查输出策略。",
    }, {
      description: "test",
      parameters: z.object({}),
      async execute() {
        return {
          title: "sample",
          output: `api_key=sk-file-secret-value\n${Array.from({ length: 3_000 }, (_, index) => `row ${index}`).join("\n")}`,
          metadata: {
            credentials: "metadata-secret",
            result: {
              coefficients: Array.from({ length: 5_000 }, (_, index) => ({
                term: `x_${index}`,
                estimate: index,
                stdError: 1,
                pValue: 0.5,
              })),
            },
          },
        }
      },
    })
    const info = await SampleTool.init()
    const result = (await info.execute({}, context())) as {
      output: string
      metadata: Record<string, any>
    }

    expect(result.metadata.truncated).toBe(true)
    expect(result.output).not.toContain("sk-file-secret-value")
    expect(result.output).not.toContain("Task tool")
    expect(result.output).toContain("offset/limit")
    expect(result.output).not.toContain(os.homedir())
    expect(result.output).toContain("tool-output:")
    const storedPath = Truncate.resolveOutputReference(result.metadata.outputPath)
    expect(storedPath).toBeDefined()
    const stored = fs.readFileSync(storedPath!, "utf-8")
    expect(stored).not.toContain("sk-file-secret-value")
    expect(stored).toContain("[已脱敏]")
    expect(fs.statSync(storedPath!).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(result.metadata)).not.toContain("metadata-secret")
    expect(result.metadata.result.coefficients.length).toBeLessThanOrEqual(51)
  })

  test("bounds nested metadata independently from the visible output", () => {
    const metadata = prepareToolMetadata({
      method: "ols_regression",
      matrix: Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => "x".repeat(2_048))),
    })

    expect(Buffer.byteLength(JSON.stringify(metadata), "utf-8")).toBeLessThanOrEqual(32 * 1024)
    expect(metadata).toMatchObject({ metadataTruncated: true })
  })

  test("rewrites a Python error JSON as bounded private high-signal data", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-error-log-"))
    const logPath = path.join(root, "python_error.json")
    fs.writeFileSync(
      logPath,
      JSON.stringify({
        error: [
          "估计失败 api_key=sk-error-log-secret",
          "Traceback (most recent call last):",
          '  File "/Users/private/runner.py", line 10, in <module>',
          "    run()",
          `ValueError: ${"x".repeat(100_000)}`,
        ].join("\n"),
        password: "tiny-secret",
      }),
      { mode: 0o644 },
    )

    sanitizeToolErrorLog(logPath, root)

    const stored = fs.readFileSync(logPath, "utf-8")
    expect(() => JSON.parse(stored)).not.toThrow()
    expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(64 * 1024)
    expect(stored).not.toContain("sk-error-log-secret")
    expect(stored).not.toContain("tiny-secret")
    expect(stored).not.toContain("Traceback")
    expect(stored).not.toContain("/Users/private")
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600)
    fs.rmSync(root, { recursive: true, force: true })
  })
})
