# J4 Learning Sources — every input, one Business Understanding

**Status: v1, 2026-08-07 — design only, not yet implemented.** This document exists because Sean corrected its own framing before it was written: "I don't want this to be thought of as an import feature — I want it to become one of J4's primary ways of learning a business... The website is simply one source of truth. J4 shouldn't think, 'I imported a website.' It should think, 'I've learned about this business.'" That correction is the whole document — everything below exists to make it architecturally true, not just rhetorically true.

## The reframe already matches the code — this isn't new philosophy, it's a name for something real

Before proposing anything new, it's worth stating plainly: Sean's instinct is already how `BusinessRecord` works today. Every canonical fact carries a `sourceProvider` — `"genesis_chat"` (the owner told J4 directly), `"genesis_upload"` (a photo or document), `"quickbooks"`/`"mailchimp"`/`"google_calendar"` (a connector sync). `J4_FOUNDATION.md` §3 is explicit that this is one registry, one set of Zod schemas, one `getBusinessProfile()` — never a separate "uploaded business data" versus "typed business data." A website and a future Shopify/WooCommerce/Gmail connection aren't a new subsystem under this reframe. They're two more values `sourceProvider` can take, feeding the exact same model everything else already feeds.

So the real design question isn't "how do we build an import feature." It's "what does it take to make a website — and, in time, any future connector — a peer of chat and uploads as a way J4 comes to know a business." That question has two different, concrete answers, because a website and an API-backed platform arrive as fundamentally different shapes of evidence.

## Two shapes of evidence, two existing mechanisms — neither is new

**A platform with a real API (Shopify, WooCommerce, Gmail, future connectors)** is not a new concept. It's a new `IntegrationConnector` (`lib/integrations/types.ts`) — the same contract Stripe, QuickBooks, Mailchimp, and Google Calendar already implement. `connect()` handles auth, `sync()` returns `SyncedRecord[]`, `persistSyncedRecords()` validates against the real entity schemas and writes with `sourceProvider: <the provider>`. The only genuinely new idea this document adds to that existing mechanism: **a connector's `sync()` shouldn't only run on a schedule.** Today, per `lib/execution/adapters/integrationExecutable.ts`, sync is something a connector does repeatedly over time. This proposes the same `sync()` call also running once, deliberately, at the moment a business connects a platform during onboarding — a large first learning pass instead of waiting for the first scheduled sync to trickle in. No new contract; a new *moment* an existing contract fires at.

**A website with no API — just a URL** has no existing equivalent, and is the genuinely new piece. The right shape for it is Business Assets' own governance, applied to scraped pages instead of uploaded files: fetch, extract, score confidence per `classifyAndExtractAsset`'s existing 0-1 model, and only at or above `CONFIDENCE_THRESHOLD` propose a create/link — otherwise ask. What a scraped page becomes is never a new write path:

- A product-like page → a `create_product` **ApprovalRequest** — not a direct `BusinessRecord` write. `item` is always derived from the real `Product` table (`J4_FOUNDATION.md` §3); this is exactly why Business Assets' own confident-product-discovery already goes through approval instead of a phantom record, and a website-learned product must follow the identical rule.
- The homepage, brand voice, "about" copy → `update_brand_identity`/`update_homepage_content` proposals — the same `GENESIS_ACTIONS` entries chat's own content-editing already targets.
- A policy page → an `update_store_content` proposal.
- A contact/locations page → a `location` `BusinessRecord`, direct-written — the same trust tier chat's own business-fact capture already uses for a stated goal, challenge, employee, or location.

Nothing here invents a new destination for learned data. The website-understanding pipeline's entire job is turning scraped HTML into the same shape J4's other learning sources already produce, so every downstream system — the approval queue, `getBusinessUnderstanding()`, chat's own data-answer path — sees one business, learned five different ways, not a website-shaped fact sitting apart from a chat-shaped fact.

## Where this sits in the Foundation's own architecture — and where it doesn't, yet

`J4_FOUNDATION.md` names Understand/Execute/Learn/Reason as the four real subsystems. This document's proposal is squarely **Understand** — more Facts, from more sources, assembled into the same `getBusinessProfile()`. It is deliberately *not* proposed as a **Learn** contribution (a `Belief`, with confidence and maturity) — a one-time website read is a snapshot, not repeated evidence over time, and blending the two would violate the Foundation's own root rule that Facts and Beliefs stay separate. A learned fact from a website is exactly as canonical, and exactly as revisable, as a fact the owner typed in chat — no more, no less certain for having come from a crawl instead of a sentence.

**Sean's "not just during onboarding" instruction is real, additional scope, not something the architecture already gives for free.** A connector re-syncs on its own schedule; a website does not re-crawl itself. If a business's site changes six months in — a new policy, a discontinued product — nothing today would notice unless a real re-check mechanism exists. This document does not propose one yet (verification/re-check cadence, staleness display, and how a re-crawl reconciles against fact the owner has since edited by hand are all real design questions of their own), but names it explicitly so "continuous, not just onboarding" isn't quietly dropped once the onboarding moment ships.

## The presentation moment: "here's what I already understand," not a form

Sean's own framing — the first conversation is J4 presenting understanding, then asking only what's missing — has a real, already-proven precedent to build on rather than invent: `lib/onboarding/experienceFlow.ts`'s `MAX_VISITOR_TURNS_BEFORE_FORCED_GENERATION = 2`, "one, rarely two" clarifying rounds, told to the model as a real constraint rather than hard-truncated. The same bounded-questioning discipline applies here. And the presentation itself — a synthesized understanding, not a list of forty extracted fields — is the same concise-summary-first principle already agreed for chat replies (`J4_UNIFIED_INTELLIGENCE.md` §7): lead with what J4 now understands, in a few sentences, with the detail available to expand into, not required reading.

## Two honest constraints, unchanged from the original proposal

- **Scraping a real business's site needs a real policy before it touches one** — respect `robots.txt`, never scrape behind a login, rate-limit real requests. Not an afterthought.
- **Confidence-gated extraction from one photo is a narrower problem than confidently understanding an entire business from a homepage crawl.** A thin or low-quality site shouldn't produce a wall of low-confidence guesses — there needs to be a real threshold for "enough to summarize honestly" versus "this source gave me too little to trust," distinct from the per-item confidence score each extracted fact already carries.

## A phased approach

1. **Website understanding first** — no dependency on any one platform's API, the broadest real applicability (every business has a website; most existing small businesses aren't all on one platform), and the most novel, differentiating half of what's proposed here. Proves the confidence-gated scrape-to-proposal pipeline end to end.
2. **One real structured connector** (Shopify is the natural first candidate — the most common real platform an existing small business is already on) proving the "sync at onboarding, not just on schedule" idea against a real API rather than scraped HTML.
3. **Generalize**: once both are real, *every* future connector inherits "can also run once at onboarding as a first learning pass" as a property of the connector contract itself, not something reinvented per integration.

## Open questions this document doesn't answer yet

- **Re-check cadence for a non-API source.** How and when does a website-learned fact get revisited, and how does a re-crawl reconcile against something the owner has since corrected by hand?
- **The "enough to summarize" threshold** — distinct from per-fact confidence, a real bar for whether a source produced enough real signal to present understanding at all versus asking the owner to just tell J4 directly.
- **Multi-source conflict.** If a website says one price and a later-connected Shopify sync says another, which wins, and how is that surfaced honestly rather than silently overwritten? `BusinessRecord`'s `sourceProvider` already makes provenance visible per-record — this document doesn't yet propose what conflicting provenance across two live sources should do.
