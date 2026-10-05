import { describe, expect, test } from "vitest"
import {
  DEFAULT_PERMISSION_MODE,
  DEFAULT_REASONING_EFFORT,
  isPermissionMode,
  isReasoningEffort,
  modelDisplayName,
  permissionModeInfo,
  permissionRuleset,
  PERMISSION_MODES,
} from "./session-policy"

const actionFor = (mode: Parameters<typeof permissionRuleset>[0], permission: string) =>
  permissionRuleset(mode).find((rule) => rule.permission === permission)?.action

describe("session permission modes", () => {
  test("keeps network, subagent and out-of-workspace access denied in every mode", () => {
    for (const mode of PERMISSION_MODES) {
      expect(actionFor(mode.id, "external_directory")).toBe("deny")
      expect(actionFor(mode.id, "webfetch")).toBe("deny")
      expect(actionFor(mode.id, "websearch")).toBe("deny")
      expect(actionFor(mode.id, "task")).toBe("deny")
    }
  })

  test("escalates write and shell access as the mode widens, never the reverse", () => {
    expect(actionFor("read_only", "edit")).toBe("ask")
    expect(actionFor("read_only", "bash")).toBe("ask")

    expect(actionFor("workspace_write", "edit")).toBe("allow")
    expect(actionFor("workspace_write", "bash")).toBe("ask")

    expect(actionFor("full_access", "edit")).toBe("allow")
    expect(actionFor("full_access", "bash")).toBe("allow")
  })

  test("treats every write-capable tool consistently within a mode", () => {
    for (const mode of PERMISSION_MODES) {
      const edit = actionFor(mode.id, "edit")
      expect(actionFor(mode.id, "write")).toBe(edit)
      expect(actionFor(mode.id, "patch")).toBe(edit)
    }
  })

  test("always allows read-side tools so analysis can inspect its own stage artifacts", () => {
    for (const mode of PERMISSION_MODES) {
      for (const permission of ["read", "glob", "grep", "list"]) {
        expect(actionFor(mode.id, permission)).toBe("allow")
      }
    }
  })

  test("emits Core-shaped rules with a pattern for every entry", () => {
    for (const rule of permissionRuleset(DEFAULT_PERMISSION_MODE)) {
      expect(rule.pattern).toBe("*")
      expect(["allow", "deny", "ask"]).toContain(rule.action)
      expect(rule.permission.length).toBeGreaterThan(0)
    }
  })

  test("falls back to the default mode for an unknown id", () => {
    expect(permissionModeInfo("nonsense" as never).id).toBe(DEFAULT_PERMISSION_MODE)
  })
})

describe("session policy guards", () => {
  test("rejects values outside the declared unions", () => {
    expect(isPermissionMode("workspace_write")).toBe(true)
    expect(isPermissionMode("root")).toBe(false)
    expect(isPermissionMode(undefined)).toBe(false)

    expect(isReasoningEffort("default")).toBe(true)
    expect(isReasoningEffort(DEFAULT_REASONING_EFFORT)).toBe(true)
    expect(isReasoningEffort("max")).toBe(false)
    expect(isReasoningEffort(null)).toBe(false)
  })

  test("defaults reasoning to the active model policy rather than a fixed medium variant", () => {
    expect(DEFAULT_REASONING_EFFORT).toBe("default")
  })

  test("shows the model name without its provider prefix", () => {
    expect(modelDisplayName("deepseek/deepseek-v4-flash")).toBe("deepseek-v4-flash")
    expect(modelDisplayName("custom/qwen-max")).toBe("qwen-max")
    expect(modelDisplayName("bare-model")).toBe("bare-model")
    expect(modelDisplayName("  ")).toBe("未配置模型")
    expect(modelDisplayName(undefined)).toBe("未配置模型")
  })
})
