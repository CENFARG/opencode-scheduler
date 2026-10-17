import { describe, expect, it } from "vitest"
import { createMemoryStorage } from "./memory-storage"
import type { CommandRunner, FilePort } from "../src/adapters"

export function mockRunner(responses: Record<string, string | Error> = {}): CommandRunner & { calls: { command: string; args: string[]; input?: string }[] } {
  const calls: { command: string; args: string[]; input?: string }[] = []
  return {
    calls,
    async exec(command, args, options) {
      calls.push({ command, args, input: options?.input })
      const key = [command, ...args].join(" ")
      const response = responses[key]
      if (response instanceof Error) throw response
      return typeof response === "string" ? response : ""
    },
    async available(command, args) {
      calls.push({ command, args })
      const key = [command, ...args].join(" ")
      return !(responses[key] instanceof Error)
    },
  }
}

export function mockFiles(existing: Record<string, string> = {}): FilePort & { written: Map<string, string>; removed: string[] } {
  const written = new Map<string, string>(Object.entries(existing))
  const removed: string[] = []
  return {
    written,
    removed,
    async writeFile(path, contents) {
      written.set(path, contents)
    },
    async exists(path) {
      return written.has(path)
    },
    async remove(path) {
      removed.push(path)
      return written.delete(path)
    },
  }
}

export { createMemoryStorage }
