/**
 * 跨会话失败历史提示：按根因给建议，不再一律"换一种参数组合"。
 *
 * 现场（2026-08-08 用户实测）：list 因 ENOENT 失败后，系统提示"该工具在过去跨会话共失败
 * 3 次（类型：unknown_failure），建议换一种参数组合"。路径不存在跟参数组合无关，模型照做
 * 只能开始瞎猜参数，白耗两轮修复配额。而且把不同根因的次数加在一起报本身就是噪声。
 */

import { describe, expect, test } from "bun:test"
import { repairHistoryNotice } from "@/runtime/failure-reflection"

describe("repairHistoryNotice", () => {
  test("无历史失败时不产生任何提示", () => {
    expect(repairHistoryNotice("read", [])).toBe("")
  })

  test("file_not_found 给的是解析路径，不是换参数", () => {
    const notice = repairHistoryNotice("read", [{ failureType: "file_not_found" }, { failureType: "file_not_found" }])
    expect(notice).toContain("file_not_found×2")
    expect(notice).toContain("工具实际返回的准确路径")
    expect(notice).not.toContain("换一种参数组合")
  })

  test("不同根因分组计数，不再合并成一个总数", () => {
    const notice = repairHistoryNotice("data_import", [
      { failureType: "file_not_found" },
      { failureType: "tool_contract_failure" },
      { failureType: "tool_contract_failure" },
    ])
    // 最常见的一类是 tool_contract_failure（2 次），建议应针对它
    expect(notice).toContain("tool_contract_failure×2")
    expect(notice).toContain("file_not_found×1")
    expect(notice).toContain("data_import")
    expect(notice).not.toContain("共失败 3 次")
  })

  test("依赖类失败指向 healthcheck 而不是改参数", () => {
    const notice = repairHistoryNotice("panel_fe_regression", [{ failureType: "dependency_broken" }])
    expect(notice).toContain("healthcheck")
  })
})
