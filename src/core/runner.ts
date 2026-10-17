// Impure spawn adapter: turns a job + invocation into a supervised child
// process, piping output into the scoped job log and forcing v1's
// non-interactive permission baseline.

import { spawn, type ChildProcess } from "child_process"
import { createWriteStream } from "fs"
import { runSupervised, type SupervisedOutcome } from "./supervisor"
import { buildOpencodeArgs, resolveJobEnv, type Invocation } from "./invocation"
import type { JobDefinition } from "./config"
import { buildWindowsCommand } from "../util/spawn"

export function jobInvocation(job: JobDefinition, opencodePath: string): Invocation {
  return buildOpencodeArgs(job, opencodePath)
}

/** v1 buildRunEnvironment baseline: scheduled runs never block on questions. */
export function buildRunEnvironment(job: JobDefinition): NodeJS.ProcessEnv {
  const basePolicy: Record<string, unknown> = { question: "deny" }

  let mergedPolicy: Record<string, unknown> = basePolicy
  const raw = process.env.OPENCODE_PERMISSION
  if (raw) {
    try {
      const existing = JSON.parse(raw) as unknown
      if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
        mergedPolicy = { ...(existing as Record<string, unknown>), ...basePolicy }
      }
    } catch {
      // Malformed existing policy falls back to the safe baseline.
    }
  }

  return {
    ...process.env,
    ...resolveJobEnv(job, process.env),
    OPENCODE_PERMISSION: JSON.stringify(mergedPolicy),
  }
}

export interface SpawnRunOptions {
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  cwd?: string
  logPath?: string
}

export async function spawnSupervisedRun(
  invocation: Invocation,
  options: SpawnRunOptions = {}
): Promise<SupervisedOutcome> {
  const logStream = options.logPath ? createWriteStream(options.logPath, { flags: "a" }) : undefined
  logStream?.write(`\n=== Scheduled run ${new Date().toISOString()} ===\n`)

  let child: ChildProcess
  try {
    child = spawnChild(invocation, options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logStream?.write(`\n=== Run error ${new Date().toISOString()} ===\n${message}\n`)
    logStream?.end()
    return { status: "failed", exitCode: null, error: message, timedOut: false }
  }

  if (logStream) {
    child.stdout?.pipe(logStream)
    child.stderr?.pipe(logStream)
    child.on("close", () => logStream.end())
  } else {
    child.stdout?.resume()
    child.stderr?.resume()
  }

  const outcome = await runSupervised(() => child, { timeoutMs: options.timeoutMs })
  return outcome
}

function spawnChild(invocation: Invocation, options: SpawnRunOptions): ChildProcess {
  const { command, args } = invocation

  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    // .cmd/.bat targets need cmd.exe; route through the hardened builder and
    // fail closed on anything that cannot be made inert for the wrapper.
    const commandLine = buildWindowsCommand({ command, args })
    return spawn("cmd.exe", ["/c", commandLine], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
  }

  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
}
