// Hardened command builder for the Windows cmd /c wrapper (P1 hardening,
// CVE-2026-31994 class mitigations): rejects CR/LF and control characters,
// rejects cmd metacharacters and env-expansion (%) outright, requires
// absolute paths, and quotes every segment. Segments that cannot be made
// inert inside the outer cmd /c quoting are refused, never escaped silently.

import { isAbsolute } from "path"

const FORBIDDEN_CHARS = new Set(["&", "|", "^", "(", ")", "<", ">", "!", '"', "%"])

export function assertSafeWindowsSegment(value: string, label: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${label} contains bare CR/LF which enables cmd line injection`)
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} contains control characters`)
  }
  if (value.includes('"')) {
    throw new Error(`${label} contains a double quote which breaks cmd quoting balance`)
  }
  if (value.includes("%")) {
    throw new Error(`${label} contains '%' which enables cmd env expansion`)
  }
  for (const char of value) {
    if (FORBIDDEN_CHARS.has(char)) {
      throw new Error(`${label} contains cmd metacharacter '${char}'`)
    }
  }
}

export function isAbsoluteWindowsPath(value: string): boolean {
  return isAbsolute(value)
}

export function quoteWindowsArg(value: string): string {
  // v1-compatible: quote only when the token contains whitespace.
  if (!/\s/u.test(value)) return value
  return `"${value}"`
}

export function scanUnquotedOperators(line: string): string | null {
  let inQuotes = false
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (inQuotes) continue
    if (FORBIDDEN_CHARS.has(char)) return char
  }
  return null
}

export interface WindowsCommandOptions {
  command: string
  args: string[]
  logPath?: string
}

export function buildWindowsCommand(options: WindowsCommandOptions): string {
  const { command, args, logPath } = options

  if (!isAbsoluteWindowsPath(command)) {
    throw new Error(`command must be an absolute path (got: ${command})`)
  }
  assertSafeWindowsSegment(command, "command")
  args.forEach((arg, index) => assertSafeWindowsSegment(arg, `args[${index}]`))

  const base = [command, ...args].map(quoteWindowsArg).join(" ")

  // Defense in depth: nothing outside quotes may look like a shell operator.
  const unquoted = scanUnquotedOperators(base)
  if (unquoted) {
    throw new Error(`refusing to build command line: unquoted '${unquoted}' found outside quotes`)
  }

  if (logPath === undefined) {
    return `cmd.exe /c "${base}"`
  }

  if (!isAbsoluteWindowsPath(logPath)) {
    throw new Error(`logPath must be an absolute path (got: ${logPath})`)
  }
  assertSafeWindowsSegment(logPath, "logPath")

  // v1 fix branch (fix/windows-schtasks-binary-resolution): scoped output
  // redirect through the cmd wrapper.
  return `cmd.exe /c "${base} >> ${quoteWindowsArg(logPath)} 2>&1"`
}
