import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { ToolRegistry } from "@/tool/registry"
import { TOOL_MANIFEST } from "@/runtime/tool-manifest"
import { Instance } from "@/project/instance"
import { Tool } from "@/tool/tool"

async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-manifest-coverage-"))
  try {
    return await Instance.provide({ directory: root, fn })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

// 工具实现与曝光清单是两件事：Tool.Info 自己持有执行安全契约，TOOL_MANIFEST 只描述
// family/intents。这样新增工具如果漏掉 readOnly/approval/concurrency，Tool.define 就无法编译；
// 同时模型可见性仍由独立的动态工具池统一决策。

describe("tool registry ↔ manifest（反向不变量）", () => {
  test("注册表每个工具 ID 都在 TOOL_MANIFEST 中（安全属性必填）", async () => {
    const KNOWN_MISSING: string[] = [
      // 自定义/运行时注入工具不要求进 manifest（准入面不暴露给模型）。
      // 若清单实际为空，说明 manifest 已完整覆盖注册表，可删除此数组。
    ]
    await withInstance(async () => {
      const manifestIDs = new Set(TOOL_MANIFEST.map((entry) => entry.id))
      const registered = await ToolRegistry.ids()
      const missing = registered.filter((id) => !manifestIDs.has(id)).toSorted()
      expect(missing, `注册表有实现但 manifest 未声明的工具: ${missing.join(", ")}`).toEqual(KNOWN_MISSING)
    })
  })

  test("每个注册工具自身都显式声明执行安全契约", async () => {
    expect(Object.isFrozen(Tool.Execution)).toBe(true)
    for (const policy of Object.values(Tool.Execution)) expect(Object.isFrozen(policy)).toBe(true)

    await withInstance(async () => {
      const policies = new Set<object>()
      for (const toolID of await ToolRegistry.ids()) {
        const tool = await ToolRegistry.byID(toolID)
        expect(tool, toolID).toBeDefined()
        if (!tool) throw new Error(`missing tool ${toolID}`)
        expect(typeof tool.execution.readOnly, toolID).toBe("boolean")
        expect(["automatic", "confirm", "blocked"], toolID).toContain(tool.execution.approval)
        expect(["parallel", "serial"], toolID).toContain(tool.execution.concurrency)
        expect(["none", "session", "filesystem", "external"], toolID).toContain(tool.execution.sideEffect)
        expect(Object.isFrozen(tool.execution), toolID).toBe(true)
        policies.add(tool.execution)
      }
      expect(policies.size).toBe((await ToolRegistry.ids()).length)
      expect((await ToolRegistry.byID("webfetch"))?.execution).toMatchObject({
        readOnly: true,
        approval: "confirm",
        concurrency: "serial",
        sideEffect: "external",
      })
      expect((await ToolRegistry.byID("experiment_log"))?.execution).toMatchObject({
        readOnly: false,
        approval: "automatic",
        concurrency: "serial",
        sideEffect: "filesystem",
      })
    })
  })

  test("曝光清单不再复制执行安全属性", () => {
    for (const entry of TOOL_MANIFEST) {
      expect("safety" in entry, entry.id).toBe(false)
      expect("sideEffect" in entry, entry.id).toBe(false)
    }
  })
})
