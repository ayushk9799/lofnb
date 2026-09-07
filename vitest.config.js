import { defineConfig } from "vitest/config";
export default defineConfig({test: {setupFiles: ["./tests/setup.js"], testTimeout: 30000, hookTimeout: 120000, fileParallelism: false}});
