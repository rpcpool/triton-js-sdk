import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    bail: 1,
    testTimeout: 5_000,
    hookTimeout: 5_000
  }
});
