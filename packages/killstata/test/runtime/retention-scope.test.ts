/**
 * 会话隔离：retention 的 scopeSessionID 必须只清本会话的 child 子会话。
 *
 * 现场（2026-08-08）：dispatch defer 里 cleanupSessions({ childSessionsOnly: true })
 * 不带 scope，新窗口一条消息退出就全项目扫——把 25h 前别的会话遗留的 verifier
 * 子会话误删（父会话在 keepTopSessions 里保留，但 child updated 超活跃窗口）。
 */

import { describe, expect, test } from "bun:test"
import { protectActiveChildAncestors, selectRemovableChildren } from "@/runtime/retention"

const now = 1_000_000_000_000

function child(id: string, parentID: string, updated: number) {
  return { id, parentID, updated }
}

describe("selectRemovableChildren 会话隔离", () => {
  test("active child 的旧父会话必须进入 keepIds，避免递归删除 child", () => {
    const keepIds = protectActiveChildAncestors({
      sessions: [
        { id: "old_parent" },
        { id: "active_verifier", parentID: "old_parent" },
      ],
      activeChildIds: new Set(["active_verifier"]),
      keepIds: new Set(),
    })
    expect(keepIds).toEqual(new Set(["old_parent"]))
  })

  test("scopeSessionID 指定时，只清该会话的 child，不动别的会话", () => {
    const children = [
      child("a_verifier", "ses_a", now - 25 * 3600_000), // 超窗，但属于别的会话
      child("b_verifier", "ses_b", now - 25 * 3600_000), // 超窗，属于本会话 → 该删
    ]
    const removable = selectRemovableChildren({
      children,
      keepIds: new Set(["ses_a", "ses_b"]),
      activeCutoff: now - 24 * 3600_000,
      scopeSessionID: "ses_b",
    })
    expect(removable).toEqual(["b_verifier"])
  })

  test("scopeSessionID 指定时，本会话仍在运行的 child 必须保留", () => {
    const children = [child("mine_verifier", "ses_b", now - 1000)]
    const removable = selectRemovableChildren({
      children,
      keepIds: new Set(["ses_b"]),
      activeCutoff: now - 24 * 3600_000,
      scopeSessionID: "ses_b",
      activeChildIds: new Set(["mine_verifier"]),
    })
    expect(removable).toEqual([])
  })

  test("不传 scopeSessionID：走旧语义（父会话不在 keepIds 或 child 超窗）", () => {
    const children = [
      child("a_verifier", "ses_a", now - 25 * 3600_000),
      child("active_child", "ses_a", now - 1000), // 活跃 → 保留
      child("orphan", "ses_gone", now - 1000), // 父不在 keepIds → 删
    ]
    const removable = selectRemovableChildren({
      children,
      keepIds: new Set(["ses_a"]),
      activeCutoff: now - 24 * 3600_000,
    })
    expect(removable.sort()).toEqual(["a_verifier", "orphan"])
  })

  test("手动全项目 cleanup 也不能删除仍在运行的 child", () => {
    const removable = selectRemovableChildren({
      children: [child("active_verifier", "ses_parent", now - 25 * 3600_000)],
      keepIds: new Set(["ses_parent"]),
      activeCutoff: now - 24 * 3600_000,
      activeChildIds: new Set(["active_verifier"]),
    })
    expect(removable).toEqual([])
  })
})
