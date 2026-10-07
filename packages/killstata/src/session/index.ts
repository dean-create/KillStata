// Stable public entry point for the Session namespace.
// The implementation lives in session-state.ts so prompt submodules can depend
// on it directly without importing this barrel back through session/prompt.
export * from "./session-state"
