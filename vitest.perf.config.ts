import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.perf.test.ts", "scripts/**/*.perf.test.ts"],
    fileParallelism: false,
  },
});
