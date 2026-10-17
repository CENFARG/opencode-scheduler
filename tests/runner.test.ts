// Host-runnable spawn tests use the real node binary (no external deps);
// binary resolution for win32 delegates to the fix-branch finder, pinned via
// the existing schtasks tests.

import { describe, expect, it } from "vitest"
import { buildRunEnvironment, spawnSupervisedRun } from "../src/core/runner"
import process from "node:process"

describe("spawnSupervisedRun (host smoke)", () => {
  it("propagates a clean exit code", async () => {
    const outcome = await spawnSupervisedRun({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    })
    expect(outcome).toMatchObject({ status: "success", exitCode: 0, timedOut: false })
  })

  it("propagates failure exit codes with the v1 message", async () => {
    const outcome = await spawnSupervisedRun({
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
    })
    expect(outcome).toMatchObject({ status: "failed", exitCode: 3, error: "Exit code 3" })
  }, 15_000)

  it("enforces the timeout via SIGTERM escalation", async () => {
    const outcome = await spawnSupervisedRun(
      { command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"] },
      { timeoutMs: 150 }
    )
    expect(outcome).toMatchObject({ status: "failed", exitCode: 124, error: "timeout", timedOut: true })
  }, 15_000)
})

describe("buildRunEnvironment (v1 non-interactive baseline)", () => {
  it("forces question:deny and preserves an existing policy's other fields", () => {
    const previous = process.env.OPENCODE_PERMISSION
    process.env.OPENCODE_PERMISSION = JSON.stringify({ bash: "allow" })
    try {
      const env = buildRunEnvironment({
        id: "j",
        name: "j",
        schedule: "* * * * *",
        run: { prompt: "x" },
      } as never)
      expect(JSON.parse(env.OPENCODE_PERMISSION!)).toEqual({ bash: "allow", question: "deny" })
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_PERMISSION
      else process.env.OPENCODE_PERMISSION = previous
    }
  })
})
