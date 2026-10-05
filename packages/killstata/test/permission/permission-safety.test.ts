import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { PermissionNext } from "@/permission/next"
import { Agent } from "@/agent/agent"
import { Identifier } from "@/id/id"
import { Storage } from "@/storage/storage"

// 权限系统对齐（Phase 2）：
// 1. defaults 按副作用收紧（* ask，计量/只读放行）
// 2. safetyCheck：.killstata/、.env 路径免疫 allow 规则
// 3. always 批准落盘（重启记忆）

let root = ""

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-permission-safety-"))
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("defaults 收紧（对齐 claude-code fail-closed）", () => {
  test("analyst：计量工具与只读工具放行，bash/edit 默认 ask", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const analyst = await Agent.get("analyst")
        const p = analyst.permission
        expect(PermissionNext.evaluate("ols_regression", "*", p).action).toBe("allow")
        expect(PermissionNext.evaluate("data_import", "*", p).action).toBe("allow")
        expect(PermissionNext.evaluate("data_preprocess", "*", p).action).toBe("allow")
        expect(PermissionNext.evaluate("grep", "*", p).action).toBe("allow")
        expect(PermissionNext.evaluate("read", "*", p).action).toBe("allow")
        // 有副作用的默认要问，不再 * allow
        expect(PermissionNext.evaluate("bash", "*", p).action).toBe("ask")
        expect(PermissionNext.evaluate("edit", "*", p).action).toBe("ask")
        expect(PermissionNext.evaluate("write", "*", p).action).toBe("ask")
      },
    })
  })

  test("explore 子代理仍保持全 deny + 白名单（不被 defaults 放宽）", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const explore = await Agent.get("explore")
        const p = explore.permission
        expect(PermissionNext.evaluate("grep", "*", p).action).toBe("allow")
        expect(PermissionNext.evaluate("ols_regression", "*", p).action).toBe("deny")
        expect(PermissionNext.evaluate("edit", "*", p).action).toBe("deny")
      },
    })
  })
})

describe("safetyCheck（敏感路径免疫 allow）", () => {
  test("所有受管计量 runner 都显式声明 managedRuntime capability", () => {
    const files = [
      "auto-recommend.ts",
      "composite-evaluation.ts",
      "count.ts",
      "data-import/index.ts",
      "data-preprocess.ts",
      "econometrics-method-tools.ts",
      "glm.ts",
      "iv-test.ts",
      "iv.ts",
      "multinomial.ts",
      "ols.ts",
      "panel-fe.ts",
      "panel.ts",
      "pyfixest.ts",
      "quantile.ts",
      "rdd.ts",
      "rlm.ts",
      "wls.ts",
    ]
    const legacyFiles = new Set([
      "count.ts", "econometrics-method-tools.ts", "glm.ts", "iv-test.ts", "iv.ts", "multinomial.ts",
      "ols.ts", "panel-fe.ts", "panel.ts", "pyfixest.ts", "quantile.ts", "rdd.ts", "rlm.ts", "wls.ts",
    ])
    for (const file of files) {
      const source = fs.readFileSync(
        legacyFiles.has(file)
          ? path.join(import.meta.dir, "../../../..", "trash/killstata-legacy-econometrics/tool", file)
          : path.join(import.meta.dir, "../../src/tool", file),
        "utf-8",
      )
      expect(source, `${file} 必须声明 managedRuntime`).toContain("managedRuntime: true")
    }
  })

  test(".env 路径即使 allow 规则命中仍挂起等待", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const ruleset: PermissionNext.Ruleset = [{ permission: "read", pattern: "*", action: "allow" }]
        const asked = PermissionNext.ask({
          id: Identifier.ascending("permission"),
          sessionID: Identifier.ascending("session"),
          permission: "read",
          patterns: [path.join(root, ".env")],
          metadata: {},
          always: [],
          ruleset,
        })
        const state = await Promise.race([asked.then(() => "resolved"), Bun.sleep(30).then(() => "pending")])
        expect(state).toBe("pending")
        // 清理挂起请求
        for (const req of await PermissionNext.list()) {
          await PermissionNext.reply({ requestID: req.id, reply: "reject" })
        }
      },
    })
  })

  test(".killstata 路径只读工具放行（模型读自己的状态是本职工作）", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const ruleset: PermissionNext.Ruleset = [{ permission: "read", pattern: "*", action: "allow" }]
        // 只读工具（read/glob/grep/list）读 .killstata/ 直接放行：
        // .killstata/ 是本产品状态目录（datasets/inspection/reports），
        // 模型读检查表/stage 状态是正常工作流，不能挂起。
        await PermissionNext.ask({
          id: Identifier.ascending("permission"),
          sessionID: Identifier.ascending("session"),
          permission: "read",
          patterns: [path.join(root, ".killstata", "datasets", "gf_1", "inspection", "stage_000.csv")],
          metadata: {},
          always: [],
          ruleset,
        })
        // 无异常 + 立即返回 = 放行（不挂起）
      },
    })
  })

  test(".killstata 路径写工具即使 allow 规则命中仍挂起等待（防篡改内部状态）", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const ruleset: PermissionNext.Ruleset = [
          { permission: "edit", pattern: "*", action: "allow" },
          { permission: "write", pattern: "*", action: "allow" },
        ]
        for (const permission of ["edit", "write"] as const) {
          const asked = PermissionNext.ask({
            id: Identifier.ascending("permission"),
            sessionID: Identifier.ascending("session"),
            permission,
            patterns: [path.join(root, ".killstata", "datasets", "gf_1", "manifest.json")],
            metadata: {},
            always: [],
            ruleset,
          })
          const state = await Promise.race([asked.then(() => "resolved"), Bun.sleep(30).then(() => "pending")])
          expect(state, `${permission} .killstata 必须挂起`).toBe("pending")
          for (const req of await PermissionNext.list()) {
            await PermissionNext.reply({ requestID: req.id, reply: "reject" })
          }
        }
      },
    })
  })

  test("bash 整串命令中的 .killstata 路径即使 allow 规则命中仍挂起等待（正则边界修复）", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const ruleset: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
        // bash 权限传入的 pattern 是整条命令字符串（tool/bash.ts token 拼接），
        // .killstata 前面是空格而不是 /——旧正则 (^|/) 会漏检，此处断言必须挂起。
        const asked = PermissionNext.ask({
          id: Identifier.ascending("permission"),
          sessionID: Identifier.ascending("session"),
          permission: "bash",
          patterns: [`cd ${root} && rm -rf .killstata/datasets`],
          metadata: {},
          always: [],
          ruleset,
        })
        const state = await Promise.race([asked.then(() => "resolved"), Bun.sleep(30).then(() => "pending")])
        expect(state, "bash 整串命令中的 .killstata 必须挂起").toBe("pending")
        for (const req of await PermissionNext.list()) {
          await PermissionNext.reply({ requestID: req.id, reply: "reject" })
        }
      },
    })
  })

  test("普通路径 allow 规则直接放行（不挂起）", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const ruleset: PermissionNext.Ruleset = [{ permission: "read", pattern: "*", action: "allow" }]
        await PermissionNext.ask({
          id: Identifier.ascending("permission"),
          sessionID: Identifier.ascending("session"),
          permission: "read",
          patterns: [path.join(root, "data.csv")],
          metadata: {},
          always: [],
          ruleset,
        })
        // 无异常 + 立即返回 = 放行（safetyCheck 不拦普通路径）
      },
    })
  })

  test("通用 python -c 不能绕过 .killstata 写保护", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const ruleset: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
        for (const pattern of [
          `/Users/cw/.killstata/venv/bin/python -c "import shutil; shutil.rmtree('.killstata')"`,
          `rm -rf .killstata; /Users/cw/.killstata/venv/bin/python -V`,
          `/Users/cw/.killstata/venv/bin/python script.py > .killstata/manifest.json`,
        ]) {
          const asked = PermissionNext.ask({
            id: Identifier.ascending("permission"),
            sessionID: Identifier.ascending("session"),
            permission: "bash",
            patterns: [pattern],
            metadata: {},
            always: [],
            ruleset,
          })
          expect(await Promise.race([asked.then(() => "resolved"), Bun.sleep(30).then(() => "pending")])).toBe("pending")
          for (const req of await PermissionNext.list()) {
            await PermissionNext.reply({ requestID: req.id, reply: "reject" })
          }
        }
      },
    })
  })

  test("受管 python runner：只有结构化 managedRuntime 标记与固定 pattern 同时满足才放行", async () => {
    // ~/.killstata/venv/bin/python 是产品自带 venv，data_import/估计器调它执行受管 runner。
    // safetyActionFor 把它判定为受管 python runner 直接放行——否则每次跑计量工具都会弹
    // 权限（2026-08-05 真实数据测试：safety 修复前已 allow 的 bash 仍弹窗 120s 被 watchdog 杀）。
    // 旁路仅在 `rule.action === "allow" && safetyActionFor === "ask"` 时生效：Analyst 默认只对
    // `.killstata/venv` 的受管 pattern 放行，普通 bash 仍为 ask；用户规则仍可覆盖默认值。
    // **限制**：bash 显式 allow 后 `-c "任意代码"` 不受控（用户自配责任）；用户应在 bash 默认规则下使用。
    await Instance.provide({
      directory: root,
      fn: async () => {
        const sessionID = Identifier.ascending("session")
        const ruleset: PermissionNext.Ruleset = [
          { permission: "bash", pattern: "/Users/cw/.killstata/venv/bin/python *data*", action: "allow" },
        ]
        const venvPython = `/Users/cw/.killstata/venv/bin/python *data*`
        await PermissionNext.ask({
          id: Identifier.ascending("permission"),
          sessionID,
          permission: "bash",
          patterns: [venvPython],
          metadata: { managedRuntime: true },
          always: [venvPython],
          ruleset,
        })
        // 无异常 + 立即返回 = safetyActionFor 受管 python 旁路放行（不再弹窗）
      },
    })
  })
})

describe("always 落盘（重启记忆）", () => {
  test("reply(always) 写入 Storage，且同会话后续请求直接放行", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const requestID = Identifier.ascending("permission")
        const sessionID = Identifier.ascending("session")
        const asked = PermissionNext.ask({
          id: requestID,
          sessionID,
          permission: "bash",
          patterns: ["echo *"],
          always: ["echo *"],
          metadata: {},
          ruleset: [],
        })
        expect(await Promise.race([asked.then(() => "resolved"), Bun.sleep(30).then(() => "pending")])).toBe("pending")
        await PermissionNext.reply({ requestID, reply: "always" })
        await asked

        // 落盘验证
        const stored = await Storage.read<PermissionNext.Ruleset>(["permission", Instance.project.id])
        expect(stored.some((r) => r.permission === "bash" && r.pattern === "echo *" && r.action === "allow")).toBe(true)

        // 同 session 后续同 pattern 直接放行（不再弹权限）
        await PermissionNext.ask({
          id: Identifier.ascending("permission"),
          sessionID,
          permission: "bash",
          patterns: ["echo *"],
          metadata: {},
          always: ["echo *"],
          ruleset: [],
        })
      },
    })
  })
})
