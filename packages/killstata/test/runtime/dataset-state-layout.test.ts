/**
 * 回归测试：readDatasetManifest / readDatasetIndex 必须先建目录布局。
 *
 * B3 重构时把这两个函数从 tool/analysis-state 移到 runtime/dataset-state，
 * 一度漏掉了 ensureInternalLayout() 调用——在全新项目目录（.killstata 还不存在）
 * 上 readDatasetIndex 会返回空索引但不落盘，后续 upsert 拿到的是过期视图。
 * 此测试冻结"读之前先建布局"这条契约。
 */

import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { datasetIndexPath, projectInternalRoot, readDatasetIndex, readDatasetManifest } from "@/runtime/dataset-state"

function freshProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "killstata-layout-"))
}

describe("dataset-state 目录布局契约", () => {
  test("readDatasetIndex 在全新目录上自建布局并把索引落盘", async () => {
    const directory = freshProjectDir()
    await Instance.provide({
      directory,
      fn: () => {
        // 前置：.killstata 完全不存在
        expect(fs.existsSync(projectInternalRoot())).toBe(false)

        const index = readDatasetIndex()
        expect(index).toEqual({ version: 1, entries: {} })

        // 关键断言：读操作必须已经把布局建好并落盘 index.json，
        // 否则后续 upsertDatasetIndexEntry 会基于不存在的文件做增量写。
        expect(fs.existsSync(projectInternalRoot())).toBe(true)
        expect(fs.existsSync(datasetIndexPath())).toBe(true)
      },
    })
  })

  test("readDatasetManifest 对不存在的数据集抛业务错误，且已建好布局", async () => {
    const directory = freshProjectDir()
    await Instance.provide({
      directory,
      fn: () => {
        expect(fs.existsSync(projectInternalRoot())).toBe(false)

        expect(() => readDatasetManifest("nonexistent_dataset")).toThrow(/Dataset manifest not found/)

        // 即使读失败，布局也应当已经建好（原 analysis-state 的行为）
        expect(fs.existsSync(projectInternalRoot())).toBe(true)
      },
    })
  })
})
