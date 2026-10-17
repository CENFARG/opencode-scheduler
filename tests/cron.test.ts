import { describe, expect, it } from "vitest"
import {
  addJitter,
  nextFire,
  parseCronExpression,
  planCatchUp,
  splitCronExpression,
  upcomingFires,
} from "../src/core/cron"

// Local-time date helpers keep tests timezone-independent.
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0)

describe("splitCronExpression (v1 semantics)", () => {
  it("splits five fields", () => {
    expect(splitCronExpression("0 9 * * *")).toEqual(["0", "9", "*", "*", "*"])
  })

  it("rejects wrong field count with the v1 message", () => {
    expect(() => splitCronExpression("0 9 *")).toThrow("Invalid cron: 0 9 *")
  })

  it("accepts extra whitespace like v1", () => {
    expect(splitCronExpression("  30   8 * * 1 ")).toEqual(["30", "8", "*", "*", "1"])
  })
})

describe("parseCronExpression (v1-compatible subset)", () => {
  it("parses star fields as null", () => {
    expect(parseCronExpression("* * * * *")).toEqual({
      minute: null,
      hour: null,
      dayOfMonth: null,
      month: null,
      dayOfWeek: null,
    })
  })

  it("parses lists and steps", () => {
    expect(parseCronExpression("0,30 */6 * * *")).toEqual({
      minute: [0, 30],
      hour: [0, 6, 12, 18],
      dayOfMonth: null,
      month: null,
      dayOfWeek: null,
    })
  })

  it("normalizes day-of-week 7 to Sunday", () => {
    expect(parseCronExpression("0 0 * * 7").dayOfWeek).toEqual([0])
  })

  it("rejects out-of-range values with the v1 message", () => {
    expect(() => parseCronExpression("60 * * * *")).toThrow("Invalid cron minute value: 60")
    expect(() => parseCronExpression("* 24 * * *")).toThrow("Invalid cron hour value: 24")
    expect(() => parseCronExpression("* * 32 * *")).toThrow("Invalid cron day of month value: 32")
    expect(() => parseCronExpression("* * * 13 *")).toThrow("Invalid cron month value: 13")
  })

  it("rejects zero step with the v1 message", () => {
    expect(() => parseCronExpression("*/0 * * * *")).toThrow("Invalid cron minute step: */0")
  })

  it("rejects ranges (not in the v1 subset) with the v1 field message", () => {
    expect(() => parseCronExpression("1-5 * * * *")).toThrow("Invalid cron minute field: 1-5")
  })

  it("rejects non-numeric values with the v1 field message", () => {
    expect(() => parseCronExpression("a * * * *")).toThrow("Invalid cron minute field: a")
  })
})

describe("nextFire", () => {
  it("returns the next daily occurrence", () => {
    expect(nextFire("0 9 * * *", at(2026, 3, 10, 10, 30))).toEqual(at(2026, 3, 11, 9, 0))
  })

  it("fires later the same day when still ahead", () => {
    expect(nextFire("30 8 * * *", at(2026, 3, 10, 8, 0))).toEqual(at(2026, 3, 10, 8, 30))
  })

  it("is strictly after the reference instant", () => {
    expect(nextFire("0 9 * * *", at(2026, 3, 10, 9, 0))).toEqual(at(2026, 3, 11, 9, 0))
  })

  it("computes stepped minutes", () => {
    expect(nextFire("*/15 * * * *", at(2026, 3, 10, 10, 30))).toEqual(at(2026, 3, 10, 10, 45))
  })

  it("computes the next weekday occurrence", () => {
    // 2026-03-10 is a Tuesday; next Monday is 2026-03-16.
    expect(nextFire("30 8 * * 1", at(2026, 3, 10, 12, 0))).toEqual(at(2026, 3, 16, 8, 30))
  })

  it("respects month restrictions", () => {
    expect(nextFire("0 9 1 1 *", at(2026, 3, 10, 12, 0))).toEqual(at(2027, 1, 1, 9, 0))
  })

  it("uses cron OR semantics when both day-of-month and day-of-week are restricted", () => {
    // Fires on the 1st of the month OR any Monday.
    const next = nextFire("0 12 1 * 1", at(2026, 3, 10, 12, 0))
    expect(next).toEqual(at(2026, 3, 16, 12, 0)) // Monday
    expect(nextFire("0 12 1 * 1", at(2026, 3, 16, 12, 0))).toEqual(at(2026, 3, 23, 12, 0)) // next Monday, before the Apr 1st branch
  })

  it("throws when the expression can never match", () => {
    expect(() => nextFire("0 0 31 2 *", at(2026, 3, 10, 12, 0))).toThrow(/never matches/)
  })
})

describe("upcomingFires", () => {
  it("returns fires in the (start, end] window", () => {
    const fires = upcomingFires("*/15 * * * *", at(2026, 3, 10, 10, 0), at(2026, 3, 10, 11, 0))
    expect(fires).toEqual([
      at(2026, 3, 10, 10, 15),
      at(2026, 3, 10, 10, 30),
      at(2026, 3, 10, 10, 45),
      at(2026, 3, 10, 11, 0),
    ])
  })

  it("respects the limit", () => {
    const fires = upcomingFires("* * * * *", at(2026, 3, 10, 10, 0), at(2026, 3, 10, 11, 0), 3)
    expect(fires).toHaveLength(3)
  })

  it("returns empty when nothing is due", () => {
    expect(upcomingFires("0 9 * * *", at(2026, 3, 10, 10, 0), at(2026, 3, 10, 11, 0))).toEqual([])
  })
})

describe("addJitter", () => {
  it("applies deterministic jitter from the injected random source", () => {
    const fire = at(2026, 3, 10, 9, 0)
    expect(addJitter(fire, 60, () => 0.5)).toEqual(new Date(fire.getTime() + 30_000))
    expect(addJitter(fire, 60, () => 0)).toEqual(fire)
    expect(addJitter(fire, 60, () => 0.999)).toEqual(new Date(fire.getTime() + 59_940))
  })

  it("is a no-op without jitter", () => {
    const fire = at(2026, 3, 10, 9, 0)
    expect(addJitter(fire, 0, () => 0.5)).toEqual(fire)
  })
})

describe("planCatchUp (P1: per-job catch-up policy)", () => {
  const now = at(2026, 3, 10, 12, 0)
  const missed = [at(2026, 3, 10, 11, 0), at(2026, 3, 10, 11, 30), at(2026, 3, 10, 11, 45)]

  it("skip fires nothing", () => {
    expect(planCatchUp("skip", missed, now, 300)).toEqual([])
  })

  it("most-recent fires exactly the latest missed time", () => {
    expect(planCatchUp("most-recent", missed, now, 300)).toEqual([
      { fire: at(2026, 3, 10, 11, 45), catchUp: true },
    ])
  })

  it("most-recent marks a single due fire as normal", () => {
    expect(planCatchUp("most-recent", [at(2026, 3, 10, 11, 45)], now, 300)).toEqual([
      { fire: at(2026, 3, 10, 11, 45), catchUp: false },
    ])
  })

  it("fire-late-capped keeps only fires within the cap", () => {
    expect(planCatchUp("fire-late-capped", missed, now, 15 * 60)).toEqual([
      { fire: at(2026, 3, 10, 11, 45), catchUp: true },
    ])
    expect(planCatchUp("fire-late-capped", missed, now, 31 * 60)).toEqual([
      { fire: at(2026, 3, 10, 11, 30), catchUp: true },
      { fire: at(2026, 3, 10, 11, 45), catchUp: true },
    ])
  })

  it("empty missed window plans nothing", () => {
    expect(planCatchUp("most-recent", [], now, 300)).toEqual([])
  })
})
