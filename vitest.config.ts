import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "lint/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "src/**/*.perf.test.ts"],
  },
});
