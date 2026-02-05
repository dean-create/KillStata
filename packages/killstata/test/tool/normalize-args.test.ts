import { describe, expect, test } from "bun:test"
import z from "zod"

/**
 * 测试工具参数规范化逻辑
 * 模拟 tool.ts 中的 normalizeArgs 行为
 */

// 模拟 tool.ts 中的参数规范化逻辑
function normalizeArgs<T>(args: T | string): T {
    let normalizedArgs = args
    if (typeof args === "string") {
        try {
            const parsed = JSON.parse(args)
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                normalizedArgs = parsed as T
            }
        } catch {
            // JSON 解析失败，保留原始值
        }
    }
    return normalizedArgs as T
}

describe("工具参数规范化", () => {
    // 模拟 bash 工具的参数 schema
    const BashParams = z.object({
        command: z.string(),
        description: z.string().optional(),
        workdir: z.string().optional(),
        timeout: z.number().optional(),
    })

    test("对象参数直接通过验证", () => {
        const args = { command: "echo hello", description: "Test command" }
        const normalized = normalizeArgs(args)

        const result = BashParams.safeParse(normalized)
        expect(result.success).toBe(true)
    })

    test("JSON 字符串参数被解析为对象", () => {
        const args = '{"command": "echo hello", "description": "Test command"}'
        const normalized = normalizeArgs(args)

        expect(typeof normalized).toBe("object")
        expect(normalized).toHaveProperty("command", "echo hello")

        const result = BashParams.safeParse(normalized)
        expect(result.success).toBe(true)
    })

    test("无效 JSON 字符串保留原值", () => {
        const args = "not valid json"
        const normalized = normalizeArgs(args)

        // 保留原始字符串
        expect(normalized).toBe("not valid json")

        // Zod 验证会失败并给出有意义的错误
        const result = BashParams.safeParse(normalized)
        expect(result.success).toBe(false)
    })

    test("模拟实际错误场景 - bash 工具收到字符串参数", () => {
        // 这是用户报告的实际场景
        const stringArgs = '{"command": "ls -la", "description": "List files"}'

        // 规范化处理
        const normalized = normalizeArgs(stringArgs)

        // 验证可以通过 schema
        const result = BashParams.safeParse(normalized)
        expect(result.success).toBe(true)

        if (result.success) {
            expect(result.data.command).toBe("ls -la")
            expect(result.data.description).toBe("List files")
        }
    })

    // 模拟 todowrite 工具的参数 schema
    const TodoWriteParams = z.object({
        todos: z.array(z.object({
            content: z.string(),
            status: z.enum(["pending", "in-progress", "completed"]),
        })),
    })

    test("模拟 todowrite 工具收到字符串参数", () => {
        const stringArgs = '{"todos": [{"content": "Fix bug", "status": "in-progress"}]}'

        const normalized = normalizeArgs(stringArgs)

        const result = TodoWriteParams.safeParse(normalized)
        expect(result.success).toBe(true)

        if (result.success) {
            expect(result.data.todos).toHaveLength(1)
            expect(result.data.todos[0].content).toBe("Fix bug")
        }
    })

    test("数组类型 JSON 字符串不被转换（保留原值让验证失败）", () => {
        const args = "[1, 2, 3]"
        const normalized = normalizeArgs(args)

        // 数组不是有效的工具参数格式，保留原值
        expect(normalized).toBe("[1, 2, 3]")
    })

    test("null 和 undefined 保持不变", () => {
        expect(normalizeArgs(null)).toBe(null)
        expect(normalizeArgs(undefined)).toBe(undefined)
    })

    test("嵌套对象正确解析", () => {
        const complexArgs = '{"options": {"verbose": true, "format": "json"}, "path": "/test"}'
        const normalized = normalizeArgs(complexArgs)

        expect(typeof normalized).toBe("object")
        expect(normalized).toHaveProperty("options")
        expect((normalized as any).options.verbose).toBe(true)
    })
})
