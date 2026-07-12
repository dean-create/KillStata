#!/usr/bin/env bun

import { Script } from "@killstata/script"
import { $ } from "bun"

if (!Script.preview) {
  await $`gh release edit v${Script.version} --draft=false`
}

await $`bun install`

await $`gh release download --pattern "killstata-linux-*64.tar.gz" --pattern "killstata-darwin-*64.zip" -D dist`

await import(`../packages/killstata/script/publish-registries.ts`)
