// Windows schtasks adapter tests (mocked commands — creation is asserted, not
// executed). The cron-subset mapping pins v1 ensureWindowsRepresentable
// behavior including exact error messages.

import { describe, expect, it } from "vitest"
import {
  buildWindowsTaskArgs,
  cronToWindowsPlans,
  enhancedWindowsPath,
  findOpencodeWindows,
  windowsTaskName,
  createSchtasksAdapter,
} from "../src/adapters/schtasks"
import { deriveScopeId } from "../src/adapters"
import { mockFiles, mockRunner } from "./helpers/adapters"

const WORKDIR = "C:\\work\\demo"
const COMMAND = "C:\\Users\\me\\.opencode\\bin\\opencode.exe"
const LOG = "C:\\Users\\me\\.config\\opencode\\logs\\scheduler\\demo\\daily-deal.log"

describe("cronToWindowsPlans (v1 cron-subset mapping)", () => {
  it("maps a daily expression to one DAILY task", () => {
    expect(cronToWindowsPlans("0 9 * * *")).toEqual([{ schedule: "DAILY", startTime: "09:00" }])
  })

  it("maps stepped minutes to MINUTE tasks", () => {
    expect(cronToWindowsPlans("*/15 * * * *")).toEqual([
      { schedule: "MINUTE", modifier: "15", startTime: "00:00" },
    ])
    expect(cronToWindowsPlans("* * * * *")).toEqual([
      { schedule: "MINUTE", modifier: "1", startTime: "00:00" },
    ])
  })

  it("maps stepped hours to HOURLY with a start-time offset", () => {
    expect(cronToWindowsPlans("30 */6 * * *")).toEqual([
      { schedule: "HOURLY", modifier: "6", startTime: "00:30" },
    ])
  })

  it("maps weekday expressions to WEEKLY tasks", () => {
    expect(cronToWindowsPlans("30 8 * * 1")).toEqual([
      { schedule: "WEEKLY", weekdays: "MON", startTime: "08:30" },
    ])
    expect(cronToWindowsPlans("0 9 * * 0,6")).toEqual([
      { schedule: "WEEKLY", weekdays: "SUN,SAT", startTime: "09:00" },
    ])
  })

  it("expands multiple times into ordered DAILY tasks", () => {
    const plans = cronToWindowsPlans("0 9,17 * * *")
    expect(plans).toEqual([
      { schedule: "DAILY", startTime: "09:00" },
      { schedule: "DAILY", startTime: "17:00" },
    ])
  })

  it("splits day-of-month + weekday into MONTHLY and WEEKLY pairs (v1 OR semantics)", () => {
    const plans = cronToWindowsPlans("0 12 1 * 1")
    expect(plans).toEqual([
      { schedule: "MONTHLY", days: "1", startTime: "12:00" },
      { schedule: "WEEKLY", weekdays: "MON", startTime: "12:00" },
    ])
  })

  it("maps day-of-month and month restrictions to MONTHLY", () => {
    expect(cronToWindowsPlans("0 9 1,15 1,7 *")).toEqual([
      { schedule: "MONTHLY", days: "1,15", months: "JAN,JUL", startTime: "09:00" },
    ])
  })

  it("preserves the v1 error for month + weekday combinations", () => {
    expect(() => cronToWindowsPlans("5 9 * 1 1")).toThrow(
      "Windows Task Scheduler cannot combine specific months with day-of-week constraints in cron. Split this into multiple jobs (for example: one monthly job and one weekly job)."
    )
  })

  it("preserves the v1 error for month-only without day-of-month", () => {
    expect(() => cronToWindowsPlans("0 9 * 1 *")).toThrow(
      "Windows Task Scheduler cannot represent 'every day in selected months'. Use explicit day-of-month values (for example '0 9 1,15 1,7 *') or create separate jobs."
    )
  })

  it("preserves the v1 error for oversized minute steps", () => {
    expect(() => cronToWindowsPlans("*/1500 * * * *")).toThrow(
      "Windows Task Scheduler supports at most every 1439 minutes. Use 1500 with a smaller value or switch to an hourly/daily cron."
    )
  })

  it("preserves the v1 guidance error for unusable expressions", () => {
    // A star minute with explicit hours has no Task Scheduler equivalent in
    // the v1 subset (only */N minute steps map to MINUTE tasks).
    expect(() => cronToWindowsPlans("* 9 * * *")).toThrow(
      "Windows Task Scheduler requires explicit minute and hour values for this cron expression. Use formats like '0 9 * * *', '30 8 * * 1', '*/15 * * * *', or '0 */6 * * *'."
    )
  })
})

describe("windows task naming", () => {
  const scopeId = deriveScopeId(WORKDIR)

  it("names tasks under the OpenCode folder like v1", () => {
    expect(windowsTaskName(`opencode-job-${scopeId}-daily-deal`, 0, 1)).toBe(
      `\\OpenCode\\opencode-job-${scopeId}-daily-deal`
    )
  })

  it("suffixes multi-plan tasks with their index", () => {
    expect(windowsTaskName("opencode-job-scope-x", 1, 2)).toBe("\\OpenCode\\opencode-job-scope-x-2")
  })
})

describe("buildWindowsTaskArgs (v1 argument order)", () => {
  it("builds /Create with /TN, hardened /TR, /SC and /ST", () => {
    const args = buildWindowsTaskArgs({
      taskName: "\\OpenCode\\opencode-job-x",
      commandLine: `cmd.exe /c "${COMMAND} run >> ${LOG} 2>&1"`,
      plan: { schedule: "DAILY", startTime: "09:00" },
    })
    expect(args).toEqual([
      "/Create",
      "/F",
      "/TN",
      "\\OpenCode\\opencode-job-x",
      "/TR",
      `cmd.exe /c "${COMMAND} run >> ${LOG} 2>&1"`,
      "/SC",
      "DAILY",
      "/ST",
      "09:00",
    ])
  })

  it("inserts modifier, weekdays, days and months in v1 order", () => {
    const args = buildWindowsTaskArgs({
      taskName: "\\OpenCode\\x",
      commandLine: "cmd",
      plan: { schedule: "MONTHLY", modifier: "7", weekdays: "MON", days: "1", months: "JAN", startTime: "08:00" },
    })
    expect(args).toEqual([
      "/Create", "/F", "/TN", "\\OpenCode\\x", "/TR", "cmd",
      "/SC", "MONTHLY", "/MO", "7", "/D", "MON", "/D", "1", "/M", "JAN", "/ST", "08:00",
    ])
  })
})

describe("schtasks adapter (mocked commands)", () => {
  it("creates one task per plan with a hardened cmd /c command line", async () => {
    const runner = mockRunner()
    const adapter = createSchtasksAdapter({ runner, files: mockFiles() })
    await adapter.install({
      id: "daily-deal",
      name: "Daily Deal",
      schedule: "0 9 * * *",
      command: COMMAND,
      args: ["run", "--", "find deals"],
      workdir: WORKDIR,
      logPath: LOG,
    })

    const create = runner.calls.find((call) => call.command === "schtasks" && call.args[0] === "/Create")
    expect(create).toBeDefined()
    const scopeId = deriveScopeId(WORKDIR)
    expect(create!.args).toContain(`\\OpenCode\\opencode-job-${scopeId}-daily-deal`)
    const trIndex = create!.args.indexOf("/TR")
    expect(create!.args[trIndex + 1]).toBe(`cmd.exe /c "${COMMAND} run -- "find deals" >> ${LOG} 2>&1"`)
    expect(create!.args).toEqual([
      "/Create", "/F", "/TN", `\\OpenCode\\opencode-job-${scopeId}-daily-deal`,
      "/TR", create!.args[trIndex + 1], "/SC", "DAILY", "/ST", "09:00",
    ])
  })

  it("fences hostile job ids before composing task names", async () => {
    const runner = mockRunner()
    const adapter = createSchtasksAdapter({ runner, files: mockFiles() })
    await adapter.install({
      id: 'evil" & calc',
      name: "evil",
      schedule: "0 9 * * *",
      command: COMMAND,
      args: [],
    })
    const create = runner.calls.find((call) => call.args[0] === "/Create")
    expect(create!.args[3]).not.toContain('"')
    expect(create!.args[3]).toContain("evil-calc")
  })

  it("uninstall attempts scoped and legacy delete variants and swallows failures", async () => {
    const runner = mockRunner({
      // Every delete fails (task not installed) — uninstall must still resolve.
    })
    const failingRunner: typeof runner = {
      ...runner,
      async exec(command, args) {
        runner.calls.push({ command, args })
        throw new Error(`schtasks: no such task (${args.join(" ")})`)
      },
    }
    const adapter = createSchtasksAdapter({ runner: failingRunner, files: mockFiles() })
    const scopeId = deriveScopeId(WORKDIR)
    await expect(adapter.uninstall("daily-deal", WORKDIR)).resolves.toBeUndefined()

    const deleted = failingRunner.calls.filter((call) => call.args[0] === "/Delete").map((call) => call.args[2])
    expect(deleted).toContain(`\\OpenCode\\opencode-job-${scopeId}-daily-deal`)
    expect(deleted).toContain("\\OpenCode\\opencode-job-daily-deal")
    expect(deleted.some((name) => name.endsWith("-2"))).toBe(true)
  })

  it("reports availability via the schtasks probe", async () => {
    const runner = mockRunner({ "schtasks /?": "usage" })
    const adapter = createSchtasksAdapter({ runner, files: mockFiles() })
    expect(await adapter.isAvailable()).toBe(true)
  })
})

describe("findOpencodeWindows (v1 fix branch: binary resolution)", () => {
  const home = "C:\\Users\\me"

  it("prefers the explicit override", async () => {
    const resolved = await findOpencodeWindows({
      runner: mockRunner(),
      env: { OPENCODE_SCHEDULER_OPENCODE_PATH: "C:\\custom\\opencode.exe" },
      home,
      fileExists: () => false,
    })
    expect(resolved).toBe("C:\\custom\\opencode.exe")
  })

  it("uses where.exe over the enhanced PATH", async () => {
    const runner = mockRunner({ "where.exe opencode": "C:\\bin\\opencode.exe\r\nC:\\other\\opencode.exe" })
    const resolved = await findOpencodeWindows({ runner, env: {}, home, fileExists: () => false })
    expect(resolved).toBe("C:\\bin\\opencode.exe")
  })

  it("falls back to the scoop shim, then npm cmd, then the well-known bin", async () => {
    const scoopRunner = mockRunner({ "where.exe opencode": new Error("not found") })
    expect(
      await findOpencodeWindows({
        runner: scoopRunner,
        env: { SCOOP: "D:\\scoop" },
        home,
        fileExists: (path) => path === "D:\\scoop\\shims\\opencode.exe",
      })
    ).toBe("D:\\scoop\\shims\\opencode.exe")

    const npmRunner = mockRunner({ "where.exe opencode": new Error("not found") })
    expect(
      await findOpencodeWindows({
        runner: npmRunner,
        env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
        home,
        fileExists: (path) => path === "C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd",
      })
    ).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd")

    const binRunner = mockRunner({ "where.exe opencode": new Error("not found") })
    expect(
      await findOpencodeWindows({
        runner: binRunner,
        env: {},
        home,
        fileExists: (path) => path === `${home}\\.opencode\\bin\\opencode.exe`,
      })
    ).toBe(`${home}\\.opencode\\bin\\opencode.exe`)
  })

  it("returns the bare binary when every probe misses", async () => {
    const resolved = await findOpencodeWindows({
      runner: mockRunner({ "where.exe opencode": new Error("not found") }),
      env: {},
      home,
      fileExists: () => false,
    })
    expect(resolved).toBe("opencode")
  })

  it("builds the enhanced Windows PATH like the v1 fix branch", () => {
    const path = enhancedWindowsPath(
      { SystemRoot: "C:\\Windows", APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
      home
    )
    expect(path).toBe(
      [
        "C:\\Windows\\System32",
        `${home}\\scoop\\shims`,
        "C:\\Users\\me\\AppData\\Roaming\\npm",
        `${home}\\.opencode\\bin`,
      ].join(";")
    )
  })
})
