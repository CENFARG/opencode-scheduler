/**
 * opencode-scheduler v2 — native OpenCode v2 plugin entry.
 * Timer inside setup() (official background pattern) drives the scheduling
 * engine; cleanup clears the timer and aborts the event subscription.
 */
import { appendFileSync, mkdirSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { Plugin } from "@opencode/plugin"
import { createAuditLog } from "./core/audit"
import { parseJobDefinition, type JobDefinition } from "./core/config"
import { isOwnIdleEvent, runTick, type EngineDeps } from "./core/engine"
import { buildRunEnvironment, jobInvocation, spawnSupervisedRun } from "./core/runner"
import { resolveOpencodeBinary } from "./adapters/binary"
import { deriveScopeId } from "./adapters"

const TICK_INTERVAL_MS = 30_000
const SCHEDULER_DIR = join(homedir(), ".config", "opencode", "scheduler")
const AUDIT_PATH = join(SCHEDULER_DIR, "audit-v2.jsonl")
const LOGS_ROOT = join(homedir(), ".config", "opencode", "logs")

export const SchedulerPlugin = Plugin.define({
  id: "opencode-scheduler",

  async setup(ctx) {
    const audit = createAuditLog({
      append: (line) => {
        try {
          mkdirSync(SCHEDULER_DIR, { recursive: true })
          appendFileSync(AUDIT_PATH, line)
        } catch {
          // Audit failures must never break scheduling; the OS log still exists.
        }
      },
    })

    const jobs: JobDefinition[] = []
    const rawJobs = Array.isArray(ctx.options.jobs) ? ctx.options.jobs : []
    for (const raw of rawJobs) {
      try {
        jobs.push(parseJobDefinition(raw))
      } catch (error) {
        audit.log({ kind: "skip", reason: `invalid-config: ${error instanceof Error ? error.message : String(error)}` })
      }
    }

    const storage = {      get: (key: string) => ctx.storage.get(key),
      set: (key: string, value: unknown) => ctx.storage.set(key, value as never),
      remove: (key: string) => ctx.storage.remove(key),
      scan: (options: { prefix: string; after?: string; limit?: number }) => ctx.storage.scan(options),
    }

    const opencodePath = await resolveOpencodeBinary()
    const spawnJob: EngineDeps["spawnJob"] = async (job, _runId) =>
      spawnSupervisedRun(jobInvocation(job, opencodePath), {
        timeoutMs: job.timeoutSeconds ? job.timeoutSeconds * 1000 : undefined,
        env: buildRunEnvironment(job),
        cwd: job.workdir,
        logPath: join(LOGS_ROOT, "scheduler", deriveScopeId(job.workdir ?? homedir()), `${job.id}.log`),
      })

    let ticking = false
    const tick = async (): Promise<void> => {
      if (ticking) return
      ticking = true
      try {
        await runTick({ jobs, storage, audit, spawnJob }, new Date())
      } catch (error) {
        audit.log({ kind: "skip", reason: `tick-error: ${error instanceof Error ? error.message : String(error)}` })
      } finally {
        ticking = false
      }
    }

    const timer = setInterval(() => void tick(), TICK_INTERVAL_MS)
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const envelope = event as { type?: string }
          if (envelope.type === "session.idle" && isOwnIdleEvent(event, ctx.location.directory)) {
            await tick()
          }
        }
      } catch {
        // Subscription ended (shutdown or transport close); timer still ticks.
      }
    })()
    void tick()

    return () => {
      clearInterval(timer)
      controller.abort()
    }
  },
})

export default SchedulerPlugin
