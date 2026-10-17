// No-overlap supervision (research REC.3, v1 parity): a durable lock per job
// with heartbeat + stale recovery (proper-lockfile patterns), and a timeout
// escalation SIGTERM -> SIGKILL that mirrors v1 (exit code 124, error
// "timeout", 5s default grace).

import type { JsonStorage } from "./runs"

export const LOCK_PREFIX = "scheduler/locks/"

export interface LockRecord {
  jobId: string
  pid: number
  startedAt: string
  heartbeatAt: string
}

export interface AcquireResult {
  acquired: boolean
  lock?: LockRecord
  holder?: LockRecord
  recoveredStale?: boolean
}

export interface AcquireOptions {
  pid: number
  staleMs: number
  now: number
  clock?: () => Date
}

const lockKey = (jobId: string) => `${LOCK_PREFIX}${jobId}`

export async function acquireLock(
  storage: JsonStorage,
  jobId: string,
  options: AcquireOptions
): Promise<AcquireResult> {
  const clock = options.clock ?? (() => new Date())
  const existing = await storage.get(lockKey(jobId))

  if (isLockRecord(existing)) {
    const heartbeatAge = options.now - Date.parse(existing.heartbeatAt)
    if (heartbeatAge <= options.staleMs) {
      // v1 parity: "Scheduled run skipped (already running pid=...)".
      return { acquired: false, holder: existing }
    }
  }

  const now = clock()
  const lock: LockRecord = {
    jobId,
    pid: options.pid,
    startedAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
  }
  await storage.set(lockKey(jobId), lock)
  return { acquired: true, lock, recoveredStale: isLockRecord(existing) }
}

export async function heartbeatLock(
  storage: JsonStorage,
  jobId: string,
  clock: () => Date = () => new Date()
): Promise<boolean> {
  const existing = await storage.get(lockKey(jobId))
  if (!isLockRecord(existing)) return false
  await storage.set(lockKey(jobId), { ...existing, heartbeatAt: clock().toISOString() })
  return true
}

export async function releaseLock(storage: JsonStorage, jobId: string): Promise<void> {
  await storage.remove(lockKey(jobId))
}

export async function getLock(storage: JsonStorage, jobId: string): Promise<LockRecord | null> {
  const existing = await storage.get(lockKey(jobId))
  return isLockRecord(existing) ? existing : null
}

function isLockRecord(value: unknown): value is LockRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as LockRecord).pid === "number" &&
    typeof (value as LockRecord).heartbeatAt === "string"
  )
}

export interface SpawnedChild {
  pid?: number
  kill(signal: "SIGTERM" | "SIGKILL"): void
  on(event: "close", listener: (code: number | null) => void): void
  on(event: "error", listener: (error: Error) => void): void
}

export interface SupervisedOutcome {
  status: "success" | "failed"
  exitCode: number | null
  error?: string
  timedOut: boolean
  killedWith?: "SIGTERM" | "SIGKILL"
}

export interface SuperviseOptions {
  timeoutMs?: number
  termGraceMs?: number
}

export async function runSupervised(
  childFactory: () => SpawnedChild,
  options: SuperviseOptions = {}
): Promise<SupervisedOutcome> {
  const child = childFactory()

  return new Promise<SupervisedOutcome>((resolve) => {
    let settled = false
    let timedOut = false
    let killedWith: "SIGTERM" | "SIGKILL" | undefined
    let termTimer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (outcome: SupervisedOutcome) => {
      if (settled) return
      settled = true
      if (termTimer) clearTimeout(termTimer)
      if (killTimer) clearTimeout(killTimer)
      resolve(outcome)
    }

    child.on("error", (error) => {
      finish({ status: "failed", exitCode: null, error: error.message, timedOut })
    })

    child.on("close", (code) => {
      if (timedOut) {
        // v1 parity: any timeout is reported as exit code 124 / "timeout".
        finish({ status: "failed", exitCode: 124, error: "timeout", timedOut: true, killedWith })
        return
      }
      if (code === 0) {
        finish({ status: "success", exitCode: 0, timedOut: false })
        return
      }
      finish({
        status: "failed",
        exitCode: code,
        error: `Exit code ${code ?? "unknown"}`,
        timedOut: false,
      })
    })

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      termTimer = setTimeout(() => {
        timedOut = true
        killedWith = "SIGTERM"
        child.kill("SIGTERM")
        killTimer = setTimeout(
          () => {
            killedWith = "SIGKILL"
            child.kill("SIGKILL")
          },
          options.termGraceMs ?? 5_000
        )
      }, options.timeoutMs)
    }
  })
}
