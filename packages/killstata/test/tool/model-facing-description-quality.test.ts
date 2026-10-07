import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import z from "zod"
import { Instance } from "@/project/instance"
import { ToolRegistry } from "@/tool/registry"
import { buildModelToolJsonSchema } from "@/session/prompt/tools"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"
import { ensureRuntimePythonReady, econometricsEngineRoot, resolveRuntimePythonCommand } from "@/killstata/runtime-config"

const toolRoot = path.join(process.cwd(), "src", "tool")

function prompt(name: string) {
  return fs.readFileSync(path.join(toolRoot, name), "utf-8")
}

async function pythonEngine() {
  const runtime = await ensureRuntimePythonReady()
  if (!runtime.ok) throw new Error("受管 Python Registry 不可用，不能验证 Python capability 描述。")
  return new EconometricsEngineClient({
    command: await resolveRuntimePythonCommand(),
    cwd: Instance.directory,
    pythonPath: path.join(econometricsEngineRoot(), "src"),
    methodRoot: path.join(econometricsEngineRoot(), "python"),
  })
}

function runtimeExampleFor(description: Record<string, unknown>) {
  const values: Record<string, string> = {
    datasetId: "dataset_example",
    stageId: "stage_000",
    expectedDataFingerprint: `sha256:${"a".repeat(64)}`,
    inputPath: "/controlled/input.csv",
    outputPath: "/controlled/output.parquet",
    runId: "run_example",
    branch: "main",
    outputDir: "/controlled/output",
  }
  const fields = Array.isArray(description.runtime_injected_fields)
    ? description.runtime_injected_fields.filter((field): field is string => typeof field === "string")
    : []
  return Object.fromEntries(fields.map((field) => [field, values[field] ?? "runtime_example"]))
}

function missingPropertyDescriptions(schema: unknown) {
  const missing: string[] = []
  const seen = new Set<object>()
  const visit = (node: unknown, pathPrefix: string) => {
    if (!node || typeof node !== "object" || seen.has(node)) return
    seen.add(node)
    const current = node as Record<string, any>
    for (const [name, property] of Object.entries(current.properties ?? {}) as Array<[string, Record<string, any>]>) {
      const path = pathPrefix ? `${pathPrefix}.${name}` : name
      if (!property.description) missing.push(path)
      visit(property, path)
    }
    if (current.items) visit(current.items, `${pathPrefix}[]`)
    for (const keyword of ["anyOf", "oneOf", "allOf"]) {
      for (const branch of current[keyword] ?? []) visit(branch, pathPrefix)
    }
    for (const [name, definition] of Object.entries(current.$defs ?? {})) {
      visit(definition, `$defs.${name}`)
    }
  }
  visit(schema, "")
  return missing
}

describe("模型可见工具说明质量", () => {
  test("每个内置工具都声明模型选择命名空间与四段使用边界", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-tool-contract-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          for (const id of await ToolRegistry.ids()) {
            const tool = (await ToolRegistry.byID(id)) as any
            expect(tool?.model?.namespace, `${id} 缺少模型选择命名空间`).toBeString()
            expect(tool?.model?.useWhen, `${id} 缺少适用场景`).toMatch(/[\u3400-\u9fff]/)
            expect(tool?.model?.doNotUseWhen, `${id} 缺少不适用场景`).toMatch(/[\u3400-\u9fff]/)
            expect(tool?.model?.returns, `${id} 缺少返回说明`).toMatch(/[\u3400-\u9fff]/)
            expect(tool?.model?.failureRecovery, `${id} 缺少失败恢复说明`).toMatch(/[\u3400-\u9fff]/)

            const initialized = await tool?.init({})
            const description = initialized?.description ?? ""
            expect(description.length, `${id} 的说明过长，会挤占当前工具池的模型上下文`).toBeLessThanOrEqual(2_000)
            for (const section of ["【工具族】", "【适用】", "【不适用】", "【返回】", "【失败恢复】"]) {
              expect(description, `${id} 的模型可见说明缺少 ${section}`).toContain(section)
            }
          }
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("每个参数及嵌套字段都有中文格式或来源说明", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-tool-schema-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          for (const id of await ToolRegistry.ids()) {
            const tool = await ToolRegistry.byID(id)
            const initialized = await tool?.init({})
            if (!initialized) continue
            const schema = z.toJSONSchema(initialized.parameters, { unrepresentable: "any" })
            expect(missingPropertyDescriptions(schema), `${id} 存在缺少说明的参数`).toEqual([])
          }
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("运行分组字段默认省略且不得由模型自行编造", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-tool-run-fields-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          for (const id of await ToolRegistry.ids()) {
            const tool = await ToolRegistry.byID(id)
            const initialized = await tool?.init({})
            if (!initialized) continue
            const schema = z.toJSONSchema(initialized.parameters, { unrepresentable: "any" }) as {
              properties?: Record<string, { description?: string }>
            }
            for (const field of ["runId", "branch"] as const) {
              const property = schema.properties?.[field]
              if (!property) continue
              expect(property.description, `${id}.${field} 没有禁止模型编造`).toContain("不得自行")
              expect(property.description, `${id}.${field} 没有说明默认省略`).toContain("通常省略")
            }
          }
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("复杂数据与计量工具提供可通过自身 schema 的示例输入", async () => {
    const complexToolIDs = [
      "pipeline",
      "data_import",
      "data_preprocess",
      "econometrics_recommend",
      "psm_matching",
      "did_static",
      "did2s",
      "iv_2sls",
      "iv_test",
      "rdd_sharp",
      "rdd_fuzzy",
      "heterogeneity_runner",
    ]
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-tool-examples-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const engine = await pythonEngine()
          try {
          for (const id of complexToolIDs) {
            let examples: Array<Record<string, unknown>>
            if (id === "pipeline") {
              const tool = (await ToolRegistry.byID(id)) as any
              expect(tool, `${id} 未注册`).toBeDefined()
              examples = [...(tool?.model?.inputExamples ?? [])]
              const initialized = await tool.init({})
              for (const example of examples) {
                expect(initialized.parameters.safeParse(example).success, `${id} 示例不符合自身 schema`).toBe(true)
              }
              const modelSchema = buildModelToolJsonSchema(initialized.parameters, examples) as { examples?: unknown[] }
              expect(modelSchema.examples, `${id} 示例没有注入模型可见 JSON Schema`).toEqual(examples)
            } else {
              const described = await engine.describe(id)
              examples = ((described.input_schema as { examples?: unknown[] }).examples ?? []) as Array<Record<string, unknown>>
              const runtime = runtimeExampleFor(described)
              for (const example of examples) {
                await expect(engine.validate(id, example as Record<string, unknown>, { runtime })).resolves.toMatchObject({
                  method_id: id,
                })
              }
            }
            expect(examples.length, `${id} 缺少示例输入`).toBeGreaterThan(0)
            expect(examples.length, `${id} 示例过多会污染工具 schema`).toBeLessThanOrEqual(2)
          }
          } finally {
            await engine.close()
          }
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("data_preprocess 明确 method 是唯一动作字段并给出组合列示例", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-description-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const engine = await pythonEngine()
          try {
            const described = await engine.describe("data_preprocess")
            const schema = described.input_schema as { properties: Record<string, unknown>; examples?: unknown[] }
            expect(schema.properties).toHaveProperty("method")
            expect(schema.properties).not.toHaveProperty("action")
            expect(described.description).toContain("没有 action 参数")
            expect(schema.examples).toContainEqual({
            method: "combine_columns",
            columns: ["省份", "地区"],
            options: { output_column: "省份_地区", separator: "_" },
            })
          } finally {
            await engine.close()
          }
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("create_column 不把 year >= time 作为默认政策变量示例", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-post-description-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const engine = await pythonEngine()
          try {
            const described = await engine.describe("data_preprocess")
            const examples = (described.input_schema as { examples?: unknown[] }).examples ?? []
            expect(JSON.stringify(examples)).not.toContain("year >= time")
            expect(described.description).toContain("政策")
            expect(described.description).toContain("用户确认")
            expect(described.description).toContain("year >= time")
          } finally {
            await engine.close()
          }
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("模型 schema 装配拒绝绕过 Zod 契约的原始 JSON Schema", () => {
    expect(() => buildModelToolJsonSchema({ type: "object" } as never)).toThrow(
      "工具参数 schema 必须使用 Zod 4 定义",
    )
  })

  test("原英文说明中的关键能力、参数和边界在中文重写后仍完整保留", () => {
    const contracts: Record<string, string[]> = {
      "bash.txt": ["workdir", "120000", "专用工具", "输出过长", "并行", "Git"],
      "data-import.txt": ["import", "export", "profile", "correlation", "validate", "healthcheck", "rollback", "datasetId", "stageId", "sheetPolicy", "blocking_errors", "numeric snapshot"],
      "edit.txt": ["read", "oldString", "newString", "命中多处", "replaceAll"],
      "experiment-log.txt": ["全部已尝试规格", "不显著", "p-hacking", "结构化结果"],
      "glob.txt": ["pattern", "path", "修改时间", "明确路径", "**/*", "截断"],
      "grep.txt": ["pattern", "include", "行号", "二进制", "task", "截断"],
      "heterogeneity-runner.txt": ["当前规范化数据阶段", "Harness", "线性固定效应（FE）基准", "DID2S", "baselineOutputKey", "独立结构化结果目录", "全部相关规格"],
      "ls.txt": ["path", "ignore", "递归", "100", "glob", "grep", "read"],
      "question.txt": ["3-5", "custom", "multiple", "30 个字符", "（推荐）"],
      "read.txt": ["filePath", "2000 行", "offset", "limit", "二进制", "修改文件前"],
      "task.txt": ["{agents}", "subagent_type", "description", "prompt", "session_id", "上下文边界", "不得重复"],
      "todowrite.txt": ["content", "status", "priority", "id", "in_progress", "completed", "cancelled"],
      "webfetch.txt": ["URL", "markdown", "text", "html", "HTTP", "HTTPS", "只读"],
      "write.txt": ["filePath", "content", "read", "edit", "README", "完整覆盖"],
    }

    for (const [file, terms] of Object.entries(contracts)) {
      const content = prompt(file)
      expect(content).toMatch(/[\u3400-\u9fff]/)
      for (const term of terms) expect(content, `${file} 缺少语义：${term}`).toContain(term)
    }
  })

  test("工具说明不承诺实现中不存在的传输或扫描行为", () => {
    const webfetch = prompt("webfetch.txt")
    const list = prompt("ls.txt")

    expect(webfetch).not.toContain("自动升级到 HTTPS")
    expect(list).not.toContain("只列一层")
    expect(list).not.toContain("不递归扫描")
  })

  test("read 明确引导数据任务优先复用画像和质检摘要", () => {
    const read = prompt("read.txt")

    expect(read).toContain("data_import 的 profile/validate")
    expect(read).toContain("不要重复读取原始或内部数据文件")
  })

  test("注册表中的每个内置工具说明均为中文，不残留整段英文模板", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-tool-description-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          for (const id of await ToolRegistry.ids()) {
            const tool = await ToolRegistry.byID(id)
            const initialized = await tool?.init({})
            const description = initialized?.description ?? ""
            expect(description, `${id} 没有中文工具说明`).toMatch(/[\u3400-\u9fff]/)
            expect(description).not.toMatch(/\b(?:Use this tool|When to use|When NOT to use|Load a skill|Inspect the current|Writes a file|Reads a file|Executes a given|Lists files)\b/i)
          }
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
