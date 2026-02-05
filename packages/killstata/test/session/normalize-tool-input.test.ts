import { describe, expect, test } from "bun:test"

/**
 * 测试 normalizeToolInput 函数的逻辑
 * 这个函数用于规范化工具输入，确保返回对象类型
 */

// 复制 processor.ts 中的 normalizeToolInput 函数逻辑进行独立测试
function normalizeToolInput(input: unknown): Record<string, unknown> {
    // 如果已经是对象类型，直接返回
    if (typeof input === "object" && input !== null && !Array.isArray(input)) {
        return input as Record<string, unknown>
    }
    // 如果是字符串，尝试解析为 JSON
    if (typeof input === "string") {
        try {
            const parsed = JSON.parse(input)
            // 确保解析结果是对象
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>
            }
            // 如果解析结果不是对象，包装成错误对象
            return { _raw: input, _parseError: "Parsed value is not an object" }
        } catch {
            // JSON 解析失败，包装成错误对象
            return { _raw: input, _parseError: "Invalid JSON" }
        }
    }
    // 其他类型，包装成对象
    return { _raw: String(input), _parseError: "Unexpected input type" }
}

describe("normalizeToolInput", () => {
    test("对象类型输入直接返回", () => {
        const input = { todos: [{ content: "test", status: "pending" }] }
        const result = normalizeToolInput(input)
        expect(result).toEqual(input)
    })

    test("空对象直接返回", () => {
        const input = {}
        const result = normalizeToolInput(input)
        expect(result).toEqual({})
    })

    test("JSON 字符串解析为对象", () => {
        const input = '{"todos": [{"content": "test", "status": "pending"}]}'
        const result = normalizeToolInput(input)
        expect(result).toEqual({ todos: [{ content: "test", status: "pending" }] })
    })

    test("空 JSON 对象字符串解析为空对象", () => {
        const input = "{}"
        const result = normalizeToolInput(input)
        expect(result).toEqual({})
    })

    test("无效 JSON 字符串返回错误对象", () => {
        const input = "not valid json"
        const result = normalizeToolInput(input)
        expect(result._raw).toBe(input)
        expect(result._parseError).toBe("Invalid JSON")
    })

    test("JSON 数组字符串返回错误对象", () => {
        const input = "[1, 2, 3]"
        const result = normalizeToolInput(input)
        expect(result._raw).toBe(input)
        expect(result._parseError).toBe("Parsed value is not an object")
    })

    test("JSON 原始值字符串返回错误对象", () => {
        const input = '"just a string"'
        const result = normalizeToolInput(input)
        expect(result._raw).toBe(input)
        expect(result._parseError).toBe("Parsed value is not an object")
    })

    test("null 输入返回错误对象", () => {
        const result = normalizeToolInput(null)
        expect(result._parseError).toBe("Unexpected input type")
    })

    test("undefined 输入返回错误对象", () => {
        const result = normalizeToolInput(undefined)
        expect(result._parseError).toBe("Unexpected input type")
    })

    test("数组输入返回错误对象", () => {
        const input = [1, 2, 3]
        const result = normalizeToolInput(input)
        expect(result._parseError).toBe("Unexpected input type")
    })

    test("数字输入返回错误对象", () => {
        const result = normalizeToolInput(123)
        expect(result._raw).toBe("123")
        expect(result._parseError).toBe("Unexpected input type")
    })

    test("模拟实际错误场景 - todowrite 工具的 JSON 字符串输入", () => {
        // 这是实际可能发生的场景：某些模型返回 JSON 字符串而非解析后的对象
        const stringInput = '{"todos": [{"content": "Fix bug", "status": "in-progress"}]}'
        const result = normalizeToolInput(stringInput)

        // 验证可以正确解析
        expect(result.todos).toBeDefined()
        expect(Array.isArray(result.todos)).toBe(true)
    })

    test("嵌套对象正确处理", () => {
        const input = {
            nested: {
                deep: {
                    value: "test"
                }
            }
        }
        const result = normalizeToolInput(input)
        expect(result).toEqual(input)
    })
})
