import crypto from "crypto"
import { serializeForTokenEstimate } from "@/runtime/context-budget"

export type PromptStability = "global" | "session" | "turn"

export type PromptSection = {
  id: string
  stability: PromptStability
  content: string
}

export type PromptSectionBundle = {
  globalSystem: string[]
  sessionSystem: string[]
  turnSystem: string[]
  system: string[]
  providerSystem: string[]
  globalHash: string
  sessionHash: string
  turnHash: string
}

function hash(value: unknown) {
  return crypto.createHash("sha256").update(serializeForTokenEstimate(value)).digest("hex")
}

export function assemblePromptSections(sections: readonly PromptSection[]): PromptSectionBundle {
  const globalSystem: string[] = []
  const sessionSystem: string[] = []
  const turnSystem: string[] = []

  for (const section of sections) {
    const content = section.content.trim()
    if (!content) continue
    if (section.stability === "global") globalSystem.push(content)
    else if (section.stability === "session") sessionSystem.push(content)
    else turnSystem.push(content)
  }

  const stableSystem = [...globalSystem, ...sessionSystem]
  const providerSystem = [
    globalSystem.length ? globalSystem.join("\n") : undefined,
    sessionSystem.length ? sessionSystem.join("\n") : undefined,
    ...turnSystem,
  ].filter((content): content is string => Boolean(content))

  return {
    globalSystem,
    sessionSystem,
    turnSystem,
    system: [...stableSystem, ...turnSystem],
    providerSystem,
    globalHash: hash(globalSystem),
    sessionHash: hash(sessionSystem),
    turnHash: hash(turnSystem),
  }
}
