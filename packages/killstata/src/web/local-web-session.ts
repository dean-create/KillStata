import { randomBytes, timingSafeEqual } from "node:crypto"

export const LOCAL_WEB_COOKIE_NAME = "killstata_web"
export const LOCAL_WEB_LAUNCH_TOKEN_LIFETIME_MS = 60_000
export const LOCAL_WEB_SESSION_LIFETIME_SECONDS = 12 * 60 * 60
export const LOCAL_WEB_SHARE_TOKEN_LIFETIME_MS = 60 * 60 * 1_000
export const LOCAL_WEB_SHARE_SESSION_LIFETIME_SECONDS = 8 * 60 * 60

type LocalWebSessionOptions = {
  share?: boolean
  now?: () => number
  launchTokenLifetimeMs?: number
  sessionLifetimeSeconds?: number
}

function randomToken() {
  return randomBytes(32).toString("base64url")
}

function equalSecret(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function cookieValues(header: string | null, name: string) {
  if (!header) return []
  return header.split(";").flatMap((part) => {
    const separator = part.indexOf("=")
    if (separator < 0 || part.slice(0, separator).trim() !== name) return []
    return [part.slice(separator + 1).trim()]
  })
}

function sessionFromCookie(header: string | null, sessions: Map<string, { expiresAt: number; share: boolean }>) {
  const values = cookieValues(header, LOCAL_WEB_COOKIE_NAME)
  if (values.length !== 1) return undefined
  for (const [token, session] of sessions) {
    if (equalSecret(values[0]!, token)) return session
  }
  return undefined
}

export function createLocalWebSession(options: LocalWebSessionOptions = {}) {
  const now = options.now ?? Date.now
  const share = options.share === true
  const launchTokenLifetimeMs = options.launchTokenLifetimeMs ?? (share
    ? LOCAL_WEB_SHARE_TOKEN_LIFETIME_MS
    : LOCAL_WEB_LAUNCH_TOKEN_LIFETIME_MS)
  const sessionLifetimeSeconds = options.sessionLifetimeSeconds ?? (share
    ? LOCAL_WEB_SHARE_SESSION_LIFETIME_SECONDS
    : LOCAL_WEB_SESSION_LIFETIME_SECONDS)
  const launchToken = randomToken()
  const shareToken = share ? randomToken() : undefined
  const launchExpiresAt = now() + launchTokenLifetimeMs
  let launchTokenUsed = false
  let shareSessionToken: string | undefined
  const sessions = new Map<string, { expiresAt: number; share: boolean }>()

  return {
    launchToken,
    shareToken,

    exchangeLaunchToken(candidate: string, shared = false) {
      const expectedToken = shared ? shareToken : launchToken
      if (typeof candidate !== "string" || !expectedToken || now() >= launchExpiresAt || !equalSecret(candidate, expectedToken)) return undefined
      if (shared) {
        shareSessionToken ??= randomToken()
        sessions.set(shareSessionToken, { expiresAt: now() + sessionLifetimeSeconds * 1_000, share: true })
        return shareSessionToken
      }
      if (launchTokenUsed) return undefined
      launchTokenUsed = true
      const sessionToken = randomToken()
      sessions.set(sessionToken, { expiresAt: now() + sessionLifetimeSeconds * 1_000, share: false })
      return sessionToken
    },

    authenticateCookieHeader(header: string | null) {
      const session = sessionFromCookie(header, sessions)
      return Boolean(session && now() < session.expiresAt)
    },

    isShareCookieHeader(header: string | null) {
      const session = sessionFromCookie(header, sessions)
      return Boolean(session?.share && now() < session.expiresAt)
    },

    setCookieHeader(value: string) {
      const session = sessions.get(value)
      if (!session || now() >= session.expiresAt) throw new Error("本地 Web 会话凭据无效")
      return `${LOCAL_WEB_COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetimeSeconds}`
    },
  }
}
