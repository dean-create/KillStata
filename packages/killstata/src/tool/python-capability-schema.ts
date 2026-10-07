import z from "zod"

/**
 * TS Python-capability wrappers validate only the transport envelope here.
 * Method fields, enums and cross-field rules come from Python Registry Pydantic.
 */
export function pythonCapabilityInput<RuntimeArguments extends Record<string, any>>() {
  return z.record(z.string(), z.unknown()).transform((value) => value as RuntimeArguments)
}
