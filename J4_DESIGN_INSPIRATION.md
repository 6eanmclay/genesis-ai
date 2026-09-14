# J4 Design Inspiration — learning design language, not copying websites

**Status: v3, 2026-08-07 — design only, not yet implemented.** Sean's framing: "the goal isn't to learn the business — it's to learn design principles." A real test today confirmed the current gap directly: pasting a URL into chat waited a long time, then correctly replied it can't access external websites. Expected, given nothing fetches a URL today — and it confirms this capability (and J4 Learning Sources) are both real gaps, not imagined ones. v2 added multi-source synthesis. v3 adds inspiration sources beyond whole websites (a logo, a product photo, a single screen) and names cross-business design learning as a real, distinct, deliberately-not-designed-yet future direction.

## Why this is a distinct capability, not a mode of Learning Sources

`J4_LEARNING_SOURCES.md` answers "what is this business" — facts, feeding `BusinessRecord` via `sourceProvider`. This document answers a completely different question: "what makes this design effective, and how do those principles translate into an original design for *this* business." Different question, different target. Learning Sources writes to the Understand layer (Facts). Design Inspiration never touches `BusinessRecord` at all — its destination is `Theme`/`DesignDirection`, the exact structures `update_theme` and `update_design_direction` (`GENESIS_ACTIONS`) already govern. Keeping these as two documents, as Sean asked, keeps two genuinely different problems from blurring into one.

**Where this actually sits, precisely, rather than forced into the Facts/Beliefs split**: it's neither. A `Belief` is a pattern *learned* from repeated evidence about the business itself; a Fact is current, verifiable state. A reference site the owner points at isn't evidence about their business at all — it's a stated creative preference, informed by real external examples instead of an abstract adjective ("make it feel more premium"). That's closer in kind to how `brandPersonality`/`designDirection` already work as owner-authored creative input than to either existing category — worth naming honestly as a third kind of input (*presentation intent*) rather than stretching Facts or Beliefs to cover it.

## Multi-source synthesis — principles across examples, not emulation of any one

Sean's extension: an owner should be able to cite several references at once — "I like Apple's navigation, Notion's typography, Stripe's illustrations, and Patagonia's storytelling" — with J4 identifying the common design language across them, not picking one to emulate.

That example itself reveals the real shape this needs: the owner isn't saying "I like these four sites overall" — they're citing a **specific aspect** from **each** specific source. Apple for navigation, Notion for typography, Stripe for illustration style, Patagonia for narrative/content voice. A synthesis step that just pools every attribute from every source and averages them would lose exactly what the owner asked for — they want navigation-pattern from source A blended with typography-approach from source B, not a homogenized composite of all four. The analysis step (§ above) needs to carry, per source, *which aspect it was cited for* when the owner specifies one — and fall back to a full general reading only when they don't (e.g., "I like Apple and Notion's whole aesthetic").

This means the pipeline gains a real step between analysis and adaptation: **N independent per-source analyses** (each producing the same asset-free, structured design-language attributes as the single-source case, tagged with whichever aspect it was cited for, if any) → **one synthesis pass** that identifies genuine common principles where sources overlap and preserves distinct per-aspect attribution where they don't → **one adaptation pass**, same as the single-source case, now drawing from the synthesized language instead of one source's. The explanation step (§ above) also needs to scale: not four separate "here's what I noticed" replies, but one coherent synthesis explaining what each reference actually contributed and why those specific principles were chosen.

## Inspiration isn't only whole websites

Sean's own further examples — "I like the color palette from this logo," "I like this product photography," "I like this app's dashboard" — aren't website URLs at all. A logo or a product photo is exactly what the chat's existing upload buttons already accept; an app's dashboard or one specific screen is a single image, not a whole site to crawl. This isn't a new input mechanism to build — it's the same per-source analysis step (§ above) accepting either of the two sources this codebase already has real fetch paths for: a URL (screenshot it, per the shared fetch layer) or an uploaded image (already real, via the same upload flow `classifyAndExtractAsset` uses for a business asset today). Both converge on the identical next step — a real image in front of the same vision-based design-language analysis — so "source type" only matters at the point of getting a screenshot into hand, never afterward. `classifyAndExtractAsset`'s job is asking "what business fact is this"; this pipeline asks a same-shaped image the opposite question, "what design principle is this" — genuinely reusing the ingestion half of Business Assets without reusing (or needing to touch) its interpretation half at all.

## Shared infrastructure, separate interpretation — don't build two site-fetchers

Both capabilities need the same first step: given a public URL, fetch it. Building that twice — one fetcher for Learning Sources, a separate one for Design Inspiration — would be real, avoidable duplication. The right shape is one shared fetch/render layer, governed by the same real constraints already named in `J4_LEARNING_SOURCES.md` (`robots.txt`, no scraping behind a login, real rate-limiting), with two independent interpretation passes on top: one reads the fetched content for business facts, the other reads it for design language. Same input, two different questions asked of it.

**A real technical fork worth naming now**: Learning Sources is fundamentally a text-extraction problem (copy, prices, policies, contact info) — reasonably robust to a plain HTML fetch. Design Inspiration is fundamentally a *visual* problem — layout, spacing, hierarchy, color, typography as they actually render, not as they're described in markup. A raw HTML/CSS parse is a poor proxy for this, especially against modern component-library-heavy sites where the real visual design only exists after JavaScript renders it. **The design-language analysis should run against a real rendered screenshot, not parsed markup** — captured via a real headless browser (Playwright, already a real dependency in this codebase, currently used only for testing) and analyzed through the same vision pipeline `classifyAndExtractAsset` already uses for an uploaded photo. This reuses a real, proven capability instead of inventing CSS-parsing heuristics that would miss what a rendered page actually looks like.

## What already exists to build on

The destination isn't new. Onboarding already generates a structured `Theme` + composition from a text brand description — `GENERATION_COMPOSITION_SYSTEM_PROMPT` and `CHAT_COMPOSITION_SYSTEM_PROMPT` already produce exactly the shape `ThemeInputSchema` (colors, typography, layout, presentation, composition) validates, which `update_theme`'s approval flow already knows how to diff and apply. Design Inspiration doesn't need a new generation mechanism — it needs a new *input* into the one that exists: a reference site's analyzed design language, standing in for (or alongside) a text description, producing the same structured proposal through the same approval action.

## The critical guardrail: principles out, never assets

"Inspired by, not copied" has to be enforced in what the extraction step is structurally capable of producing, not left to a prompt's good behavior. The design-analysis output should be restricted to *language about* the design — a layout's structural pattern (e.g. split hero, generous negative space), a palette's tonal character (e.g. muted earth tones, high-contrast monochrome with one accent), a typographic pairing's category (e.g. a humanist sans headline over a book-style serif body), a spacing rhythm — never the literal hex values lifted verbatim, never the source's actual copy, and never its images or logo. The schema itself should have no field capable of carrying a literal asset forward; this is a data-shape decision, not an instruction to be careful.

## Sean's own example names a second real output most of this document's mechanism doesn't cover yet

"Explain what makes it effective" is a real, distinct conversational moment — not a byproduct of the generation step. Today's design-generation flows produce a *result* (a Theme, a Composition); nothing in the current architecture produces design *reasoning* back to the owner as its own output. This document proposes the analysis pass produce two things, not one: the structured, asset-free design-language attributes (feeding generation), and a real, plain-language explanation of what the reference site does well and why — the actual "here's what I noticed" moment Sean described, shown to the owner before the adapted design is even proposed.

## Proposed shape

1. **Fetch + render** each reference URL (shared layer, see above; one or many) — a real screenshot per source, not just HTML.
2. **Analyze, per source** — one model call per reference, given its screenshot and whichever aspect (if any) the owner cited it for, extracting (a) structured, asset-free design-language attributes, scoped to that aspect when one was given, and (b) a real, specific explanation of what that source does well and why.
3. **Synthesize** (only when there's more than one source) — one pass that reconciles the N per-source analyses into a single coherent design language: genuine common ground where sources agree, distinct per-aspect attribution preserved where they don't (navigation from one, typography from another), and one unified explanation naming what each reference actually contributed. Presented to the owner as understanding, before anything is proposed — matching the same "here's what I understand, then ask/propose" pattern already established for Learning Sources and for chat's own concise-summary direction.
4. **Adapt** — the synthesized (or single-source) design language, plus the owner's *own* real brand identity and content (already known — this is where it genuinely benefits from Business Understanding already existing, even though this document's own output never writes to it), generates an original `Theme`/`DesignDirection`/composition proposal through the existing `update_theme`/`update_design_direction` approval actions. Owner-reviewed, same as every other content action — never auto-applied.

## A named, deliberately un-designed future direction: J4 learning design across businesses

Sean's longer-term framing: every reference an owner shares, every approved design, every rejected proposal should eventually teach J4 what good design *is*, generalized — not just what one business asked for. Real and worth taking seriously, but honest about why it isn't designed here: everything above this section is scoped to one store, one owner, one conversation. This is categorically different — it's a **Learn-layer** capability (`J4_FOUNDATION.md`'s Understand/Execute/Learn/Reason architecture) that would need to generalize *across* stores, which today's `Belief` model was never built for (one row per `(store, topic)`, deliberately store-scoped) and which this codebase's tenant-isolation guard (`lib/tenantIsolation.ts`) exists specifically to prevent leaking between.

That doesn't make it wrong — it makes it a real design problem in its own right, roughly the same shape as the one narrow, already-precedented exception to tenant isolation this codebase allows (`prismaSystem`, reserved for genuine cross-tenant system operations, never a request carrying one user's session). A future cross-business design-learning system would need the same discipline: learning *abstracted* principles only (a pattern like "high-contrast CTAs against muted palettes tend to get approved," never one business's actual brand, copy, or imagery), with real evidence behind each generalized claim the way `Belief` already requires for a single store. Naming this now so it isn't lost — designing it is a separate, later document, not a paragraph inside this one.

## Open questions this document doesn't answer yet

- **Screenshot fidelity across real-world sites** — responsive breakpoints, animation/interaction design, dark-mode variants. A single static screenshot is a real simplification; how much of "the design" that misses is unverified.
- **Genuine conflicts between sources** — one reference minimal, another maximalist, with no real common ground for a given aspect. Undecided whether synthesis should pick one, blend cautiously, or surface the tension back to the owner rather than silently resolving it.
- **How the explanation and the adaptation relate conversationally** — does the owner see the explanation and get to react/redirect before adaptation runs, or are both produced in one pass? Bounded-questioning precedent (`experienceFlow.ts`) suggests the former is more consistent with how this product already works, but isn't decided here.
- **Same legal/ToS posture as Learning Sources** — inherits those constraints via the shared fetch layer, not a separate policy, but worth confirming explicitly once both capabilities are real and this document isn't the only place that assumption lives.

---

## v4, 2026-09-14 — Contextual Link Understanding + Explicit Reference Design Intent

**Status: backlog, design only, not implemented.** Sean's framing, captured verbatim in shape: this capability decides **when and why** Reference Design Mode is invoked. It does not replace it. Reference Design Mode (see `project_reference_design_mode` — slice 1 built on frozen 741ebbb, approval/execution deliberately unwired) stays exactly as it is; what is missing is the judgement in front of it.

### A URL alone must never imply "copy this"

Four distinct intents an owner can carry when they put a link in front of J4, and today nothing distinguishes them:

| | The owner says | What J4 should do |
|---|---|---|
| **A** | "What do you think of this?" | Analyse the site, offer observations. **Change nothing.** |
| **B** | "Find some ideas from this." | Extract principles worth reusing. **Change nothing.** |
| **C** | "Make my website layout look like this." | The only intent that activates the reference-design workflow. |
| **D** | "Find me some great commerce website designs for my business." | Research several strong examples and reason about their patterns. |

The rule underneath: **only an explicit stated intent to reproduce or adapt a site's layout activates C.** A pasted URL is not that intent. A/B analyse and report without touching the owner's storefront — which is the same discipline the multi-source analysis above already has, applied one step earlier, at intent rather than at synthesis.

**D is not "pick one and copy it."** It is research across examples, reasoned about as patterns. Its output is the same shape the rest of this document already calls for: reusable **design principles, patterns and recommendations** J4 can apply to *this* business — never a single site selected and reproduced. This is the same "learn design language, not copy websites" rule in the document's title, extended to the case where the owner supplies no reference at all.

### J4's design suggestions must be visually demonstrable

A proposal an owner cannot see is a proposal they cannot judge. When J4 proposes a visual or layout change it should be able to **generate a contextual mockup** and say, plainly:

> "Here's what I mean."

and show the owner the proposed result **before** asking whether to apply it.

Ideas it should be able to demonstrate: product-photo collages · hero compositions · product grids · image placement beneath icons/categories · editorial layouts · promotional sections · alternate navigation arrangements · typography and visual hierarchy · merchandising compositions.

**Grounded in the owner's real business, not placeholders.** The mockup should be built from their actual storefront, products, imagery, brand identity and available content whenever those assets exist. Generic placeholder products when real assets are available would make the demonstration answer a different question than the one asked — and this codebase already has the standing rule (`project_studio_creation_station`): never fake an asset to make an offer render.

**The visual is a proposal, never an automatic change.** This is the same boundary Reference Design Mode already draws by leaving approval/execution unwired, and it holds here for J4-originated ideas too.

### It has to work for both origins

- **Explicit reference** — "make my site look more like this" (intent C above).
- **J4-originated** — "I think this would look better."

The second must come from J4's understanding of the business plus established design patterns. It must not be a reference site copied without being asked for — which is the failure mode the intent table above exists to prevent, arriving by a different door.

### What this adds to the open questions

- Where intent classification lives: a bounded question to the owner when a link arrives with ambiguous framing, versus inferring from the sentence around the URL. The bounded-questioning precedent (`experienceFlow.ts`) argues for asking rather than guessing, and guessing wrong here means editing somebody's storefront they only wanted an opinion on.
- Whether a mockup is rendered from the real storefront (the live route, themed) or composed as an image. The storefront already renders from `Theme` + real products, and `resolvePreviewTheme` already previews an unapproved proposal against it for owner/employee only — which is a real, existing mechanism this should be measured against before inventing an image compositor.
