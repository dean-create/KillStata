import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { ToolModel } from "./model-contracts"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileTime } from "../file/time"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { displayPath } from "./analysis-display"

export const WriteTool = Tool.define("write", Tool.Execution.protectedFilesystem, ToolModel.forTool("write"), {
  description: DESCRIPTION,
  parameters: z.object({
    content: z.string().describe("要写入文件的内容"),
    filePath: z.string().describe("要写入的文件绝对路径，不能使用相对路径"),
  }),
  async execute(params, ctx) {
    const filepath = path.isAbsolute(params.filePath) ? params.filePath : path.join(Instance.directory, params.filePath)
    await assertExternalDirectory(ctx, filepath)

    const file = Bun.file(filepath)
    const exists = await file.exists()
    if (exists) await FileTime.assert(ctx.sessionID, filepath)

    await ctx.ask({
      permission: "edit",
      patterns: [path.relative(Instance.worktree, filepath)],
      always: ["*"],
      metadata: { filepath },
    })

    await Bun.write(filepath, params.content)
    await Bus.publish(File.Event.Edited, {
      file: filepath,
    })
    FileTime.read(ctx.sessionID, filepath)

    // 过去这里会拉起语言服务器扫描刚写的文件，把 "LSP errors detected, please fix" 拼进
    // 输出——那是"你是程序员"的假设。计量用户写的是 do-file / 报告 / 数据脚本，不需要
    // 一个 TypeScript 语言服务器对着他们的 .py 指手画脚。
    const output = "Wrote file successfully."

    return {
      title: displayPath(path.relative(Instance.worktree, filepath)),
      metadata: {
        filepath,
        exists: exists,
      },
      output,
    }
  },
})
