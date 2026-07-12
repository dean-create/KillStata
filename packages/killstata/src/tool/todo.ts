import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"
import { createToolDisplay } from "./analysis-display"

const TodoWriteItemInput = z.object({
  content: z.string().min(1).describe("Brief description of the task"),
  status: z.string().optional().describe("Current status of the task"),
  priority: z.string().optional().describe("Priority level of the task"),
  id: z.string().optional().describe("Unique identifier for the todo item"),
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

export const TodoWriteTool = Tool.define("todowrite", {
  description: DESCRIPTION_WRITE,
  parameters: z.object({
    todos: z.array(TodoWriteItemInput).describe("The updated todo list"),
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

export const TodoReadTool = Tool.define("todoread", {
  description: "Use this tool to read your todo list",
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
