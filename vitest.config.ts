import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["tests/setup/no-process-backup.ts"],
    include: [
      "tests/unit/**/*.test.ts",
      "tests/property/**/*.property.test.ts",
    ],
    coverage: {
      provider: "v8",
      // Only first-party source counts. `include` already keeps tests/,
      // scripts/, dist/ and node_modules/ out; the explicit excludes drop what
      // has no meaningful behaviour to assert on:
      //   src/index.ts  — process entrypoint (arg parsing + wiring), exercised
      //                   by the live suite rather than unit tests
      //   **/*.d.ts     — type declarations, zero runtime
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "**/*.d.ts"],
      reporter: ["text-summary", "html"],
    },
    testTimeout: 30000,
  },
});
