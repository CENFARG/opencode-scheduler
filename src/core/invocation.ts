// Job invocation (v1 parity): a job definition becomes an `opencode run`
// command line with the exact v1 flag order, plus the fire-time environment
// resolution for env-reference-only job envs.

import type { JobDefinition } from "./config"

export interface Invocation {
  command: string
  args: string[]
}

export function buildOpencodeArgs(job: JobDefinition, opencodePath: string): Invocation {
  const run = job.run ?? { prompt: job.prompt ?? "" }
  const args: string[] = ["run"]

  if (run.attachUrl) {
    args.push("--attach", run.attachUrl)
  }

  if (run.port !== undefined) {
    args.push("--port", String(run.port))
  }

  if (run.command) {
    args.push("--command", run.command)
  }

  if (run.agent) {
    args.push("--agent", run.agent)
  }

  if (run.model) {
    args.push("--model", run.model)
  }

  if (run.variant) {
    args.push("--variant", run.variant)
  }

  if (run.runFormat) {
    args.push("--format", run.runFormat)
  }

  if (run.share) {
    args.push("--share")
  }

  if (run.title) {
    args.push("--title", run.title)
  }

  if (run.continue) {
    args.push("--continue")
  }

  if (run.session) {
    args.push("--session", run.session)
  }

  for (const file of run.files ?? []) {
    args.push("--file", file)
  }

  args.push("--")
  args.push(run.command ? run.arguments ?? "" : run.prompt ?? "")

  return { command: opencodePath, args }
}

/**
 * Resolves env-reference-only job env at fire time (P0: no inline secrets).
 * Unset variables resolve to nothing — placeholders never leak into runs.
 */
export function resolveJobEnv(
  job: JobDefinition,
  processEnv: Record<string, string | undefined>
): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const [key, reference] of Object.entries(job.env ?? {})) {
    const name = reference.replace(/^\$\{?|\}$/g, "")
    const value = processEnv[name]
    if (value !== undefined) {
      resolved[key] = value
    }
  }
  return resolved
}
