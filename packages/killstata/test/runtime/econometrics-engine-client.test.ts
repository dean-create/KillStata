import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { EconometricsEngineClient, type EngineRequestPayload } from "@/runtime/services/econometrics-engine-client"

function client() {
  const managedPython = process.platform === "win32"
    ? path.join(os.homedir(), ".killstata", "venv", "Scripts", "python.exe")
    : path.join(os.homedir(), ".killstata", "venv", "bin", "python")
  return new EconometricsEngineClient({
    // 系统 Python 不保证安装计量引擎依赖；测试应与产品运行时一样使用受管环境。
    command: process.env.KILLSTATA_PYTHON ?? managedPython,
    cwd: path.resolve(process.cwd(), "../.."),
    pythonPath: path.resolve(process.cwd(), "../killstata-econometrics-engine/src"),
  })
}

describe("EconometricsEngineClient", () => {
  function fakeEngine(root: string, body: string) {
    const script = path.join(root, "fake-engine.sh")
    fs.writeFileSync(script, `#!/bin/sh\n${body}\n`, "utf8")
    fs.chmodSync(script, 0o755)
    return script
  }

  test("calls health and searches the Python registry through one JSONL process", async () => {
    const engine = client()
    try {
      await expect(engine.health()).resolves.toMatchObject({ registry_version: 2, method_count: 30 })
      await expect(engine.search({ query: "普通最小二乘", limit: 3 })).resolves.toMatchObject({
        methods: [{ method_id: "ols_regression" }],
      })
    } finally {
      await engine.close()
    }
  })

  test("returns a structured method-not-found error", async () => {
    const engine = client()
    try {
      await expect(engine.describe("missing_method")).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" })
    } finally {
      await engine.close()
    }
  })

  test("validates capability arguments with the Python Registry contract", async () => {
    const engine = client()
    try {
      await expect(engine.validate("econometrics_recommend", {
        dependentVar: "创新指数",
        treatmentVar: "高质量发展指数",
      }, {
        runtime: { datasetId: "dataset_current", stageId: "stage_000" },
      })).resolves.toMatchObject({
        method_id: "econometrics_recommend",
        arguments: { dependentVar: "创新指数", treatmentVar: "高质量发展指数" },
      })
      await expect(engine.validate("econometrics_recommend", {
        dependentVar: 123,
      }, {
        runtime: { datasetId: "dataset_current", stageId: "stage_000" },
      })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
    } finally {
      await engine.close()
    }
  })

  test("serializes requests and refuses an already aborted request", async () => {
    const engine = client()
    try {
      const controller = new AbortController()
      controller.abort()
      const payload: EngineRequestPayload = { query: "普通最小二乘", limit: 1 }
      await expect(engine.request("search", payload, controller.signal)).rejects.toMatchObject({ code: "ENGINE_ABORTED" })
      await expect(engine.search({ query: "面板固定效应", limit: 1 })).resolves.toMatchObject({ methods: [{ method_id: "panel_fe_regression" }] })
    } finally {
      await engine.close()
    }
  })

  test("does not reject an aborted request until the engine process has exited", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-engine-abort-close-"))
    const shutdownMarker = path.join(root, "shutdown.txt")
    const command = fakeEngine(root, [
      `trap 'sleep 0.1; printf stopped > '${shutdownMarker}'; exit 0' TERM`,
      `while IFS= read -r line; do`,
      `echo '{"protocol_version":2,"request_id":"engine_1","type":"progress","sequence":1,"event":{"status":"running"}}'`,
      "while :; do :; done",
      "done",
    ].join(String.fromCharCode(10)))
    const controller = new AbortController()
    const engine = new EconometricsEngineClient({
      command,
      cwd: root,
      pythonPath: root,
      timeoutMs: 10_000,
      onProgress: (frame) => {
        if (frame.event.status === "running") controller.abort()
      },
    })
    try {
      await expect(engine.execute({
        method_id: "ols_regression",
        data_path: path.join(root, "data.csv"),
        output_dir: path.join(root, "results"),
        arguments: {},
      }, controller.signal)).rejects.toMatchObject({ code: "ENGINE_ABORTED" })
      expect(fs.readFileSync(shutdownMarker, "utf8")).toBe("stopped")
    } finally {
      await engine.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("does not reject a closing request until the engine process has exited", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-engine-close-wait-"))
    const shutdownMarker = path.join(root, "shutdown.txt")
    const command = fakeEngine(root, [
      `trap 'sleep 0.1; printf stopped > '${shutdownMarker}'; exit 0' TERM`,
      `while IFS= read -r line; do`,
      `echo '{"protocol_version":2,"request_id":"engine_1","type":"progress","sequence":1,"event":{"status":"running"}}'`,
      "while :; do :; done",
      "done",
    ].join(String.fromCharCode(10)))
    let closePromise: Promise<void> | undefined
    let engine: EconometricsEngineClient
    engine = new EconometricsEngineClient({
      command,
      cwd: root,
      pythonPath: root,
      timeoutMs: 10_000,
      onProgress: (frame) => {
        if (frame.event.status === "running" && !closePromise) closePromise = engine.close()
      },
    })
    try {
      await expect(engine.execute({
        method_id: "ols_regression",
        data_path: path.join(root, "data.csv"),
        output_dir: path.join(root, "results"),
        arguments: {},
      })).rejects.toMatchObject({ code: "ENGINE_CLOSED" })
      expect(fs.readFileSync(shutdownMarker, "utf8")).toBe("stopped")
    } finally {
      await closePromise
      await engine.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("maps Python progress frames without consuming the terminal result", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-engine-progress-"))
    fs.writeFileSync(path.join(root, "data.csv"), "entity,y\nA,1\nB,2\n", "utf8")
    const progress: Array<{ sequence: number; status?: unknown }> = []
    const engine = new EconometricsEngineClient({
      command: process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python"),
      cwd: path.resolve(process.cwd(), "../.."),
      pythonPath: path.resolve(process.cwd(), "../killstata-econometrics-engine/src"),
      onProgress: (frame) => progress.push({ sequence: frame.sequence, status: frame.event.status }),
    })
    try {
      await expect(engine.execute({
        method_id: "data_import",
        data_path: path.join(root, "data.csv"),
        output_dir: path.join(root, "result"),
        arguments: { action: "profile" },
        runtime: {
          inputPath: path.join(root, "data.csv"),
          outputPath: path.join(root, "result", "profile.xlsx"),
          datasetId: "dataset_client_test",
          stageId: "stage_000",
        },
      })).resolves.toMatchObject({ success: true })
      expect(progress.map((item) => item.sequence)).toEqual([1, 2])
      expect(progress.map((item) => item.status)).toEqual(["running", "completed"])
    } finally {
      await engine.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("sends the actual execute envelope as one JSONL request with paths and lineage outside method arguments", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-engine-wire-envelope-"))
    const capturePath = path.join(root, "request.jsonl")
    const command = fakeEngine(root, [
      `while IFS= read -r line; do printf '%s\\n' "$line" >> '${capturePath}'`,
      `printf '%s\\n' '{"protocol_version":2,"request_id":"engine_1","type":"result","ok":true,"result":{"success":true,"method_id":"ols_regression"}}'`,
      "done",
    ].join("\n"))
    const dataPath = path.join(root, "canonical", "stage_004.parquet")
    const outputDir = path.join(root, "canonical", "results", "run_004")
    const engine = new EconometricsEngineClient({ command, cwd: root, pythonPath: root })
    try {
      await expect(engine.execute({
        method_id: "ols_regression",
        data_path: dataPath,
        output_dir: outputDir,
        arguments: { dependentVar: "y", treatmentVar: "x", covariates: [] },
        runtime: { datasetId: "dataset_current", stageId: "stage_004" },
      })).resolves.toMatchObject({ success: true, method_id: "ols_regression" })

      const lines = fs.readFileSync(capturePath, "utf8").trim().split("\n")
      expect(lines).toHaveLength(1)
      const request = JSON.parse(lines[0]!)
      expect(request).toMatchObject({
        protocol_version: 2,
        request_id: "engine_1",
        operation: "execute",
        payload: {
          method_id: "ols_regression",
          data_path: dataPath,
          output_dir: outputDir,
          arguments: { dependentVar: "y", treatmentVar: "x", covariates: [] },
          runtime: { datasetId: "dataset_current", stageId: "stage_004" },
        },
      })
      expect(request.payload.arguments).not.toHaveProperty("datasetId")
      expect(request.payload.arguments).not.toHaveProperty("stageId")
      expect(request.payload.arguments).not.toHaveProperty("data_path")
      expect(request.payload.arguments).not.toHaveProperty("output_dir")
    } finally {
      await engine.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("exposes a read-only preflight result before execution", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-engine-preflight-"))
    fs.writeFileSync(path.join(root, "data.csv"), "y,x,z\n1,1,2\n2,2,4\n3,3,6\n", "utf8")
    const engine = client()
    try {
      await expect(engine.preflight({
        method_id: "ols_regression",
        data_path: path.join(root, "data.csv"),
        arguments: { dependentVar: "y", treatmentVar: "x", covariates: ["z"] },
      })).resolves.toMatchObject({
        executable: false,
        status: "requires_user_decision",
        issues: [{ code: "DESIGN_MATRIX_RANK_DEFICIENT" }],
      })
    } finally {
      await engine.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("classifies a hung engine as a timeout and clears the request", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-engine-timeout-"))
    const engine = new EconometricsEngineClient({
      command: fakeEngine(root, "while IFS= read line; do :; done"),
      cwd: root,
      pythonPath: root,
      timeoutMs: 20,
    })
    try {
      await expect(engine.health()).rejects.toMatchObject({ code: "ENGINE_TIMEOUT" })
      await expect(engine.search({ query: "OLS", limit: 1 })).rejects.toMatchObject({ code: "ENGINE_TIMEOUT" })
    } finally {
      await engine.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("reports an engine crash instead of turning an empty response into success", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-engine-crash-"))
    const engine = new EconometricsEngineClient({
      command: fakeEngine(root, "exit 17"),
      cwd: root,
      pythonPath: root,
      timeoutMs: 10_000,
    })
    try {
      await expect(engine.health()).rejects.toMatchObject({ code: "ENGINE_CRASHED" })
    } finally {
      await engine.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects a single oversized JSONL frame before it enters the result envelope", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-engine-oversize-"))
    const oversized = "x".repeat(2 * 1024 * 1024 + 1)
    const engine = new EconometricsEngineClient({
      command: fakeEngine(root, `while IFS= read line; do printf '%s\\n' '${oversized}'; done`),
      cwd: root,
      pythonPath: root,
      timeoutMs: 10_000,
    })
    try {
      await expect(engine.health()).rejects.toMatchObject({ code: "ENGINE_RESPONSE_TOO_LARGE" })
    } finally {
      await engine.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
