// Secret redaction applied at the logger: key deny-list first, then
// value-regex redaction for unambiguous token formats (research REC.5/A4.5).
// Every sink goes through this module so audit lines and logs are covered.

export const REDACTED = "[REDACTED]"

const MAX_REDACT_DEPTH = 6

// Substring deny-list: over-redaction is safe, misses are not.
const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|authorization|cookie|credential|api[-_]?key|private[-_]?key|client[-_]?secret|session[-_]?key)/i

const VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key)
}

export function redactString(value: string): string {
  let redacted = value
  for (const pattern of VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED)
  }
  // DSN userinfo: scheme://user:pass@ -> keep user, mask the password.
  redacted = redacted.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi,
    (_match, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`
  )
  return redacted
}

export function redactValue(value: unknown, maxDepth: number = MAX_REDACT_DEPTH): unknown {
  if (maxDepth <= 0 && typeof value === "object" && value !== null) {
    return REDACTED
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, maxDepth - 1))
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, maxDepth - 1)
    }
    return out
  }
  if (typeof value === "string") {
    return redactString(value)
  }
  return value
}

export function createRedactedLogger(write: (line: string) => void): (...parts: unknown[]) => void {
  return (...parts: unknown[]) => {
    const line = parts
      .map((part) => (typeof part === "string" ? part : JSON.stringify(redactValue(part))))
      .filter((part) => part !== undefined)
      .join(" ")
    write(redactString(line))
  }
}
