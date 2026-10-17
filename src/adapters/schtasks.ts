// Windows Task Scheduler adapter (schtasks) — implementation lands with its
// TDD cycle; see tests/schtasks.test.ts.
import type { AdapterDeps, SchedulerAdapter } from "./index"

export function createSchtasksAdapter(_deps: AdapterDeps): SchedulerAdapter {
  throw new Error("not implemented")
}
