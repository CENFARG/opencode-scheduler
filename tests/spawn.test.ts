import { describe, expect, it } from "vitest"
import {
  assertSafeWindowsSegment,
  buildWindowsCommand,
  isAbsoluteWindowsPath,
  quoteWindowsArg,
  scanUnquotedOperators,
} from "../src/util/spawn"

const COMMAND = "C:\\Users\\me\\.opencode\\bin\\opencode.exe"

describe("assertSafeWindowsSegment (CVE-2026-31994 mitigations)", () => {
  it("rejects bare CR and LF", () => {
    expect(() => assertSafeWindowsSegment("line1\r\nline2", "args[0]")).toThrow(/CR\/LF/)
    expect(() => assertSafeWindowsSegment("line1\nline2", "args[0]")).toThrow(/CR\/LF/)
    expect(() => assertSafeWindowsSegment("line1\rline2", "args[0]")).toThrow(/CR\/LF/)
  })

  it("rejects control characters", () => {
    expect(() => assertSafeWindowsSegment("a\u0000b", "args[0]")).toThrow(/control character/)
    expect(() => assertSafeWindowsSegment("a\tb", "args[0]")).toThrow(/control character/)
  })

  it("rejects env-expansion percent signs", () => {
    expect(() => assertSafeWindowsSegment("%PATH%", "args[0]")).toThrow(/env expansion/)
  })

  it("rejects double quotes that break cmd quoting balance", () => {
    expect(() => assertSafeWindowsSegment('x" & calc & "y', "args[0]")).toThrow(/double quote/)
  })

  it("rejects cmd metacharacters outright", () => {
    for (const ch of ["&", "|", "^", "(", ")", "<", ">", "!"]) {
      expect(() => assertSafeWindowsSegment(`safe${ch}evil`, "args[0]"), ch).toThrow(/cmd metacharacter/)
    }
  })

  it("accepts ordinary values", () => {
    expect(() => assertSafeWindowsSegment("--title=daily deal hunt", "args[0]")).not.toThrow()
  })
})

describe("isAbsoluteWindowsPath", () => {
  it("accepts drive-letter and UNC paths", () => {
    expect(isAbsoluteWindowsPath("C:\\bin\\opencode.exe")).toBe(true)
    expect(isAbsoluteWindowsPath("\\\\server\\share\\opencode.exe")).toBe(true)
  })

  it("rejects relative paths", () => {
    expect(isAbsoluteWindowsPath("opencode.exe")).toBe(false)
    expect(isAbsoluteWindowsPath(".\\opencode.exe")).toBe(false)
    expect(isAbsoluteWindowsPath("bin\\opencode.exe")).toBe(false)
  })
})

describe("quoteWindowsArg (v1-compatible quoting)", () => {
  it("leaves simple tokens unquoted", () => {
    expect(quoteWindowsArg("run")).toBe("run")
  })

  it("quotes tokens with whitespace", () => {
    expect(quoteWindowsArg("daily deal hunt")).toBe('"daily deal hunt"')
  })
})

describe("scanUnquotedOperators (defense in depth)", () => {
  it("finds operators outside quotes", () => {
    expect(scanUnquotedOperators('a "b" & calc')).toBe("&")
    expect(scanUnquotedOperators('a "b | c"')).toBeNull()
    expect(scanUnquotedOperators("echo hello >> log")).toBe(">")
  })
})

describe("buildWindowsCommand (cmd /c wrapper with the v1 output-redirect fix)", () => {
  it("wraps an absolute command and args in cmd /c", () => {
    expect(buildWindowsCommand({ command: COMMAND, args: ["run", "--", "hello world"] })).toBe(
      `cmd.exe /c "${COMMAND} run -- "hello world""`
    )
  })

  it("appends the scoped log redirect like the v1 fix branch", () => {
    const line = buildWindowsCommand({
      command: COMMAND,
      args: ["run"],
      logPath: "C:\\logs\\job.log",
    })
    expect(line).toBe(`cmd.exe /c "${COMMAND} run >> C:\\logs\\job.log 2>&1"`)
  })

  it("rejects a relative command", () => {
    expect(() => buildWindowsCommand({ command: "opencode", args: [] })).toThrow(/absolute path/)
  })

  it("rejects a relative log path", () => {
    expect(() =>
      buildWindowsCommand({ command: COMMAND, args: [], logPath: "logs\\job.log" })
    ).toThrow(/absolute path/)
  })

  it("rejects injection attempts through args or logPath", () => {
    expect(() => buildWindowsCommand({ command: COMMAND, args: ["run\r calc"] })).toThrow(/CR\/LF/)
    expect(() => buildWindowsCommand({ command: COMMAND, args: ["--", "a & calc"] })).toThrow(
      /cmd metacharacter/
    )
    expect(() =>
      buildWindowsCommand({ command: COMMAND, args: [], logPath: "C:\\log %TEMP% x.txt" })
    ).toThrow(/env expansion/)
  })
})
