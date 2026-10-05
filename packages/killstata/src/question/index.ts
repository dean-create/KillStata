import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import z from "zod"

export namespace Question {
  const log = Log.create({ service: "question" })

  export const Option = z
    .object({
      label: z.string().max(30).describe("选项显示文字，简短清晰"),
      description: z.string().describe("说明该选项的含义或影响"),
    })
    .meta({
      ref: "QuestionOption",
    })
  export type Option = z.infer<typeof Option>

  export const Info = z
    .object({
      question: z.string().describe("完整、明确的问题"),
      header: z.string().max(30).describe("不超过 30 字的简短标签"),
      options: z.array(Option).describe("可选择的答案"),
      multiple: z.boolean().optional().describe("是否允许多选"),
      custom: z.boolean().optional().describe("是否允许用户填写自定义答案，默认允许"),
    })
    .meta({
      ref: "QuestionInfo",
    })
  export type Info = z.infer<typeof Info>

  export const Request = z
    .object({
      id: Identifier.schema("question"),
      sessionID: Identifier.schema("session"),
      questions: z.array(Info).describe("需要向用户提出的问题"),
      tool: z
        .object({
          messageID: z.string(),
          callID: z.string(),
        })
        .optional(),
    })
    .meta({
      ref: "QuestionRequest",
    })
  export type Request = z.infer<typeof Request>

  export const Answer = z.array(z.string()).meta({
    ref: "QuestionAnswer",
  })
  export type Answer = z.infer<typeof Answer>

  export const Reply = z.object({
    answers: z
      .array(Answer)
      .describe("按问题顺序返回的用户答案；每个答案是已选标签的数组"),
  })
  export type Reply = z.infer<typeof Reply>

  export const Event = {
    Asked: BusEvent.define("question.asked", Request),
    Replied: BusEvent.define(
      "question.replied",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
        answers: z.array(Answer),
      }),
    ),
    Rejected: BusEvent.define(
      "question.rejected",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
      }),
    ),
  }

  const state = Instance.state(async () => {
    const pending: Record<
      string,
      {
        info: Request
        resolve: (answers: Answer[]) => void
        reject: (e: any) => void
      }
    > = {}

    return {
      pending,
    }
  })

  export async function ask(input: {
    sessionID: string
    questions: Info[]
    tool?: { messageID: string; callID: string }
  }): Promise<Answer[]> {
    const issues = collectLabelIssues(input.questions)
    if (issues.length) {
      throw new Error(
        `question tool 参数不合法：${issues.join("；")}。label 必须 ≤30 字符，header 也必须 ≤30 字符；超出会被 TUI 拒收。`,
      )
    }
    const s = await state()
    const id = Identifier.ascending("question")

    log.info("asking", { id, questions: input.questions.length })

    return new Promise<Answer[]>((resolve, reject) => {
      const info: Request = {
        id,
        sessionID: input.sessionID,
        questions: input.questions,
        tool: input.tool,
      }
      s.pending[id] = {
        info,
        resolve,
        reject,
      }
      Bus.publish(Event.Asked, info)
    })
  }

  /** 提前拦截超长 label/header：让模型在拿到错误时知道是字符数问题，避免无效重试。 */
  function collectLabelIssues(questions: Info[]) {
    const issues: string[] = []
    questions.forEach((q, qi) => {
      if (q.header && q.header.length > 30) {
        issues.push(`第 ${qi + 1} 题 header "${q.header}" 长 ${q.header.length}，超过 30`)
      }
      q.options?.forEach((opt, oi) => {
        if (opt.label && opt.label.length > 30) {
          issues.push(`第 ${qi + 1} 题第 ${oi + 1} 项 label "${opt.label}" 长 ${opt.label.length}，超过 30`)
        }
      })
    })
    return issues
  }

  export async function reply(input: { requestID: string; answers: Answer[] }): Promise<void> {
    const s = await state()
    const existing = s.pending[input.requestID]
    if (!existing) {
      log.warn("reply for unknown request", { requestID: input.requestID })
      return
    }
    delete s.pending[input.requestID]

    log.info("replied", { requestID: input.requestID, answers: input.answers })

    Bus.publish(Event.Replied, {
      sessionID: existing.info.sessionID,
      requestID: existing.info.id,
      answers: input.answers,
    })

    existing.resolve(input.answers)
  }

  export async function reject(requestID: string): Promise<void> {
    const s = await state()
    const existing = s.pending[requestID]
    if (!existing) {
      log.warn("reject for unknown request", { requestID })
      return
    }
    delete s.pending[requestID]

    log.info("rejected", { requestID })

    Bus.publish(Event.Rejected, {
      sessionID: existing.info.sessionID,
      requestID: existing.info.id,
    })

    existing.reject(new RejectedError())
  }

  export class RejectedError extends Error {
    constructor() {
      super("The user dismissed this question")
    }
  }

  export async function list() {
    return state().then((x) => Object.values(x.pending).map((x) => x.info))
  }
}
