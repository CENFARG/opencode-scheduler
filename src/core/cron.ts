// 5-field cron parsing, next-fire computation, jitter and catch-up policies.
// Field semantics are v1-compatible (subset): "*", "*/step", comma lists and
// single values; day-of-week 0-7 with 7 normalized to Sunday. Ranges are not
// part of the v1 subset and are rejected with the v1 error messages.

export interface CronFields {
  minute: number[] | null
  hour: number[] | null
  dayOfMonth: number[] | null
  month: number[] | null
  dayOfWeek: number[] | null
}

export type CatchUpPolicy = "fire-late-capped" | "most-recent" | "skip"

export interface PlannedFire {
  fire: Date
  catchUp: boolean
}

/** ~8 years of day scans: covers every representable combination incl. leap years. */
const MAX_DAY_SCAN = 2922

export function splitCronExpression(cron: string): [string, string, string, string, string] {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`Invalid cron: ${cron}`)
  }
  return parts as [string, string, string, string, string]
}

function uniqueSorted(values: number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b)
}

export function parseCronField(
  field: string,
  min: number,
  max: number,
  label: string,
  allowSundaySeven = false
): number[] | null {
  if (field === "*") return null

  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10)
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error(`Invalid cron ${label} step: ${field}`)
    }
    const values: number[] = []
    for (let value = min; value <= max; value += step) {
      values.push(value)
    }
    return values
  }

  const parts = field.split(",")
  if (parts.length > 1) {
    const values = parts.map((part) => parseCronNumber(part, min, max, label, allowSundaySeven))
    return uniqueSorted(values)
  }

  if (/^\d+$/.test(field)) {
    return [parseCronNumber(field, min, max, label, allowSundaySeven)]
  }

  throw new Error(`Invalid cron ${label} field: ${field}`)
}

function parseCronNumber(
  value: string,
  min: number,
  max: number,
  label: string,
  allowSundaySeven: boolean
): number {
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid cron ${label} value: ${value}`)
  }
  const normalized = allowSundaySeven && parsed === 7 ? 0 : parsed
  if (normalized < min || normalized > max) {
    throw new Error(`Invalid cron ${label} value: ${value}`)
  }
  return normalized
}

export function parseCronExpression(cron: string): CronFields {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = splitCronExpression(cron)
  return {
    minute: parseCronField(minute, 0, 59, "minute"),
    hour: parseCronField(hour, 0, 23, "hour"),
    dayOfMonth: parseCronField(dayOfMonth, 1, 31, "day of month"),
    month: parseCronField(month, 1, 12, "month"),
    dayOfWeek: parseCronField(dayOfWeek, 0, 7, "day of week", true),
  }
}

export function nextFire(cron: string, after: Date): Date {
  const fields = parseCronExpression(cron)
  const cursor = new Date(after.getFullYear(), after.getMonth(), after.getDate())

  for (let scanned = 0; scanned < MAX_DAY_SCAN; scanned += 1) {
    if (monthMatches(fields, cursor.getMonth()) && dayMatches(fields, cursor)) {
      const fire = firstMinuteOfDay(fields, cursor, after)
      if (fire) return fire
    }
    cursor.setDate(cursor.getDate() + 1)
  }

  throw new Error(`cron expression never matches: ${cron}`)
}

function monthMatches(fields: CronFields, monthIndex: number): boolean {
  return fields.month === null || fields.month.includes(monthIndex + 1)
}

function dayMatches(fields: CronFields, day: Date): boolean {
  const domOk = fields.dayOfMonth === null || fields.dayOfMonth.includes(day.getDate())
  const dowOk = fields.dayOfWeek === null || fields.dayOfWeek.includes(day.getDay())
  // Standard cron: when both day fields are restricted, either may match.
  if (fields.dayOfMonth !== null && fields.dayOfWeek !== null) return domOk || dowOk
  return domOk && dowOk
}

function firstMinuteOfDay(fields: CronFields, day: Date, after: Date): Date | null {
  const sameDay = day.toDateString() === after.toDateString()
  for (let hour = sameDay ? after.getHours() : 0; hour <= 23; hour += 1) {
    if (fields.hour !== null && !fields.hour.includes(hour)) continue
    const minuteStart = sameDay && hour === after.getHours() ? after.getMinutes() + 1 : 0
    for (let minute = minuteStart; minute <= 59; minute += 1) {
      if (fields.minute !== null && !fields.minute.includes(minute)) continue
      return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute)
    }
  }
  return null
}

export function upcomingFires(cron: string, windowStart: Date, windowEnd: Date, limit = 24): Date[] {
  const fires: Date[] = []
  if (windowEnd.getTime() <= windowStart.getTime()) return fires

  let cursor = nextFire(cron, windowStart)
  while (cursor.getTime() <= windowEnd.getTime() && fires.length < limit) {
    fires.push(cursor)
    cursor = nextFire(cron, cursor)
  }
  return fires
}

export function addJitter(fire: Date, jitterSeconds: number, random: () => number = Math.random): Date {
  if (!Number.isFinite(jitterSeconds) || jitterSeconds <= 0) return fire
  const offsetMs = Math.floor(random() * jitterSeconds * 1000)
  return new Date(fire.getTime() + offsetMs)
}

export function planCatchUp(
  policy: CatchUpPolicy,
  missed: Date[],
  now: Date,
  maxLateSeconds: number
): PlannedFire[] {
  const sorted = [...missed].sort((a, b) => a.getTime() - b.getTime())

  if (policy === "skip") return []

  if (policy === "most-recent") {
    const latest = sorted[sorted.length - 1]
    if (!latest) return []
    return [{ fire: latest, catchUp: sorted.length > 1 }]
  }

  // fire-late-capped (inclusive cap)
  const capMs = Math.max(0, maxLateSeconds) * 1000
  return sorted
    .filter((fire) => now.getTime() - fire.getTime() <= capMs)
    .map((fire) => ({ fire, catchUp: true }))
}
