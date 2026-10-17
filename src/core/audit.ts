// Append-only audit log: one line per scheduling call/firing/skip with reason
// (research REC.6). Redaction is applied before serialization so secrets from
// job definitions never reach the audit sink.

import { redactValue } from "../util/log"

export type AuditKind = "intent" | "decision" | "firing" | "skip" | "result"

export interface AuditEvent {
  kind: AuditKind
  jobId?: string
  runId?: string
  reason?: string
  details?: Record<string, unknown>
}

export interface AuditLog {
  log(event: AuditEvent): void
}

export interface AuditLogOptions {
  append: (line: string) => void
  clock?: () => Date
}

export function createAuditLog(options: AuditLogOptions): AuditLog {
  const clock = options.clock ?? (() => new Date())
  return {
    log(event: AuditEvent): void {
      const record = {
        at: clock().toISOString(),
        kind: event.kind,
        ...(event.jobId !== undefined ? { jobId: event.jobId } : {}),
        ...(event.runId !== undefined ? { runId: event.runId } : {}),
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
        ...(event.details !== undefined ? { details: event.details } : {}),
      }
      options.append(`${JSON.stringify(redactValue(record))}\n`)
    },
  }
}
