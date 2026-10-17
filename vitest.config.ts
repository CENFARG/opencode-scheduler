import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Green from the first scaffold commit, before behavior tests exist.
    passWithNoTests: true,
  },
})
