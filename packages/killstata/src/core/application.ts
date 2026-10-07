import { Instance } from "../project/instance"
import { InstanceBootstrap } from "../project/bootstrap"
import { Server } from "../server/server"
import { GlobalBus } from "../bus/global"
import { Log } from "../util/log"
import { createRuntimeDiagnostics, type RuntimeDiagnosticsReport } from "../killstata/runtime-diagnostics"

export type CoreRuntimeDiagnostics = {
  inspect(): Promise<RuntimeDiagnosticsReport>
  install(): Promise<RuntimeDiagnosticsReport>
}

export type CoreApplicationOptions = {
  directory: string
  runtimeDiagnostics?: CoreRuntimeDiagnostics
}

export type CoreApplication = {
  directory: string
  fetch(request: Request): Promise<Response>
  runtimeDiagnostics?: CoreRuntimeDiagnostics
  dispose(): Promise<void>
}

function requestForDirectory(request: Request, directory: string) {
  const headers = new Headers(request.headers)
  headers.set("x-killstata-directory", directory)
  return new Request(request, { headers })
}

/**
 * Core 的进程内应用边界。
 *
 * CLI、TUI Worker 和 Desktop host 都通过这个门面启动同一套 Instance/Harness。
 * 这里不解析命令行参数，也不负责选择传输方式；transport 只需要把请求交给
 * `fetch`，这样 HTTP、Worker/RPC 和 CLI in-process 不会各自复制业务状态机。
 */
export namespace CoreApplication {
  const log = Log.create({ service: "core.application" })

  export async function create(options: CoreApplicationOptions): Promise<CoreApplication> {
    let disposed = false
    const runtimeDiagnostics = options.runtimeDiagnostics ?? createRuntimeDiagnostics()

    await Instance.provide({
      directory: options.directory,
      init: InstanceBootstrap,
      fn: async () => undefined,
    })

    return {
      directory: options.directory,
      runtimeDiagnostics: {
        inspect: async () => await Instance.provide({
          directory: options.directory,
          init: InstanceBootstrap,
          fn: runtimeDiagnostics.inspect,
        }),
        install: async () => await Instance.provide({
          directory: options.directory,
          init: InstanceBootstrap,
          fn: runtimeDiagnostics.install,
        }),
      },
      async fetch(request) {
        if (disposed) return Promise.reject(new Error("KillStata Core application 已经释放"))
        return Instance.provide({
          directory: options.directory,
          init: InstanceBootstrap,
          fn: async () => Server.App().fetch(requestForDirectory(request, options.directory)),
        })
      },
      async dispose() {
        if (disposed) return
        disposed = true
        await Instance.provide({
          directory: options.directory,
          init: InstanceBootstrap,
          fn: () => Instance.dispose(),
        })
      },
    }
  }

  /**
   * 供 host 进程转发全局事件；事件仍由 Core Bus 产生，入口不重新解释事件语义。
   */
  export function onEvent(handler: (event: unknown) => void) {
    GlobalBus.on("event", handler)
    return () => GlobalBus.off("event", handler)
  }

  export function logError(error: unknown) {
    log.error("core application failed", { error })
  }
}
