import type { JsonStorage } from "../../src/core/runs"

/** Deterministic in-memory JsonStorage for tests (sorted prefix scan). */
export function createMemoryStorage(initial?: Record<string, unknown>): MemoryJsonStorage {
  return new MemoryJsonStorage(initial ? new Map(Object.entries(initial)) : new Map())
}

export class MemoryJsonStorage implements JsonStorage {
  constructor(private readonly map: Map<string, unknown>) {}

  async get(key: string): Promise<unknown> {
    return this.map.get(key)
  }

  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, value)
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }

  async scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: { key: string; value: unknown }[]
    next?: string
  }> {
    let entries = [...this.map.entries()]
      .filter(([key]) => key.startsWith(options.prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => ({ key, value }))

    if (options.after) {
      entries = entries.filter((entry) => entry.key > options.after!)
    }
    if (options.limit !== undefined) {
      entries = entries.slice(0, options.limit)
    }
    return { entries }
  }

  snapshot(): Map<string, unknown> {
    return new Map(this.map)
  }
}
