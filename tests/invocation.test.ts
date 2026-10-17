import { describe, expect, it } from "vitest"
import { buildOpencodeArgs, resolveJobEnv } from "../src/core/invocation"
import { parseJobDefinition, type JobDefinition } from "../src/core/config"

const parse = (raw: Record<string, unknown>): JobDefinition => parseJobDefinition(raw)

describe("buildOpencodeArgs (v1 flag parity)", () => {
  it("maps prompt jobs to `opencode run -- <prompt>`", () => {
    const job = parse({ name: "deals", schedule: "0 9 * * *", run: { prompt: "find deals" } })
    expect(buildOpencodeArgs(job, "/usr/local/bin/opencode")).toEqual({
      command: "/usr/local/bin/opencode",
      args: ["run", "--", "find deals"],
    })
  })

  it("maps command jobs to `--command` with trailing arguments slot", () => {
    const job = parse({
      name: "cleanup",
      schedule: "0 9 * * *",
      run: { command: "my-command", arguments: "extra args" },
    })
    const invocation = buildOpencodeArgs(job, "opencode")
    expect(invocation.args).toEqual(["run", "--command", "my-command", "--", "extra args"])
  })

  it("preserves the v1 flag order", () => {
    const job = parse({
      name: "full",
      schedule: "0 9 * * *",
      run: {
        prompt: "do it",
        attachUrl: "http://localhost:4096",
        port: 4096,
        agent: "plan",
        model: "openai/gpt-5",
        variant: "high",
        runFormat: "json",
        share: true,
        title: "Daily Deal",
        session: "ses_123",
        files: ["a.txt", "b dir"],
      },
    })
    expect(buildOpencodeArgs(job, "opencode").args).toEqual([
      "run",
      "--attach",
      "http://localhost:4096",
      "--port",
      "4096",
      "--agent",
      "plan",
      "--model",
      "openai/gpt-5",
      "--variant",
      "high",
      "--format",
      "json",
      "--share",
      "--title",
      "Daily Deal",
      "--session",
      "ses_123",
      "--file",
      "a.txt",
      "--file",
      "b dir",
      "--",
      "do it",
    ])
  })

  it("omits unset flags like v1", () => {
    const job = parse({ name: "minimal", schedule: "0 9 * * *", run: { prompt: "x" } })
    const { args } = buildOpencodeArgs(job, "opencode")
    expect(args).toEqual(["run", "--", "x"])
  })
})

describe("resolveJobEnv (P0: env references only)", () => {
  it("resolves $VAR and ${VAR} from the process environment", () => {
    const job = parse({
      name: "envy",
      schedule: "0 9 * * *",
      run: { prompt: "x" },
      env: { TOKEN: "$MY_TOKEN", KEY: "${MY_KEY}" },
    })
    expect(resolveJobEnv(job, { MY_TOKEN: "abc", MY_KEY: "def" })).toEqual({ TOKEN: "abc", KEY: "def" })
  })

  it("drops references whose variable is unset (never leaks placeholders)", () => {
    const job = parse({ name: "envy", schedule: "0 9 * * *", run: { prompt: "x" }, env: { TOKEN: "$MISSING" } })
    expect(resolveJobEnv(job, {})).toEqual({})
  })
})
