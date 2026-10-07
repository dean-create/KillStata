import { describe, expect, test } from "bun:test"
import { searchToolCatalog, type ToolSearchCandidate } from "@/tool/tool-search"
import type { Tool } from "@/tool/tool"
import { toolIDsByFamily } from "@/runtime/tool-manifest"

/** 搜索匹配本身只依赖 ID/别名；方法完整契约由 Python Registry describe 提供。 */
const catalog: ToolSearchCandidate[] = toolIDsByFamily("diagnostic", "estimator").map((id) => ({
  id,
  model: {
    namespace: (id === "iv_test" ? "econometrics_diagnostic" : "econometrics_estimator") as Tool.ModelNamespace,
    useWhen: id,
    doNotUseWhen: "方法前置条件不满足时不要调用。",
    returns: "Python Registry 结构化结果。",
    failureRecovery: "读取 Registry 错误并修复目标字段。",
  },
}))

const ids = (query: string, limit = 10) =>
  searchToolCatalog(catalog, { query, limit }).map((item) => item.toolID)

describe("tool_search 按方法 ID 或产品别名确定性查表", () => {
  test("完整 ID 精确命中并排在首位", () => {
    expect(ids("ols_regression")[0]).toBe("ols_regression")
    expect(ids("did2s")[0]).toBe("did2s")
  })

  test("ID 片段命中同族全部方法", () => {
    const psm = ids("psm")
    expect(psm).toContain("psm_matching")
    expect(psm).toContain("psm_ipw")
    expect(psm).toContain("psm_construction")
    expect(psm.every((id) => id.startsWith("psm"))).toBe(true)
  })

  test("did 命中三个 DID 方法，且精确 ID 优先于片段匹配", () => {
    const did = ids("did")
    expect(did).toContain("did_static")
    expect(did).toContain("did2s")
    expect(did).toContain("did_event_study_saturated")

    // did_static 是精确 ID，必须压过同样含 "did" 的其他方法
    expect(ids("did_static")[0]).toBe("did_static")
  })

  test("真实对话中的中文方法名能命中正确工具", () => {
    expect(ids("普通最小二乘回归")[0]).toBe("ols_regression")
    expect(ids("面板固定效应")[0]).toBe("panel_fe_regression")
    expect(ids("传统双重差分")[0]).toBe("did_static")
    expect(ids("倾向得分匹配")[0]).toBe("psm_matching")
  })

  // 回归点：只断言"首位正确"不足以保证安全。中文别名里嵌着方法族英文缩写
  //（"交错DID" → idTokens 剥出 "did"），该缩写会以 ID 片段命中同族其他方法，
  // 于是"交错DID"曾同时返回 did2s(别名 125)、did_static(片段 40)、
  // did_event_study_saturated(片段 40)。排序虽对，但 tool_search 的 limit 默认为 3，
  // 三个方法会被一起装进方法窗口，模型凭空多出两个可直接调用的近似 DID 方法。
  // 因此这里断言**完整返回集合**，不是首位。
  test("精确中文别名只加载对应方法，不把同族方法一起带出来", () => {
    expect(ids("交错DID")).toEqual(["did2s"])
    expect(ids("动态DID")).toEqual(["did_event_study_saturated"])
    expect(ids("传统双重差分")).toEqual(["did_static"])
    expect(ids("事件研究")).toEqual(["did_event_study_saturated"])
    // 非 DID 家族同理：别名命中后不夹带同前缀的兄弟方法
    expect(ids("倾向得分匹配")).toEqual(["psm_matching"])
    expect(ids("逆概率加权")).toEqual(["psm_ipw"])
  })

  // 与上一条互补：没有别名命中时，族级缩写仍返回整族候选交给模型选择。
  // 这是有意保留的行为——裸 "did" 不是方法选择，而是族名提及，此时给出候选清单
  // 比猜一个更安全。若将来要求泛化词"只列不加载"，需同时改 tool_search 的装载契约。
  test("无别名命中时族级缩写仍返回整族候选", () => {
    const did = ids("did")
    expect(did.length).toBeGreaterThan(1)
    expect(did).toContain("did_static")
    expect(did).toContain("did2s")
  })

  test("不相关查询不返回任何方法，不做模糊兜底", () => {
    expect(ids("生成音乐播放列表")).toEqual([])
    expect(ids("wage")).toEqual([])
  })

  test("limit 生效且被夹在 1—10", () => {
    expect(ids("psm", 2)).toHaveLength(2)
    expect(ids("regression", 100).length).toBeLessThanOrEqual(10)
    expect(ids("psm", 0).length).toBeGreaterThanOrEqual(1)
  })

  test("目录为空或查询无有效 ID 字符时返回空，不抛错", () => {
    expect(searchToolCatalog([], { query: "ols_regression", limit: 3 })).toEqual([])
    expect(ids("！！！")).toEqual([])
  })
})
