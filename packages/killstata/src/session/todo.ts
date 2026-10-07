import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { Storage } from "../storage/storage"

export namespace Todo {
  export const Info = z
    .object({
      content: z.string().describe("任务的简短说明"),
      status: z.string().describe("任务状态：pending、in_progress、completed 或 cancelled"),
      priority: z.string().describe("优先级：high、medium 或 low"),
      id: z.string().describe("待办事项的唯一标识"),
    })
    .meta({ ref: "Todo" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "todo.updated",
      z.object({
        sessionID: z.string(),
        todos: z.array(Info),
      }),
    ),
  }

  export async function update(input: { sessionID: string; todos: Info[] }) {
    await Storage.write(["todo", input.sessionID], input.todos)
    Bus.publish(Event.Updated, input)
  }

  export async function get(sessionID: string) {
    return Storage.read<Info[]>(["todo", sessionID])
      .then((x) => x || [])
      .catch(() => [])
  }
}
