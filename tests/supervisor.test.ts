import { afterEach, describe, expect, it, vi } from "vitest"
import {
  acquireLock,
  getLock,
  heartbeatLock,
  releaseLock,
  runSupervised,
  LOCK_PREFIX,
  type LockRecord,
  type SpawnedChild,
} from "../src/core/supervisor"
import { createMemoryStorage } from "./helpers/memory-storage"

const T0 = Date.parse("2026-03-10T09:00:00.000Z")
const clockAt = (ms: number) => () => new Date(T0 + ms)

describe("acquireLock (P0: no-overlap supervision)", () => {
  it("acquires when free and persists the lock", async () => {
    const storage = createMemoryStorage()
    const result = await acquireLock(storage, "j1", {
      pid: 4242,
      staleMs: 60_000,
      now: T0,
      clock: clockAt(0),
    })
    expect(result.acquired).toBe(true)
    const stored = (await storage.get(`${LOCK_PREFIX}j1`)) as LockRecord
    expect(stored).toMatchObject({ jobId: "j1", pid: 4242, startedAt: "2026-03-10T09:00:00.000Z" })
  })

  it("rejects acquisition while a fresh lock is held (v1 overlap skip)", async () => {
    const storage = createMemoryStorage()
    await acquireLock(storage, "j1", { pid: 100, staleMs: 60_000, now: T0, clock: clockAt(0) })
    const second = await acquireLock(storage, "j1", {
      pid: 200,
      staleMs: 60_000,
      now: T0 + 10_000,
      clock: clockAt(10_000),
    })
    expect(second.acquired).toBe(false)
    expect(second.holder?.pid).toBe(100)
  })

  it("recovers a stale lock when the heartbeat is older than staleMs", async () => {
    const storage = createMemoryStorage()
    await acquireLock(storage, "j1", { pid: 100, staleMs: 60_000, now: T0, clock: clockAt(0) })
    const takeover = await acquireLock(storage, "j1", {
      pid: 300,
      staleMs: 60_000,
      now: T0 + 61_000,
      clock: clockAt(61_000),
    })
    expect(takeover.acquired).toBe(true)
    expect(takeover.recoveredStale).toBe(true)
    expect((await getLock(storage, "j1"))?.pid).toBe(300)
  })

  it("heartbeat refreshes heartbeatAt only while holding the lock", async () => {
    const storage = createMemoryStorage()
    expect(await heartbeatLock(storage, "j1", clockAt(5_000))).toBe(false)

    await acquireLock(storage, "j1", { pid: 100, staleMs: 60_000, now: T0, clock: clockAt(0) })
    expect(await heartbeatLock(storage, "j1", clockAt(30_000))).toBe(true)
    expect((await getLock(storage, "j1"))?.heartbeatAt).toBe("2026-03-10T09:00:30.000Z")
  })

  it("release removes the lock so the next run can acquire", async () => {
    const storage = createMemoryStorage()
    await acquireLock(storage, "j1", { pid: 100, staleMs: 60_000, now: T0, clock: clockAt(0) })
    await releaseLock(storage, "j1")
    expect(await getLock(storage, "j1")).toBeNull()
    const again = await acquireLock(storage, "j1", {
      pid: 200,
      staleMs: 60_000,
      now: T0 + 1_000,
      clock: clockAt(1_000),
    })
    expect(again.acquired).toBe(true)
  })
})

type FakeChild = SpawnedChild & { signals: string[]; exit: (code: number | null) => void }

function fakeChild(): FakeChild {
  const signals: string[] = []
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const child: FakeChild = {
    pid: 999,
    signals,
    kill(signal) {
      signals.push(signal)
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener as (...args: unknown[]) => void)
      listeners.set(event, list)
    },
  }
  ;(child as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit = (
    event: string,
    ...args: unknown[]
  ) => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
    return true
  }
  return child
}

const emit = (child: FakeChild, event: "close" | "error", ...args: unknown[]) =>
  (child as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit(event, ...args)

describe("runSupervised (v1 timeout semantics)", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("reports success for a clean exit without touching the child", async () => {
    const child = fakeChild()
    const promise = runSupervised(() => child, { timeoutMs: 60_000 })
    emit(child, "close", 0)
    expect(await promise).toMatchObject({ status: "success", exitCode: 0, timedOut: false })
    expect(child.signals).toEqual([])
  })

  it("reports failure with the v1 exit-code message", async () => {
    const child = fakeChild()
    const promise = runSupervised(() => child, { timeoutMs: 60_000 })
    emit(child, "close", 3)
    expect(await promise).toMatchObject({ status: "failed", exitCode: 3, error: "Exit code 3" })
  })

  it("escalates to SIGTERM then SIGKILL when the child ignores termination", async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const promise = runSupervised(() => child, { timeoutMs: 1_000, termGraceMs: 5_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(child.signals).toEqual(["SIGTERM"])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"])
    emit(child, "close", 137)
    expect(await promise).toEqual({
      status: "failed",
      exitCode: 124,
      error: "timeout",
      timedOut: true,
      killedWith: "SIGKILL",
    })
  })

  it("marks a SIGTERM-terminated child as timeout with exit code 124 (v1 parity)", async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const promise = runSupervised(() => child, { timeoutMs: 1_000, termGraceMs: 5_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    emit(child, "close", 143)
    const outcome = await promise
    expect(outcome).toMatchObject({ status: "failed", exitCode: 124, error: "timeout", timedOut: true })
  })

  it("runs without timeout when none is configured", async () => {
    const child = fakeChild()
    const promise = runSupervised(() => child)
    emit(child, "close", 0)
    expect(await promise).toMatchObject({ status: "success", timedOut: false })
    expect(child.signals).toEqual([])
  })

  it("reports spawn errors as failures", async () => {
    const child = fakeChild()
    const promise = runSupervised(() => child, { timeoutMs: 60_000 })
    emit(child, "error", new Error("spawn ENOENT"))
    expect(await promise).toMatchObject({ status: "failed", exitCode: null, error: "spawn ENOENT" })
  })
})
