import { describe, expect, it } from "vitest"
import { createRedactedLogger, isSensitiveKey, REDACTED, redactString, redactValue } from "../src/util/log"

describe("isSensitiveKey (key deny-list)", () => {
  it("matches common secret key names case-insensitively", () => {
    for (const key of [
      "password",
      "PASSWORD",
      "user_passwd",
      "apiKey",
      "api_key",
      "API-KEY",
      "telegram_token",
      "AUTHORIZATION",
      "sessionCookie",
      "clientSecret",
      "private_key",
      "credentials",
    ]) {
      expect(isSensitiveKey(key), key).toBe(true)
    }
  })

  it("does not match ordinary keys", () => {
    for (const key of ["name", "schedule", "workdir", "keynote"]) {
      expect(isSensitiveKey(key), key).toBe(false)
    }
  })

  it("deliberately over-redacts compound keys containing a keyword", () => {
    // Substring matching is the documented deny-list pattern (A4.5):
    // over-redaction is safe, misses are not.
    expect(isSensitiveKey("tokenCount")).toBe(true)
  })
})

describe("redactString (unambiguous value formats)", () => {
  it("redacts Bearer tokens", () => {
    expect(redactString("auth: Bearer abc123def456ghi")).toBe(`auth: ${REDACTED}`)
  })

  it("redacts OpenAI-style sk- keys", () => {
    expect(redactString("key=sk-proj8Zx1y2z3a4b5c6d")).toBe(`key=${REDACTED}`)
  })

  it("redacts GitHub tokens", () => {
    expect(redactString("ghp_0123456789abcdefghijklmnopqrst")).toBe(REDACTED)
    expect(redactString("github_pat_0123456789abcdefABCDEF_1234")).toBe(REDACTED)
  })

  it("redacts Slack tokens", () => {
    expect(redactString("xoxb-123456789-abcdef")).toBe(REDACTED)
  })

  it("redacts AWS access key ids", () => {
    expect(redactString("AKIAIOSFODNN7EXAMPLE")).toBe(REDACTED)
  })

  it("redacts PEM private key blocks", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----"
    expect(redactString(`cert: ${pem}`)).toBe(`cert: ${REDACTED}`)
  })

  it("redacts DSN userinfo passwords", () => {
    expect(redactString("postgres://admin:s3cret@db.example.com:5432/app")).toBe(
      "postgres://admin:[REDACTED]@db.example.com:5432/app"
    )
  })

  it("leaves ordinary text untouched", () => {
    const line = "scheduled job standing-desk at 09:00"
    expect(redactString(line)).toBe(line)
  })
})

describe("redactValue (structured records)", () => {
  it("masks values under sensitive keys", () => {
    expect(redactValue({ password: "hunter2", name: "job" })).toEqual({ password: REDACTED, name: "job" })
  })

  it("recurses into nested objects and arrays", () => {
    expect(redactValue({ env: { TELEGRAM_TOKEN: "raw-secret" }, items: ["ok"] })).toEqual({
      env: { TELEGRAM_TOKEN: REDACTED },
      items: ["ok"],
    })
  })

  it("applies value regexes to plain strings", () => {
    expect(redactValue("Bearer abc123def456ghi")).toBe(REDACTED)
  })

  it("scalars pass through", () => {
    expect(redactValue(42)).toBe(42)
    expect(redactValue(null)).toBe(null)
  })
})

describe("createRedactedLogger", () => {
  it("redacts secrets across the formatted line", () => {
    const lines: string[] = []
    const log = createRedactedLogger((line) => lines.push(line))
    log("firing job", { token: "Bearer abc123def456ghi" })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("firing job")
    expect(lines[0]).not.toContain("abc123def456ghi")
    expect(lines[0]).toContain(REDACTED)
  })
})
