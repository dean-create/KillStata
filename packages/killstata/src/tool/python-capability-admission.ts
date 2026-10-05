import type { UnifiedToolDescriptor, UnifiedToolEffect } from "./tool-descriptor"

export type PythonCapabilityAdmission = {
  maximum_permission: UnifiedToolEffect
  allow_destructive?: boolean
}

const EFFECT_RANK: Record<UnifiedToolEffect, number> = {
  read_only: 0,
  writes_state: 1,
  writes_files: 2,
  external: 3,
}

/**
 * Python Registry 只能声明能力，不能自行扩大 Harness 的权限。
 * Schema 和其它描述字段原样保留；这里仅做安全边界校验。
 */
export function validateCapabilityAdmission(input: {
  descriptor: UnifiedToolDescriptor
  admission: PythonCapabilityAdmission
}) {
  const actual = EFFECT_RANK[input.descriptor.permission.effect]
  const maximum = EFFECT_RANK[input.admission.maximum_permission]
  if (actual > maximum) {
    throw new Error(
      `能力权限契约不一致：${input.descriptor.tool_id} 声明为 ${input.descriptor.permission.effect}，` +
      `超过 Harness allowlist 的 ${input.admission.maximum_permission}。`,
    )
  }
  if (input.descriptor.permission.destructive && input.admission.allow_destructive !== true) {
    throw new Error(`能力权限契约不一致：${input.descriptor.tool_id} 声明为破坏性操作，但当前 allowlist 未允许。`)
  }
  return input.descriptor
}
