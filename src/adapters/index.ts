// Common scheduler adapter port (research REC.1): one interface, one adapter
// per OS. All process execution and file writes go through injected ports so
// every adapter is unit-testable with mocked commands. The non-Windows
// adapters (systemd, cron, launchd) are NOT host-testable on this Windows
// machine; their tests exercise generated commands and file content only.

import { basename } from "path"
import { slugify } from "../core/config"
import { createCronAdapter } from "./cron"
import { createLaunchdAdapter } from "./launchd"
import { createSchtasksAdapter } from "./schtasks"
import { createSystemdAdapter } from "./systemd"

export type AdapterId = "schtasks" | "systemd" | "cron" | "launchd"

/** Process port: every adapter command flows through here (mockable). */
export interface CommandRunner {
  /** Run a command and resolve with stdout; rejects on failure. */
  exec(command: string, args: string[], options?: { input?: string }): Promise<string>
  /** Availability probe; resolves false instead of throwing. */
  available(command: string, args: string[]): Promise<boolean>
}

/** Filesystem port for unit/plist/crontab artifacts. */
export interface FilePort {
  writeFile(path: string, contents: string): Promise<void>
  exists(path: string): Promise<boolean>
  remove(path: string): Promise<boolean>
}

export interface AdapterDeps {
  runner: CommandRunner
  files: FilePort
  /** Where job-scoped artifacts (plists, units) are written. */
  launchAgentsDir?: string
  systemdUserDir?: string
}

export interface AdapterJob {
  id: string
  name: string
  schedule: string
  /** Absolute path of the binary the OS scheduler should launch. */
  command: string
  args: string[]
  workdir?: string
  logPath?: string
}

export interface SchedulerAdapter {
  readonly id: AdapterId
  isAvailable(): Promise<boolean>
  install(job: AdapterJob): Promise<void>
  uninstall(fencedId: string, workdir?: string): Promise<void>
}

// v1 scope identity: FNV-1a 64 over the normalized workdir, first 12 hex.
export function fnv1a64Hex(input: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const data = Buffer.from(input, "utf8")
  for (const byte of data) {
    hash ^= BigInt(byte)
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, "0")
}

export function deriveScopeId(workdir: string): string {
  const normalized = workdir.trim() || "/"
  const base = slugify(basename(normalized)) || "workspace"
  return `${base}-${fnv1a64Hex(normalized).slice(0, 12)}`
}

/**
 * Job-name fencing (P1 item 9): OS scheduler entry names may only contain a
 * safe charset, have bounded length, and never be empty — protects the audit
 * trail from name-based poisoning (openclaw job-name fencing precedent).
 */
export function fenceJobName(raw: string): string {
  const fenced = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return fenced || "job"
}

export async function detectAdapterId(platform: NodeJS.Platform, runner: CommandRunner): Promise<AdapterId | null> {
  if (platform === "win32") return "schtasks"
  if (platform === "darwin") return "launchd"

  if (platform === "linux") {
    if (await runner.available("systemctl", ["--user", "show-environment"])) return "systemd"
    if (await runner.available("crontab", ["-l"])) return "cron"
    return null
  }

  // Other POSIX systems: cron fallback when present (v1 behavior).
  if (await runner.available("crontab", ["-l"])) return "cron"
  return null
}

export function createAdapter(id: AdapterId, deps: AdapterDeps): SchedulerAdapter {
  switch (id) {
    case "schtasks":
      return createSchtasksAdapter(deps)
    case "systemd":
      return createSystemdAdapter(deps)
    case "cron":
      return createCronAdapter(deps)
    case "launchd":
      return createLaunchdAdapter(deps)
  }
}
