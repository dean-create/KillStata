import fallbackSnapshot from "./models-fallback.snapshot.json" with { type: "json" }

export function fallbackProviders() {
  return fallbackSnapshot as Record<
    string,
    {
      id: string
      name: string
      env: string[]
      api?: string
      npm?: string
      models: Record<string, any>
    }
  >
}
