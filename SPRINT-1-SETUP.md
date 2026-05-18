# EQ Platform — Sprint 1 Setup & Decision Framework (v2)

**Last updated:** 29 Apr 2026
**Phase:** Phase 1 — Canonical Spine
**Sprint:** Sprint 1 — Repo + Schema System
**Status:** Ready to begin Sprint 1 build

> **Before starting:** read `EQ-AS-CONDUIT.md` (what we're building and why) and `HOW-WE-WORK-WITH-AI.md` (working principles for AI sessions). This sprint is technical plumbing, but the plumbing only matters if it serves the framing. If at any point the AI's suggestions don't sound like Royce, that's the signal to pause and re-anchor.

---

## Purpose

This document defines:

1. The default technical decisions for Phase 1
2. The decision workflow pattern used in Cowork sessions
3. The Sprint 1 execution plan

The goal is to eliminate decision drag and maintain build velocity.

---

## Decision Workflow (Standard Pattern)

All Cowork sessions begin with a prepopulated decision block.

**How it works:**
- Each decision includes a recommended default
- The user can:
  - Reply: `accept all`
  - Or override specific items (e.g. `7 → dual module`)

**Rules:**
- Defaults are optimised for speed, not perfection
- Avoid premature abstraction
- Any decision can be revisited in later phases if needed
- If no override is given, defaults are considered accepted

---

## Sprint 1 — Locked Decisions (v2)

```
1.  Runtime target: Node 20.11 LTS (minor floor)
    → matches Supabase functions, current tooling, schema generators

2.  Package manager: pnpm 9.x
    → required for workspace performance + monorepo structure

3.  AI client: fetch-based (no Anthropic SDK)
    → keeps eq-ai lightweight and provider-agnostic

4.  Database access: Supabase JS client (thin usage, no repo layer)
    → avoids premature abstraction in Phase 1
    → Phase 2 will introduce a thin `eq-data` package wrapping the RPCs
      (eq_intake_commit_batch / rollback / find_template_by_signature).
      Until then, Supabase calls live alongside their callers — accept the
      mess for 6 weeks rather than build the wrong abstraction now.

5.  Test runner: Vitest
    → fast, TS-native, good coverage tooling

6.  Build system: tsup
    → simple, fast, ideal for package builds

7.  Module format: ESM only
    → avoids dual-build complexity

8.  Schema generation:
    - json-schema-to-typescript (pinned)
    - json-schema-to-zod (pinned)
    → executed via `scripts/generate.ts`

9.  Generated code policy:
    - `src/generated/` is gitignored
    - generation runs on `pnpm build` and `pnpm prepare`
    - CI enforces zero drift: regenerate, then `git diff --exit-code`

10. Hashing implementation:
    - Web Crypto API (`globalThis.crypto.subtle.digest`) with Node `crypto`
      fallback
    → both Node and Workers runtimes supported on day one; no “adapt later”
      task

11. JSON Schema validation in CI (NEW):
    - Every `*.schema.json` is validated against JSON Schema draft 2020-12
      meta-schema
    - Run via `pnpm schemas:lint` in CI
    → catches malformed schemas at PR time, not runtime

12. Schema URLs (NEW):
    - The `$id` fields use `https://schemas.eq.solutions/...` URLs
    - In Phase 1, these are *identifiers only* — not resolvable HTTP URLs
    - Phase 4 publishes them as actual GET endpoints (read-only mirror of
      `eq_schema_registry`)
    → no DNS / hosting work in Phase 1; identifiers stay stable for life
```

---

## Key Architectural Constraints (Phase 1)

### 1. Single Source of Truth

- All schemas originate as JSON Schema
- TypeScript + Zod are generated artifacts only
- Generated files must never be manually edited

### 2. Generated Code Integrity

To prevent schema drift:
- `src/generated/` is gitignored
- Generation runs automatically via `pnpm build` and `pnpm prepare`
- CI check: regenerate schemas; fail if `git diff --exit-code` produces output

### 3. Validation Behaviour (Version-Aware)

- Every row carries `schema_version`
- Validation uses the row's schema version
- New imports use the current schema (`is_current = true`)
- **Corollary (NEW):** if a caller passes a non-current schema version to
  `validate()`, the orchestrator refuses unless `allowNonCurrentSchema: true`
  is explicitly set. Prevents silent schema forks.
- No retroactive re-validation in Phase 1

### 4. AI Integration Boundary

The AI layer (`eq-ai`) is strictly limited to:

```ts
interface AIProvider {
  map(input: MapInput): Promise<MapResult>;
  extract(input: ExtractInput): Promise<ExtractResult>;
}
```

Constraints:
- No plugin systems
- No dependency injection frameworks
- No provider-specific logic leaking outside the package

### 5. Signature Hash Caching

Used to eliminate repeated AI mapping calls.

Inputs to hash:
- Normalised column names
- Entity name
- Sampled value structure (not raw values — pattern fingerprints only, no PII)

Normalisation rules:
- Lowercase
- Trim whitespace
- Strip punctuation
- Stable column ordering (sorted)

Hash algorithm: SHA-256 (Web Crypto with Node fallback per decision #10)

### 6. Import Modes

Each intake event must specify:

- `append` (default)
- `upsert`
- `replace`

Safety rules:
- `replace` requires explicit confirmation flag (`p_confirm_replace = true`
  in the RPC)
- Scope tightly controlled: `replace` deletes only rows matching
  `tenant_id + imported_from`, never broader

---

## Sprint 1 — Execution Plan

### Objective

Stand up the monorepo + schema generation pipeline.

### Deliverables

- Monorepo initialised (pnpm)
- Workspace configured
- Base TypeScript config
- `eq-schemas` package created
- 10 JSON schemas dropped in
- Code generation pipeline working:
  - JSON Schema → TypeScript types
  - JSON Schema → Zod schemas
- Build + prepare hooks wired
- Generated files output correctly
- JSON Schema meta-validation script (`pnpm schemas:lint`) wired

### Definition of Done (Sprint 1)

- `pnpm install` runs generation automatically
- `pnpm build` regenerates schemas
- Generated files appear in `packages/eq-schemas/src/generated/`
- No manual edits required
- Repo builds cleanly with zero TypeScript errors
- `pnpm schemas:lint` passes against the 10 canonical schemas

---

## Cowork Session Operating Model

Each session:

1. Confirm (or accept) decision block
2. Implement a single deliverable group
3. Run locally
4. Fix immediately if broken
5. Stop when stable

No multi-sprint blending. No partial scaffolds.

---

## What Comes Next (Sprint 2 Preview)

- Coercion engine
- Type-safe validation inputs
- High-coverage test suite (Vitest)
- Edge-case handling (AU-specific formats)

---

## What Comes After Phase 1 (Phase 2 doors)

Phase 1 finishes when the canonical schemas, validation engine, and AI mapping
layer are working end-to-end against the Supabase spine. After that, Phase 2
lights up the user-facing doors, in this order:

1. **EQ Cards** — already shipping in pause-and-polish mode on its own
   Supabase project. Migrates onto the canonical spine before EQ Format ships.
   See `EQ-CARDS-INTAKE-BRIDGE.md` for the migration timing and what's safe to
   change in Cards during the pause.

2. **EQ Format** — the universal sheet wrangler. Bidirectional: cleanup-in
   (the dog-shit tag-and-test moment, on-phone, while-fresh) and reshape-out
   (canonical data → client format / payslip / customer report). Bulk
   migration of historical sheets is a mode of Format, not a separate door.
   Earlier docs called this "EQ Import" — that name is retired. See
   `EQ-FORMAT.md`.

3. **EQ Capture** (later) — a standalone OCR surface for inputs that don't
   go through Cards. The OCR engine already runs inside Cards. Future-additional,
   not priority.

Sprint 1 is plumbing for all three. Nothing in this sprint depends on which
door ships first.

---

## Notes

- Speed > elegance in Phase 1
- Abstractions must justify themselves
- Every layer should remain swappable without rewrite
- If something feels "too clever", simplify it

---

## Changelog

- **v2.1 (29 Apr 2026):** Added "What Comes After Phase 1" section. Phase 2
  door order locked: Cards → Format → Capture. EQ Import retired as a named
  door — bulk migration is a mode of EQ Format. References `EQ-FORMAT.md`
  and `EQ-CARDS-INTAKE-BRIDGE.md`.
- **v2 (29 Apr 2026):** Added decisions #11 (JSON Schema CI lint) and #12
  (`$id` URL policy). Clarified decision #4 (Phase 2 `eq-data` note).
  Clarified decision #10 (Web Crypto + Node fallback, no later adaptation).
  Added validation behaviour corollary on non-current schema refusal.
  Pinned Node 20.11 LTS, pnpm 9.x.
- **v1 (28 Apr 2026):** Initial decision framework.
