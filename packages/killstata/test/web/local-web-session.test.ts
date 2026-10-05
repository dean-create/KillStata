import { describe, expect, test } from "bun:test"
import { createLocalWebSession } from "../../src/web/local-web-session"

describe("local Web browser session", () => {
  test("exchanges a one-use launch token for an HttpOnly SameSite cookie", () => {
    const session = createLocalWebSession()

    expect(session.launchToken).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    const cookie = session.exchangeLaunchToken(session.launchToken)
    if (!cookie) throw new Error("valid launch token should create a browser cookie")

    expect(cookie).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(session.setCookieHeader(cookie)).toContain("HttpOnly")
    expect(session.setCookieHeader(cookie)).toContain("SameSite=Strict")
    expect(session.setCookieHeader(cookie)).toContain("Path=/")
    expect(session.exchangeLaunchToken(session.launchToken)).toBeUndefined()
  })

  test("rejects a wrong launch token without consuming the correct one", () => {
    const session = createLocalWebSession()

    expect(session.exchangeLaunchToken("attacker-token")).toBeUndefined()
    expect(typeof session.exchangeLaunchToken(session.launchToken)).toBe("string")
  })

  test("authenticates only one exact cookie value and fails closed on duplicates", () => {
    const session = createLocalWebSession()
    const cookie = session.exchangeLaunchToken(session.launchToken)!

    expect(session.authenticateCookieHeader(`theme=dark; killstata_web=${cookie}`)).toBe(true)
    expect(session.authenticateCookieHeader(`killstata_web=${cookie}x`)).toBe(false)
    expect(session.authenticateCookieHeader(`killstata_web=${cookie}; killstata_web=${cookie}`)).toBe(false)
    expect(session.authenticateCookieHeader(null)).toBe(false)
  })

  test("expires the launch token after its short exchange window", () => {
    let now = 10_000
    const session = createLocalWebSession({ now: () => now, launchTokenLifetimeMs: 1_000 })
    now += 1_001

    expect(session.exchangeLaunchToken(session.launchToken)).toBeUndefined()
  })

  test("allows a share token to establish multiple bounded browser sessions", () => {
    let now = 10_000
    const session = createLocalWebSession({ share: true, now: () => now })
    const firstCookie = session.exchangeLaunchToken(session.shareToken!, true)
    const secondCookie = session.exchangeLaunchToken(session.shareToken!, true)

    expect(firstCookie).toBeTruthy()
    expect(secondCookie).toBe(firstCookie)
    expect(session.setCookieHeader(firstCookie!)).toContain("Max-Age=28800")
    expect(session.exchangeLaunchToken(session.shareToken!, true)).toBe(firstCookie)

    now += 60 * 60 * 1_000 + 1
    expect(session.exchangeLaunchToken(session.shareToken!, true)).toBeUndefined()
    expect(session.authenticateCookieHeader(`killstata_web=${firstCookie}`)).toBe(true)
  })
})
