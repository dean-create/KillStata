import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { ToolRegistry } from "@/tool/registry"
import { WORKFLOW_INPUT_INTENT_TOOL_BUNDLES } from "@/runtime/tool-catalog"

describe("tool.data_preprocess registration", () => {
  test("does not advertise data_preprocess unless the registry can load it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-data-preprocess-registration-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const ids = await ToolRegistry.ids()
          const advertised = WORKFLOW_INPUT_INTENT_TOOL_BUNDLES.analysis.includes("data_preprocess")
          expect(advertised).toBe(ids.includes("data_preprocess"))
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
