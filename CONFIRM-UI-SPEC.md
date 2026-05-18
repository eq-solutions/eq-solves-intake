# EQ Intake — Confirmation UI Spec v1

## Purpose

After AI column mapping + validation, the user sees a confirmation screen before commit. This spec defines the components, states, and interactions.

The UI is **the most important user-facing surface in the entire intake pipeline.** A bad confirm UX kills trust in AI mapping — users either over-trust (and import garbage) or abandon (and revert to manual). Build this carefully.

---

## Tech stack

- React 19 (Next.js App Router)
- Tailwind v4
- shadcn/ui primitives (Dialog, Select, Tooltip, Sheet, Tabs, Card)
- TanStack Table for the row preview grid
- Zustand for the confirm-flow state machine
- Lives in `apps/eq-import/` and `apps/eq-cards/` (shared via `packages/eq-confirm-ui`)

---

## Flow states

```
[upload]
   ↓
[detecting] → spinner: "scanning your file..."
   ↓
[ai-mapping] → spinner: "matching columns..."
   ↓
[confirm-mapping]   ← user reviews mapping, accepts or edits
   ↓
[validating] → progress bar: "checking 1,247 rows..."
   ↓
[confirm-rows]      ← user reviews flagged rows + sample valid rows
   ↓
[committing] → progress bar
   ↓
[complete] → summary: "1,180 imported · 47 flagged · 20 rejected"
```

User can go back from any confirm state. Validation results are cached against the file hash so re-confirm is instant.

---

## Screen 1: Mapping confirm

Layout: split view, left = source columns, right = canonical fields.

```
┌─────────────────────────────────────────────────────────────────────┐
│  ← back                          [save mapping] [skip] [continue →] │
│                                                                     │
│  We found 12 columns. 10 mapped automatically, 2 need your input.  │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░    │
│  ✓ matched     ⚠ needs input     × ignored                         │
│                                                                     │
│  ┌──────────────────────┐         ┌──────────────────────────────┐ │
│  │ source               │   →     │ canonical                    │ │
│  ├──────────────────────┤         ├──────────────────────────────┤ │
│  │ Emp #                │ ✓ 95%   │ external_id                  │ │
│  │   E0023, E0024, ...  │         │   payroll number / HR id     │ │
│  ├──────────────────────┤         ├──────────────────────────────┤ │
│  │ Name                 │ ⚠       │ split into first + last [✓] │ │
│  │   John Smith, ...    │         │                              │ │
│  ├──────────────────────┤         ├──────────────────────────────┤ │
│  │ Phone                │ ✓ 100%  │ phone                        │ │
│  │   0412 345 678, ...  │         │   AU mobile, will be E.164   │ │
│  ├──────────────────────┤         ├──────────────────────────────┤ │
│  │ Type                 │ ✓ 90%   │ employment_type              │ │
│  │   FT, Sub, Sub, ...  │         │   "FT"→employee, "Sub"→subby │ │
│  ├──────────────────────┤         ├──────────────────────────────┤ │
│  │ Started              │ ✓ 95%   │ start_date                   │ │
│  │   1/3/2022, ...      │         │   parsed as AU dd/mm/yyyy    │ │
│  ├──────────────────────┤         ├──────────────────────────────┤ │
│  │ Rate                 │ ⚠ 40%   │ ?? cost or charge ??  [pick] │ │
│  │   $45.00, $92.50     │         │                              │ │
│  ├──────────────────────┤         ├──────────────────────────────┤ │
│  │ Notes                │ ✓ 100%  │ notes                        │ │
│  └──────────────────────┘         └──────────────────────────────┘ │
│                                                                     │
│  Required fields not yet mapped: (none — split-name covers them)   │
└─────────────────────────────────────────────────────────────────────┘
```

### Components

#### `<MappingTable>`
- Renders the AI mapping as rows. One row per source column.
- Each row displays:
  - Source column name + first 3 sample values (truncated, hover for full)
  - Confidence indicator (icon + percentage)
  - Canonical field name + description tooltip
  - Coercion preview ("0412 345 678 → +61412345678")
  - Override action (click to open `<FieldPicker>`)

#### `<FieldPicker>`
- Dropdown with all canonical fields for this entity, grouped by section.
- Shows a "fuzzy search" input.
- Required fields are visually distinguished with a red asterisk.
- Already-mapped fields are greyed but selectable (will reassign).
- Bottom option: "Don't import this column" (sets canonical = null).

#### `<ClarificationPrompts>`
- Renders any `needs_clarification` items from the AI response as inline modal cards.
- Example: "Is the 'Rate' column the cost rate or the charge-out rate?" → 2 buttons.
- User must answer all clarifications before continuing.

#### `<TransformPicker>`
- Shows when AI suggested a transform (split-name, concat, currency-strip, etc).
- User can accept, modify (e.g. change split delimiter), or reject.

#### `<UnmappedRequiredAlert>`
- Sticky banner at the top if any required canonical fields have no source match.
- Lists the unmapped required fields.
- Cannot continue until resolved (either map a column or use a transform).

### State

```ts
type MappingState = {
  fileHash: string;
  sourceColumns: string[];
  sampleRows: Record<string, unknown>[];
  aiResponse: AIColumnMappingResponse;
  userOverrides: Record<string, string | null>;       // source col → canonical field
  transformations: Record<string, TransformSpec>;
  clarificationAnswers: Record<string, string>;       // question id → chosen option
  isReadyToValidate: boolean;
};
```

### Actions

- `setMapping(sourceCol, canonicalField)` — user picks/changes mapping
- `setTransform(sourceCol, spec)` — user accepts/modifies transform
- `answerClarification(questionId, answer)` — resolves an AI question
- `acceptAllAISuggestions()` — bulk accept
- `saveAsTemplate(name)` — persist to `eq_intake_templates` for reuse

### Save mapping behaviour

When the user clicks "Save mapping":
1. POST to `/api/intake/templates` with the resolved mapping
2. Future imports of files with similar `source_signature` (sample of column names + values) auto-apply this template
3. User sees a "Template saved · will be used next time" toast

---

## Screen 2: Row preview & flag resolution

Layout: tabs across the top, table below.

```
┌─────────────────────────────────────────────────────────────────────┐
│  ← back              ▶ commit 1,180 rows now    [download report]   │
│                                                                     │
│  [ valid 1,180 ]  [ flagged 47 ]  [ rejected 20 ]                  │
│  ══════════════════════════════════════════════════════════════════ │
│                                                                     │
│  Flagged rows need a decision before committing.                    │
│  ┌───┬────────────┬──────────────────────────────────────────────┐ │
│  │ # │ Name       │ Issue                                        │ │
│  ├───┼────────────┼──────────────────────────────────────────────┤ │
│  │ 23│ J. Smith   │ Site "Equnix SY3" — did you mean...         │ │
│  │   │            │   • Equinix SY3 (95%)   [select]            │ │
│  │   │            │   • Equinix SY4 (78%)   [select]            │ │
│  │   │            │   • create new "Equnix SY3" [create]         │ │
│  ├───┼────────────┼──────────────────────────────────────────────┤ │
│  │ 41│ K. Patel   │ Date "03/04/26" — could be 3 Apr or 4 Mar   │ │
│  │   │            │   • 2026-04-03 (AU)     [select]            │ │
│  │   │            │   • 2026-03-04 (US)     [select]            │ │
│  ├───┼────────────┼──────────────────────────────────────────────┤ │
│  │ 89│ L. O'Brien │ Cost rate $-12 — unusual value (negative)   │ │
│  │   │            │   • keep as-is          [select]            │ │
│  │   │            │   • mark as 0           [select]            │ │
│  │   │            │   • skip this row       [select]            │ │
│  └───┴────────────┴──────────────────────────────────────────────┘ │
│                                                                     │
│  [ ↑ apply same answer to similar flags ]                          │
└─────────────────────────────────────────────────────────────────────┘
```

### Components

#### `<TabBar>`
- Three tabs with counts: valid / flagged / rejected
- Only flagged tab requires interaction
- Rejected tab shows the errors but no actions (need to fix at source)

#### `<ValidRowsTable>` (read-only preview)
- 50 rows visible by default
- Search bar
- Column visibility toggle
- Each cell shows the canonical value with a hover tooltip showing the source value

#### `<FlaggedRowsTable>`
- Each row expands to show the flag(s) and resolution options
- Resolution options come from the flag type:
  - `fk_fuzzy_match` → list of candidates with scores + "create new" option
  - `date_ambiguous` → both interpretations as buttons
  - `value_unusual` → keep / zero / skip
  - `phone_kept_raw` → no action (informational only)
- Bulk "apply to all similar" — auto-resolve identical flags

#### `<RejectedRowsTable>`
- Read-only with error reasons highlighted
- "Download as CSV" — fix at source, retry import
- "Skip and continue" option to commit only the valid + flagged-resolved rows

### State

```ts
type RowReviewState = {
  validRows: ValidRow[];
  flaggedRows: FlaggedRow[];
  rejectedRows: RejectedRow[];
  resolutions: Record<number, FlagResolution>;        // row index → resolution
  bulkResolutions: Record<string, FlagResolution>;    // flag fingerprint → resolution
  canCommit: boolean;                                 // all flagged rows resolved
};
```

### Actions

- `resolveFlag(rowIndex, resolution)` — single row
- `resolveBulk(flagFingerprint, resolution)` — apply to all matching
- `createMissingFkTarget(field, value)` — opens a sub-flow to create a missing site/asset/etc inline
- `commitNow()` — POSTs valid + flagged-resolved rows to RPC
- `downloadRejectedCsv()` — for the user to fix and re-upload

---

## Screen 3: Commit progress + complete

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│         ✿ committing 1,227 rows ...                                 │
│         ████████████████████████████░░░░░░░░░░░  72%                │
│                                                                     │
│         [ stay on page ] · safe to leave, this runs server-side    │
└─────────────────────────────────────────────────────────────────────┘
```

After commit:

```
┌─────────────────────────────────────────────────────────────────────┐
│         ✓ done. 1,227 rows imported in 8 seconds.                   │
│                                                                     │
│         · 1,180 added straight from valid                           │
│         · 47 added after flag resolution                            │
│         · 20 skipped (download report to fix and retry)             │
│                                                                     │
│         [view in EQ Field →]    [import another file]               │
│         [save mapping as template]  [download summary report]       │
│                                                                     │
│         ✿ Heads up: undo available for 7 days.                     │
│         To roll back this entire import, click here.                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Accessibility

- Full keyboard navigation. Tab through cells, arrow keys within tables.
- Screen reader labels on every interactive element.
- Confidence indicators have text equivalents (not colour-only).
- Confirm dialogs for destructive actions (skip rejected, rollback import).
- Focus management: dialog open → focus first input; close → focus trigger.

## Empty states

- File parsed but no rows: "We found columns but no data rows. Did you upload the right tab?"
- All required fields unmapped: "We couldn't match enough columns to import this. [Manual mapping →]"
- All rows rejected: "Every row failed validation. Common issue: [most common error]. [Download error report]."

## Mobile

- Confirm flow on mobile uses a stack of full-screen views instead of split-pane.
- Flagged row resolution uses bottom sheets.
- The sample preview is replaced with a single column carousel (swipe between fields).

## Telemetry events to capture

For platform improvement (not for ad tracking):
- `intake.mapping.ai_accepted` — % of AI suggestions kept verbatim
- `intake.mapping.field_overridden` — which fields users override most
- `intake.mapping.transform_modified` — how often transforms get tweaked
- `intake.flag.resolution_chosen` — which flag types get auto-resolved bulk vs. one-by-one
- `intake.commit.duration_ms` — performance budget tracking
- `intake.template.reused` — template effectiveness

## Out of scope for v1

- Drag-and-drop column reordering (not needed; mapping is bidirectional)
- Live preview of the canonical row as the user changes mapping (compute cost too high for large files)
- Inline editing of canonical values in the preview (force fix-at-source for now)
- Multi-file batch upload (single file at a time in v1; multi-file in v2)

## Version history

- v1.0 (28 Apr 2026) — initial spec
