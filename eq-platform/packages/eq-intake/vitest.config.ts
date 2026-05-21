import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests are opt-in: they hit live APIs (cost money).
    // Loaded via `test:integration` script with their own vitest config.
    exclude: ["test/**/*.integration.test.ts", "**/node_modules/**"],
    environment: "node",
    globals: false,
  },
});
