import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Resolve workspace @eq/* deps to their TypeScript source for tests.
//
// Every @eq package publishes only its built `dist/` (see each package.json
// `exports`), and `dist/` is gitignored — so a fresh checkout has no dist, and
// an out-of-date dist silently serves stale code. Either makes `pnpm -r test`
// fail or pass against the wrong source. Aliasing to `src` makes these tests run
// against current code with no prior `pnpm build`, and reflects src edits
// immediately. Exact-match (`$`) so subpath exports like
// `@eq/schemas/schemas/*.json` still resolve through the package. See issue #47.
const src = (pkg: string) =>
  fileURLToPath(new URL(`../${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@eq\/intake$/, replacement: src("eq-intake") },
      { find: /^@eq\/ai$/, replacement: src("eq-ai") },
      { find: /^@eq\/schemas$/, replacement: src("eq-schemas") },
      { find: /^@eq\/validation$/, replacement: src("eq-validation") },
    ],
  },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "node",
    globals: false,
  },
});
