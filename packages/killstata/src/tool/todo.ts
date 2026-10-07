import z from "zod"
import { Tool } from "./tool"
import { ToolModel } from "./model-contracts"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"
import { createToolDisplay } from "./analysis-display"

const TodoWriteItemInput = z.object({
  content: z.string().min(1).describe("任务的简短说明"),
  status: z.string().optional().describe("任务当前状态"),
  priority: z.string().optional().describe("任务优先级"),
  id: z.string().optional().describe("待办事项唯一标识"),
})

function normalizeTodoStatus(value?: string) {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "in_progress" || normalized === "completed" || normalized === "cancelled") {
    return normalized
  }
  return "pending"
}

function normalizeTodoPriority(value?: string) {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized
  }
  return "medium"
}

export function normalizeTodoItems(items: Array<z.infer<typeof TodoWriteItemInput>>) {
  return items.map((todo, index) => ({
    content: todo.content.trim(),
    status: normalizeTodoStatus(todo.status),
    priority: normalizeTodoPriority(todo.priority),
    id: todo.id?.trim() || `todo_${index + 1}`,
  }))
}

export function createTodoToolDisplay(summary: string) {
  return createToolDisplay({
    visibility: "internal_only",
    summary,
  })
}

export const TodoWriteTool = Tool.define("todowrite", Tool.Execution.session, ToolModel.forTool("todowrite"), {
  description: DESCRIPTION_WRITE,
  parameters: z.object({
    todos: z.array(TodoWriteItemInput).describe("更新后的内部任务清单"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "todowrite",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const todos = normalizeTodoItems(params.todos)
    await Todo.update({
      sessionID: ctx.sessionID,
      todos,
    })
    return {
      title: `${todos.filter((x) => x.status !== "completed").length} todos`,
      output: JSON.stringify(todos, null, 2),
      metadata: {
        todos,
        display: createTodoToolDisplay("todo list updated"),
      },
    }
  },
})

export const TodoReadTool = Tool.define("todoread", Tool.Execution.readOnly, ToolModel.forTool("todoread"), {
  description:
    "只读获取当前会话的内部任务清单，用于恢复复杂多步骤工作的真实进度。仅在已有清单且需要核对 pending/in_progress/completed/cancelled 状态时使用；不要为简单任务调用，不把清单状态当作工具执行证据或用户可见结论。",
  parameters: z.object({}),
  async execute(_params, ctx) {
    await ctx.ask({
      permission: "todoread",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const todos = await Todo.get(ctx.sessionID)
    return {
      title: `${todos.filter((x) => x.status !== "completed").length} todos`,
      metadata: {
        todos,
        display: createTodoToolDisplay("todo list loaded"),
      },
      output: JSON.stringify(todos, null, 2),
    }
  },
})
