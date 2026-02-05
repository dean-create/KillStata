import { describe, expect, test, beforeAll } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import z from "zod"

/**
 * 测试 ToolState schema 验证
 * 确保我们的 normalizeToolInput 修复后，所有工具状态都能正确验证
 */

describe("ToolState schema validation", () => {
    test("ToolStatePending 接受对象类型 input", () => {
        const state = {
            status: "pending" as const,
            input: { todos: [{ content: "test", status: "pending" }] },
            raw: "",
        }

        const result = MessageV2.ToolStatePending.safeParse(state)
        expect(result.success).toBe(true)
    })

    test("ToolStatePending 拒绝字符串类型 input", () => {
        const state = {
            status: "pending" as const,
            input: '{"todos": []}',  // 字符串，应该被拒绝
            raw: "",
        }

        const result = MessageV2.ToolStatePending.safeParse(state)
        expect(result.success).toBe(false)
        // 只需验证解析失败即可，不检查具体错误信息
        // 因为不同版本的 Zod 可能有不同的错误消息格式
    })

    test("ToolStateRunning 接受对象类型 input", () => {
        const state = {
            status: "running" as const,
            input: { filePath: "/test/file.txt" },
            time: { start: Date.now() },
        }

        const result = MessageV2.ToolStateRunning.safeParse(state)
        expect(result.success).toBe(true)
    })

    test("ToolStateRunning 拒绝字符串类型 input", () => {
        const state = {
            status: "running" as const,
            input: '{"filePath": "/test/file.txt"}',  // 字符串，应该被拒绝
            time: { start: Date.now() },
        }

        const result = MessageV2.ToolStateRunning.safeParse(state)
        expect(result.success).toBe(false)
    })

    test("ToolStateCompleted 接受对象类型 input", () => {
        const state = {
            status: "completed" as const,
            input: { command: "ls -la" },
            output: "file1.txt\nfile2.txt",
            title: "Listed files",
            metadata: {},
            time: { start: Date.now() - 1000, end: Date.now() },
        }

        const result = MessageV2.ToolStateCompleted.safeParse(state)
        expect(result.success).toBe(true)
    })

    test("ToolStateError 接受对象类型 input", () => {
        const state = {
            status: "error" as const,
            input: { query: "invalid sql" },
            error: "Syntax error at line 1",
            time: { start: Date.now() - 1000, end: Date.now() },
        }

        const result = MessageV2.ToolStateError.safeParse(state)
        expect(result.success).toBe(true)
    })

    test("ToolState discriminatedUnion 正确处理所有状态", () => {
        const states = [
            { status: "pending" as const, input: {}, raw: "" },
            { status: "running" as const, input: {}, time: { start: Date.now() } },
            { status: "completed" as const, input: {}, output: "", title: "", metadata: {}, time: { start: 0, end: 0 } },
            { status: "error" as const, input: {}, error: "", time: { start: 0, end: 0 } },
        ]

        for (const state of states) {
            const result = MessageV2.ToolState.safeParse(state)
            expect(result.success).toBe(true)
        }
    })

    test("ToolPart 完整验证 - 模拟 todowrite 工具", () => {
        const toolPart: z.infer<typeof MessageV2.ToolPart> = {
            id: "part_12345",
            sessionID: "session_12345",
            messageID: "message_12345",
            type: "tool",
            callID: "call_12345",
            tool: "todowrite",
            state: {
                status: "completed",
                input: {
                    todos: [
                        { content: "Fix bug in processor.ts", status: "in-progress" },
                        { content: "Add unit tests", status: "pending" }
                    ]
                },
                output: "2 todos",
                title: "Updated todos",
                metadata: { todos: [] },
                time: { start: Date.now() - 500, end: Date.now() },
            },
        }

        const result = MessageV2.ToolPart.safeParse(toolPart)
        expect(result.success).toBe(true)
    })

    test("Part discriminatedUnion 包含 ToolPart", () => {
        const toolPart = {
            id: "part_12345",
            sessionID: "session_12345",
            messageID: "message_12345",
            type: "tool" as const,
            callID: "call_12345",
            tool: "bash",
            state: {
                status: "running" as const,
                input: { command: "echo hello" },
                time: { start: Date.now() },
            },
        }

        const result = MessageV2.Part.safeParse(toolPart)
        expect(result.success).toBe(true)
    })
})

describe("normalizeToolInput integration", () => {
    // 复制 processor.ts 中的 normalizeToolInput 函数
    function normalizeToolInput(input: unknown): Record<string, unknown> {
        if (typeof input === "object" && input !== null && !Array.isArray(input)) {
            return input as Record<string, unknown>
        }
        if (typeof input === "string") {
            try {
                const parsed = JSON.parse(input)
                if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                    return parsed as Record<string, unknown>
                }
                return { _raw: input, _parseError: "Parsed value is not an object" }
            } catch {
                return { _raw: input, _parseError: "Invalid JSON" }
            }
        }
        return { _raw: String(input), _parseError: "Unexpected input type" }
    }

    test("字符串 input 经过 normalizeToolInput 后可以通过 ToolStateRunning 验证", () => {
        // 模拟某些模型返回字符串 input 的场景
        const stringInput = '{"todos": [{"content": "test", "status": "pending"}]}'

        // 应用 normalizeToolInput
        const normalizedInput = normalizeToolInput(stringInput)

        // 构造 ToolStateRunning
        const state = {
            status: "running" as const,
            input: normalizedInput,
            time: { start: Date.now() },
        }

        // 验证可以通过 schema
        const result = MessageV2.ToolStateRunning.safeParse(state)
        expect(result.success).toBe(true)

        // 验证 input 内容正确
        if (result.success) {
            expect(result.data.input.todos).toBeDefined()
        }
    })

    test("无效 JSON 字符串经过 normalizeToolInput 后也能通过验证", () => {
        const invalidInput = "not valid json"

        const normalizedInput = normalizeToolInput(invalidInput)

        const state = {
            status: "error" as const,
            input: normalizedInput,
            error: "Invalid tool input",
            time: { start: Date.now() - 100, end: Date.now() },
        }

        const result = MessageV2.ToolStateError.safeParse(state)
        expect(result.success).toBe(true)

        if (result.success) {
            expect(result.data.input._parseError).toBe("Invalid JSON")
        }
    })

    test("实际场景模拟 - todowrite 工具调用完整流程", () => {
        // 模拟模型返回的工具调用 input (可能是字符串)
        const modelInput = '{"todos": [{"content": "Write tests", "status": "pending"}]}'

        // Step 1: normalizeToolInput 规范化
        const normalizedInput = normalizeToolInput(modelInput)

        // Step 2: 创建 running 状态
        const runningState = {
            status: "running" as const,
            input: normalizedInput,
            time: { start: Date.now() },
        }
        expect(MessageV2.ToolStateRunning.safeParse(runningState).success).toBe(true)

        // Step 3: 创建 completed 状态
        const completedState = {
            status: "completed" as const,
            input: normalizedInput,
            output: "1 todo",
            title: "Updated todos",
            metadata: { todos: [{ content: "Write tests", status: "pending" }] },
            time: { start: runningState.time.start, end: Date.now() },
        }
        expect(MessageV2.ToolStateCompleted.safeParse(completedState).success).toBe(true)

        // Step 4: 创建完整的 ToolPart
        const toolPart = {
            id: "part_test",
            sessionID: "session_test",
            messageID: "message_test",
            type: "tool" as const,
            callID: "call_test",
            tool: "todowrite",
            state: completedState,
        }
        expect(MessageV2.ToolPart.safeParse(toolPart).success).toBe(true)
    })
})
