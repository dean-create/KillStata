import type { NamedError } from "@killstata/util/error"
import { MessageV2 } from "./message-v2"

export namespace SessionRetry {
  export const RETRY_INITIAL_DELAY = 2000
  export const RETRY_BACKOFF_FACTOR = 2
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
  export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout

  function hasTransientDisconnect(message: string | undefined) {
    if (!message) return false
    const lower = message.toLowerCase()
    return (
      lower.includes("stream disconnected before completion") ||
      lower.includes("connection reset by server") ||
      (lower.includes("error sending request for url") &&
        (lower.includes("/responses/compact") || lower.includes("/backend-api/codex/responses")))
    )
  }

  function hasTransientCertificateError(message: string | undefined) {
    if (!message) return false
    const lower = message.toLowerCase()
    return (
      lower.includes("unknown certificate verification error") ||
      lower.includes("certificate verification error") ||
      lower.includes("certificate verification failed") ||
      lower.includes("unable to verify the first certificate") ||
      lower.includes("client network socket disconnected before secure tls connection was established") ||
      lower.includes("tls handshake") ||
      lower.includes("ssl handshake")
    )
  }

  function retryReasonFromMessage(message: string | undefined) {
    if (hasTransientDisconnect(message)) return "Provider stream disconnected"
    if (hasTransientCertificateError(message)) return "Provider TLS/certificate verification failed"
    return undefined
  }

  export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        clearTimeout(timeout)
        reject(new DOMException("Aborted", "AbortError"))
      }
      const timeout = setTimeout(
        () => {
          signal.removeEventListener("abort", abortHandler)
          resolve()
        },
        Math.min(ms, RETRY_MAX_DELAY),
      )
      signal.addEventListener("abort", abortHandler, { once: true })
    })
  }

  export function delay(attempt: number, error?: MessageV2.APIError) {
    if (error) {
      const headers = error.data.responseHeaders
      if (headers) {
        const retryAfterMs = headers["retry-after-ms"]
        if (retryAfterMs) {
          const parsedMs = Number.parseFloat(retryAfterMs)
          if (!Number.isNaN(parsedMs)) {
            return parsedMs
          }
        }

        const retryAfter = headers["retry-after"]
        if (retryAfter) {
          const parsedSeconds = Number.parseFloat(retryAfter)
          if (!Number.isNaN(parsedSeconds)) {
            // convert seconds to milliseconds
            return Math.ceil(parsedSeconds * 1000)
          }
          // Try parsing as HTTP date format
          const parsed = Date.parse(retryAfter) - Date.now()
          if (!Number.isNaN(parsed) && parsed > 0) {
            return Math.ceil(parsed)
          }
        }

        return RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
      }
    }

    return Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS)
  }

  export function retryable(error: ReturnType<NamedError["toObject"]>) {
    if (MessageV2.APIError.isInstance(error)) {
      const reason = retryReasonFromMessage(error.data.message)
      if (reason) return reason
      if (!error.data.isRetryable) return undefined
      return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
    }

    if (typeof error.data?.message === "string") {
      const reason = retryReasonFromMessage(error.data.message)
      if (reason) return reason
      try {
        const json = JSON.parse(error.data.message)
        if (json.type === "error" && json.error?.type === "too_many_requests") {
          return "Too Many Requests"
        }
        if (json.code.includes("exhausted") || json.code.includes("unavailable")) {
          return "Provider is overloaded"
        }
        if (json.type === "error" && json.error?.code?.includes("rate_limit")) {
          return "Rate Limited"
        }
        if (
          json.error?.message?.includes("no_kv_space") ||
          (json.type === "error" && json.error?.type === "server_error") ||
          !!json.error
        ) {
          return "Provider Server Error"
        }
      } catch {}
    }

    return undefined
  }
}
