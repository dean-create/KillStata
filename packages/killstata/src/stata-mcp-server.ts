import { runBundledStataMcpServer } from "./mcp/stata"

try {
  await runBundledStataMcpServer()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exitCode = 1
} finally {
  process.exit()
}
