import { describe, expect, it } from "vitest"
import { isOwnIdleEvent, runTick, LAST_TICK_KEY, type EngineDeps } from "../src/core/engine"
import { createAuditLog } from "../src/core/audit"
import { createMemoryStorage } from "./helpers/memory-storage"
import { parseJobDefinition, type JobDefinition } from "../src/core/config"
import type { SupervisedOutcome } from "../src/core/supervisor"

const T0 = Date.parse("2026-03-10T10:00:00.000Z")
const at = (offsetMinutes: number) => new Date(T0 + offsetMinutes * 60_000)

const okOutcome = (): SupervisedOutcome => ({ status: "success", exitCode: 0, timedOut: false })

function makeJob(raw: Record<string, unknown>): JobDefinition {
  return parseJobDefinition({ name: "j", schedule: "* * * * *", run: { prompt: "hi" }, ...raw })
}

interface Harness {
  deps: EngineDeps
  storage: ReturnType<typeof createMemoryStorage>
  spawned: { jobId: string; runId: string }[]
  auditLines: string[]
}

function harness(jobs: JobDefinition[], outcomes: SupervisedOutcome[] = []): Harness {
  const storage = createMemoryStorage()
  const spawned: { jobId: string; runId: string }[] = []
  const auditLines: string[] = []
  let call = 0
  const deps: EngineDeps = {
    jobs,
    storage,
    audit: createAuditLog({ append: (line) => auditLines.push(line), clock: () => new Date(T0) }),
    spawnJob: async (job, runId) => {
      spawned.push({ jobId: job.id, runId })
      return outcomes[call++] ?? okOutcome()
    },
    clock: () => new Date(T0),
    random: () => 0,
  }
  return { deps, storage, spawned, auditLines }
}

describe("runTick (P0/P1 engine)", () => {
  it("cold start records a baseline without backfilling", async () => {
    const h = harness([makeJob({ id: "a" })])
    const summary = await runTick(h.deps, at(0))
    expect(summary.fired).toEqual([])
    expect(await h.storage.get(LAST_TICK_KEY)).toBe(at(0).toISOString())
  })

  it("fires a due job once and records claim, history and audit events", async () => {
    const h = harness([makeJob({ id: "a" })])
    await runTick(h.deps, at(0)) // baseline at 10:00
    const summary = await runTick(h.deps, at(3)) // window (10:00, 10:03] -> 3 fires

    // Default catch-up policy most-recent collapses to exactly one fire.
    expect(h.spawned).toHaveLength(1)
    expect(summary.fired).toHaveLength(1)
    expect(summary.fired[0]?.catchUp).toBe(true)
    expect(h.auditLines.join("\n")).toContain('"kind":"firing"')

    const { listRunHistory, getRunClaim } = await import("../src/core/runs")
    const history = await listRunHistory(h.storage, "a")
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ status: "success", exitCode: 0 })
    expect(await getRunClaim(h.storage, "a", summary.fired[0]!.fireTime)).not.toBeNull()
  })

  it("never re-fires the same fire across ticks (claim idempotency)", async () => {
    const h = harness([makeJob({ id: "a" })])
    await runTick(h.deps, at(0))
    await runTick(h.deps, at(1))
    const second = await runTick(h.deps, at(2))
    // The 10:01 fire was claimed in the previous tick (window (10:00,10:01]);
    // the 10:02 fire is new.
    expect(h.spawned).toHaveLength(2)
    expect(second.fired).toHaveLength(1)
  })

  it("respects the skip catch-up policy (missed runs are dropped)", async () => {
    const h = harness([makeJob({ id: "a", catchUp: "skip" })])
    await runTick(h.deps, at(0))
    await runTick(h.deps, at(5))
    expect(h.spawned).toHaveLength(0)
  })

  it("fire-late-capped keeps only fires within the cap", async () => {
    const h = harness([makeJob({ id: "a", catchUp: "fire-late-capped", catchUpMaxSeconds: 90 })])
    await runTick(h.deps, at(0))
    const summary = await runTick(h.deps, at(3)) // fires at :01 (120s late), :02 (60s), :03 (0s)
    expect(summary.fired.map((f) => f.catchUp)).toEqual([true, true]) // :02 and :03 only
    expect(h.spawned).toHaveLength(2)
  })

  it("skips jobs past their activeUntil expiry with an audited reason", async () => {
    const h = harness([makeJob({ id: "a", activeUntil: "2026-03-10T10:01:00.000Z" })])
    await runTick(h.deps, at(0))
    const summary = await runTick(h.deps, at(3))
    expect(summary.fired).toEqual([])
    expect(summary.skipped).toHaveLength(1)
    expect(summary.skipped[0]?.reason).toBe("expired")
    expect(h.auditLines.join("\n")).toContain('"reason":"expired"')
  })

  it("rejects a fire already claimed by another instance (at-least-once)", async () => {
    const h = harness([makeJob({ id: "a" })])
    await runTick(h.deps, at(0))

    const { claimRun } = await import("../src/core/runs")
    await claimRun(h.storage, "a", at(1).toISOString(), () => new Date(T0))

    const summary = await runTick(h.deps, at(1))
    expect(h.spawned).toHaveLength(0)
    expect(summary.skipped.some((s) => s.reason === "already-claimed")).toBe(true)
  })

  it("skips with reason overlap when the no-overlap lock is held", async () => {
    const h = harness([makeJob({ id: "a" })])
    await runTick(h.deps, at(0))

    const { acquireLock } = await import("../src/core/supervisor")
    await acquireLock(h.storage, "a", {
      pid: 111,
      staleMs: 3_600_000,
      now: T0 + 60_000,
      clock: () => new Date(T0 + 60_000),
    })

    const summary = await runTick(h.deps, at(1))
    expect(h.spawned).toHaveLength(0)
    expect(summary.skipped.some((s) => s.reason === "overlap")).toBe(true)
  })

  it("records failed outcomes including v1 timeout semantics", async () => {
    const h = harness([makeJob({ id: "a" })], [
      { status: "failed", exitCode: 124, error: "timeout", timedOut: true },
    ])
    await runTick(h.deps, at(0))
    await runTick(h.deps, at(1))

    const { listRunHistory } = await import("../src/core/runs")
    expect(await listRunHistory(h.storage, "a")).toMatchObject([
      { status: "failed", exitCode: 124, error: "timeout" },
    ])
    expect(h.auditLines.join("\n")).toContain('"kind":"result"')
  })

  it("excludes fires whose jittered time has not arrived yet", async () => {
    const storage = createMemoryStorage()
    const spawned: string[] = []
    const deps: EngineDeps = {
      jobs: [makeJob({ id: "a", jitterSeconds: 3600 })],
      storage,
      audit: createAuditLog({ append: () => {} }),
      spawnJob: async (job) => {
        spawned.push(job.id)
        return okOutcome()
      },
      clock: () => new Date(T0),
      random: () => 0.5, // jitter = 1800s = 30min, past the window edge
    }
    await runTick(deps, at(0))
    const summary = await runTick(deps, at(1))
    expect(spawned).toHaveLength(0)
    expect(summary.fired).toEqual([])
  })

  it("releases the lock after the spawn finishes", async () => {
    const h = harness([makeJob({ id: "a" })])
    await runTick(h.deps, at(0))
    await runTick(h.deps, at(1))

    const { getLock } = await import("../src/core/supervisor")
    expect(await getLock(h.storage, "a")).toBeNull()
  })
})

describe("isOwnIdleEvent (P1: cross-project event filter)", () => {
  const own = "C:\\work\\demo"

  it("accepts envelopes carrying our own location", () => {
    expect(isOwnIdleEvent({ properties: { location: own } }, own)).toBe(true)
  })

  it("rejects foreign and location-less envelopes (global stream gotcha)", () => {
    expect(isOwnIdleEvent({ properties: { location: "C:\\other" } }, own)).toBe(false)
    expect(isOwnIdleEvent({}, own)).toBe(false)
    expect(isOwnIdleEvent({ properties: {} }, own)).toBe(false)
    expect(isOwnIdleEvent(null, own)).toBe(false)
  })
})
