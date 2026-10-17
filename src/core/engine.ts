// Scheduling engine (pure, port-injected): the v2 timer-driven tick that
// computes due fires, applies catch-up policy and jitter, claims runs durably
// before spawning, enforces the no-overlap lock, and audits every decision.

import type { AuditLog } from "./audit"
import { planCatchUp, upcomingFires, addJitter, type CatchUpPolicy } from "./cron"
import { claimRun, recordRunResult, runId, type JsonStorage } from "./runs"
import { acquireLock, releaseLock, type SupervisedOutcome } from "./supervisor"
import type { JobDefinition } from "./config"

export const LAST_TICK_KEY = "scheduler/engine/lastTickAt"

export interface EngineDeps {
  jobs: JobDefinition[]
  storage: JsonStorage
  audit: AuditLog
  /** Spawns the job for a specific fire; supervision happens behind this port. */
  spawnJob: (job: JobDefinition, runId: string) => Promise<SupervisedOutcome>
  clock?: () => Date
  random?: () => number
  /** Stale threshold for the no-overlap lock (never 0 — REC.3). */
  lockStaleMs?: number
}

export interface FiredRun {
  jobId: string
  runId: string
  fireTime: string
  catchUp: boolean
}

export interface SkippedRun {
  jobId: string
  runId?: string
  reason: "expired" | "already-claimed" | "overlap"
}

export interface TickSummary {
  fired: FiredRun[]
  skipped: SkippedRun[]
}

const DEFAULT_LOCK_STALE_MS = 15 * 60_000

/**
 * P1 item 7: the v2 event stream is global — `session.idle` envelopes from
 * other projects arrive WITHOUT a location. Fail closed: only envelopes that
 * explicitly carry our own location are ours.
 */
export function isOwnIdleEvent(envelope: unknown, ownDirectory: string): boolean {
  if (typeof envelope !== "object" || envelope === null) return false
  const properties = (envelope as { properties?: unknown }).properties
  if (typeof properties !== "object" || properties === null) return false
  const record = properties as { location?: unknown; directory?: unknown }
  const location = record.location ?? record.directory
  return typeof location === "string" && location === ownDirectory
}

export async function runTick(deps: EngineDeps, now: Date): Promise<TickSummary> {
  const clock = deps.clock ?? (() => new Date())
  const random = deps.random ?? Math.random
  const lockStaleMs = deps.lockStaleMs ?? DEFAULT_LOCK_STALE_MS

  const lastTickAt = await deps.storage.get(LAST_TICK_KEY)
  const windowStart = typeof lastTickAt === "string" && !Number.isNaN(Date.parse(lastTickAt))
    ? new Date(lastTickAt)
    : now

  const summary: TickSummary = { fired: [], skipped: [] }

  for (const job of deps.jobs) {
    const fires = upcomingFires(job.schedule, windowStart, now)

    const dueFires = fires.filter((fire) => {
      const jittered = addJitter(fire, job.jitterSeconds ?? 0, random)
      return jittered.getTime() <= now.getTime()
    })

    const planned = planCatchUp(
      (job.catchUp ?? "most-recent") as CatchUpPolicy,
      dueFires,
      now,
      job.catchUpMaxSeconds ?? 7 * 24 * 3600
    )

    for (const plannedFire of planned) {
      const fireTimeISO = plannedFire.fire.toISOString()
      const id = runId(job.id, fireTimeISO)

      if (job.activeUntil !== undefined && now.getTime() > Date.parse(job.activeUntil)) {
        summary.skipped.push({ jobId: job.id, runId: id, reason: "expired" })
        deps.audit.log({ kind: "skip", jobId: job.id, runId: id, reason: "expired" })
        continue
      }

      deps.audit.log({
        kind: "intent",
        jobId: job.id,
        runId: id,
        details: { fireTime: fireTimeISO, catchUp: plannedFire.catchUp },
      })

      const claim = await claimRun(deps.storage, job.id, fireTimeISO, clock)
      if (!claim.claimed) {
        summary.skipped.push({ jobId: job.id, runId: id, reason: "already-claimed" })
        deps.audit.log({ kind: "skip", jobId: job.id, runId: id, reason: "already-claimed" })
        continue
      }

      const lock = await acquireLock(deps.storage, job.id, {
        pid: process.pid,
        staleMs: lockStaleMs,
        now: now.getTime(),
        clock,
      })
      if (!lock.acquired) {
        summary.skipped.push({ jobId: job.id, runId: id, reason: "overlap" })
        deps.audit.log({ kind: "skip", jobId: job.id, runId: id, reason: "overlap" })
        continue
      }

      deps.audit.log({ kind: "firing", jobId: job.id, runId: id })

      let outcome: SupervisedOutcome
      try {
        outcome = await deps.spawnJob(job, id)
      } finally {
        await releaseLock(deps.storage, job.id)
      }

      await recordRunResult(deps.storage, {
        runId: id,
        jobId: job.id,
        fireTime: fireTimeISO,
        finishedAt: clock().toISOString(),
        status: outcome.status,
        exitCode: outcome.exitCode ?? undefined,
        error: outcome.error,
        catchUp: plannedFire.catchUp,
      })
      deps.audit.log({
        kind: "result",
        jobId: job.id,
        runId: id,
        details: { status: outcome.status, exitCode: outcome.exitCode, error: outcome.error },
      })

      summary.fired.push({ jobId: job.id, runId: id, fireTime: fireTimeISO, catchUp: plannedFire.catchUp })
    }
  }

  await deps.storage.set(LAST_TICK_KEY, now.toISOString())
  return summary
}
