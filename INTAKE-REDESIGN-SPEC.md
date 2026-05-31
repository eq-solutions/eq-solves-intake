# EQ Intake — One-Screen Import

**Design build spec · v1 · ready to hand to a design app or designer**
Last updated 2026-05-30.

---

## 1. In one line

One screen that turns **any file** into either a **saved record in EQ** or a **ready-to-paste export** — by answering just two questions:
**“what have you got?”** (we detect it) and **“where’s it going?”** (one pick).

---

## 2. Why we’re redoing it

Today’s Import screen stacks **four** separate workflows on one page — a 42‑type
domain picker, “Quick export”, “Bundle → destination paste”, and “Save into
EQ”. It mixes **two opposite directions** (pulling data *in* vs pushing it
*out*) and leans on words no tradie should need: *canonical entity, domain,
bundle, destination template*. It makes the person do the computer’s job.

Replace all of it with **one screen**. (Their own current copy already says the
goal out loud — *“one file in, one file out — no faff”* — it’s just buried as 1
of 4 boxes. Make that the whole screen.)

---

## 3. Principles — the guardrails

1. **Technology invisible.** The user drops a file and picks a destination.
   Detecting the type, cleaning dates/phones, matching to existing records —
   all happens unseen.
2. **Two questions, both nearly answered.** *What is it?* is auto‑detected.
   *Where’s it going?* defaults to **Into EQ**.
3. **Plain English, EQ voice.** “the boys”, “the bookkeeper”, “your list” —
   never “entity” or “schema”. Calm and honest.
4. **Simple by default, deeper only when needed.** The clean path is
   drop → glance → Go. A review panel appears **only** if some rows need a human
   eye. Nothing is ever silently dropped.
5. **One screen.** No wizard, no tabs, no up‑front fork between “in” and “out”.

---

## 4. The screen — anatomy

A single centred column on the existing shell (left nav + **LIVE** pill stay).
Reads top to bottom. Three key states:

**A. Empty (landing)**
```
  Bring something in
  Drop a file and tell us where it goes. We’ll do the messy bit.

  ┌──────────────────────────────────────────────┐
  │                                              │
  │        Drop a file here, or click to pick    │
  │        CSV, Excel, PDF, or a photo of a list │
  │                                              │
  └──────────────────────────────────────────────┘
```

**B. File read → detected (the core moment)**
```
  Bring something in

  ┌──────────────────────────────────────────────┐
  │   plants.csv                          ✕      │
  └──────────────────────────────────────────────┘

  ✓ Looks like  Plant & equipment — 39 items     Change

  Where’s it going?
  ┌───────────┐ ┌──────┐ ┌──────┐ ┌─────────┐ ┌────────────┐ ┌────────┐
  │ ● Into EQ │ │ Xero │ │ MYOB │ │ Outlook │ │ SharePoint │ │ Other… │
  └───────────┘ └──────┘ └──────┘ └─────────┘ └────────────┘ └────────┘

                    [  Save into EQ  ]
```

**C. Done**
```
  ✓ Saved 39 plant items into EQ
  Filed from plants.csv — you can trace any row in Audit log.

  [ View in Plant & equipment → ]   [ Bring in another ]
```

---

## 5. Components

### 5.1 Drop zone
- The hero of the screen. Large, friendly, dashed border, **Ice** fill.
- **States:** idle → drag‑over (Sky border, lifts) → reading (filename +
  “Reading…” with a quiet spinner) → done (filename chip, detection line
  appears below).
- **Multiple files allowed** (some lists arrive in pieces, e.g. customers +
  sites + contacts). Show each as a small chip; hint: *“order doesn’t matter.”*
- Click anywhere in the zone = file picker.

### 5.2 “What is it” — detection line
The line that kills the domain picker. After reading, state what we found:
- **Confident:** `✓ Looks like  Plant & equipment — 39 items`  ·  **Change** link.
- **Close call:** `This could be Staff or Contacts.` → two inline buttons.
- **Unsure:** `We couldn’t place this one — what is it?` → a plain‑language
  type dropdown (the manual fallback; the *only* time the user picks a type).
- **Change** is always available, so a wrong guess is never a dead end.

### 5.3 Destination picker — “where’s it going?”
- A single row of pill/segmented options. **Into EQ selected by default.**
- v1 set: **Into EQ · Xero · MYOB · Outlook · SharePoint · Other…**
  - **Into EQ** → saves to the **logged‑in tenant’s** canonical layer.
  - **External** → produces a download shaped for that system.
  - **Other…** → “upload a sample of your target list and we’ll match it.”
- Selected = **Sky** fill, white text. Unselected = white, **Ink** text, light border.

### 5.4 Primary action
- **One button, adaptive label** so the user knows what happens:
  - Into EQ → **“Save into EQ”**
  - External → **“Download for Xero”** (MYOB/Outlook/…).
- Disabled (greyed) until a file is read. Destination is pre‑picked, so usually
  it’s live the moment detection lands.

### 5.5 Result
- **Into EQ:** `✓ Saved 39 plant items into EQ` · sub: *“Filed from {file} — trace
  any row in Audit log.”* · actions: **View in {place} →**, **Bring in another**.
- **Export:** `✓ Your Xero file is ready` · **Download**, **Start over**.

### 5.6 Review panel — *only when needed*
- If some rows need a human eye, the result reads:
  `Saved 36 of 39 · 3 need a quick look →`.
- Opens a slim list: the flagged rows, the plain reason (*“couldn’t read the
  date 13/13/2025”*, *“no site matches ‘Equnix’”*), and inline **fix / skip**.
- The clean rows are already in — the panel never blocks them. This is how we
  keep the screen simple **and** never silently drop a row.

---

## 6. The flow

```
Drop file(s)
   → Read + auto‑detect type        (unseen: parse, classify, clean up)
   → Show "Looks like X — N items"  (Change if wrong)
   → Pick destination               (Into EQ by default)
   → Press Go
        ├─ all clean  → Result: saved / downloaded
        └─ some flagged → Result + "N need a look" → Review panel → done
```

---

## 7. States & edge cases

| Situation | What the screen does |
|---|---|
| Unreadable / not a data file | `We couldn’t read that file. Is it a CSV, Excel, PDF or photo?` |
| Big file | Progress in the drop zone; stays on the one screen. |
| PDF / photo | Same flow; “Reading…” may sit a little longer (it’s doing OCR/extract) — say *“this one takes a moment.”* |
| Excel with several tabs | `This workbook has 3 tabs — which one?` small picker. |
| Wrong guess | **Change** is always present. |
| Re‑importing a list we’ve seen | `Looks like an update to your existing Staff — replace, or add as new?` |
| Empty result after filtering | Never silent — show what was skipped and why. |

---

## 8. Copy deck (exact words)

| Element | Words |
|---|---|
| Page title | **Bring something in** |
| Page subtitle | Drop a file and tell us where it goes. We’ll do the messy bit. |
| Drop zone (idle) | **Drop a file here, or click to pick** · CSV, Excel, PDF, or a photo of a list |
| Reading | Reading {filename}… |
| Detected (confident) | ✓ Looks like **{type}** — {n} items · *Change* |
| Detected (unsure) | We couldn’t place this one — what is it? |
| Destination heading | **Where’s it going?** |
| Destinations | Into EQ · Xero · MYOB · Outlook · SharePoint · Other… |
| Button (into EQ) | **Save into EQ** |
| Button (export) | **Download for {system}** |
| Success (into EQ) | ✓ Saved {n} {type} into EQ |
| Success sub | Filed from {filename} — you can trace any row in Audit log. |
| Success (export) | ✓ Your {system} file is ready |
| Needs review | Saved {x} of {n} · {y} need a quick look → |
| Secondary actions | View in {place} → · Bring in another · Start over |

> Voice rule: plain, warm, honest. Never “entity”, “schema”, “canonical”,
> “bundle”. Never over‑promise (“done” only when it’s actually saved).

---

## 9. Look & feel

- **Font:** Plus Jakarta Sans.
- **Palette:** Sky `#3DA8D8` (primary / selected), Deep `#2986B4` (hover /
  active), Ice `#EAF5FB` (fills, drop zone), Ink `#1A1A2E` (text).
- **No gradients. No shadows.** Flat, 1px borders, rounded corners.
  Linear / Notion calm. Generous whitespace — the drop zone should breathe.
- Drop zone: Ice fill, dashed border; **Sky** solid border on drag‑over.
- Selected destination: **Sky** fill / white text. Others: white / Ink / light border.
- Keep the existing left nav and **LIVE** pill untouched.

---

## 10. What’s already built (so design knows what’s real)

This is **one screen over capabilities that already exist** — not new plumbing.

- **Read any file** — CSV, Excel, born‑digital PDF, and photos of lists.
- **Auto‑detect the type** — scores the columns against all ~42 EQ list types
  and picks the match. *This is what powers the “Looks like…” line — and why the
  domain picker can be deleted.*
- **Clean it up** — Australian dates, phone numbers, yes/no, and fuzzy‑matching
  names to records already in EQ.
- **Into EQ** — saves to the logged‑in tenant’s canonical layer, with a full
  audit trail (trace every file and row).
- **Out to** — Xero (Contacts), MYOB (Card File), Outlook (contacts),
  SharePoint (rollup), and “upload a sample to match a custom list”.

> For the build team: engine lives in `eq-platform/packages/eq-intake`
> (readers + `classify.ts`), `@eq/validation` (clean‑up), the canonical commit
> RPCs, and `eq-platform/packages/eq-format-ui` (the out‑routes).

---

## 11. Out of scope for v1

- The legacy **SimPRO‑branded** framing (the engine stays; the SimPRO wording goes).
- A distinct “bundle” mode — multi‑file is handled by just detecting each file.
- Scheduling / automation / API import. Manual drop only for v1.

---

## 12. Open questions for design / Royce

1. **Show destinations smartly per type** (hide Xero for a plant register), or
   show all and grey out the irrelevant? *Reco: grey‑out in v1, smart in v2.*
2. **Preview before saving Into EQ**, or save‑then‑show‑result with easy undo?
   *Reco: save‑then‑result (we already have one‑click rollback); only force the
   review panel when rows are flagged.*
3. **Re‑import behaviour** — when the same list comes in again, default to
   *update existing* or *add as new*? Needs a clear, plain prompt either way.
