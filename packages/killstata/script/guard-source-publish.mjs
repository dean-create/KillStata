#!/usr/bin/env node

import fs from "fs"
import path from "path"
import process from "process"

const packageJsonPath = path.resolve(process.cwd(), "package.json")
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"))

const hasWorkspaceDependency = Object.values({
  ...(packageJson.dependencies ?? {}),
  ...(packageJson.devDependencies ?? {}),
  ...(packageJson.optionalDependencies ?? {}),
}).some((version) => typeof version === "string" && version.startsWith("workspace:"))

if (!hasWorkspaceDependency) {
  process.exit(0)
}

console.error(`
Refusing to publish the source package directly.

This package still contains workspace:* dependencies, so publishing from
packages/killstata would create an npm package that users cannot install.

Use the release package instead:
  bun run pack:publish:windows
  bun run publish:windows
`)

process.exit(1)
