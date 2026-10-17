import { describe, expect, it } from "vitest"
import {
  evaluateToolPermission,
  parseJobDefinition,
  resolveJobRun,
  slugify,
  type JobDefinition,
} from "../src/core/config"

const validBase = {
  name: "Standing Desk Search",
  schedule: "0 9 * * *",
  run: { prompt: "search deals" },
}

describe("slugify (v1 semantics)", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slugify("Standing Desk Search!")).toBe("standing-desk-search")
  })

  it("strips leading/trailing dashes", () => {
    expect(slugify("--hello world--")).toBe("hello-world")
  })
})

describe("parseJobDefinition (v1-compatible)", () => {
  it("parses a valid definition and derives the id from the name", () => {
    const job = parseJobDefinition(validBase)
    expect(job.id).toBe("standing-desk-search")
    expect(job.name).toBe("Standing Desk Search")
    expect(job.schedule).toBe("0 9 * * *")
  })

  it("accepts an explicit id", () => {
    expect(parseJobDefinition({ ...validBase, id: "custom-id" }).id).toBe("custom-id")
  })

  it("rejects non-objects", () => {
    expect(() => parseJobDefinition("nope")).toThrow("job definition must be an object")
  })

  it("requires name and schedule", () => {
    expect(() => parseJobDefinition({ run: { prompt: "x" } })).toThrow("job definition requires a name")
    expect(() => parseJobDefinition({ name: "x" })).toThrow("job definition requires a schedule")
  })

  it("propagates v1 cron messages", () => {
    expect(() => parseJobDefinition({ name: "x", schedule: "0 9 *" })).toThrow("Invalid cron: 0 9 *")
  })

  it("applies v1 run-spec validation messages", () => {
    expect(() =>
      parseJobDefinition({ name: "x", schedule: "0 9 * * *", run: {} })
    ).toThrow("Job must have either run.prompt or run.command")
    expect(() =>
      parseJobDefinition({ name: "x", schedule: "0 9 * * *", run: { prompt: "a", command: "b" } })
    ).toThrow("Job cannot specify both run.prompt and run.command")
    expect(() =>
      parseJobDefinition({ name: "x", schedule: "0 9 * * *", run: { command: "b", runFormat: "yaml" } })
    ).toThrow("Invalid runFormat: yaml (expected: default | json)")
  })

  it("silently drops non-positive port like v1 normalization", () => {
    const job = parseJobDefinition({ name: "x", schedule: "0 9 * * *", run: { command: "b", port: -1 } })
    expect(job.run?.port).toBeUndefined()
  })

  it("falls back to the legacy prompt field like v1", () => {
    const job = parseJobDefinition({ name: "legacy", schedule: "0 9 * * *", prompt: "old prompt" })
    expect(resolveJobRun(job).prompt).toBe("old prompt")
  })

  it("rejects a bodyless run spec with the v1 message", () => {
    expect(() =>
      parseJobDefinition({ name: "x", schedule: "0 9 * * *", run: { title: "no body" } })
    ).toThrow("Job must have either run.prompt or run.command")
  })

  it("rejects jobs with neither run nor legacy prompt", () => {
    expect(() => parseJobDefinition({ name: "x", schedule: "0 9 * * *" })).toThrow(
      'Job "x" is missing a prompt'
    )
  })

  it("validates timeoutSeconds as a non-negative integer (v1 message)", () => {
    expect(() => parseJobDefinition({ ...validBase, timeoutSeconds: -1 })).toThrow(
      "timeoutSeconds must be a non-negative integer"
    )
    expect(() => parseJobDefinition({ ...validBase, timeoutSeconds: 1.5 })).toThrow(
      "timeoutSeconds must be a non-negative integer"
    )
  })

  it("validates attachUrl", () => {
    expect(() => parseJobDefinition({ ...validBase, run: { prompt: "x", attachUrl: "not a url" } })).toThrow(
      "Invalid attach URL: not a url"
    )
  })
})

describe("env references only (P0: no inline secrets)", () => {
  it("accepts $VAR and ${VAR} references", () => {
    const job = parseJobDefinition({
      ...validBase,
      env: { TELEGRAM_TOKEN: "$TELEGRAM_TOKEN", API_KEY: "${API_KEY}" },
    })
    expect(job.env).toEqual({ TELEGRAM_TOKEN: "$TELEGRAM_TOKEN", API_KEY: "${API_KEY}" })
  })

  it("rejects inline values with a clear message", () => {
    expect(() =>
      parseJobDefinition({ ...validBase, env: { TELEGRAM_TOKEN: "12345:secret" } })
    ).toThrow("env.TELEGRAM_TOKEN must be an environment variable reference (e.g. ${VAR_NAME}); inline values are not allowed")
  })
})

describe("catch-up / expiry options", () => {
  it("accepts a known catch-up policy", () => {
    expect(parseJobDefinition({ ...validBase, catchUp: "most-recent" }).catchUp).toBe("most-recent")
  })

  it("rejects unknown catch-up policies", () => {
    expect(() => parseJobDefinition({ ...validBase, catchUp: "always" })).toThrow(
      "catchUp must be one of: fire-late-capped, most-recent, skip"
    )
  })

  it("rejects a non-integer catchUpMaxSeconds", () => {
    expect(() => parseJobDefinition({ ...validBase, catchUpMaxSeconds: -5 })).toThrow(
      "catchUpMaxSeconds must be a positive integer"
    )
  })

  it("rejects invalid activeUntil dates", () => {
    expect(() => parseJobDefinition({ ...validBase, activeUntil: "not-a-date" })).toThrow(
      "activeUntil must be a valid ISO date string"
    )
    expect(parseJobDefinition({ ...validBase, activeUntil: "2026-12-31T00:00:00.000Z" }).activeUntil).toBe(
      "2026-12-31T00:00:00.000Z"
    )
  })
})

describe("evaluateToolPermission (P0: unattended ask=deny)", () => {
  const jobWith = (permissions: JobDefinition["permissions"]): JobDefinition =>
    parseJobDefinition({ ...validBase, permissions })

  it("denies by default when no rules are configured", () => {
    expect(evaluateToolPermission(jobWith(undefined), "bash")).toBe("deny")
    expect(evaluateToolPermission(parseJobDefinition(validBase), "read")).toBe("deny")
  })

  it("allows explicitly permitted tools", () => {
    const job = jobWith({ allow: ["read", "bash"] })
    expect(evaluateToolPermission(job, "read")).toBe("allow")
    expect(evaluateToolPermission(job, "bash")).toBe("allow")
    expect(evaluateToolPermission(job, "write")).toBe("deny")
  })

  it("supports prefix wildcards", () => {
    const job = jobWith({ allow: ["web:*"] })
    expect(evaluateToolPermission(job, "web:search")).toBe("allow")
    expect(evaluateToolPermission(job, "web")).toBe("allow")
    expect(evaluateToolPermission(job, "network:fetch")).toBe("deny")
  })

  it("deny beats allow", () => {
    const job = jobWith({ allow: ["bash:*"], deny: ["bash:dangerous"] })
    expect(evaluateToolPermission(job, "bash:safe")).toBe("allow")
    expect(evaluateToolPermission(job, "bash:dangerous")).toBe("deny")
  })

  it("treats ask rules as deny (unattended runs have nobody to ask)", () => {
    const job = jobWith({ allow: ["ask:bash", "read"] })
    expect(evaluateToolPermission(job, "bash")).toBe("deny")
    expect(evaluateToolPermission(job, "read")).toBe("allow")
  })
})
