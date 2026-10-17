import { describe, expect, it } from "vitest"
import { deriveScopeId, detectAdapterId, fenceJobName, fnv1a64Hex } from "../src/adapters"
import { mockRunner } from "./helpers/adapters"

describe("fnv1a64Hex / deriveScopeId (v1 algorithm)", () => {
  it("hashes deterministically with the v1 FNV-1a 64", () => {
    expect(fnv1a64Hex("")).toBe("cbf29ce484222325")
    expect(fnv1a64Hex("hello")).toHaveLength(16)
    expect(fnv1a64Hex("hello")).toBe(fnv1a64Hex("hello"))
  })

  it("derives scoped ids like v1 (basename + 12 hash chars)", () => {
    const scopeId = deriveScopeId("C:\\Users\\me\\projects\\My Project")
    expect(scopeId).toBe(`my-project-${fnv1a64Hex("C:\\Users\\me\\projects\\My Project").slice(0, 12)}`)
  })

  it("falls back to the workspace label for root-ish paths", () => {
    expect(deriveScopeId("/")).toBe(`workspace-${fnv1a64Hex("/").slice(0, 12)}`)
  })
})

describe("fenceJobName (P1: job-name fencing)", () => {
  it("keeps a safe charset and lowercase form", () => {
    expect(fenceJobName("Standing Desk Search")).toBe("standing-desk-search")
    expect(fenceJobName("job_1.2")).toBe("job_1.2")
  })

  it("strips path traversal and shell-hostile characters", () => {
    expect(fenceJobName("../../etc/passwd")).toBe("..-..-etc-passwd")
    expect(fenceJobName("a/b\\c:d*e?f\"g<h>i|j")).not.toMatch(/[/\\:*?"<>|]/)
  })

  it("caps length and never returns empty", () => {
    expect(fenceJobName("x".repeat(200))).toHaveLength(80)
    expect(fenceJobName("///")).toBe("job")
  })
})

describe("detectAdapterId (OS detection with mocked probes)", () => {
  it("selects schtasks on win32 without probing", async () => {
    const runner = mockRunner()
    expect(await detectAdapterId("win32", runner)).toBe("schtasks")
    expect(runner.calls).toHaveLength(0)
  })

  it("selects launchd on darwin", async () => {
    expect(await detectAdapterId("darwin", mockRunner())).toBe("launchd")
  })

  it("prefers systemd on linux, then cron, then null", async () => {
    const withSystemd = mockRunner({ "systemctl --user show-environment": "ok" })
    expect(await detectAdapterId("linux", withSystemd)).toBe("systemd")

    const withCron = mockRunner({
      "systemctl --user show-environment": new Error("not available"),
      "crontab -l": "",
    })
    expect(await detectAdapterId("linux", withCron)).toBe("cron")

    const neither = mockRunner({
      "systemctl --user show-environment": new Error("not available"),
      "crontab -l": new Error("no crontab"),
    })
    expect(await detectAdapterId("linux", neither)).toBeNull()
  })
})
