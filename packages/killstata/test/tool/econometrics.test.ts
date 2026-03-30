import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { execFileSync } from "child_process"
import { EconometricsTool } from "../../src/tool/econometrics"
import { resolveRuntimePythonCommand } from "../../src/killstata/runtime-config"
import { Instance } from "../../src/project/instance"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "econometrics",
  abort: AbortSignal.any([]),
  metadata: async () => undefined,
  ask: async () => undefined,
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "killstata-econometrics-"))
}

async function withInstance<T>(fn: (root: string) => Promise<T>) {
  const root = makeTempDir()
  try {
    return await Instance.provide({
      directory: root,
      fn: async () => fn(root),
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("tool.econometrics", () => {
  test("requires panel keys for DID-family methods", async () => {
    await withInstance(async () => {
      const tool = await EconometricsTool.init()
      for (const methodName of ["did_static", "did_staggered", "did_event_study", "did_event_study_viz"] as const) {
        await expect(
          tool.execute(
            {
              methodName,
              dataPath: "missing.csv",
              dependentVar: "y",
              options: {
                treatment_entity_dummy: "treated_entity",
                treatment_finished_dummy: "treated_finished",
              },
            },
            ctx as any,
          ),
        ).rejects.toThrow("entityVar and timeVar")
      }
    })
  })

  test("does not require relative_time_variable at validation time", async () => {
    await withInstance(async () => {
      const tool = await EconometricsTool.init()
      await expect(
        tool.execute(
          {
            methodName: "did_event_study",
            dataPath: "missing.csv",
            dependentVar: "y",
            entityVar: "entity",
            timeVar: "year",
            options: {
              treatment_entity_dummy: "treated_entity",
              treatment_finished_dummy: "treated_finished",
            },
          },
          ctx as any,
        ),
      ).rejects.not.toThrow("relative_time_variable")
    })
  })

  test("persists common output helpers and parameter mappings in source", () => {
    const sourcePath = path.join(process.cwd(), "src", "tool", "econometrics.ts")
    const source = fs.readFileSync(sourcePath, "utf-8")
    expect(source).toContain("persist_common_outputs")
    expect(source).toContain("scalar_coefficient_table")
    expect(source).toContain('result["summary_path"]')
    expect(source).toContain("running_variable_cutoff=cutoff")
    expect(source).toContain("running_variable_bandwidth=options.get(\"bandwidth\", None)")
    expect(source).toContain("max_order=polynomial_degree")
    expect(source).toContain("target_type = options.get(\"target_type\", \"ATE\")")
  })

  test("imports econometric_algorithm in headless mode", async () => {
    await withInstance(async () => {
      const pythonCommand = await resolveRuntimePythonCommand()
      const algorithmPath = path.join(process.cwd(), "python", "econometrics")
      const output = execFileSync(
        pythonCommand,
        [
          "-c",
          [
            "import sys",
            `sys.path.insert(0, r'${algorithmPath.replace(/\\/g, "\\\\")}')`,
            "import econometric_algorithm",
            "print('ok')",
          ].join("\n"),
        ],
        { encoding: "utf-8" },
      )
      expect(output.trim()).toBe("ok")
    })
  })
})
