import { describe, expect, it } from "vitest"
import {
  claimRun,
  getRunClaim,
  listRunHistory,
  recordRunResult,
  runId,
  CLAIM_PREFIX,
  type RunClaim,
} from "../src/core/runs"
import { createMemoryStorage, type JsonStorage } from "./helpers/memory-storage"

const FIRE = "2026-03-10T09:00:00.000Z"
const clock = () => new Date("2026-03-10T09:00:01.000Z")

describe("runId", () => {
  it("is jobId:fireTimeISO (Google SRE launch identity)", () => {
    expect(runId("standing-desk", FIRE)).toBe(`standing-desk:${FIRE}`)
  })
})

describe("claimRun (P0: durable pre-fire claim, at-least-once)", () => {
  it("claims an unclaimed run and persists the claim", async () => {
    const storage = createMemoryStorage()
    const result = await claimRun(storage, "standing-desk", FIRE, clock)
    expect(result.claimed).toBe(true)
    expect(result.runId).toBe(`standing-desk:${FIRE}`)
    const stored = (await storage.get(`${CLAIM_PREFIX}standing-desk:${FIRE}`)) as RunClaim
    expect(stored).toEqual({
      runId: `standing-desk:${FIRE}`,
      jobId: "standing-desk",
      fireTime: FIRE,
      claimedAt: "2026-03-10T09:00:01.000Z",
      status: "claimed",
    })
  })

  it("rejects a double claim and leaves storage unchanged", async () => {
    const storage = createMemoryStorage()
    await claimRun(storage, "standing-desk", FIRE, clock)
    const snapshot = storage.snapshot()

    const second = await claimRun(storage, "standing-desk", FIRE, clock)
    expect(second.claimed).toBe(false)
    expect(second.existing?.claimedAt).toBe("2026-03-10T09:00:01.000Z")
    expect(storage.snapshot()).toEqual(snapshot)
  })

  it("claims are durable across storage instances (restart-safe)", async () => {
    const shared = new Map<string, unknown>()
    const first = new MemoryBackedStorage(shared)
    const restarted = new MemoryBackedStorage(shared)

    await claimRun(first, "j1", FIRE, clock)
    const after = await claimRun(restarted, "j1", FIRE, clock)
    expect(after.claimed).toBe(false)
  })

  it("different fire times claim independently", async () => {
    const storage = createMemoryStorage()
    expect((await claimRun(storage, "j1", FIRE, clock)).claimed).toBe(true)
    expect((await claimRun(storage, "j1", "2026-03-10T10:00:00.000Z", clock)).claimed).toBe(true)
  })

  it("getRunClaim returns the claim or null", async () => {
    const storage = createMemoryStorage()
    expect(await getRunClaim(storage, "j1", FIRE)).toBeNull()
    await claimRun(storage, "j1", FIRE, clock)
    expect((await getRunClaim(storage, "j1", FIRE))?.status).toBe("claimed")
  })
})

describe("run history", () => {
  it("records results keyed by unique runId and lists them sorted by fireTime", async () => {
    const storage = createMemoryStorage()
    await recordRunResult(storage, {
      runId: runId("j1", FIRE),
      jobId: "j1",
      fireTime: FIRE,
      finishedAt: "2026-03-10T09:05:00.000Z",
      status: "success",
      exitCode: 0,
    })
    await recordRunResult(storage, {
      runId: runId("j1", "2026-03-10T08:00:00.000Z"),
      jobId: "j1",
      fireTime: "2026-03-10T08:00:00.000Z",
      finishedAt: "2026-03-10T08:05:00.000Z",
      status: "skipped",
      skipReason: "expired",
    })

    const history = await listRunHistory(storage, "j1")
    expect(history.map((r) => r.fireTime)).toEqual([
      "2026-03-10T08:00:00.000Z",
      "2026-03-10T09:00:00.000Z",
    ])
  })

  it("filters by job when a jobId is given", async () => {
    const storage = createMemoryStorage()
    await recordRunResult(storage, {
      runId: runId("j1", FIRE),
      jobId: "j1",
      fireTime: FIRE,
      finishedAt: FIRE,
      status: "success",
    })
    await recordRunResult(storage, {
      runId: runId("j2", FIRE),
      jobId: "j2",
      fireTime: FIRE,
      finishedAt: FIRE,
      status: "failed",
      exitCode: 1,
    })
    expect(await listRunHistory(storage, "j1")).toHaveLength(1)
    expect(await listRunHistory(storage, "j2")).toMatchObject([{ status: "failed", exitCode: 1 }])
  })
})

// Test helper mirroring the shared memory storage contract.
class MemoryBackedStorage implements JsonStorage {
  constructor(private readonly map: Map<string, unknown>) {}
  async get(key: string): Promise<unknown> {
    return this.map.get(key)
  }
  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }
  async scan(options: { prefix: string; after?: string; limit?: number }) {
    const entries = [...this.map.entries()]
      .filter(([key]) => key.startsWith(options.prefix))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, value]) => ({ key, value }))
    return { entries }
  }
}
