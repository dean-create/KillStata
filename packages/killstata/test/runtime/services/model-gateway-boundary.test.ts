import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

const SOURCE_ROOT = path.join(process.cwd(), "src")

describe("model gateway boundary", () => {
  test("routes foreground and background model calls through the shared gateway", () => {
    const callers = [
      "runtime/query-runtime.ts",
      "session/summary.ts",
      "session/prompt/message.ts",
    ]

    for (const file of callers) {
      const source = fs.readFileSync(path.join(SOURCE_ROOT, file), "utf-8")
      expect(source).toContain('import { ModelGateway } from "@/runtime/services/model-gateway"')
      expect(source).toContain("ModelGateway.stream(")
      expect(source).not.toContain("LLM.stream(")
    }
  })

  test("owns the provider SDK call in the service layer and keeps LLM as a compatibility facade", () => {
    const gateway = fs.readFileSync(path.join(SOURCE_ROOT, "runtime/services/model-gateway.ts"), "utf-8")
    const llm = fs.readFileSync(path.join(SOURCE_ROOT, "session/llm.ts"), "utf-8")

    expect(gateway).toContain("streamText(")
    expect(llm).toContain("return ModelGateway.stream(input)")
    expect(llm).not.toContain("streamText(")
  })
})
