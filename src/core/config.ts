// Job definition parsing/validation (v1-compatible semantics where feasible),
// per-job unattended permission rules (ask = deny), and env-reference-only
// environment config (no inline secrets).

import { parseCronExpression, type CatchUpPolicy } from "./cron"

export type OpencodeRunFormat = "default" | "json"

export interface JobRunSpec {
  prompt?: string
  command?: string
  arguments?: string
  files?: string[]
  agent?: string
  model?: string
  variant?: string
  title?: string
  share?: boolean
  continue?: boolean
  session?: string
  runFormat?: OpencodeRunFormat
  attachUrl?: string
  port?: number
}

export interface JobPermissions {
  allow?: string[]
  deny?: string[]
}

export interface JobDefinition {
  id: string
  name: string
  schedule: string
  run?: JobRunSpec
  prompt?: string
  timeoutSeconds?: number
  workdir?: string
  source?: string
  permissions?: JobPermissions
  env?: Record<string, string>
  catchUp?: CatchUpPolicy
  catchUpMaxSeconds?: number
  jitterSeconds?: number
  activeUntil?: string
}

export type PermissionDecision = "allow" | "deny"

const ENV_REF_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/
const CATCH_UP_POLICIES: CatchUpPolicy[] = ["fire-late-capped", "most-recent", "skip"]

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

export function parseJobDefinition(raw: unknown): JobDefinition {
  if (!isRecord(raw)) {
    throw new Error("job definition must be an object")
  }

  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  if (!name) {
    throw new Error("job definition requires a name")
  }

  const schedule = typeof raw.schedule === "string" ? raw.schedule.trim() : ""
  if (!schedule) {
    throw new Error("job definition requires a schedule")
  }
  // Propagates the v1 cron messages on invalid expressions.
  parseCronExpression(schedule)

  const id = optionalString(raw.id) ?? slugify(name)
  if (!id) {
    throw new Error("job definition requires a non-empty id")
  }

  const job: JobDefinition = { id, name, schedule }

  if (typeof raw.prompt === "string") {
    const trimmed = raw.prompt.trim()
    if (trimmed) job.prompt = trimmed
  }

  if (raw.run !== undefined) {
    if (!isRecord(raw.run)) {
      throw new Error("run must be an object")
    }
    // v1 creation-path strictness: an explicit invalid runFormat is rejected
    // with the parseRunFormatInput message (not silently dropped).
    if (typeof raw.run.runFormat === "string" && raw.run.runFormat.trim()) {
      const normalized = raw.run.runFormat.trim()
      if (normalized !== "json" && normalized !== "default") {
        throw new Error(`Invalid runFormat: ${raw.run.runFormat} (expected: default | json)`)
      }
    }
    const run = normalizeRunSpec(raw.run as JobRunSpec)
    validateRunSpec(run)
    job.run = run
  }

  // v1 fallback semantics: a job body comes from run or the legacy prompt.
  if (!job.run && !job.prompt) {
    throw new Error(`Job "${id}" is missing a prompt. Update the job to include run.prompt or prompt.`)
  }

  if (raw.timeoutSeconds !== undefined) {
    const n = raw.timeoutSeconds
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
      throw new Error("timeoutSeconds must be a non-negative integer")
    }
    job.timeoutSeconds = n
  }

  const workdir = optionalString(raw.workdir)
  if (workdir) job.workdir = workdir

  const source = optionalString(raw.source)
  if (source) job.source = source

  if (raw.permissions !== undefined) {
    job.permissions = parsePermissions(raw.permissions)
  }

  if (raw.env !== undefined) {
    job.env = parseEnvReferences(raw.env)
  }

  if (raw.catchUp !== undefined) {
    if (typeof raw.catchUp !== "string" || !CATCH_UP_POLICIES.includes(raw.catchUp as CatchUpPolicy)) {
      throw new Error("catchUp must be one of: fire-late-capped, most-recent, skip")
    }
    job.catchUp = raw.catchUp as CatchUpPolicy
  }

  if (raw.catchUpMaxSeconds !== undefined) {
    const n = raw.catchUpMaxSeconds
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
      throw new Error("catchUpMaxSeconds must be a positive integer")
    }
    job.catchUpMaxSeconds = n
  }

  if (raw.jitterSeconds !== undefined) {
    const n = raw.jitterSeconds
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
      throw new Error("jitterSeconds must be a non-negative integer")
    }
    job.jitterSeconds = n
  }

  if (raw.activeUntil !== undefined) {
    if (typeof raw.activeUntil !== "string" || Number.isNaN(new Date(raw.activeUntil).getTime())) {
      throw new Error("activeUntil must be a valid ISO date string")
    }
    job.activeUntil = raw.activeUntil
  }

  return job
}

function parsePermissions(raw: unknown): JobPermissions {
  if (!isRecord(raw)) {
    throw new Error("permissions must be an object with allow/deny arrays")
  }
  const permissions: JobPermissions = {}
  for (const key of ["allow", "deny"] as const) {
    const value = raw[key]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.some((rule) => typeof rule !== "string" || !rule.trim())) {
      throw new Error(`permissions.${key} must be an array of non-empty strings`)
    }
    permissions[key] = value.map((rule) => rule.trim())
  }
  return permissions
}

function parseEnvReferences(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) {
    throw new Error("env must be an object of variable references")
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string" || !ENV_REF_PATTERN.test(value)) {
      throw new Error(
        `env.${key} must be an environment variable reference (e.g. \${VAR_NAME}); inline values are not allowed`
      )
    }
    env[key] = value
  }
  return env
}

export function resolveJobRun(job: JobDefinition): JobRunSpec {
  if (job.run) {
    return job.run
  }

  const fallbackPrompt = (job.prompt ?? "").trim()
  if (!fallbackPrompt) {
    throw new Error(`Job "${job.id}" is missing a prompt. Update the job to include run.prompt or prompt.`)
  }

  return { prompt: fallbackPrompt }
}

export function validateRunSpec(run: JobRunSpec): void {
  const hasPrompt = typeof run.prompt === "string" && run.prompt.trim().length > 0
  const hasCommand = typeof run.command === "string" && run.command.trim().length > 0

  if (!hasPrompt && !hasCommand) {
    throw new Error("Job must have either run.prompt or run.command")
  }

  if (hasPrompt && hasCommand) {
    throw new Error("Job cannot specify both run.prompt and run.command")
  }

  if (hasCommand && run.arguments !== undefined && typeof run.arguments !== "string") {
    throw new Error("run.arguments must be a string")
  }

  if (run.attachUrl !== undefined) {
    normalizeAttachUrl(run.attachUrl)
  }

  if (run.port !== undefined) {
    if (!Number.isFinite(run.port) || run.port <= 0) {
      throw new Error("run.port must be a positive integer")
    }
  }

  if (run.runFormat !== undefined && run.runFormat !== "default" && run.runFormat !== "json") {
    throw new Error("run.runFormat must be 'default' or 'json'")
  }
}

function normalizeAttachUrl(attachUrl?: string): string | undefined {
  if (attachUrl === undefined) return undefined
  const trimmed = attachUrl.trim()
  if (!trimmed) return undefined
  try {
    new URL(trimmed)
  } catch {
    throw new Error(`Invalid attach URL: ${attachUrl}`)
  }
  return trimmed
}

// Mirrors v1 normalizeRunSpec: trims string fields, drops empty values,
// coerces optional flags.
function normalizeRunSpec(run: JobRunSpec): JobRunSpec {
  const normalized: JobRunSpec = { ...run }

  for (const key of ["prompt", "command", "arguments", "agent", "model", "variant", "title", "session"] as const) {
    const value = normalized[key]
    if (typeof value === "string") {
      const trimmed = value.trim()
      normalized[key] = trimmed ? trimmed : undefined
    }
  }

  if (Array.isArray(normalized.files)) {
    const files = normalized.files.map((file) => String(file).trim()).filter(Boolean)
    normalized.files = files.length ? files : undefined
  }

  if (normalized.share !== true) normalized.share = undefined
  if (normalized.continue !== true) normalized.continue = undefined

  if (typeof normalized.attachUrl === "string") {
    const trimmed = normalized.attachUrl.trim()
    normalized.attachUrl = trimmed ? trimmed : undefined
  }

  if (typeof normalized.port === "number" && Number.isFinite(normalized.port)) {
    normalized.port = Math.floor(normalized.port)
    if (normalized.port <= 0) normalized.port = undefined
  } else {
    normalized.port = undefined
  }

  return normalized
}

function matchesRule(rule: string, toolName: string): boolean {
  if (rule.endsWith(":*")) {
    const prefix = rule.slice(0, -1) // "bash:*" -> "bash:"
    return toolName === rule.slice(0, -2) || toolName.startsWith(prefix)
  }
  return rule === toolName
}

/**
 * Unattended permission resolution (P0): rules are bare tool names or "tool:*"
 * prefixes, evaluated deny-first with default deny. Rules written as
 * "ask:<tool>" express interactive approval — unattended runs have nobody to
 * ask, so ask rules are treated as deny no matter which list they sit in.
 */
export function evaluateToolPermission(job: JobDefinition, toolName: string): PermissionDecision {
  const permissions = job.permissions
  if (!permissions) return "deny"

  const allowRules = permissions.allow ?? []
  const denyRules = [
    ...(permissions.deny ?? []).map(stripAsk),
    ...allowRules.filter((rule) => rule.startsWith("ask:")).map((rule) => rule.slice(4)),
  ]

  for (const rule of denyRules) {
    if (matchesRule(rule, toolName)) return "deny"
  }
  for (const rule of allowRules.filter((rule) => !rule.startsWith("ask:"))) {
    if (matchesRule(rule, toolName)) return "allow"
  }
  return "deny"
}

function stripAsk(rule: string): string {
  return rule.startsWith("ask:") ? rule.slice(4) : rule
}
