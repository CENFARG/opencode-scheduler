// crontab adapter — implementation lands with its TDD cycle.
// NOT host-testable on this Windows machine: tests use mocked commands.
import type { AdapterDeps, SchedulerAdapter } from "./index"

export function createCronAdapter(_deps: AdapterDeps): SchedulerAdapter {
  throw new Error("not implemented")
}
