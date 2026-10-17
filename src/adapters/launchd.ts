// launchd adapter: v1 label/plist format (StartCalendarInterval dict or array,
// dom/dow OR split) with the opencode binary executed directly.
// NOT host-testable on this Windows machine: tests use mocked commands/files.

import { join as posixJoin } from "path/posix"
import { parseCronField, splitCronExpression } from "../core/cron"
import { enhancedPosixPath } from "./cron"
import {
  deriveScopeId,
  fenceJobName,
  type AdapterDeps,
  type AdapterJob,
  type SchedulerAdapter,
} from "./index"

const LAUNCHD_PREFIX = "com.opencode.job"

function escapePlistString(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Verbatim port of v1 cronToLaunchdCalendars + renderLaunchdCalendar. */
export function cronToLaunchdCalendars(cron: string): Record<string, number>[] {
  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = splitCronExpression(cron)
  const minuteValues = parseCronField(minuteField, 0, 59, "minute")
  const hourValues = parseCronField(hourField, 0, 23, "hour")
  const dayValues = parseCronField(dayOfMonthField, 1, 31, "day of month")
  const monthValues = parseCronField(monthField, 1, 12, "month")
  const weekdayValues = parseCronField(dayOfWeekField, 0, 7, "day of week", true)

  const expand = (
    entries: Record<string, number>[],
    key: string,
    values: number[] | null
  ): Record<string, number>[] => {
    if (!values) return entries
    const expanded: Record<string, number>[] = []
    for (const entry of entries) {
      for (const value of values) {
        expanded.push({ ...entry, [key]: value })
      }
    }
    return expanded
  }

  let entries: Record<string, number>[] = [{}]
  entries = expand(entries, "Minute", minuteValues)
  entries = expand(entries, "Hour", hourValues)
  entries = expand(entries, "Day", dayValues)
  entries = expand(entries, "Month", monthValues)
  entries = expand(entries, "Weekday", weekdayValues)
  return entries
}

function renderLaunchdCalendar(calendar: Record<string, number>): string {
  return Object.entries(calendar)
    .map(([key, value]) => `    <key>${key}</key>\n    <integer>${value}</integer>`)
    .join("\n")
}

function calendarXml(cron: string): string {
  const calendars = cronToLaunchdCalendars(cron)
  if (calendars.length === 1) {
    return `  <dict>\n${renderLaunchdCalendar(calendars[0] ?? {})}\n  </dict>`
  }
  return `  <array>\n${calendars
    .map((calendar) => `  <dict>\n${renderLaunchdCalendar(calendar)}\n  </dict>`)
    .join("\n")}\n  </array>`
}

function createLaunchdPlist(job: AdapterJob, scopeId: string): string {
  const label = `${LAUNCHD_PREFIX}.${scopeId}.${fenceJobName(job.id)}`
  const logPath = job.logPath ?? "/dev/null"
  const programArgumentsXml = [job.command, ...job.args]
    .map((arg) => `    <string>${escapePlistString(arg)}</string>`)
    .join("\n")

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>

  <key>WorkingDirectory</key>
  <string>${escapePlistString(job.workdir ?? "/")}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${enhancedPosixPath()}</string>
  </dict>

  <key>ProgramArguments</key>
  <array>
${programArgumentsXml}
  </array>

  <key>StartCalendarInterval</key>
${calendarXml(job.schedule)}

  <key>StandardOutPath</key>
  <string>${escapePlistString(logPath)}</string>

  <key>StandardErrorPath</key>
  <string>${escapePlistString(logPath)}</string>

  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>`
}

export function createLaunchdAdapter(deps: AdapterDeps): SchedulerAdapter {
  const { runner, files } = deps
  const launchAgentsDir = deps.launchAgentsDir ?? posixJoin("Library", "LaunchAgents")

  const scopedPlistPath = (jobId: string, workdir?: string): string => {
    const scopeId = deriveScopeId(workdir ?? "/")
    return posixJoin(launchAgentsDir, `${LAUNCHD_PREFIX}.${scopeId}.${fenceJobName(jobId)}.plist`)
  }
  const legacyPlistPath = (jobId: string): string =>
    posixJoin(launchAgentsDir, `${LAUNCHD_PREFIX}.${fenceJobName(jobId)}.plist`)

  const unload = async (path: string): Promise<void> => {
    try {
      await runner.exec("launchctl", ["unload", path])
    } catch {
      // v1 parity: unloading a not-loaded plist is not an error.
    }
  }

  return {
    id: "launchd",

    async isAvailable() {
      return runner.available("launchctl", ["version"])
    },

    async install(job: AdapterJob) {
      const scopeId = deriveScopeId(job.workdir ?? "/")
      const plistPath = scopedPlistPath(job.id, job.workdir)

      await unload(plistPath)
      await files.writeFile(plistPath, createLaunchdPlist(job, scopeId))
      await runner.exec("launchctl", ["load", plistPath])
    },

    async uninstall(jobId: string, workdir?: string) {
      for (const path of [scopedPlistPath(jobId, workdir), legacyPlistPath(jobId)]) {
        await unload(path)
        await files.remove(path)
      }
    },
  }
}
