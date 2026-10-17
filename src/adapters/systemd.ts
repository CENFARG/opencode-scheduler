// systemd user-timer adapter: v1 unit-name and timer-format parity, with the
// opencode binary executed directly (the v2 plugin supervises in-process, so
// the perl supervisor script is gone).
// NOT host-testable on this Windows machine: tests use mocked commands/files.

import { join as posixJoin } from "path/posix"
import { parseCronField, splitCronExpression } from "../core/cron"
import { escapeShellArg } from "../adapters/shell"
import {
  deriveScopeId,
  fenceJobName,
  type AdapterDeps,
  type AdapterJob,
  type SchedulerAdapter,
} from "./index"

const SYSTEMD_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/** Verbatim port of v1 cronToSystemdCalendars. */
export function cronToSystemdCalendars(cron: string): string[] {
  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = splitCronExpression(cron)
  const minuteValues = parseCronField(minuteField, 0, 59, "minute")
  const hourValues = parseCronField(hourField, 0, 23, "hour")
  const dayValues = parseCronField(dayOfMonthField, 1, 31, "day of month")
  const monthValues = parseCronField(monthField, 1, 12, "month")
  const weekdayValues = parseCronField(dayOfWeekField, 0, 7, "day of week", true)

  const format = (value: number): string => value.toString().padStart(2, "0")

  const minutes = minuteValues ? minuteValues.map(format) : ["*"]
  const hours = hourValues ? hourValues.map(format) : ["*"]
  const days = dayValues ? dayValues.map(format) : ["*"]
  const months = monthValues ? monthValues.map(format) : ["*"]
  const weekdays = weekdayValues
    ? weekdayValues.map((value) => SYSTEMD_WEEKDAYS[value] ?? "*")
    : ["*"]

  const calendars: string[] = []

  const buildCalendars = (domValues: string[], dowValues: string[]): void => {
    for (const minuteValue of minutes) {
      for (const hourValue of hours) {
        for (const domValue of domValues) {
          for (const monthValue of months) {
            for (const dowValue of dowValues) {
              calendars.push(`${dowValue} *-${monthValue}-${domValue} ${hourValue}:${minuteValue}:00`)
            }
          }
        }
      }
    }
  }

  // Standard cron OR semantics, mirroring v1.
  if (dayValues && weekdayValues) {
    buildCalendars(days, ["*"])
    buildCalendars(["*"], weekdays)
  } else {
    buildCalendars(days, weekdays)
  }

  return calendars
}

function createSystemService(job: AdapterJob, scopeId: string, systemdUserDir: string): string {
  const unitBase = `opencode-job-${scopeId}-${fenceJobName(job.id)}`
  const logPath = job.logPath ?? posixJoin("/tmp", `${unitBase}.log`)
  const execStart = [job.command, ...job.args].map((arg) => `"${escapeShellArg(arg)}"`).join(" ")

  return `[Unit]
Description=OpenCode Job: ${job.name}

[Service]
Type=oneshot
WorkingDirectory=${job.workdir ?? "/"}
ExecStart=${execStart}
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`
}

function createSystemdTimer(job: AdapterJob): string {
  const calendarLines = cronToSystemdCalendars(job.schedule)
    .map((calendar) => `OnCalendar=${calendar}`)
    .join("\n")

  return `[Unit]
Description=Timer for OpenCode Job: ${job.name}

[Timer]
${calendarLines}
Persistent=true

[Install]
WantedBy=timers.target
`
}

export function createSystemdAdapter(deps: AdapterDeps): SchedulerAdapter {
  const { runner, files } = deps
  const systemdUserDir = deps.systemdUserDir ?? posixJoin(".config", "systemd", "user")

  const unitBase = (jobId: string, workdir?: string): string =>
    `opencode-job-${deriveScopeId(workdir ?? "/")}-${fenceJobName(jobId)}`

  const runSystemctl = async (args: string[]): Promise<void> => {
    await runner.exec("systemctl", ["--user", ...args])
  }

  return {
    id: "systemd",

    async isAvailable() {
      return runner.available("systemctl", ["--user", "show-environment"])
    },

    async install(job: AdapterJob) {
      const scopeId = deriveScopeId(job.workdir ?? "/")
      const base = `opencode-job-${scopeId}-${fenceJobName(job.id)}`

      await files.writeFile(posixJoin(systemdUserDir, `${base}.service`), createSystemService(job, scopeId, systemdUserDir))
      await files.writeFile(posixJoin(systemdUserDir, `${base}.timer`), createSystemdTimer(job))

      await runSystemctl(["daemon-reload"])
      await runSystemctl(["enable", `${base}.timer`])
      await runSystemctl(["start", `${base}.timer`])
    },

    async uninstall(jobId: string, workdir?: string) {
      const scopedBase = unitBase(jobId, workdir)
      const legacyBase = `opencode-job-${fenceJobName(jobId)}`

      for (const base of [scopedBase, legacyBase]) {
        try {
          await runSystemctl(["stop", `${base}.timer`])
          await runSystemctl(["disable", `${base}.timer`])
        } catch {
          // v1 parity: missing units are not an error during uninstall.
        }
        await files.remove(posixJoin(systemdUserDir, `${base}.service`))
        await files.remove(posixJoin(systemdUserDir, `${base}.timer`))
      }

      try {
        await runSystemctl(["daemon-reload"])
      } catch {
        // daemon-reload is best-effort during uninstall.
      }
    },
  }
}
