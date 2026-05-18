# How we work with AI on EQ

This doc exists because we drifted off course early in the EQ build, and the lesson is worth keeping.

## What happened

The first version of this bundle was framed as a SaaS product launch — competitive moats, customer acquisition, pricing strategy, "battle-tested at scale," go-to-market thesis. That framing was never Royce's. Royce is a tradie who became an operations manager who has lived the pain of data movement in trade subbie businesses and wants to fix it. Money is a downstream mechanism, not the goal. Helping the boys at 6:30am and the bookkeeper at 8pm is the goal.

The drift wasn't a single bad turn. It accumulated. Each artefact was internally consistent. Only the totality was off-frame. By the time it got corrected, ten thousand lines of docs had been written in a register that didn't sound like Royce.

This is a recoverable mistake, but the cost was real — hours of attention spent reading docs that didn't fit. We're capturing the pattern so it doesn't happen again.

## The framing that wins

EQ exists to remove specific, named, daily moments of pain from the lives of trade subbies. Not "tradies in general." Specific people doing specific things on specific days. The apprentice doing the same induction four times this week. The bookkeeper retyping timesheets at 8pm Friday. The PM photographing a SWMS and emailing it to a compliance officer who uploads it into yet another portal.

Every product decision answers to those moments. If we can't name the person and the moment, the feature waits. If a feature is described in terms of "scale," "growth," "moat," "platform," or "market" — that's a flag to stop and ask: what specific moment of pain does this remove?

The plumbing (schemas, validation, AI mapping, migrations) serves those moments. When the plumbing becomes the point, we've drifted.

## How AI sessions should open

Every Cowork or Claude session that has scope to write or revise major docs should open with a re-anchor:

> "Read `EQ-AS-CONDUIT.md` first. Confirm in your own words what we're building and why before suggesting changes or adding scope."

If the AI's playback uses business-school vocabulary that Royce wouldn't use ("moat," "go-to-market," "platform thesis," "validate willingness to pay," "enterprise tier," "TAM," "scaling"), that's the signal that drift has started. Correct it before going further. The cost of correcting framing on turn 3 is tiny. The cost on turn 30 is hours.

## Vocabulary check — what doesn't fit

Words and phrases that signal AI has imported the wrong frame:

- "SaaS" / "product-market fit" / "go-to-market" / "GTM"
- "Moat" / "defensibility" / "competitive position"
- "Customers" used to mean "anyone who pays," rather than naming specific people we're trying to help
- "Battle-tested at scale" / "production-ready" / "enterprise-grade" — claims that sound confident but aren't backed by real running code with real users
- "Platform thesis" / "platform play" / "vertical SaaS"
- "Pricing model" / "pricing strategy" / "willingness to pay"
- "Roadmap" used as a contract rather than a guide
- "Stakeholders" instead of "the people who will use this"
- "Enterprise tier" / "free tier" / "growth tier" — tier-based thinking imported from SaaS pricing
- "Acquisition funnel" / "activation" / "retention" / "expansion revenue"
- Framing incumbents (SimPRO, Xero, AroFlo) as enemies, competitors, or things to "beat"

Words that fit:

- "The boys" / "the bookkeeper" / "the apprentice" / "the PM"
- "On site" / "at 6:30am" / "Friday at 8pm"
- "The thing that breaks" / "the moment of retyping"
- "Conduit" / "between systems" / "removes the human-retyping step"
- "We sit between, we don't replace"
- "Real people, real pain"

Not a strict ban list — sometimes business words are the right words. But if a paragraph is full of the first list and empty of the second, something has drifted.

## Concrete rules for future AI sessions

**1. Re-anchor at the start of every substantive session.** AI reads `EQ-AS-CONDUIT.md` and plays back what we're building before suggesting work. If the playback doesn't sound like Royce, correct before going deeper.

**2. Ask "for whom and when" before adding scope.** Any new feature, doc, or architectural change must answer: which specific person experiences this, on which specific day, and what moment does it remove or improve? If the answer is hand-wavy, the feature waits.

**3. Treat memories as previous conversations, not ground truth.** Memories include past framings that may have been wrong or have since changed. If a memory says "EQ targets first 5 paying customers" and Royce now says "I want to help people," the latter wins. Ask if uncertain.

**4. No "production-ready" / "battle-tested" / "ship-ready" language for code that hasn't run with real users.** Replace with: "this is a starting point. Real running will reveal flaws." That's accurate. The other claims are theatre.

**5. Push back on momentum.** When Royce says "keep going, build more," and the work has accumulated several rounds without a framing check, the right move is sometimes to ask "should we pressure-test the frame before adding another layer?" This is not refusing. It's serving.

**6. Calibrate confidence honestly.** If something is uncertain, say so. If something hasn't been tested, say so. If something is a guess based on training data rather than observed reality, say so. False precision is more harmful than admitted uncertainty.

**7. Default to plain language.** If a sentence can be written without jargon, write it without jargon. If jargon is genuinely the most precise word, use it but explain it. The bookkeeper at 8pm Friday is the audience, not the venture capitalist.

**8. Safety-critical features are never gated behind paywalls.** Inductions, SWMS, prestarts, JSAs, incident reporting. People die when corners get cut on this. We are not the reason a corner gets cut. This rule is non-negotiable and applies to every pricing or feature-gating discussion.

**9. The roadmap is a guide, not a contract.** Real customer pain reorders priorities. Listening matters more than hitting dates. AI should not push toward "shipping by date X" over "fixing the right thing well."

**10. When uncertain about framing, ask Royce directly.** Don't assume. Don't extrapolate from memories. Don't pattern-match to "what someone in this position usually wants." Ask. The cost of one clarifying question is far less than the cost of building in the wrong direction.

**11. Never let EQ Intake silently drop rows.** Every input row deserves a row out — committed, rejected with reason, or surfaced for review. Drop counters that nobody reads are not enough. When working on intake / rollup / reshape-out logic, look for `continue` / early-return / `if (!x) skip` paths that don't record what was dropped and why. New intake code should produce `{ committed, rejected: [{ row, reason }] }`, not just commit-or-discard. EQ exists to stop information falling between systems — when EQ itself swallows rows quietly, it's becoming the gap it was built to close. Caught after the SimPRO Equinix rollup lost 72 sites silently on 2026-05-18; the `dropped` counter existed and nobody read it.

## How Royce can help AI stay on track

This isn't all on the AI. A few things Royce can do that make drift less likely:

**Correct vocabulary mismatch the first time it appears.** If a doc uses words that don't sound like you, say so immediately. Don't wait for it to accumulate. The drift is cheaper to fix at turn 3 than turn 30.

**Watch for confidence inflation.** If AI says "production-ready," "battle-tested," or "ready to ship" for something that hasn't actually run with real users, push back. Replace with honest qualifiers.

**Trust the "this isn't quite right" instinct.** When something feels off but you can't articulate why, force a pause anyway. That sense is information. The whole conduit reframe came from one of those moments. Without it, the drift would have continued.

**Ask AI to tell you back what we're building.** Plain language. No jargon. If what comes back doesn't sound like you, correct it before continuing.

**Be skeptical of artefacts that grow without sanity checks.** Each round of additions is easy to wave through. The right move sometimes is to stop and ask "is this still serving the actual goal?" Even if the work is good in isolation.

## What the lesson generalises to

This pattern applies beyond EQ. Whenever working with AI on something that matters:

- Ask AI to play back the goal in plain language before going deep
- Watch for vocabulary that doesn't sound like you
- Treat AI's confidence as input, not as truth, especially for "ready to ship" claims
- Memories drift; check that current intentions still match historical framings
- Momentum is comfortable but it can carry you in the wrong direction
- The first time something feels off, say so

The technical work AI produces is often genuinely good. The framing AI imports without checking can quietly mis-aim that good work at the wrong target. Catching that early is the highest-leverage thing.

## Where this doc lives

Reference this doc at the start of any major Cowork or Claude session that has scope to write architecture, marketing, planning, or strategy docs. Sprint-level technical sessions (writing the validation engine, debugging the migration) don't need it — that work is plumbing and the plumbing is the plumbing regardless of why we're building it.

But anything that touches *why*, *for whom*, *at what cost*, *in what register* — open this doc first.
