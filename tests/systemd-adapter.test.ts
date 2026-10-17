// systemd user-timer adapter tests — mocked commands/files only: this Windows
// machine cannot run systemd, so nothing here is host-testable. The tests pin
// generated unit content and issued commands.

import { describe, expect, it } from "vitest"
import { createSystemdAdapter, cronToSystemdCalendars } from "../src/adapters/systemd"
import { deriveScopeId } from "../src/adapters"
import { mockFiles, mockRunner } from "./helpers/adapters"

const WORKDIR = "/home/me/demo"
const COMMAND = "/usr/local/bin/opencode"
const LOG = "/home/me/.config/opencode/logs/scheduler/demo/daily-deal.log"

describe("cronToSystemdCalendars (v1 mapping)", () => {
  it("renders weekday timers like v1", () => {
    expect(cronToSystemdCalendars("30 8 * * 1")).toEqual(["Mon *-*-* 08:30:00"])
  })

  it("renders daily and stepped timers", () => {
    expect(cronToSystemdCalendars("0 9 * * *")).toEqual(["* *-*-* 09:00:00"])
    // v1 emits one OnCalendar entry per expanded minute.
    expect(cronToSystemdCalendars("*/15 * * * *")).toEqual([
      "* *-*-* *:00:00",
      "* *-*-* *:15:00",
      "* *-*-* *:30:00",
      "* *-*-* *:45:00",
    ])
  })

  it("splits day-of-month + weekday into OR calendar entries", () => {
    expect(cronToSystemdCalendars("0 12 1 * 1")).toEqual([
      "* *-*-01 12:00:00",
      "Mon *-*-* 12:00:00",
    ])
  })
})

describe("systemd adapter (mocked commands)", () => {
  it("writes service+timer units and enables the timer", async () => {
    const runner = mockRunner()
    const files = mockFiles()
    const adapter = createSystemdAdapter({ runner, files, systemdUserDir: "/home/me/.config/systemd/user" })
    const scopeId = deriveScopeId(WORKDIR)

    await adapter.install({
      id: "daily-deal",
      name: "Daily Deal",
      schedule: "30 8 * * 1",
      command: COMMAND,
      args: ["run", "--", "find deals"],
      workdir: WORKDIR,
      logPath: LOG,
    })

    const servicePath = `/home/me/.config/systemd/user/opencode-job-${scopeId}-daily-deal.service`
    const timerPath = `/home/me/.config/systemd/user/opencode-job-${scopeId}-daily-deal.timer`

    const service = files.written.get(servicePath) ?? ""
    expect(service).toContain("Type=oneshot")
    expect(service).toContain(`WorkingDirectory=${WORKDIR}`)
    expect(service).toContain(`ExecStart="${COMMAND}" "run" "--" "find deals"`)
    expect(service).toContain(`StandardOutput=append:${LOG}`)

    const timer = files.written.get(timerPath) ?? ""
    expect(timer).toContain("OnCalendar=Mon *-*-* 08:30:00")
    expect(timer).toContain("Persistent=true")

    const issued = runner.calls.map((call) => [call.command, ...call.args].join(" "))
    expect(issued).toContain("systemctl --user daemon-reload")
    expect(issued).toContain(`systemctl --user enable opencode-job-${scopeId}-daily-deal.timer`)
    expect(issued).toContain(`systemctl --user start opencode-job-${scopeId}-daily-deal.timer`)
  })

  it("uninstall stops, disables, removes scoped and legacy units, then reloads", async () => {
    const runner = mockRunner()
    const files = mockFiles()
    const adapter = createSystemdAdapter({ runner, files, systemdUserDir: "/home/me/.config/systemd/user" })
    const scopeId = deriveScopeId(WORKDIR)

    await adapter.uninstall("daily-deal", WORKDIR)

    const issued = runner.calls.map((call) => [call.command, ...call.args].join(" "))
    expect(issued).toContain(`systemctl --user stop opencode-job-${scopeId}-daily-deal.timer`)
    expect(issued).toContain("systemctl --user stop opencode-job-daily-deal.timer")
    expect(issued).toContain(`systemctl --user disable opencode-job-${scopeId}-daily-deal.timer`)
    expect(issued).toContain("systemctl --user daemon-reload")
    expect(files.removed).toContain(`/home/me/.config/systemd/user/opencode-job-${scopeId}-daily-deal.service`)
    expect(files.removed).toContain("/home/me/.config/systemd/user/opencode-job-daily-deal.timer")
  })
})
