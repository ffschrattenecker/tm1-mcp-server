import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["tests/setup/no-process-backup.ts"],
    include: ["tests/unit/**/*.test.ts"],
    testTimeout: 30000,
  },
});
