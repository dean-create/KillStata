import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { persistPythonFailureArtifacts } from "@/tool/econometrics"

const TOOL_DIR = path.join(process.cwd(), "src", "tool")

describe("Harness failure artifacts", () => {
  test("never persists Python traceback or a payload-bearing crash script", () => {
    const dataImport = fs.readFileSync(path.join(TOOL_DIR, "data-import.ts"), "utf-8")
    const econometrics = fs.readFileSync(path.join(TOOL_DIR, "econometrics.ts"), "utf-8")

    expect(dataImport).not.toContain('"traceback": traceback.format_exc()')
    expect(dataImport).not.toContain("message += `\\n${result.traceback}`")
    expect(econometrics).not.toContain('"traceback": traceback.format_exc()')
    expect(econometrics).not.toContain("fs.copyFileSync(input.execution.scriptPath")
    expect(econometrics).not.toContain("message += `\\n${result.traceback}`")
    expect(dataImport).not.toContain("save_json(error_path, result)")
    expect(econometrics).not.toContain("save_json(error_path, result)")
    expect(dataImport).not.toContain('"error_log_path": error_path')
    expect(econometrics).not.toContain('"error_log_path": error_path')
  })

  test("auto recommendation receives the same abort signal as its parent tool", () => {
    const source = fs.readFileSync(path.join(TOOL_DIR, "econometrics.ts"), "utf-8")
    const definition = source.slice(source.indexOf("async function runAutoRecommend"), source.indexOf("function describeDataPath"))
    expect(definition).toContain("abort?: AbortSignal")
    expect(definition).toContain("abort: input.abort")
    expect(source.match(/runAutoRecommend\(\{[\s\S]*?abort: ctx\.abort,[\s\S]*?\}\)/g)?.length).toBe(2)
  })

  test("creates concurrent failure bundles in distinct private directories", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-failure-bundle-"))
    const bundles = await Instance.provide({
      directory,
      fn: async () => {
        const create = () => persistPythonFailureArtifacts({
          label: "ols_regression",
          command: `${os.homedir()}/.killstata/venv/bin/python`,
          cwd: directory,
          execution: {
            code: 1,
            stdout: "api_key=sk-failure-secret",
            stderr: `FileNotFoundError: ${os.homedir()}/Secret/panel.xlsx: missing`,
            scriptPath: path.join(directory, "already-removed.py"),
            cleanup() {},
          },
        })
        return [create(), create()]
      },
    })

    expect(path.dirname(bundles[0].contextPath)).not.toBe(path.dirname(bundles[1].contextPath))
    for (const bundle of bundles) {
      const bundleDir = path.dirname(bundle.contextPath)
      expect(fs.statSync(bundleDir).mode & 0o777).toBe(0o700)
      for (const filePath of [bundle.stdoutPath, bundle.stderrPath, bundle.contextPath]) {
        expect(fs.statSync(filePath).mode & 0o777).toBe(0o600)
      }
      const persisted = [bundle.stdoutPath, bundle.stderrPath, bundle.contextPath]
        .map((filePath) => fs.readFileSync(filePath, "utf-8"))
        .join("\n")
      expect(persisted).not.toContain("sk-failure-secret")
      expect(persisted).not.toContain(os.homedir())
    }
    fs.rmSync(directory, { recursive: true, force: true })
  })

  test("temporary payload scripts are private and always removed by their launcher", () => {
    const dataImport = fs.readFileSync(path.join(TOOL_DIR, "data-import.ts"), "utf-8")
    const econometrics = fs.readFileSync(path.join(TOOL_DIR, "econometrics.ts"), "utf-8")
    const privateWrite = 'fs.writeFileSync(tempScriptPath, input.script, { encoding: "utf-8", mode: 0o600 })'

    expect(dataImport).toContain(privateWrite)
    expect(econometrics).toContain(privateWrite)
    const econometricsLauncher = econometrics.slice(
      econometrics.indexOf("async function runInlinePython"),
      econometrics.indexOf("const SUPPORTED_METHODS"),
    )
    expect(econometricsLauncher).toContain("finally")
    expect(econometricsLauncher).toContain("fs.rmSync(tempScriptPath, { force: true })")
  })
})
