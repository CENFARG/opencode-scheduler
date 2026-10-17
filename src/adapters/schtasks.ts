// Windows Task Scheduler adapter: ports the v1 cron-subset mapping and the
// fix-branch binary resolution + cmd /c output redirect, hardened through
// util/spawn, with fenced task names (P1 item 9).

import { homedir } from "os"
import { join } from "path"
import { parseCronField, splitCronExpression } from "../core/cron"
import { buildWindowsCommand } from "../util/spawn"
import {
  deriveScopeId,
  fenceJobName,
  type AdapterDeps,
  type AdapterJob,
  type CommandRunner,
  type SchedulerAdapter,
} from "./index"

const WINDOWS_TASK_ROOT = "\\OpenCode"
const WINDOWS_TASK_PREFIX = "opencode-job"
const MAX_TASK_VARIANTS = 64

const WINDOWS_WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
const WINDOWS_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

export interface WindowsCronPlan {
  schedule: "MINUTE" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY"
  modifier?: string
  weekdays?: string
  days?: string
  months?: string
  startTime: string
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0")
}

function formatStartTime(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`
}

function maybeStep(field: string): number | null {
  const match = field.match(/^\*\/(\d+)$/)
  if (!match) return null
  const step = parseInt(match[1] ?? "", 10)
  return Number.isFinite(step) && step > 0 ? step : null
}

/** Verbatim port of v1 ensureWindowsRepresentable. */
export function cronToWindowsPlans(cron: string): WindowsCronPlan[] {
  const [minuteField, hourField, dayField, monthField, weekdayField] = splitCronExpression(cron)

  const minuteStep = maybeStep(minuteField)
  const hourStep = maybeStep(hourField)

  if (minuteField === "*" && hourField === "*" && dayField === "*" && monthField === "*" && weekdayField === "*") {
    return [{ schedule: "MINUTE", modifier: "1", startTime: "00:00" }]
  }

  if (minuteStep !== null && hourField === "*" && dayField === "*" && monthField === "*" && weekdayField === "*") {
    if (minuteStep > 1439) {
      throw new Error(
        `Windows Task Scheduler supports at most every 1439 minutes. Use ${minuteStep} with a smaller value or switch to an hourly/daily cron.`
      )
    }
    return [{ schedule: "MINUTE", modifier: String(minuteStep), startTime: "00:00" }]
  }

  const minuteValues = parseCronField(minuteField, 0, 59, "minute")
  const hourValues = parseCronField(hourField, 0, 23, "hour")
  const dayValues = parseCronField(dayField, 1, 31, "day of month")
  const monthValues = parseCronField(monthField, 1, 12, "month")
  const weekdayValues = parseCronField(weekdayField, 0, 7, "day of week", true)

  if (
    hourStep !== null &&
    minuteValues &&
    minuteValues.length === 1 &&
    dayField === "*" &&
    monthField === "*" &&
    weekdayField === "*"
  ) {
    return [{ schedule: "HOURLY", modifier: String(hourStep), startTime: formatStartTime(0, minuteValues[0] ?? 0) }]
  }

  if (!minuteValues || minuteValues.length === 0 || !hourValues || hourValues.length === 0) {
    throw new Error(
      "Windows Task Scheduler requires explicit minute and hour values for this cron expression. Use formats like '0 9 * * *', '30 8 * * 1', '*/15 * * * *', or '0 */6 * * *'."
    )
  }

  if (monthValues && weekdayValues) {
    throw new Error(
      "Windows Task Scheduler cannot combine specific months with day-of-week constraints in cron. Split this into multiple jobs (for example: one monthly job and one weekly job)."
    )
  }

  if (monthValues && !dayValues) {
    throw new Error(
      "Windows Task Scheduler cannot represent 'every day in selected months'. Use explicit day-of-month values (for example '0 9 1,15 1,7 *') or create separate jobs."
    )
  }

  const plans: WindowsCronPlan[] = []
  for (const minute of minuteValues) {
    for (const hour of hourValues) {
      const startTime = formatStartTime(hour, minute)

      if (dayValues && weekdayValues) {
        plans.push({
          schedule: "MONTHLY",
          days: dayValues.join(","),
          months: monthValues
            ? monthValues.map((value) => WINDOWS_MONTHS[value - 1] ?? "*").join(",")
            : undefined,
          startTime,
        })
        plans.push({
          schedule: "WEEKLY",
          weekdays: weekdayValues.map((value) => WINDOWS_WEEKDAYS[value]).join(","),
          startTime,
        })
      } else if (weekdayValues) {
        plans.push({
          schedule: "WEEKLY",
          weekdays: weekdayValues.map((value) => WINDOWS_WEEKDAYS[value]).join(","),
          startTime,
        })
      } else if (dayValues) {
        plans.push({
          schedule: "MONTHLY",
          days: dayValues.join(","),
          months: monthValues
            ? monthValues.map((value) => WINDOWS_MONTHS[value - 1] ?? "*").join(",")
            : undefined,
          startTime,
        })
      } else if (monthValues) {
        throw new Error(
          "Windows Task Scheduler cannot represent month-only cron constraints without day-of-month. Use explicit days or create separate jobs."
        )
      } else {
        plans.push({ schedule: "DAILY", startTime })
      }
    }
  }

  return plans
}

export function windowsTaskBaseName(scopeId: string, jobId: string): string {
  return `${WINDOWS_TASK_PREFIX}-${scopeId}-${fenceJobName(jobId)}`
}

export function windowsTaskName(baseName: string, index: number, total: number): string {
  const suffix = total > 1 ? `-${index + 1}` : ""
  return `${WINDOWS_TASK_ROOT}\\${baseName}${suffix}`
}

export function buildWindowsTaskArgs(options: {
  taskName: string
  commandLine: string
  plan: WindowsCronPlan
}): string[] {
  const { taskName, commandLine, plan } = options
  const args = ["/Create", "/F", "/TN", taskName, "/TR", commandLine, "/SC", plan.schedule]

  if (plan.modifier) {
    args.push("/MO", plan.modifier)
  }

  if (plan.weekdays) {
    args.push("/D", plan.weekdays)
  }

  if (plan.days) {
    args.push("/D", plan.days)
  }

  if (plan.months) {
    args.push("/M", plan.months)
  }

  args.push("/ST", plan.startTime)
  return args
}

export function scopedLogPath(scopeId: string, jobId: string, logsRoot: string): string {
  return join(logsRoot, "scheduler", scopeId, `${fenceJobName(jobId)}.log`)
}

/** Verbatim port of the v1 fix-branch enhanced Windows PATH. */
export function enhancedWindowsPath(
  env: Record<string, string | undefined>,
  home: string
): string {
  const systemRoot = env.SystemRoot ?? "C:\\Windows"
  const scoopDir = env.SCOOP ?? join(home, "scoop")
  const dirs = [
    join(systemRoot, "System32"),
    join(scoopDir, "shims"),
    ...(env.APPDATA ? [join(env.APPDATA, "npm")] : []),
    ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "Programs", "opencode", "bin")] : []),
    join(home, ".opencode", "bin"),
  ]
  return dirs.join(";")
}

export interface WindowsBinaryResolution {
  runner: CommandRunner
  env: Record<string, string | undefined>
  home: string
  fileExists(path: string): boolean
}

/**
 * Verbatim port of the v1 fix branch (fix/windows-schtasks-binary-resolution):
 * where.exe over the enhanced PATH, then well-known install locations, then
 * the bare binary name.
 */
export async function findOpencodeWindows(resolution: WindowsBinaryResolution): Promise<string> {
  const { runner, env, home, fileExists } = resolution

  const override = env.OPENCODE_SCHEDULER_OPENCODE_PATH?.trim()
  if (override) return override

  try {
    const resolved = await runner.exec("where.exe", ["opencode"])
    const firstLine = resolved
      .toString()
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0)
    if (firstLine) return firstLine
  } catch {
    // where.exe missed — fall through to well-known locations.
  }

  const scoopDir = env.SCOOP ?? join(home, "scoop")
  const candidates = [
    join(scoopDir, "shims", "opencode.exe"),
    ...(env.APPDATA ? [join(env.APPDATA, "npm", "opencode.cmd")] : []),
    ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "Programs", "opencode", "bin", "opencode.exe")] : []),
    join(home, ".opencode", "bin", "opencode"),
    join(home, ".opencode", "bin", "opencode.exe"),
  ]
  for (const candidate of candidates) {
    if (fileExists(candidate)) return candidate
  }
  return "opencode"
}

export function createSchtasksAdapter(deps: AdapterDeps): SchedulerAdapter {
  const { runner } = deps

  return {
    id: "schtasks",

    async isAvailable() {
      return runner.available("schtasks", ["/?"])
    },

    async install(job: AdapterJob) {
      const plans = cronToWindowsPlans(job.schedule)
      const scopeId = deriveScopeId(job.workdir ?? homedir())
      const baseName = windowsTaskBaseName(scopeId, job.id)
      const commandLine = buildWindowsCommand({
        command: job.command,
        args: job.args,
        logPath: job.logPath,
      })

      for (const [index, plan] of plans.entries()) {
        const taskName = windowsTaskName(baseName, index, plans.length)
        await runner.exec("schtasks", buildWindowsTaskArgs({ taskName, commandLine, plan }))
      }
    },

    async uninstall(jobId: string, workdir?: string) {
      const scopeId = deriveScopeId(workdir ?? homedir())
      const scopedBase = windowsTaskBaseName(scopeId, jobId)
      const legacyBase = `${WINDOWS_TASK_PREFIX}-${fenceJobName(jobId)}`

      const candidates = new Set<string>()
      for (let index = 0; index < MAX_TASK_VARIANTS; index += 1) {
        const suffix = index === 0 ? "" : `-${index + 1}`
        candidates.add(`${WINDOWS_TASK_ROOT}\\${scopedBase}${suffix}`)
        candidates.add(`${WINDOWS_TASK_ROOT}\\${legacyBase}${suffix}`)
      }

      for (const taskName of candidates) {
        try {
          await runner.exec("schtasks", ["/Delete", "/TN", taskName, "/F"])
        } catch {
          // v1 parity: deleting a non-existent variant is not an error.
        }
      }
    },
  }
}
