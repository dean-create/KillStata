import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { Question } from "@/question"

describe("question label length guard", () => {
  test("header / option label >30 chars 必须被显式拒收", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-q-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          let err: unknown
          try {
            await Question.ask({
              sessionID: "label-length",
              questions: [
                {
                  question: "用哪个模型？",
                  header: "推荐方法",
                  options: [
                    { label: "面板固定效应回归（双向固定效应、聚类稳健标准误、列名需真实存在，推荐）", description: "" },
                    { label: "短的", description: "" },
                  ],
                },
              ],
            })
          } catch (e) {
            err = e
          }
          expect(err).toBeInstanceOf(Error)
          const msg = (err as Error).message
          expect(msg).toContain("第 1 题第 1 项")
          expect(msg).toContain("label")
          expect(msg).toContain("30")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})