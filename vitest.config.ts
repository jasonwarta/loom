import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    // Persistence + chaos tests spawn child processes and touch sqlite files;
    // keep them isolated per-file rather than sharing a worker.
    pool: "forks",
    testTimeout: 20000,
  },
});
