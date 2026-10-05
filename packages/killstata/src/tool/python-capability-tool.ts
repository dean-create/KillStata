import type { Tool } from "./tool"
import { descriptorForPythonTool, type UnifiedToolDescriptor } from "./tool-descriptor"
import { validateCapabilityAdmission } from "./python-capability-admission"

export type PythonCapabilityReference = {
  toolID: string
  modelNamespace: Tool.ModelNamespace
  description: string
  inputSchema: Record<string, unknown>
  descriptor: UnifiedToolDescriptor
}

function maximumPermissionFor(descriptor: UnifiedToolDescriptor) {
  if (descriptor.category === "diagnostic") return "read_only" as const
  if (descriptor.category === "data") return "writes_state" as const
  return "writes_files" as const
}

/** Python Registry → TS Harness 的唯一内部引用适配器。 */
export function pythonCapabilityReference(
  value: unknown,
  modelNamespace: Tool.ModelNamespace,
): PythonCapabilityReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const descriptor = descriptorForPythonTool(value)
  validateCapabilityAdmission({
    descriptor,
    admission: { maximum_permission: maximumPermissionFor(descriptor) },
  })
  return {
    toolID: descriptor.tool_id,
    modelNamespace,
    description: descriptor.description,
    inputSchema: descriptor.input_schema,
    descriptor,
  }
}
