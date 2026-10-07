import z from "zod"
import { Tool } from "./tool"
import { ToolModel } from "./model-contracts"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

export const QuestionTool = Tool.define("question", Tool.Execution.interactive, ToolModel.forTool("question"), {
  description: DESCRIPTION,
  parameters: z.object({
    questions: z.array(Question.Info.omit({ custom: true })).describe("要向用户提出的问题"),
  }),
  async execute(params, ctx) {
    const answers = await Question.ask({
      sessionID: ctx.sessionID,
      questions: params.questions,
      tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
    })

    function format(answer: Question.Answer | undefined) {
      if (!answer?.length) return "未回答"
      return answer.join(", ")
    }

    const formatted = params.questions.map((q, i) => `"${q.question}"="${format(answers[i])}"`).join(", ")

    return {
      title: `已提问 ${params.questions.length} 项`,
      output: `用户回答如下：${formatted}。请严格按这些回答的范围继续执行。`,
      metadata: {
        answers,
      },
    }
  },
})
