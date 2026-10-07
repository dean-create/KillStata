/**
 * Tool.define 对"静态对象字面量"形式的重复 init() 调用不得叠加包装层。
 *
 * 根因（2026-08-16 drive harness 组 B 真实数据实测复现，历时多轮调试才定位）：
 * `Tool.define(id, execution, model, init)` 的 init 参数既可以是工厂函数，也可以是静态对象字面量——
 * ListTool 正是后一种写法（`Tool.define("list", policy, model, { description, parameters, execute })`）。
 * 旧实现在这条分支里直接 `toolInfo.execute = 包装后的函数`——当 init 是静态对象时，
 * `toolInfo` 就是模块加载时创建的唯一单例，这行赋值会**原地修改这个共享对象**。
 * 每次调用 `.init()`（每次会话/每次工具解析都会调用）都会在"上一次已经包装过的
 * execute"基础上再包一层 prepareToolOutput/Truncate.output，N 次 init 产生 N 层
 * 嵌套执行：第二层收到的输入已经被第一层的 redact() 清掉了零宽保护字符
 *（shieldFromLongTokenRedaction 用于豁免 .killstata 内部产物文件名），同一段文本
 * 会被第二层的 LONG_TOKEN_PATTERN 再次误判成密钥、打码成 [已脱敏]——且随进程存活期
 * 内 init 次数增多而逐次加重，是纯粹的"调用次数"触发的隐蔽 bug，与输入内容无关。
 *
 * 断言直接量的是包装层是否叠加：工具自己插入零宽字符做保护（ls.ts 的真实做法），
 * 反复 init() 后这份保护不能失效。这是唯一对旧 bug 敏感的断言形式——单纯数
 * execute 调用次数测不出问题：叠 N 层包装后，每次 tool.execute() 调用依然只会让
 * 底层 execute 触发一次（wrapped_N 调用 wrapped_{N-1} 调用 …… 调用 original，
 * 是一条链而不是并发触发多次），调用计数对包装层数不敏感，唯有"同一段文本被
 * prepareToolOutput 处理了几遍"能暴露出来。
 */

import { describe, expect, test } from "bun:test"
import z from "zod"
import { Tool } from "@/tool/tool"
import { shieldFromLongTokenRedaction } from "@/runtime/tool-result-policy"
import { PermissionNext } from "@/permission/next"

describe("Tool.define repeated init()", () => {
  test("静态对象字面量形式：工具自己插入零宽保护后，反复 init() 不能让保护失效", async () => {
    // 复现 ls.ts 的真实做法：工具自己对内部产物文件名插入零宽字符，
    // 让它逃过下游 prepareToolOutput 的 LONG_TOKEN_PATTERN 误判。
    const longToken = "stage_000_describe_20260816-173358234_numeric_snapshot"
    expect(longToken.length).toBeGreaterThan(40)
    const shielded = shieldFromLongTokenRedaction(longToken)

    const definition = Tool.define("repeated-init-shielded-probe", Tool.Execution.readOnly, {
      namespace: "filesystem",
      useWhen: "测试重复初始化。",
      doNotUseWhen: "非测试场景不要使用。",
      returns: "受保护文本。",
      failureRecovery: "检查包装层。",
    }, {
      description: "probe",
      parameters: z.object({}),
      async execute() {
        return { title: "t", metadata: { truncated: false }, output: shielded }
      },
    })

    const outputs: string[] = []
    for (let i = 0; i < 4; i++) {
      const tool = await definition.init()
      const result = await tool.execute({}, undefined as never)
      outputs.push(result.output)
    }

    // 包装层不叠加时：第一层 prepareToolOutput 把零宽字符消费掉、还原出完整的
    // longToken，之后没有第二层再把它喂回 redact() ——每次 init() 后的结果都应该
    // 一致地是"还原后的完整 token"。旧 bug 下，第 N 次 init() 会产生 N 层嵌套：
    // 第一层还原出 longToken，第二层拿着"已经不带零宽保护的 longToken"重新过
    // redact()，这次真被 LONG_TOKEN_PATTERN 命中，打码成 [已脱敏]——从第二次
    // init() 起结果就会变。
    for (const output of outputs) {
      expect(output).toBe(longToken)
      expect(output).not.toContain("已脱敏")
    }
  })

  test("执行失败会保留根因并附上该工具自己的中文修复建议", async () => {
    const definition = Tool.define("actionable-error-probe", Tool.Execution.readOnly, {
      namespace: "filesystem",
      useWhen: "测试错误恢复。",
      doNotUseWhen: "非测试场景不要使用。",
      returns: "不会成功返回。",
      failureRecovery: "检查目标文件是否存在，只修复路径后重试。",
    }, {
      description: "错误恢复探针。",
      parameters: z.object({ path: z.string().describe("测试路径。") }),
      async execute() {
        throw new Error("File not found")
      },
    })

    const initialized = await definition.init()
    await expect(initialized.execute({ path: "/missing" }, undefined as never)).rejects.toThrow(
      "File not found\n修复建议：检查目标文件是否存在，只修复路径后重试。",
    )
  })

  test("默认参数错误使用中文并指导模型只修正错误字段", async () => {
    const definition = Tool.define("validation-error-probe", Tool.Execution.readOnly, {
      namespace: "filesystem",
      useWhen: "测试参数错误。",
      doNotUseWhen: "非测试场景不要使用。",
      returns: "不会成功返回。",
      failureRecovery: "按 schema 修正参数。",
    }, {
      description: "参数错误探针。",
      parameters: z.object({ limit: z.number().int().positive().describe("正整数上限。") }),
      async execute() {
        return { title: "ok", metadata: {}, output: "ok" }
      },
    })

    const initialized = await definition.init()
    const error = await initialized.execute({ limit: "bad" } as never, undefined as never).catch((cause) => cause)
    expect(error).toBeInstanceOf(Tool.InputValidationError)
    expect(error.code).toBe("TOOL_INPUT_INVALID")
    expect(error.message).toMatch(/工具 validation-error-probe 参数不合法.*limit：类型错误.*修复建议/s)
    expect(error.message).not.toContain("Invalid input")
  })

  test("权限拒绝等运行时控制流错误保持原类型，不被通用恢复文案包装", async () => {
    const rejected = new PermissionNext.RejectedError()
    const definition = Tool.define("permission-error-probe", Tool.Execution.readOnly, {
      namespace: "filesystem",
      useWhen: "测试权限控制流。",
      doNotUseWhen: "非测试场景不要使用。",
      returns: "不会成功返回。",
      failureRecovery: "等待用户重新授权。",
    }, {
      description: "权限错误探针。",
      parameters: z.object({}),
      async execute() {
        throw rejected
      },
    })

    const initialized = await definition.init()
    try {
      await initialized.execute({}, undefined as never)
      throw new Error("测试预期权限错误")
    } catch (error) {
      expect(error).toBe(rejected)
      expect(error).toBeInstanceOf(PermissionNext.RejectedError)
    }
  })
})
