// crontab and launchd adapter tests — mocked commands/files only (no crontab
// or launchd on this Windows host; nothing here is host-testable). They pin
// v1 block/label formats and issued commands.

import { describe, expect, it } from "vitest"
import { createCronAdapter } from "../src/adapters/cron"
import { createLaunchdAdapter } from "../src/adapters/launchd"
import { deriveScopeId } from "../src/adapters"
import { mockFiles, mockRunner } from "./helpers/adapters"

const WORKDIR = "/home/me/demo"
const COMMAND = "/usr/local/bin/opencode"
const LOG = "/home/me/.config/opencode/logs/scheduler/demo/daily-deal.log"
const baseJob = {
  id: "daily-deal",
  name: "Daily Deal",
  schedule: "30 8 * * 1",
  command: COMMAND,
  args: ["run", "--", "find deals"],
  workdir: WORKDIR,
  logPath: LOG,
}

describe("cron adapter (v1 managed blocks)", () => {
  function cronRunner(existing?: string, failList = false) {
    return mockRunner(
      failList
        ? { "crontab -l": new Error("no crontab for me") }
        : existing !== undefined
          ? { "crontab -l": existing }
          : {}
    )
  }

  it("installs a managed block into an empty crontab (no-crontab tolerated)", async () => {
    const runner = cronRunner(undefined, true)
    const adapter = createCronAdapter({ runner, files: mockFiles() })
    await adapter.install(baseJob)

    const write = runner.calls.find((call) => call.command === "crontab" && call.args[0] === "-")
    expect(write).toBeDefined()
    const content = write!.input ?? ""
    const scopeId = deriveScopeId(WORKDIR)
    expect(content).toContain(`# BEGIN opencode-scheduler ${scopeId}:daily-deal`)
    expect(content).toContain(`30 8 * * 1 PATH=`)
    expect(content).toContain(`"${COMMAND}" "run" "--" "find deals" >> "${LOG}" 2>&1`)
    expect(content).toContain(`# END opencode-scheduler ${scopeId}:daily-deal`)
  })

  it("preserves unrelated crontab content and replaces its own block", async () => {
    const scopeId = deriveScopeId(WORKDIR)
    const begin = `# BEGIN opencode-scheduler ${scopeId}:daily-deal`
    const end = `# END opencode-scheduler ${scopeId}:daily-deal`
    const existing = ["0 0 1 1 * echo keep-me", begin, "OLD-ENTRY", end, ""].join("\n")

    const runner = cronRunner(existing)
    const adapter = createCronAdapter({ runner, files: mockFiles() })
    await adapter.install(baseJob)

    const write = runner.calls.find((call) => call.args[0] === "-")!
    const content = write.input ?? ""
    expect(content).toContain("echo keep-me")
    expect(content).not.toContain("OLD-ENTRY")
    expect(content.match(/BEGIN opencode-scheduler/g)).toHaveLength(1)
  })

  it("uninstall strips scoped and legacy blocks and skips writing when clean", async () => {
    const scopeId = deriveScopeId(WORKDIR)
    const begin = `# BEGIN opencode-scheduler ${scopeId}:daily-deal`
    const end = `# END opencode-scheduler ${scopeId}:daily-deal`
    const existing = [begin, "ENTRY", end, "0 0 1 1 * echo keep-me", ""].join("\n")

    const runner = cronRunner(existing)
    const adapter = createCronAdapter({ runner, files: mockFiles() })
    await adapter.uninstall("daily-deal", WORKDIR)

    const write = runner.calls.find((call) => call.args[0] === "-")!
    expect(write.input).toBe("0 0 1 1 * echo keep-me\n")

    const cleanRunner = cronRunner("0 0 1 1 * echo keep-me")
    const cleanAdapter = createCronAdapter({ runner: cleanRunner, files: mockFiles() })
    await cleanAdapter.uninstall("daily-deal", WORKDIR)
    expect(cleanRunner.calls.some((call) => call.args[0] === "-")).toBe(false)
  })
})

describe("launchd adapter (v1 plist format)", () => {
  const launchAgentsDir = "/Users/me/Library/LaunchAgents"

  it("writes a plist with StartCalendarInterval and loads it", async () => {
    const runner = mockRunner()
    const files = mockFiles()
    const adapter = createLaunchdAdapter({ runner, files, launchAgentsDir })
    const scopeId = deriveScopeId(WORKDIR)

    await adapter.install(baseJob)

    const plistPath = `${launchAgentsDir}/com.opencode.job.${scopeId}.daily-deal.plist`
    const plist = files.written.get(plistPath) ?? ""
    expect(plist).toContain(`<key>Label</key>\n  <string>com.opencode.job.${scopeId}.daily-deal</string>`)
    expect(plist).toContain("<key>Minute</key>")
    expect(plist).toContain("<integer>30</integer>")
    expect(plist).toContain("<key>Weekday</key>")
    expect(plist).toContain("<integer>1</integer>")
    expect(plist).toContain(`<string>${COMMAND}</string>`)
    expect(plist).toContain(`<key>WorkingDirectory</key>\n  <string>${WORKDIR}</string>`)

    const issued = runner.calls.map((call) => [call.command, ...call.args].join(" "))
    expect(issued).toContain(`launchctl load ${plistPath}`)
  })

  it("splits day-of-month + weekday into an array of calendars (v1 OR semantics)", async () => {
    const runner = mockRunner()
    const files = mockFiles()
    const adapter = createLaunchdAdapter({ runner, files, launchAgentsDir })

    await adapter.install({ ...baseJob, schedule: "0 12 1 * 1" })
    const plist = [...files.written.values()][0]
    expect(plist).toContain("<array>")
    expect((plist.match(/<key>Day<\/key>/g) ?? []).length).toBe(1)
    expect((plist.match(/<key>Weekday<\/key>/g) ?? []).length).toBe(1)
  })

  it("uninstall unloads and removes scoped and legacy plists", async () => {
    const runner = mockRunner()
    const files = mockFiles()
    const adapter = createLaunchdAdapter({ runner, files, launchAgentsDir })
    const scopeId = deriveScopeId(WORKDIR)

    await adapter.uninstall("daily-deal", WORKDIR)

    const issued = runner.calls.map((call) => [call.command, ...call.args].join(" "))
    expect(issued).toContain(`launchctl unload ${launchAgentsDir}/com.opencode.job.${scopeId}.daily-deal.plist`)
    expect(issued).toContain(`launchctl unload ${launchAgentsDir}/com.opencode.job.daily-deal.plist`)
    expect(files.removed).toContain(`${launchAgentsDir}/com.opencode.job.${scopeId}.daily-deal.plist`)
    expect(files.removed).toContain(`${launchAgentsDir}/com.opencode.job.daily-deal.plist`)
  })
})
