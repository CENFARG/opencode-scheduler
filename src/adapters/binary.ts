// Opencode binary resolution (v1 parity): explicit override, PATH probe, then
// well-known locations; delegates to the fix-branch Windows resolution.

import { execFileSync, spawnSync } from "child_process"
import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { findOpencodeWindows } from "./schtasks"
import type { CommandRunner } from "./index"

const nodeRunner: CommandRunner = {
  async exec(command, args) {
    return execFileSync(command, args, { encoding: "utf-8", windowsHide: true })
  },
  async available(command, args) {
    try {
      execFileSync(command, args, { stdio: "ignore", windowsHide: true })
      return true
    } catch {
      return false
    }
  },
}

function resolvePosixBinary(): string {
  const override = process.env.OPENCODE_SCHEDULER_OPENCODE_PATH?.trim()
  if (override) return override

  try {
    const probe = spawnSync("/bin/sh", ["-c", "command -v opencode"], { encoding: "utf-8" })
    const resolved = probe.stdout?.trim()
    if (probe.status === 0 && resolved) return resolved.includes("/") ? resolved : "opencode"
  } catch {
    // fall through to well-known locations
  }

  for (const candidate of [
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
    join(homedir(), ".opencode", "bin", "opencode"),
  ]) {
    if (existsSync(candidate)) return candidate
  }

  return "opencode"
}

/** v1 findOpencode parity: override -> PATH probe -> well-known -> bare name. */
export async function resolveOpencodeBinary(
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  if (platform === "win32") {
    return findOpencodeWindows({
      runner: nodeRunner,
      env: process.env as Record<string, string | undefined>,
      home: homedir(),
      fileExists: existsSync,
    })
  }
  return resolvePosixBinary()
}
