import { describe, expect, test } from "bun:test"
import { installedBinaryPackageNames, linuxLibcFromNodeReport } from "../../bin/binary-candidates.js"

describe("installed native binary selection", () => {
  test("prefers musl targets when libc is not identified as glibc", () => {
    expect(installedBinaryPackageNames("linux", "x64", { libc: "musl" })).toEqual([
      "killstata-linux-x64-musl",
      "killstata-linux-x64-baseline-musl",
      "killstata-linux-x64",
      "killstata-linux-x64-baseline",
    ])
  })

  test("prefers glibc targets when the runtime confirms glibc", () => {
    expect(installedBinaryPackageNames("linux", "x64", { libc: "glibc" })).toEqual([
      "killstata-linux-x64",
      "killstata-linux-x64-baseline",
      "killstata-linux-x64-musl",
      "killstata-linux-x64-baseline-musl",
    ])
  })

  test("uses libc-specific order for Linux ARM64 without inventing x64-only variants", () => {
    expect(installedBinaryPackageNames("linux", "arm64", { libc: "musl" })).toEqual([
      "killstata-linux-arm64-musl",
      "killstata-linux-arm64",
    ])
    expect(installedBinaryPackageNames("linux", "arm64", { libc: "glibc" })).toEqual([
      "killstata-linux-arm64",
      "killstata-linux-arm64-musl",
    ])
  })

  test("treats an absent or incomplete process report as unknown libc", () => {
    expect(linuxLibcFromNodeReport({ header: { glibcVersionRuntime: "2.31" } })).toBe("glibc")
    expect(linuxLibcFromNodeReport({ header: {} })).toBeUndefined()
    expect(linuxLibcFromNodeReport(undefined)).toBeUndefined()
    expect(installedBinaryPackageNames("linux", "x64", {}).at(0)).toBe("killstata-linux-x64-musl")
  })

  test("keeps the platform's native target first outside Linux", () => {
    expect(installedBinaryPackageNames("darwin", "arm64")).toEqual(["killstata-darwin-arm64"])
    expect(installedBinaryPackageNames("win32", "x64")).toEqual([
      "killstata-windows-x64",
      "killstata-windows-x64-baseline",
    ])
  })
})
