import type { RuntimeDiagnostics } from "../runtime-diagnostics"
import { parseRuntimeDiagnosticsReport } from "../runtime-diagnostics"
import type { CoreSessionClient } from "./client"

type CoreRuntimeClient = Pick<CoreSessionClient, "runtimeDiagnostics" | "installRuntimePackages">

export function createCoreRuntimeDiagnosticsAdapter(getCore: () => Promise<CoreRuntimeClient>): RuntimeDiagnostics {
  return {
    async inspect() {
      return parseRuntimeDiagnosticsReport(await (await getCore()).runtimeDiagnostics())
    },
    async installMissingPackages() {
      return parseRuntimeDiagnosticsReport(await (await getCore()).installRuntimePackages())
    },
  }
}
