import type { Argv } from "yargs"
import path from "path"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { Flag } from "../../flag/flag"
import { bootstrap } from "../bootstrap"
import { Command } from "../../command"
import { EOL } from "os"
import { select } from "@clack/prompts"
import { createKillstataClient, type KillstataClient } from "@killstata/sdk/v2"
import { Server } from "../../server/server"
import { Provider } from "../../provider/provider"
import { Agent } from "../../agent/agent"
import { decideNonInteractivePermission, decideNonInteractiveQuestion, shouldAutoHandleRunPermissions } from "./run-permission"
import { readToolDisplay } from "../../tool/analysis-display"

const TOOL: Record<string, [string, string]> = {
  todowrite: ["Todo", UI.Style.TEXT_WARNING_BOLD],
  todoread: ["Todo", UI.Style.TEXT_WARNING_BOLD],
  bash: ["Bash", UI.Style.TEXT_DANGER_BOLD],
  shell: ["Shell", UI.Style.TEXT_DANGER_BOLD],
  edit: ["Edit", UI.Style.TEXT_SUCCESS_BOLD],
  glob: ["Glob", UI.Style.TEXT_INFO_BOLD],
  grep: ["Grep", UI.Style.TEXT_INFO_BOLD],
  list: ["List", UI.Style.TEXT_INFO_BOLD],
  read: ["Read", UI.Style.TEXT_HIGHLIGHT_BOLD],
  write: ["Write", UI.Style.TEXT_SUCCESS_BOLD],
  websearch: ["Search", UI.Style.TEXT_DIM_BOLD],
}

const DEFAULT_HIDDEN_TOOLS = new Set(["glob", "read", "workflow", "skill", "invalid", "task", "todowrite", "todoread"])

function inferProjectRoot(workspaceRoot: string, processRoot: string) {
  const normalizedWorkspace = path.resolve(workspaceRoot)
  const marker = `${path.sep}modelpctest${path.sep}`
  const markerIndex = normalizedWorkspace.toLowerCase().indexOf(marker.toLowerCase())
  if (markerIndex > 0) {
    return normalizedWorkspace.slice(0, markerIndex)
  }

  const normalizedProcessRoot = path.resolve(processRoot)
  if (
    path.basename(normalizedProcessRoot).toLowerCase() === "killstata" &&
    path.basename(path.dirname(normalizedProcessRoot)).toLowerCase() === "packages"
  ) {
    return path.resolve(normalizedProcessRoot, "../../..")
  }

  return path.resolve(normalizedProcessRoot, "..")
}

export const RunCommand = cmd({
  command: "run [message..]",
  describe: "run killstata with a message",
  builder: (yargs: Argv) => {
    return yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("share", {
        type: "boolean",
        describe: "share the session",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running killstata server (e.g., http://localhost:4096)",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
      .option("cwd", {
        type: "string",
        describe: "workspace directory to run the session in",
      })
  },
  handler: async (args) => {
    const effectiveCwd = args.cwd ? path.resolve(process.cwd(), args.cwd) : process.cwd()
    const projectRootHint = inferProjectRoot(effectiveCwd, process.cwd())
    const autoHandlePermissions = shouldAutoHandleRunPermissions({
      format: args.format as "default" | "json",
      stdinIsTTY: Boolean(process.stdin.isTTY),
      stdoutIsTTY: Boolean(process.stdout.isTTY),
    })
    let message = [...args.message, ...(args["--"] || [])]
      .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
      .join(" ")

    const fileParts: any[] = []
    if (args.file) {
      const files = Array.isArray(args.file) ? args.file : [args.file]

      for (const filePath of files) {
        const resolvedPath = path.resolve(effectiveCwd, filePath)
        const file = Bun.file(resolvedPath)
        const stats = await file.stat().catch(() => {})
        if (!stats) {
          UI.error(`File not found: ${filePath}`)
          process.exit(1)
        }
        if (!(await file.exists())) {
          UI.error(`File not found: ${filePath}`)
          process.exit(1)
        }

        const stat = await file.stat()
        const mime = stat.isDirectory() ? "application/x-directory" : "text/plain"

        fileParts.push({
          type: "file",
          url: `file://${resolvedPath}`,
          filename: path.basename(resolvedPath),
          mime,
        })
      }
    }

    if (!process.stdin.isTTY) message += "\n" + (await Bun.stdin.text())

    if (message.trim().length === 0 && !args.command) {
      UI.error("You must provide a message or a command")
      process.exit(1)
    }

    const execute = async (sdk: KillstataClient, sessionID: string) => {
      let finalText: string | undefined
      let lastToolSignature: string | undefined
      const eventsAbort = new AbortController()

      const printEvent = (color: string, type: string, title: string) => {
        UI.println(
          color + `|`,
          UI.Style.TEXT_NORMAL + UI.Style.TEXT_DIM + ` ${type.padEnd(7, " ")}`,
          "",
          UI.Style.TEXT_NORMAL + title,
        )
      }

      const outputJsonEvent = (type: string, data: any) => {
        if (args.format === "json") {
          process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID, ...data }) + EOL)
          return true
        }
        return false
      }

      const shouldPrintTool = (part: any) => {
        const display = readToolDisplay(part.state?.metadata)
        if (display?.visibility === "internal_only" || display?.visibility === "user_collapsed") return false
        if (DEFAULT_HIDDEN_TOOLS.has(part.tool)) return false
        return true
      }

      const toolTitle = (part: any) => {
        const display = readToolDisplay(part.state?.metadata)
        if (display?.summary) return display.summary
        return part.state.title || (Object.keys(part.state.input).length > 0 ? JSON.stringify(part.state.input) : "Unknown")
      }

      const events = await sdk.event.subscribe(undefined, {
        signal: eventsAbort.signal,
      })
      let errorMsg: string | undefined

      const eventProcessor = (async () => {
        for await (const event of events.stream) {
          const rawEvent = event as any
          if (rawEvent.type === "runtime.workflow.state" && rawEvent.properties?.sessionID === sessionID) {
            if (outputJsonEvent("runtime.workflow.state", { properties: rawEvent.properties })) continue
          }

          if (event.type === "message.part.updated") {
            const part = event.properties.part
            if (part.sessionID !== sessionID) continue

            if (part.type === "tool" && part.state.status === "completed") {
              if (outputJsonEvent("tool_use", { part })) continue
              if (!shouldPrintTool(part)) continue
              const [tool, color] = TOOL[part.tool] ?? [part.tool, UI.Style.TEXT_INFO_BOLD]
              const title = toolTitle(part)
              const signature = `${part.tool}:${title}`
              if (signature === lastToolSignature) continue
              lastToolSignature = signature
              printEvent(color, tool, title)
              if ((part.tool === "bash" || part.tool === "shell") && part.state.output?.trim()) {
                UI.println()
                UI.println(part.state.output)
              }
            }

            if (part.type === "step-start") {
              if (outputJsonEvent("step_start", { part })) continue
            }

            if (part.type === "step-finish") {
              if (outputJsonEvent("step_finish", { part })) continue
            }

            if (part.type === "text" && part.time?.end) {
              if (outputJsonEvent("text", { part })) continue
              finalText = part.text
            }
          }

          if (event.type === "session.error") {
            const props = event.properties
            if (props.sessionID !== sessionID || !props.error) continue
            let err = String(props.error.name)
            if ("data" in props.error && props.error.data && "message" in props.error.data) {
              err = String(props.error.data.message)
            }
            errorMsg = errorMsg ? errorMsg + EOL + err : err
            if (outputJsonEvent("error", { error: props.error })) continue
            UI.error(err)
          }

          if (event.type === "session.idle" && event.properties.sessionID === sessionID) {
            if (args.format === "default" && finalText?.trim()) {
              const isPiped = !process.stdout.isTTY
              if (!isPiped) UI.println()
              process.stdout.write((isPiped ? finalText : UI.markdown(finalText)) + EOL)
              if (!isPiped) UI.println()
            }
            eventsAbort.abort()
            break
          }

          if (event.type === "permission.asked") {
            const permission = event.properties
            if (permission.sessionID !== sessionID) continue
            if (autoHandlePermissions) {
              const decision = decideNonInteractivePermission({
                workspaceRoot: effectiveCwd,
                projectRoot: projectRootHint,
                request: {
                  permission: permission.permission,
                  patterns: permission.patterns,
                  metadata: permission.metadata,
                },
              })
              if (
                outputJsonEvent(decision.response === "reject" ? "permission_auto_rejected" : "permission_auto_allowed", {
                  permission,
                  decision,
                })
              ) {
                await sdk.permission.respond({
                  sessionID,
                  permissionID: permission.id,
                  response: decision.response,
                })
                continue
              }
              if (decision.response === "reject") {
                UI.println(
                  UI.Style.TEXT_WARNING_BOLD + "!",
                  UI.Style.TEXT_NORMAL,
                  `${decision.reason}: ${permission.permission} (${permission.patterns.join(", ")}) -> ${decision.response}`,
                )
              }
              await sdk.permission.respond({
                sessionID,
                permissionID: permission.id,
                response: decision.response,
              })
              continue
            }
            const result = await select({
              message: `Permission required: ${permission.permission} (${permission.patterns.join(", ")})`,
              options: [
                { value: "once", label: "Allow once" },
                { value: "always", label: "Always allow: " + permission.always.join(", ") },
                { value: "reject", label: "Reject" },
              ],
              initialValue: "once",
            }).catch(() => "reject")
            const response = (result.toString().includes("cancel") ? "reject" : result) as "once" | "always" | "reject"
            await sdk.permission.respond({
              sessionID,
              permissionID: permission.id,
              response,
            })
          }

          if (event.type === "question.asked") {
            const question = event.properties
            if (question.sessionID !== sessionID) continue
            if (autoHandlePermissions) {
              const decision = decideNonInteractiveQuestion({
                workspaceRoot: effectiveCwd,
                projectRoot: projectRootHint,
                request: {
                  questions: question.questions.map((item) => ({
                    header: item.header,
                    question: item.question,
                  })),
                },
              })
              if (decision.action === "reply" && decision.answers) {
                if (outputJsonEvent("question_auto_replied", { question, decision })) {
                  await sdk.question.reply({
                    requestID: question.id,
                    answers: decision.answers,
                  })
                  continue
                }
                await sdk.question.reply({
                  requestID: question.id,
                  answers: decision.answers,
                })
                continue
              }
              if (outputJsonEvent("question_auto_rejected", { question, decision })) {
                await sdk.question.reject({
                  requestID: question.id,
                })
                continue
              }
              UI.println(
                UI.Style.TEXT_WARNING_BOLD + "!",
                UI.Style.TEXT_NORMAL,
                `${decision.reason}: auto-rejecting question request ${question.id}`,
              )
              await sdk.question.reject({
                requestID: question.id,
              })
              continue
            }
            await sdk.question.reject({
              requestID: question.id,
            })
            if (outputJsonEvent("question_rejected", { question })) continue
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL,
              `auto-rejecting question request ${question.id}`,
            )
          }
        }
      })()

      // Validate agent if specified
      const resolvedAgent = await (async () => {
        if (!args.agent) return undefined
        const agent = await Agent.get(args.agent)
        if (!agent) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${args.agent}" not found. Falling back to default agent`,
          )
          return undefined
        }
        if (agent.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${args.agent}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }
        return args.agent
      })()

      if (args.command) {
        await sdk.session.command({
          sessionID,
          agent: resolvedAgent,
          model: args.model,
          command: args.command,
          arguments: message,
          variant: args.variant,
        })
      } else {
        const modelParam = args.model ? Provider.parseModel(args.model) : undefined
        await sdk.session.promptAsync({
          sessionID,
          agent: resolvedAgent,
          model: modelParam,
          variant: args.variant,
          parts: [...fileParts, { type: "text", text: message }],
        })
      }

      await eventProcessor.finally(() => {
        eventsAbort.abort()
      })
      return errorMsg ? 1 : 0
    }

    if (args.attach) {
      const attachFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const headers = new Headers(request.headers)
        headers.set("x-killstata-directory", effectiveCwd)
        return fetch(request, {
          ...init,
          headers,
        })
      }) as typeof globalThis.fetch
      const sdk = createKillstataClient({ baseUrl: args.attach, fetch: attachFetch })

      const sessionID = await (async () => {
        if (args.continue) {
          const result = await sdk.session.list()
          return result.data?.find((s) => !s.parentID)?.id
        }
        if (args.session) return args.session

        const title =
          args.title !== undefined
            ? args.title === ""
              ? message.slice(0, 50) + (message.length > 50 ? "..." : "")
              : args.title
            : undefined

        const result = await sdk.session.create(
          title
            ? {
                title,
                permission: [
                  {
                    permission: "question",
                    action: "deny",
                    pattern: "*",
                  },
                ],
              }
            : {
                permission: [
                  {
                    permission: "question",
                    action: "deny",
                    pattern: "*",
                  },
                ],
              },
        )
        return result.data?.id
      })()

      if (!sessionID) {
        UI.error("Session not found")
        process.exit(1)
      }

      const cfgResult = await sdk.config.get()
      if (cfgResult.data && (cfgResult.data.share === "auto" || Flag.KILLSTATA_AUTO_SHARE || args.share)) {
        const shareResult = await sdk.session.share({ sessionID }).catch((error) => {
          if (error instanceof Error && error.message.includes("disabled")) {
            UI.println(UI.Style.TEXT_DANGER_BOLD + "!  " + error.message)
          }
          return { error }
        })
        if (!shareResult.error && "data" in shareResult && shareResult.data?.share?.url) {
          UI.println(UI.Style.TEXT_INFO_BOLD + "~  " + shareResult.data.share.url)
        }
      }

      const exitCode = await execute(sdk, sessionID)
      process.exit(exitCode)
    }

    await bootstrap(effectiveCwd, async () => {
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const headers = new Headers(request.headers)
        headers.set("x-killstata-directory", effectiveCwd)
        return Server.App().fetch(
          new Request(request, {
            headers,
          }),
        )
      }) as typeof globalThis.fetch
      const sdk = createKillstataClient({ baseUrl: "http://killstata.internal", fetch: fetchFn })

      if (args.command) {
        const exists = await Command.get(args.command)
        if (!exists) {
          UI.error(`Command "${args.command}" not found`)
          process.exit(1)
        }
      }

      const sessionID = await (async () => {
        if (args.continue) {
          const result = await sdk.session.list()
          return result.data?.find((s) => !s.parentID)?.id
        }
        if (args.session) return args.session

        const title =
          args.title !== undefined
            ? args.title === ""
              ? message.slice(0, 50) + (message.length > 50 ? "..." : "")
              : args.title
            : undefined

        const result = await sdk.session.create(
          title
            ? {
                title,
                permission: [
                  {
                    permission: "question",
                    action: "deny",
                    pattern: "*",
                  },
                ],
              }
            : {
                permission: [
                  {
                    permission: "question",
                    action: "deny",
                    pattern: "*",
                  },
                ],
              },
        )
        return result.data?.id
      })()

      if (!sessionID) {
        UI.error("Session not found")
        process.exit(1)
      }

      const cfgResult = await sdk.config.get()
      if (cfgResult.data && (cfgResult.data.share === "auto" || Flag.KILLSTATA_AUTO_SHARE || args.share)) {
        const shareResult = await sdk.session.share({ sessionID }).catch((error) => {
          if (error instanceof Error && error.message.includes("disabled")) {
            UI.println(UI.Style.TEXT_DANGER_BOLD + "!  " + error.message)
          }
          return { error }
        })
        if (!shareResult.error && "data" in shareResult && shareResult.data?.share?.url) {
          UI.println(UI.Style.TEXT_INFO_BOLD + "~  " + shareResult.data.share.url)
        }
      }

      const exitCode = await execute(sdk, sessionID)
      process.exit(exitCode)
    })
  },
})
