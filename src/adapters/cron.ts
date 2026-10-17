// crontab adapter: v1 managed-block format (BEGIN/END markers, scoped and
// legacy block ids) with the opencode binary executed directly.
// NOT host-testable on this Windows machine: tests use mocked commands/files.

import { join as posixJoin } from "path/posix"
import { shellEscapeDoubleQuoted } from "./shell"
import {
  deriveScopeId,
  fenceJobName,
  type AdapterDeps,
  type AdapterJob,
  type SchedulerAdapter,
} from "./index"

const CRON_MANAGED_PREFIX = "opencode-scheduler"

/** v1 getEnhancedPath for POSIX systems. */
export function enhancedPosixPath(): string {
  return ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":")
}

function cronBlockId(jobId: string, workdir?: string): string {
  return `${deriveScopeId(workdir ?? "/")}:${fenceJobName(jobId)}`
}

function cronLegacyBlockId(jobId: string): string {
  return `legacy:${fenceJobName(jobId)}`
}

function cronBlockStart(id: string): string {
  return `# BEGIN ${CRON_MANAGED_PREFIX} ${id}`
}

function cronBlockEnd(id: string): string {
  return `# END ${CRON_MANAGED_PREFIX} ${id}`
}

/** Verbatim port of v1 stripManagedCronBlocks. */
export function stripManagedCronBlocks(content: string, blockIds: Set<string>): { content: string; removed: number } {
  const lines = content ? content.split(/\r?\n/) : []
  const retained: string[] = []
  const prefix = `# BEGIN ${CRON_MANAGED_PREFIX} `
  const endPrefix = `# END ${CRON_MANAGED_PREFIX} `
  let removed = 0

  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? ""
    if (!line.startsWith(prefix)) {
      retained.push(line)
      index += 1
      continue
    }

    const id = line.slice(prefix.length).trim()
    let endIndex = lines.length - 1
    for (let probe = index + 1; probe < lines.length; probe += 1) {
      if (lines[probe] === `${endPrefix}${id}`) {
        endIndex = probe
        break
      }
    }

    if (blockIds.has(id)) {
      removed += 1
    } else {
      for (let keep = index; keep <= endIndex; keep += 1) {
        retained.push(lines[keep] ?? "")
      }
    }

    index = endIndex + 1
  }

  return {
    content: retained.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd(),
    removed,
  }
}

function createCronEntry(job: AdapterJob): string {
  const escapedPath = shellEscapeDoubleQuoted(enhancedPosixPath())
  const commandLine = [job.command, ...job.args]
    .map((arg) => `"${shellEscapeDoubleQuoted(arg)}"`)
    .join(" ")
  const logPath = job.logPath ?? "/dev/null"
  return `${job.schedule} PATH="${escapedPath}" ${commandLine} >> "${shellEscapeDoubleQuoted(logPath)}" 2>&1`
}

export function createCronAdapter(deps: AdapterDeps): SchedulerAdapter {
  const { runner } = deps

  const readUserCrontab = async (): Promise<string> => {
    try {
      return await runner.exec("crontab", ["-l"])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/no crontab/i.test(message)) return ""
      throw error
    }
  }

  const writeUserCrontab = async (content: string): Promise<void> => {
    const normalized = content.trim()
    await runner.exec("crontab", ["-"], { input: normalized ? `${normalized}\n` : "" })
  }

  return {
    id: "cron",

    async isAvailable() {
      return runner.available("crontab", ["-l"])
    },

    async install(job: AdapterJob) {
      const blockId = cronBlockId(job.id, job.workdir)
      const current = await readUserCrontab()
      const stripped = stripManagedCronBlocks(current, new Set([blockId, cronLegacyBlockId(job.id)]))
      const block = [cronBlockStart(blockId), createCronEntry(job), cronBlockEnd(blockId)].join("\n")
      const next = [stripped.content.trim(), block].filter(Boolean).join("\n\n")
      await writeUserCrontab(next)
    },

    async uninstall(jobId: string, workdir?: string) {
      const current = await readUserCrontab()
      const stripped = stripManagedCronBlocks(
        current,
        new Set([cronBlockId(jobId, workdir), cronLegacyBlockId(jobId)])
      )
      if (stripped.removed === 0) return
      await writeUserCrontab(stripped.content)
    },
  }
}

/** Exposed for tests and future diagnostics. */
export const cronAdapterPaths = { managedPrefix: CRON_MANAGED_PREFIX, join: posixJoin }
