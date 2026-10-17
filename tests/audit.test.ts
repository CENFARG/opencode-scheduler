import { describe, expect, it } from "vitest"
import { createAuditLog, type AuditEvent } from "../src/core/audit"

function collect() {
  const lines: string[] = []
  return {
    lines,
    append: (line: string) => lines.push(line),
  }
}

const fixedClock = () => new Date("2026-03-10T09:00:00.000Z")

function parseEvents(lines: string[]): (AuditEvent & { at: string })[] {
  return lines.map((line) => JSON.parse(line))
}

describe("createAuditLog", () => {
  it("emits exactly one JSON line per event (append-only contract)", () => {
    const sink = collect()
    const audit = createAuditLog({ append: sink.append, clock: fixedClock })
    audit.log({ kind: "intent", jobId: "standing-desk" })
    audit.log({ kind: "firing", jobId: "standing-desk", runId: "standing-desk:2026-03-10T09:00:00.000Z" })
    expect(sink.lines).toHaveLength(2)
    expect(sink.lines[0]).toContain('"kind":"intent"')
    expect(sink.lines[1]).toContain('"kind":"firing"')
  })

  it("records jobId, runId, reason and a timestamp from the injected clock", () => {
    const sink = collect()
    const audit = createAuditLog({ append: sink.append, clock: fixedClock })
    audit.log({ kind: "skip", jobId: "j1", runId: "r1", reason: "overlap" })
    const [event] = parseEvents(sink.lines)
    expect(event).toMatchObject({
      at: "2026-03-10T09:00:00.000Z",
      kind: "skip",
      jobId: "j1",
      runId: "r1",
      reason: "overlap",
    })
  })

  it("serializes structured details", () => {
    const sink = collect()
    const audit = createAuditLog({ append: sink.append, clock: fixedClock })
    audit.log({ kind: "result", jobId: "j1", details: { exitCode: 0, status: "success" } })
    const [event] = parseEvents(sink.lines)
    expect(event.details).toEqual({ exitCode: 0, status: "success" })
  })

  it("redacts secrets before they reach the audit sink", () => {
    const sink = collect()
    const audit = createAuditLog({ append: sink.append, clock: fixedClock })
    audit.log({
      kind: "firing",
      jobId: "j1",
      details: { telegram_token: "Bearer abc123def456ghi", plain: "ok" },
    })
    const raw = sink.lines[0]
    expect(raw).not.toContain("abc123def456ghi")
    expect(raw).toContain('"plain":"ok"')
  })
})
