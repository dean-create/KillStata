import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import { Log } from "@/util/log"

describe("private bounded logs", () => {
  test("redacts secrets and private paths and creates the log as owner-only", async () => {
    await Log.init({ print: false, dev: true, level: "INFO" })
    const logger = Log.create({ service: `log-policy-${Date.now()}` })
    logger.info("run import", {
      apiKey: "sk-log-secret",
      inputPath: `${os.homedir()}/Secret/payroll.xlsx`,
    })
    await Bun.sleep(10)

    const content = fs.readFileSync(Log.file(), "utf-8")
    expect(content).not.toContain("sk-log-secret")
    expect(content).not.toContain(os.homedir())
    expect(content).toContain("[已脱敏]")
    expect(content).toContain("[本机路径已隐藏]")
    expect(fs.statSync(Log.file()).mode & 0o777).toBe(0o600)
  })
})
