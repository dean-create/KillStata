import { cmd } from "./cmd"
import { Instance } from "../../project/instance"
import { runKillstataConfigWizard } from "./config"
import * as prompts from "@clack/prompts"

export const InitCommand = cmd({
  command: "init",
  describe: "launch the guided killstata setup wizard",
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        prompts.log.warn("`killstata init` now delegates to `killstata config`.")
        await runKillstataConfigWizard({
          intro: "killstata init",
        })
      },
    })
  },
})
