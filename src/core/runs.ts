// Run identity and durable pre-fire claims (research REC.2, Google SRE
// pattern): runId = `${jobId}:${fireTimeISO}`; the claim is written to durable
// storage BEFORE spawning so at-least-once delivery never double-fires.

export const CLAIM_PREFIX = "scheduler/runs/claim/"
export const HISTORY_PREFIX = "scheduler/runs/history/"

/** Structural subset of the OpenCode v2 `ctx.storage` domain. */
export interface JsonStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: { key: string; value: unknown }[]
    next?: string
  }>
}

export interface RunClaim {
  runId: string
  jobId: string
  fireTime: string
  claimedAt: string
  status: "claimed"
}

export interface ClaimResult {
  claimed: boolean
  runId: string
  existing?: RunClaim
}

export type RunStatus = "success" | "failed" | "skipped"

export interface RunResultRecord {
  runId: string
  jobId: string
  fireTime: string
  finishedAt: string
  status: RunStatus
  exitCode?: number
  error?: string
  catchUp?: boolean
  skipReason?: string
}

export function runId(jobId: string, fireTimeISO: string): string {
  return `${jobId}:${fireTimeISO}`
}

export async function claimRun(
  storage: JsonStorage,
  jobId: string,
  fireTimeISO: string,
  clock: () => Date = () => new Date()
): Promise<ClaimResult> {
  const id = runId(jobId, fireTimeISO)
  const key = `${CLAIM_PREFIX}${id}`

  const existing = await storage.get(key)
  if (isRunClaim(existing)) {
    return { claimed: false, runId: id, existing }
  }

  const claim: RunClaim = {
    runId: id,
    jobId,
    fireTime: fireTimeISO,
    claimedAt: clock().toISOString(),
    status: "claimed",
  }
  await storage.set(key, claim)
  return { claimed: true, runId: id }
}

export async function getRunClaim(
  storage: JsonStorage,
  jobId: string,
  fireTimeISO: string
): Promise<RunClaim | null> {
  const existing = await storage.get(`${CLAIM_PREFIX}${runId(jobId, fireTimeISO)}`)
  return isRunClaim(existing) ? existing : null
}

export async function recordRunResult(storage: JsonStorage, record: RunResultRecord): Promise<void> {
  await storage.set(`${HISTORY_PREFIX}${record.runId}`, record)
}

export async function listRunHistory(storage: JsonStorage, jobId?: string): Promise<RunResultRecord[]> {
  const history: RunResultRecord[] = []
  let after: string | undefined

  // Paginated scan to honor the storage cursor contract.
  for (;;) {
    const page = await storage.scan({ prefix: HISTORY_PREFIX, after })
    for (const entry of page.entries) {
      if (isRunResultRecord(entry.value) && (jobId === undefined || entry.value.jobId === jobId)) {
        history.push(entry.value)
      }
    }
    if (!page.next) break
    after = page.next
  }

  return history.sort((a, b) => (a.fireTime < b.fireTime ? -1 : a.fireTime > b.fireTime ? 1 : 0))
}

function isRunClaim(value: unknown): value is RunClaim {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as RunClaim).status === "claimed" &&
    typeof (value as RunClaim).runId === "string"
  )
}

function isRunResultRecord(value: unknown): value is RunResultRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RunResultRecord).runId === "string" &&
    typeof (value as RunResultRecord).status === "string"
  )
}
