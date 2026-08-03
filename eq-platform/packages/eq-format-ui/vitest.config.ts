import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Resolve workspace @eq/* deps to source — see eq-confirm-ui/vitest.config.ts and issue #47.
const src = (pkg: string) =>
  fileURLToPath(new URL(`../${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@eq\/schemas$/, replacement: src("eq-schemas") },
      { find: /^@eq\/validation$/, replacement: src("eq-validation") },
      { find: /^@eq\/ai$/, replacement: src("eq-ai") },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
