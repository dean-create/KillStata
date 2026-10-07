import { ToolRegistry } from "@/tool/registry"
import type { ToolAvailabilityResolution } from "./types"

export type DeferredToolDescriptor = {
  toolID: string
  description: string
  reason: string
  enableWhen: string[]
  remoteSafe: boolean
  repairOnlyAllowed: boolean
}

export async function deferredToolDescriptors(
  resolution: ToolAvailabilityResolution,
): Promise<DeferredToolDescriptor[]> {
  const descriptors = await Promise.all(
    (resolution.exposurePlan?.deferredTools ?? []).map(async (entry) => {
    const implementation = await ToolRegistry.byID(entry.toolID)
    if (!implementation) return undefined
    const initialized = await implementation.init()
    return {
      ...entry,
      description: initialized.description,
    }
    }),
  )
  return descriptors.filter((item): item is DeferredToolDescriptor => item !== undefined)
}
