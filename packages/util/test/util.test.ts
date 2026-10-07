import { describe, expect, test } from "bun:test"
import z from "zod"
import { NamedError } from "../src/error"
import { lazy } from "../src/lazy"
import { iife } from "../src/iife"
import { Slug } from "../src/slug"
import { Binary } from "../src/binary"
import { retry } from "../src/retry"

// ── error ──

describe("NamedError", () => {
  const ValidationError = NamedError.create("ValidationError", z.object({ field: z.string() }))

  test("creates error with correct name and data", () => {
    const err = new ValidationError({ field: "email" })
    expect(err.name).toBe("ValidationError")
    expect(err.data).toEqual({ field: "email" })
    expect(err.message).toBe("ValidationError")
  })

  test("isInstance detects NamedError instances", () => {
    const err = new ValidationError({ field: "email" })
    expect(ValidationError.isInstance(err)).toBe(true)
  })

  test("isInstance rejects different type", () => {
    expect(ValidationError.isInstance(undefined)).toBe(false)
    expect(ValidationError.isInstance("string")).toBe(false)
    expect(ValidationError.isInstance(42)).toBe(false)
  })

  test("toObject returns serializable form", () => {
    const err = new ValidationError({ field: "email" })
    expect(err.toObject()).toEqual({ name: "ValidationError", data: { field: "email" } })
  })

  test("UnknownError is predefined", () => {
    const err = new NamedError.Unknown({ message: "something broke" })
    expect(err.name).toBe("UnknownError")
    expect(err.toObject().data.message).toBe("something broke")
  })
})

// ── lazy ──

describe("lazy", () => {
  test("only calls factory once", () => {
    let calls = 0
    const get = lazy(() => { calls++; return 42 })
    expect(get()).toBe(42)
    expect(calls).toBe(1)
    expect(get()).toBe(42)
    expect(calls).toBe(1)
  })

  test("reset re-enables factory", () => {
    let calls = 0
    const get = lazy(() => { calls++; return calls })
    expect(get()).toBe(1)
    get.reset()
    expect(get()).toBe(2)
  })
})

// ── iife ──

describe("iife", () => {
  test("calls the function and returns its result", () => {
    expect(iife(() => 42)).toBe(42)
  })

  test("passes this context", () => {
    const obj = { x: 1 }
    const result = iife(function (this: any) { return this.x }.bind(obj))
    expect(result).toBe(1)
  })
})

// ── slug ──

describe("Slug", () => {
  test("create returns adjective-noun pair", () => {
    const slug = Slug.create()
    expect(slug).toMatch(/^[a-z]+-[a-z]+$/)
  })

  test("create never returns empty", () => {
    for (let i = 0; i < 100; i++) {
      expect(Slug.create().length).toBeGreaterThan(3)
    }
  })
})

// ── binary ──

describe("Binary", () => {
  const items = [
    { id: "apple", val: 1 },
    { id: "banana", val: 2 },
    { id: "cherry", val: 3 },
  ].sort((a, b) => a.id.localeCompare(b.id))

  test("search finds existing item", () => {
    const r = Binary.search(items, "banana", (x) => x.id)
    expect(r.found).toBe(true)
    expect(items[r.index].val).toBe(2)
  })

  test("search returns insertion point for missing item", () => {
    const r = Binary.search(items, "blueberry", (x) => x.id)
    expect(r.found).toBe(false)
    expect(r.index).toBe(2)
  })

  test("insert adds item in sorted order", () => {
    const list = [{ id: "a" }, { id: "c" }]
    Binary.insert(list, { id: "b" }, (x) => x.id)
    expect(list.map((x) => x.id)).toEqual(["a", "b", "c"])
  })
})

// ── retry ──

describe("retry", () => {
  test("succeeds on first attempt", async () => {
    const result = await retry(async () => "ok", { attempts: 3 })
    expect(result).toBe("ok")
  })

  test("retries on transient error then succeeds", async () => {
    let attempts = 0
    const result = await retry(async () => {
      attempts++
      if (attempts < 3) throw new Error("ECONNRESET")
      return "recovered"
    }, { attempts: 3, delay: 1 })
    expect(result).toBe("recovered")
    expect(attempts).toBe(3)
  })

  test("fails after exhausting retries", async () => {
    expect(
      retry(async () => { throw new Error("ECONNRESET") }, { attempts: 2, delay: 1 }),
    ).rejects.toThrow()
  })

  test("does not retry non-transient errors", async () => {
    let attempts = 0
    expect(
      retry(async () => {
        attempts++
        throw new Error("syntax error")
      }, { attempts: 3, delay: 1 }),
    ).rejects.toThrow()
    expect(attempts).toBe(1)
  })
})
