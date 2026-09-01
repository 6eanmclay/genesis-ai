# Architecture

A snapshot of how Genesis AI currently works — not chronological (see `CHANGELOG.md` for history) and not a priority list (see the [engineering roadmap](https://claude.ai/code/artifact/7679e3e9-1030-4d2b-b3b4-9a18fd64b4a7) for what's next). This file is edited in place as the system changes, so it should always describe *today's* system, not a past one.

**Last updated:** 2026-07-31, through the J4 Cognitive Architecture's Foundation (Understand/Execute/Learn/Reason, formally adopted and frozen) and the Business Intelligence Engine's first three capability tiers. See the new *J4 Cognitive Architecture* and *Business Intelligence Engine* sections below — inserted after *Delegated Authority*, since Execute's authority model is a direct prerequisite for both. `J4_REASON_VALIDATION.md` (repo root) records the empirical validation behind this architecture's central design bet (Reason grows by receiving richer inputs, not by rewriting its own logic) and should be read alongside this file, not duplicated into it. Phases 0–5 of the earlier "Genesis operates the business" pivot (authority/action classification, closing the chat-vs-manual approval fork, the Genesis Workspace shell, opportunistic proactivity, and Measure/Learn) still aren't individually documented in this file — see `CHANGELOG.md`'s condensed pivot entry for that detail.

---

## High-level overview

Genesis AI is an AI-first e-commerce platform: a merchant describes their business in plain English, and Claude generates a complete branded storefront — identity, homepage content, theme, and products — which the merchant can then refine through conversation with Genesis before publishing.

**Stack:** Next.js 16 (App Router) + React 19 + TypeScript, Tailwind CSS v4, PostgreSQL (Neon in production) via Prisma 7 (driver-adapter pattern — see the Database section), Auth.js (NextAuth v5 beta), Anthropic Claude (`claude-opus-4-8`) for all generation/chat, Stripe for payments, Unsplash for placeholder product imagery. Deployed on Vercel.

**Where logic lives:** almost everything is a Next.js Server Action (`"use server"` files), not a REST API today — see *API design* below for why that's a known gap, not an oversight, and what's planned to change it.

---

## Authentication

`auth.ts` (NextAuth v5, JWT session strategy) supports email/password (bcrypt-hashed, `Credentials` provider) and Google OAuth. The session JWT carries only `user.id` — nothing else, deliberately. Role/permission context is **not** baked into the session; see *Permissions & Roles* below for why.

`next-auth.d.ts` augments the default session type so `session.user.id` is typed.

---

## Security & Trust — BUILT AND VERIFIED 2026-08-22

**Status: shipped.** Contract approved by Sean with six explicit decisions; built in the dependency-driven order the contract set — event log, session revocation, re-authentication, 2FA with recovery codes, the security screen, access review, member management, notifications.

**What the audit of the existing architecture found, before any code was written** — the item the original scoping asked for:

* **JWT session revocation already existed and worked.** `auth.ts` refuses a token whose `iat` predates `User.passwordChangedAt`, killing it on its NEXT request rather than at expiry, verified against Auth.js internals. So D1 was approved to EXTEND that mechanism rather than move every user onto database sessions. `UserSession` is a *record* of a session keyed by the `sessionInstanceId` the JWT already carries — not the session itself.
* **The authorization model was enforced on the read side and unreachable on the write side.** `StoreMember` has been honoured by `hasPermission` everywhere for months, and nothing in the product could create one: every row that had ever existed was written by a verification script. That is why D5 rejected a review screen on its own.
* **Three standings, not a boolean.** A token minted before `UserSession` existed carries an instance id with no row. Treating "no row" as "revoked" would have signed out every user on the platform on deploy.

**Invariants this milestone holds**, each negative-controlled:

* A revoked session dies on its NEXT request, and ending one device never ends the others.
* The second factor is enforced in `authorize` — the single gate every credential sign-in passes — so no session exists until it is satisfied. Refused identically to a wrong password.
* A recovery code works exactly once, claimed with a conditional update.
* The TOTP seed is encrypted at rest with the same AES-256 helper as integration credentials; the suite reads the column and asserts the plaintext is not in it.
* Security events are account-scoped and append-only, and recording never fails the act it records.
* Removing a member ends that member's sessions — which is why member management came after revocation.
* The access review READS `ROLE_PERMISSIONS` (now exported) rather than restating it.

**Externally blocked, and recorded rather than faked:** notification *delivery* needs `RESEND_API_KEY`. Every decision — whether to notify, about what, to whom, and what it says — is proved through an injected sender; only the send itself is unverified.

**Deferred from v1 by decision:** trusted devices (D3 — the one item that weakens the guarantee 2FA exists to provide); 2FA remains opt-in (D6); no IP or location is stored (D4).

**Original scoping, kept for the record — 2026-08-06, then explicitly not built:** Sean's own framing for why this earns a dedicated milestone rather than a scattered list of feature requests: *"As Genesis becomes a business operating environment that stores documents, financial information, integrations, and J4's understanding of a business, account security becomes a core product capability."* Follows the current foundation work (J4 Cognitive Architecture, Business Assets, the Understanding page) in priority — high, but deliberately sequenced after it, not competing with it.

Treated as one cohesive milestone, not eight unrelated features — every item below shares the same real subject (an owner's account and everything it now protects) and should ship together, not piecemeal:

1. **Two-factor authentication** — authenticator app / TOTP as the primary second factor, with real one-time recovery codes generated at setup. Owner can enable, disable, and regenerate recovery codes from an Account Security settings surface (new). The second factor is required after a successful password sign-in whenever 2FA is enabled — never a bypassable prompt. Must work cleanly on both desktop and mobile.
2. **Active sessions** — see what's currently signed in, sign out of other devices individually or all at once.
3. **Login history and security activity** — a real, readable log of sign-ins and security-relevant events on the account.
4. **Trusted devices** — remember a device that's already completed 2FA once, so the second factor isn't demanded on every single sign-in from a device the owner already verified.
5. **Account security dashboard** — the one real home for all of the above, not scattered across Settings.
6. **Permission and access audits** — a real, reviewable answer to "who can do what on my store" (`StoreMember`/`lib/permissions.ts` already models roles; this is the first real UI surface for reviewing that model, not a redesign of it).
7. **Security notifications** — real alerts for account-security-relevant events (new sign-in, 2FA disabled, recovery codes regenerated, and similar).
8. **A real review of encryption, secrets management, and production security practices.** Not starting from zero: `INTEGRATION_ENCRYPTION_KEY` already encrypts stored integration credentials at rest (AES-256, `lib/integrations/credentials.ts`), and passwords are already bcrypt-hashed (`auth.ts`) — this item audits that real existing groundwork end to end (session handling, secret rotation, what's encrypted vs. what should be) rather than assuming a blank slate.

**Before implementation of item 1 specifically**, the explicit instruction this milestone was scoped under: audit the current authentication architecture (`auth.ts`, NextAuth v5, JWT session strategy — see *Authentication* above) and recommend the cleanest integration with the existing system, rather than layering 2FA on afterward. The session JWT today carries only `user.id`, deliberately minimal — where a "2FA verified this session" signal belongs (the JWT itself vs. a separate check) is a real design decision for that future audit, not decided here.

**Verification bar, once built**: real end-to-end testing of the complete flow (enable → scan a real authenticator code → verify → recovery codes work → disable → re-enable) before any part of this milestone is marked complete — the same live-verification discipline every other milestone in this document has already held itself to, not a lower bar because it's security-labeled.

---

## Shipping & Fulfilment — BUILT AND VERIFIED 2026-08-22

**Status: shipped.** Contract approved with six decisions (S1–S6). Three findings from the audit shaped it, and two of them shrank the work:

* **The rate path was already carrier-agnostic.** `toShippingOptions` passes through whatever carrier the broker quotes. Only three narrow things assumed USPS — a fallback filter, a default, and the owner-facing copy — and all three are gone. The filter was a real defect: a merchant whose broker carried UPS but not USPS could not buy a label at all on the no-selection path.
* **EasyPost is itself the multi-carrier layer**, so S1 abstracts over **providers** (`lib/carriage/`), not carriers. There is deliberately **no `quoteRates` method**: quoting already runs through one carrier-agnostic path that resolves store, product and origin itself, and wrapping it would have meant re-plumbing checkout for a seam nothing needed.
* **`mapTrackerToShipment` already existed**, pure and covered — and nothing called it. The gap was never the mapping; it was ingestion. An earlier report that "Delivered has no data source anywhere" was too strong and is corrected here.

**`lib/carriage/` is carriage; `lib/fulfillment/` remains supplier fulfilment** (Printful — who *makes* the product). S2 kept them apart by name: one word for two things is how somebody later wires the wrong one.

**`lib/carriage/lifecycle.ts` imports nothing at all, and that emptiness is load-bearing** — `OrdersList` is a client component, and importing the lifecycle from the ingestion module (which uses `prisma` and `node:crypto`) pulled a database client into the browser bundle and broke the Orders page. Found by the browser suite.

**Invariants held, each negative-controlled:** the webhook signature is timing-safe and verified over the *raw* body; a replay changes nothing; an out-of-order scan cannot un-deliver a parcel; delivery means the carrier said so, never elapsed time; a carrier is never assumed; the label double-purchase claim is untouched.

**Externally blocked:** live tracker delivery needs a real EasyPost account, a public URL and `EASYPOST_WEBHOOK_SECRET`. Buying a real label spends postage and stays behind an injected buyer. Carrier accounts beyond USPS need attaching before real multi-carrier quotes.

**Deferred by decision:** voiding/refunding labels (S4), international and customs (S5), a second provider (S6 — generality is stated as unproven until one exists).

---

## Shipping & Fulfillment — the original scoping (superseded by the section above)

**Status: named and scoped 2026-08-06, explicitly not built.** Sean's own framing for why this is high-priority, not just plausible: once Stripe checkout is fully live, the next real question every merchant asks is *"someone bought my product — now how do I ship it?"* Genesis should let them complete that entire workflow without leaving the platform.

**The one real architectural instruction this milestone was scoped under**: build it the same way payments were built — a **Shipping Provider Framework**, not a USPS integration. `lib/integrations/`'s existing `IntegrationConnector` contract (`connect`/`verify`/`disconnect`/`status`, provider-agnostic by design — see *Integration Framework* above) is the real, already-proven shape for this: a common shipping API surface underneath, carrier-specific connector modules on top, so adding UPS or FedEx later is a new connector module, never a redesign. Not starting from zero: `IntegrationProvider`'s own Prisma enum already reserves `USPS` as a future value (`prisma/schema.prisma`), the same "reserved ahead of any real connector" pattern this codebase already uses elsewhere (e.g. `PERMISSIONS.ANALYTICS_VIEW` before anything read it) — this milestone is what finally gives that reservation a real implementation.

Five real phases, in order:

1. **Carrier integration** — USPS and UPS first (both have real, documented APIs suited to the connector pattern above), FedEx next, DHL and international support named as later, not required for the first real version.
2. **Label purchasing** — buy a real shipping label inside Genesis, generated automatically once an order is marked paid; print labels; generate packing slips.
3. **Shipping intelligence** — J4 reasons over real package weight, dimensions, shipping class, destination, and each connected carrier's real quoted rate/speed, to recommend concretely: *"USPS Ground Advantage is $6.82"* or *"UPS is only $1.20 more but arrives two days sooner."* This is Understand/Reason work in the same sense every other real recommendation in this app already is (see *J4 Cognitive Architecture* above) — grounded in real quoted rates, never an estimate presented as a quote.
4. **Order fulfillment** — the real, concrete sequence: order received → payment confirmed → shipping label created → packing slip printed → order marked ready → tracking sent automatically → customer notified. Each step is a real, verifiable state transition, not a single opaque "fulfilled" flag.
5. **Business intelligence on shipping** — once real shipping data exists, J4 can answer real questions from it: average shipping cost, which products cost the most to ship, which carrier has the fewest delays, monthly postage spend, which destinations cost the most to fulfill. The same Understand-enrichment pattern the Business Intelligence Engine's own 4-tier roadmap already establishes (see above) — new facts feeding Reason's existing inputs, not a new reasoning pipeline.

**Explicitly not decided here**: which carrier ships first in Phase 1 (USPS vs. UPS), the real commercial/API relationship each carrier requires (some, like UPS/FedEx, may need a real business account before their API is usable — a genuine external dependency, the same category of real constraint that paused the Marketing Engine's own Resend integration), and the real schema this needs (`Product` has no weight/dimensions field today, the same kind of honest gap already named for inventory above). Real future scoping work, not implementation defaults.

---

## Standing invariant: every stored file has a declared lifecycle (2026-08-28)

**A blob path with no declared lifecycle is a leak that has not been noticed yet.**

One ordinary month of one account left 306 MB that nothing referenced — enough,
unchecked, to consume an entire 5 GB allocation in about sixteen months without
the customer keeping a single thing — and Genesis could not have cleaned any of
it up, because `del` from `@vercel/blob` was imported nowhere in the codebase. Three separate leaks were
found, and the worst of them is self-worsening: a failed product creation
strands its print files and mockups, so every failure consumes the quota the
next attempt needs.

So: **every new blob path declares whether what it writes is a permanent
customer asset, a derived artefact, or a temporary one, and when it may be
reclaimed.** Derived assets are reproducible from the design that made them,
which is what makes a retention policy on them safe; an owner's own upload is
the one thing Genesis cannot recreate.

Two rules govern any deletion. **The reference scan is schema-driven** — it asks
`information_schema` for every text and JSON column rather than reading a list
of tables, because a list falls behind the first time somebody stores a URL
somewhere new, and does it silently. And **deletion re-checks at the moment of
deletion**, never trusting a prior report: a report is a photograph, and a file
that was safe when it was drawn can be load-bearing by the time the delete
arrives.

Full requirements, the classification table, and the outstanding work:
[STORAGE.md](STORAGE.md).

## Standing invariant: the mirrored registry (2026-08-21)

**A hand-maintained registry that mirrors another registry, where the type system appears to enforce the mirror but cannot.** Found three times during the verification sprint, in three unrelated parts of the codebase, always with the same signature: the file documents the mirror, the compiler checks the *shape*, and nothing checks the *membership*.

| Mirror | What a drift would do |
|---|---|
| `lib/storefront/targets.ts` → `GENESIS_ACTIONS` | A target names a retired action. J4 highlights part of the storefront, sounds certain, and has no verb behind it — the exact failure that file's own invariant exists to prevent |
| `lib/storefront/dimensions.ts` → `lib/theme.ts` | A value is offered that theme.ts no longer renders. It is chosen, shown on an approval card that looks legitimate, approved — and then renders as undefined CSS |
| `lib/onboarding/discoveryFlow.ts`'s `ECOMMERCE_SLUGS` → `lib/businessTaxonomy.ts` | Renaming a revenue-stream slug silently sends every product business down the non-ecommerce path |
| `lib/j4/workspaceContext.ts` → `lib/dashboard/navConfig.ts` | A room the registry never learned about. J4 stands in it and knows nothing — indistinguishable from a screen with nothing worth saying, because "no context" is an ordinary outcome |
| `ACTION_SECTIONS` (`lib/execution/genesisActions.ts`) → `lib/dashboard/navConfig.ts` | J4 names a place the owner cannot see; or, worse, an action with no entry at all gets no nav badge, no focusable approval and an attention card with no Review link |
| `DEPARTURE_PRIORITY` (`lib/onboarding/initialDesignRestraint.ts`) → `Presentation` + `Composition` | A dial missing from the list compares `undefined` to `undefined`, is never a departure, and is therefore never charged against the first-storefront budget — which still reports four while five dials sit off baseline |
| `GROWTH_POINT_PURCHASE_CATALOG` (`lib/growthPoints/purchaseCatalog.ts`) → `PACKAGES` (`scripts/provision-pricing.ts`) | The price an owner is shown is not the price Stripe charges. This one is money |
| `FIELD_LABELS` + `HIDDEN_DIFF_KEYS` → every action's `inputSchema` | An approval card renders the machine's own camelCase field name at the owner, because the lookup is `FIELD_LABELS[key] ?? key` |
| `TENANT_SCOPED_MODELS` (`lib/tenantIsolation.ts`) → every model in `schema.prisma` with a `storeId` | **Found 2026-08-31.** The map had fallen SEVEN models behind the schema — `job`, `outboundOperation`, `securitySignal`, `storageEvent`, `storageObject`, `temporaryAsset`, `webhookDelivery`. A model missing from it is silently exempt from the isolation guard: an unscoped `updateMany` or `findMany` on it is simply allowed, and no test, type or review step says so. Nothing was leaking — all but one call site already passed a `storeId` — but the protection everybody would have said covered those tables did not, and the next model added would have been exempt too. Cross-checked now by `scripts/verify-fetch-then-authorize-db.ts` |
| `COGNITIVE_OUTPUT_KIND_LABEL` → the kinds actually written | ActivityFeed's fallback renders the raw kind string at a merchant. Already happened once: "insight" was real and unlabelled |
| `PROPOSABLE_ACTION_TYPES` → `ProposedActionSchema` (both in `lib/intelligence/cognitiveLayer.ts`) | Two spellings of the same seven actions. An action the schema can emit but the list omits is one Genesis proposes with no price in `growthPointCosts` — and the prompt's own rule is "an actionType absent from growthPointCosts has no real price yet, never invent one" |
| `RECORD_PROVENANCE` (`lib/businessModel/provenance.ts`) → the `RecordProvenance` Prisma enum | A kind of source the database can store and the runtime cannot name, or the reverse. Either way a fact's origin renders as nothing, or a label lookup returns undefined next to somebody's logo — and provenance exists precisely so J4 does not overstate where a claim came from |
| `BELIEF_CATEGORY_LABEL` (`lib/intelligence/beliefReview.ts`) → the categories `lib/intelligence/learn.ts` writes | A new detector's category reaches the Understanding room with no label. Same failure as `COGNITIVE_OUTPUT_KIND_LABEL`'s, which already happened once: the raw key printed at a merchant |
| `RELATIONSHIP_KINDS` → `PROJECTIONS` (both in `lib/businessModel/relationships.ts`) | A projected edge whose kind has no entry renders as "relates to" — the exact ambiguity typed relationships were introduced to remove |
| `TOOL_POLICY` (`lib/execution/toolPolicy.ts`) → `buildStoreChatUnifiedTools()` | A tool the model can emit with no policy. The lookup is closed, so it refuses — but a mutating tool missing from the table is one nobody decided the permission for, and a lookup that fell back to a default would either refuse a legitimate read or wave a change through |
| `TOOL_HANDLERS` (`lib/execution/toolHandlers.ts`) → `buildStoreChatUnifiedTools()` | A tool the model can emit with no handler falls through to whatever comes next. `edit_store_content` is the single declared exception, because the legacy content pipeline is its implementation |
| `SOCIAL_PLATFORMS` (`lib/social/platforms.ts`) → the `IntegrationProvider` enum **and** `SocialContentSchema`'s `kind` values | A platform offered in the Studio carousel whose posts cannot be stored, because no content shape holds its `kind`; or one naming a connector that does not exist, so the workspace implies publishing is a credential away when it is actually a migration away. X is the live example — it has no provider at all, and that null is load-bearing |
| `NAV_DESTINATIONS` → `TakeMeThereInputSchema`'s own enum | A destination the schema accepts and the map lacks resolves to null, and the owner is told "I'm not sure where you want to go" about a place J4 was explicitly asked for |

**Why the compiler cannot help.** In each case the values are typed against a union or an enum, which catches a typo. What it cannot catch is a name that is still a valid member of the *type* while no longer being a live key in the *runtime* registry — and `dimensions.ts` says why it is a literal at all: "TypeScript types are erased at runtime and this needs to validate real model output." The erasure that forces the duplication is the same erasure that makes it uncheckable.

**The rule going forward.** A registry that mirrors another must carry a runtime cross-check asserting every referenced name resolves in the registry it mirrors. All seventeen above are now guarded — `scripts/verify-storefront-scope.ts`, `scripts/verify-dimensions.ts`, `scripts/verify-taxonomy.ts`, `scripts/verify-workspace-context.ts`, `scripts/verify-action-sections.ts`, `scripts/verify-cognitive-proposals.ts`, `scripts/verify-initial-restraint.ts`, `scripts/verify-owner-facing-labels.ts`, `scripts/verify-field-labels.ts`, `scripts/verify-purchase-catalog.ts`, `scripts/verify-provenance.ts`, `scripts/verify-belief-review.ts`, `scripts/verify-tool-policy.ts`, `scripts/verify-tool-handlers.ts`, `scripts/verify-social-creation.ts` — and all seventeen are currently clean.

**Two more were added on 2026-08-22 by the Unified Intelligence milestone, and the second had ALREADY DRIFTED** — `SERVER_ACTION_TOOLS`, which listed the eleven of nineteen tools `app/dashboard/ai-actions.ts` had a branch for. It was the fourth instance found to have actually drifted rather than merely being able to, and the most expensive: it did not fail, it ran a different capability and presented that result. A message answered with `generate_brand_logo` matched nothing there, fell through to the legacy content pipeline, and ran a full store-content regeneration. Found by checking, before refactoring the dispatch, whether it had the failure a registry would prevent — the guard was cheap and the refactor was not.

**And on 2026-08-23 that mirror was DELETED, which is the outcome worth aiming for.** A mirror exists because the same knowledge is written down twice; the guard makes the duplication safe, it does not make it go away. Both chat paths now dispatch through one handler registry via `lib/dashboard/runToolTurn.ts`, so there is no longer a set of tools one path can do and the other cannot — nothing left to mirror, and `SERVER_ACTION_TOOLS` went with it. The remaining row is stronger than the one it replaces: `TOOL_HANDLERS` is checked against the tool catalogue itself rather than against a second dispatch ladder, so a new tool with no handler fails in `scripts/verify-tool-policy.ts` and `scripts/verify-tool-handlers.ts` regardless of which path would have served it. **Guard a mirror the day you write it; delete it the day the duplication stops being necessary.**

**Three more were added later on 2026-08-22** — the two provenance registries and the relationship-kind mirror — each guarded on the day it was written, by `scripts/verify-provenance.ts`, `scripts/verify-belief-review.ts` and `scripts/verify-provenance.ts` respectively. The belief-category check reads `learn.ts`'s own source rather than a second list, so a fifth detector added tomorrow fails there rather than shipping a raw key to a merchant.

**The last two of the original ten were added on 2026-08-22, and they are the first instances found to have ACTUALLY DRIFTED** rather than merely being able to. Both had the same cause: the product moved to the rooms and a registry did not follow. `workspaceContext` never learned Studio or the catalog and resolved nothing at all on `/b/<slug>/…`, where every owner has been since 2026-08-20. `ACTION_SECTIONS` still said "Website" three days after the bar stopped saying it, and was missing `refine_storefront` and `answer_supplier_economics` outright. Neither was a type error, and neither failed loudly — which is the whole point of the invariant. **Do not refactor them to derive from their source**; the literals exist for the runtime-validation reason above, and the cross-check is the cheaper and more honest fix.

**The invariant this protects, stated plainly:** Genesis must never present an action as executable unless a real registered executable stands behind it, and must never claim a change outside what the proposal actually authorises. A dangling registry reference is how either becomes possible without anybody writing a line of wrong logic.

### The sibling rule: `npx next build` is a gate, and typecheck is not it

**Found 2026-08-23, two commits after it broke.** Four declarations were exported
from `app/dashboard/ai-actions.ts` so a verification harness could import them.
That file begins with `"use server"`, and such a module may export ONLY async
functions — a schema or a string is a build error:

```
A "use server" file can only export async functions, found object.
```

For two commits `tsc --noEmit` was clean, all 41 shared suites passed, the
standalone suites passed, and the application could not be built. Three gates
agreed and all three were looking somewhere else. It surfaced only because a
build was explicitly asked for.

**The rule.** A change is not done until `npx next build` has run.

**Not `npm run build`.** That script is `node scripts/migrate-deploy.mjs && next
build`, and the first half runs `prisma migrate deploy` against whatever `.env`
points at — production. `npx next build` skips it.

The corollary is the one worth remembering: **a test's need to import something
is not a reason to export it.** If a test needs a prompt or a schema out of a
`"use server"` module, the declaration moves to a plain module under `lib/`
first — `lib/dashboard/storeChatUnified.ts` is the precedent. See
`PROMPT_MODULE_EXTRACTION.md`.

### The sibling rule: comments document the reason, source is the evidence

**Found five times in one session, each time the same way.** A source-level
assertion — "the pane creates no approval", "nothing reconstructs a historical
understanding", "no opener survives anywhere", "the model has no closing field",
"nothing closes or archives" — matched the COMMENT explaining that the code does
none of those things. Every time the code was right and the assertion was
reading the wrong thing; twice it went the other way and a green assertion was
satisfied by prose while the code was free to drift.

Fixing it case by case did not work, because the trap is structural: a
well-commented file explains its own invariants in the same words an assertion
about those invariants uses. The better the comment, the more likely it satisfies
the check.

**The rule.** A source-level assertion runs against CODE, with comments stripped
first. `codeOnly()` in `scripts/verify-context-pane.ts` is the reference
implementation — block comments (including JSX `{/* … */}`) and line comments
removed, sparing the `//` in a URL. The comments stay; they are the record of why
anything is shaped as it is. They simply stop being evidence.

It lives in one suite today. **Move it to `scripts/lib/` the moment a second
suite needs it** — a copy-pasted `codeOnly` is the same class of duplication this
codebase deletes everywhere else.

**And prefer a behavioural assertion where one exists.** Source assertions are
for properties a runtime test cannot reach: an added filter, a missing guard, a
call site that stopped calling. Where the property can be observed by running the
code, run the code.

### The sibling rule: a pure reader module does not import a database client

**Drawn at the import, not at the usage.** A negative control that added a bare
`import { prisma }` to `lib/j4/contextTypes.ts` slipped past an assertion
checking for `prisma.` usage — harmless in itself, and exactly one line from not
being. For a module whose whole contract is "pure function of an already-fetched
value", holding a client is already the violation.

### The sibling rule: a check is only as wide as what it was asked about

**Found 2026-08-23, in the authorization path, by two correct features meeting.**
Genesis checked whether the viewer could invoke the tool a turn had decided on.
Separately, a turn stopped discarding every tool the model asked for after the
first. Neither change is wrong. Together, the check ran on the head of a list
and the whole list ran — an employee's allowed read carried an unauthorized
product deletion behind it.

Nothing about this is visible in either diff. The permission function was
correct, its caller passed it a real tool name, and the type system was
satisfied throughout. What changed underneath was the ARITY of the thing being
authorized: `the tool` became `the tools`, and one call site kept the singular.

**The rule.** When a check takes a single subject and the thing it protects can
have several, the check must take the collection. Not "check the first and
assume the rest match" — they do not, and the mixed case (a permitted read
alongside a forbidden mutation) is the ordinary one rather than the exotic one.
And when a caller can forget to run the check at all, repeat it at the point the
work actually happens: `lib/dashboard/runToolTurn.ts` refuses an unauthorized
turn even though both of its callers already did, because the failure that made
that module necessary was precisely a second caller that had forgotten a step.

**How to test it.** A source assertion that the check is CALLED is not enough —
the first version here asserted `firstRefusedTool(role,` appeared, and a
negative control that narrowed the argument back to `[chosenTool.name]` passed
it with the hole fully reintroduced. Assert what the check is ASKED ABOUT, and
where possible assert it behaviourally: `scripts/verify-tool-handlers.ts` runs a
real turn as an EMPLOYEE and asserts no message was written and no deletion
proposed. That is the assertion that caught the narrowed check.

### The sibling rule: a registry lookup is only as closed as its key

Found six times in one day, in six unrelated parts of the codebase, always the same two lines:

```ts
const x = SOME_REGISTRY[key];   // key comes from outside
if (!x) return null;            // or `x ?? fallback`, or `x === undefined`
```

A plain object inherits from `Object.prototype`, so `SOME_REGISTRY["constructor"]` is a **function**, not `undefined`. Functions are truthy, are not `undefined`, and are not `null` — so they walk through every guard of that shape and come back typed as whatever the signature promised. **None of these was a type error.** Every signature said `string | null` or `number | null`, and every one could return a function.

| Where | What it actually did |
|---|---|
| `RECOMMENDATION_MESSAGES` | A function was interpolated into a live Claude prompt, really billed |
| `GROWTH_POINT_PURCHASE_CATALOG` | `price: undefined` reached a live `checkout.sessions.create` |
| `OAUTH_ERROR_MESSAGES` | A function was written into a merchant's ExecutionLog as their error message; key came from a URL |
| `ENTITY_REGISTRY` | `undefined.safeParse` — a TypeError killed the whole chat turn instead of dropping one bad capture |
| `EXTENSION_CONTENT_TYPE` | A file named `notes.constructor` resolved to a function instead of being refused; key came from a filename |
| `ANTHROPIC_RATES_PER_MILLION_TOKENS` and the other two rate tables | Cost came back **NaN** instead of `null` — and unlike `null`, NaN spreads through every `SUM` after it |

**The rule.** If a caller can hand you a string you did not define — a filename, a URL param, a model's output, a free-text DB column — use `Object.prototype.hasOwnProperty.call`, and check the **shape** of what came back rather than its truthiness. `typeof x !== "string"` is the check; `if (!x)` is the bug.

**Not a lint rule, deliberately.** The bare form is correct wherever the key is a closed union, and a rule broad enough to catch the dangerous cases flags dozens of safe ones. `scripts/verify-registry-lookups.ts` is the standing guard instead: it exercises every free-string lookup with the full prototype key set and asserts each gives its own honest refusal — plus that none returns a function and no cost returns NaN, because "is it null" would pass against both.

### The companion rule: a model is only as truthful as the facts it is handed

The same sprint established a second standing rule, and it applies wherever a model writes something an owner reads as fact. **The model is never the safeguard — the data structure handed to it is.** Three shapes recur, and each has a verified example:

**An absence must stay an absence.** A missing supplier price is not zero, an unknown product cost is an exclusion rather than a zero, a store with no accounting connected has *no invoice data* rather than zero outstanding invoices, an unpriced model costs *unknown* rather than nothing, and `quantityAvailable: null` is not "out of stock" — that last one would announce every catalogue in production as depleted. Zero propagates as a claim; null propagates as an absence.

**Two silences are not the same silence.** "There was no last visit" and "nothing happened since your last visit" are different facts, and `OwnerBriefingChangeSet.hasPriorAnchor` exists solely to keep them apart. Collapse them and the model is handed the exact sentence its own prompt forbids — a confident "nothing changed since we last spoke", said to somebody Genesis has never spoken to.

**A model may state what was said; only code decides what is derived.** A capture schema covers what can be inferred from real text, while `status`, `identifiedAt` and reference arrays are assigned in code *after* the capture is spread. Reverse that ordering and a model can mark a goal achieved the moment it invents one, or backdate it by years. Same rule at the taxonomy layer: a category slug nobody defined is dropped, never stored.

**A partial truth must never be phrased as a whole one.** `replyFor` always states both what was learned and what is still unknown, because a reply reporting the fact it just recorded, without the other half, "is the part of the truth that sounds like all of it".

Every one of these is asserted by a suite that fails when the property is broken, and each was proved by breaking it deliberately at least once.


## Standing invariant: a room is made of something, and the Office is not (2026-08-22)

**The room architecture is LOCKED.** Five decisions, signed off by Sean on 2026-08-22, recorded in `J4_FOUR_ROOMS_DESIGN.md` and settled in `GENESIS_SURFACES.md`. Not to be reopened "unless implementation reveals a direct contradiction with an existing verified invariant."

The bar is **Storefront · Studio · (J4 · Office) · Commerce · Account**, and **Commerce holds both the ledger and the catalogue**. The older four-metaphor framing (Storefront/Orders/Studio/Products) predates the 2026-08-17 merge and must not be restored.

**A room's character comes from what it is made of, not from what colour it is.** Three variables — the lead, the density, the ground — resolved in `lib/dashboard/rooms.ts` and applied **in exactly one place**, `DashboardShell`. The prohibition is half the decision: **no per-page styling**, because a screen that paints its own ground is how three rooms quietly become three products.

**Two exemptions, both deliberate, both asserted:**

- **Arrival and Account take the default ground.** Arrival is "a third kind of surface, neither a room nor a tab"; Account is configured rather than visited. Giving either a character would be inventing work.
- **The Office gets no character at all, permanently.** It is the only surface that renders *on top of* a room, so anything about it that varied with what is underneath would read as belonging to the room — which is precisely how it becomes a fifth room. `GENESIS_ATMOSPHERE` is its single source. `scripts/verify-rooms-browser.ts` opens it over all three rooms and asserts the computed background is identical.

**And the constraint that outranks all of it: blue marks J4 and nothing else.** No room's identity may depend on hue — "a room that glows blue steals the one signal the owner has learned to read." `scripts/verify-rooms.ts` fails on any room ground that is not neutral, and on any two rooms that share one.


## Fetch-then-authorize: safe only when something authorizes afterwards (2026-08-31)

This codebase deliberately and widely fetches a record by bare id and *then* authorizes against whatever business it turns out to belong to — `editProduct`, `toggleProductActive`, `deleteProduct`, `attachTrackingNumber`, `toggleOrderFulfilled`, `approvalAccessibleTo`. That is correct, and a sweep must not "fix" it. The lookup exists to learn which business owns the record so that `execute()` can re-verify the caller against **that** business, which is the business that owns the resource being acted upon. `lib/tenantIsolation.ts` leaves `findUnique`/`findFirst` unguarded for exactly this reason.

What makes it correct is the second half. Every one of the 34 executables declares a real `requiredPermission`, so none can take `executeInner`'s unauthorized `else` branch; and where an action does not go through `execute()`, it performs the check itself (`task.storeId !== store.id`, `draft.userId !== session.user.id`, `accessTo(userId, approval.storeId)`).

**The rule**: an unscoped lookup by caller-supplied id is safe if and only if an authorization follows it that names the fetched record's own business. Where nothing follows, the shape is a bare read of anybody's row. The full-repository sweep on 2026-08-31 found exactly one such place — `app/store/[slug]/success/page.tsx`, a public page that read `order_id` from the query string, ignored the `[slug]` it was rendered under, and printed the product name and amount of any order on the platform.

## Permissions & Roles

Three conceptual roles: **Owner**, **Employee**, **Customer** — but only two are ever stored:

- **Owner** is derived, not stored: whoever a `Store.userId` points to. This is unchanged from before roles existed at all, so no migration was needed for it.
- **Employee** is a real row in `StoreMember` (`storeId`, `userId`, `role`), added specifically so ownership data never needed to move.
- **Customer** is not a role that gets assigned to anyone — it's what you get by default (no `Store.userId` match, no `StoreMember` row). The system enforces this as a real guarantee (zero dashboard access), not just an absence of a feature.

**`lib/permissions.ts`** is the single authorization surface everything else goes through:
- `PERMISSIONS` — a canonical registry of capability strings (`STORE_MANAGE`, `PRODUCTS_MANAGE`, `ORDERS_VIEW`, `REVENUE_VIEW`, `ANALYTICS_VIEW`, `PAYMENTS_MANAGE`, `EMPLOYEES_MANAGE`, `GENESIS_CHAT`, `AUTHORITY_MANAGE`). Call sites always reference `PERMISSIONS.X`, never a raw string. `ANALYTICS_VIEW` and `PAYMENTS_MANAGE` were reserved ahead of any code using them; `PAYMENTS_MANAGE` is now wired up by the Integration Framework. `AUTHORITY_MANAGE` (Phase 6) governs granting/revoking `DelegatedAuthority` — OWNER-only, deliberately separate from `STORE_MANAGE` since "can edit store content" and "can change what Genesis may do unsupervised" are different-stakes decisions — see *Delegated Authority* below.
- `ROLE_PERMISSIONS` — maps each role to its permission set. Owner gets everything; Employee gets `PRODUCTS_MANAGE`, `ORDERS_VIEW`, `GENESIS_CHAT`. This is role-based today, but every check goes through `hasPermission(role, permission)` rather than comparing roles directly, so per-user permission overrides (a `StoreMember.customPermissions` column) could be added later without touching call sites.
- `getStoreRole(userId, storeId)` / `resolveUserStore(userId)` — pure, non-throwing resolution. `resolveUserStore` finds "the" store for a user (owner-first, then employee membership) and is what page-level display logic uses, since "no store yet" is a normal state (a new signup), not an error.
- `requireStorePermission(permission, storeId?)` — the throwing/redirecting chokepoint every mutation calls. Every server action in `app/dashboard/actions.ts` and `app/dashboard/ai-actions.ts`, plus the callback route in `app/api/integrations/[provider]/callback/route.ts`, goes through this instead of a hand-rolled ownership check.

**Genesis (the AI) is not a bypass around this system.** For a live store, `applyGenesisMessageToStore` gates chat *entry* on `GENESIS_CHAT` and gates the *apply* step on `STORE_MANAGE` — checked before calling Claude at all, both to avoid an unnecessary generation and to guarantee Genesis never claims a change happened when the caller didn't have permission to make it.

`StoreDraft` (the pre-launch flow) is explicitly outside this system — a draft belongs to exactly one user and isn't a `Store` yet, so there's nothing to have employees on.

**Structural tenant isolation (Track 0)** — `lib/tenantIsolation.ts` is a Prisma Client Extension (`$extends`, wired in once at `lib/prisma.ts`, reaching every call site that imports `prisma` from there) that requires a store-scoping filter in the `where` clause of `update`/`delete`/`updateMany`/`deleteMany` and `findMany`/`count`/`aggregate` on the ~19 tenant-scoped models. It accepts either a flat scope key (`storeId`, or a model-specific dual key like `storeGeneration`'s `storeId`/`storeDraftId` for draft-vs-live, or `productEvent`'s `storeId`/`userId` for pre/post-store-creation) or a nested `store: { ... }` relation filter — both are legitimate patterns already used across the codebase (see `app/store/[slug]/products/[productId]/page.tsx` for a real example of each). Missing scoping throws immediately rather than executing.

This is **defense-in-depth, not the primary authorization mechanism.** The real gate is `requireStorePermission` above, which independently re-verifies the actual authenticated session user against a target storeId. That's already correct on its own — confirmed by tracing it, not assumed.

Deliberately **not** guarded, by design:
- **`findFirst`/`findUnique` (single-record lookups) are never guarded.** A real, intentional, widespread pattern exists across the codebase — e.g. `app/dashboard/actions.ts`'s `editProduct`/`toggleProductActive`/`deleteProduct` — of fetching a record by bare `id` with no storeId filter, then calling `execute()` → `requireStorePermission(permission, record.storeId)`, which independently re-verifies the real session user against whatever store that record actually belongs to. This is safe today and must stay that way: **do not "fix" a single-record lookup by adding a storeId filter to it** — a future contributor might see an unscoped `findUnique` and assume it's a gap, but adding scoping there wouldn't close anything the authorization call after it doesn't already close, and misreads the pattern as a bug. If you're auditing a call site and it's a `findFirst`/`findUnique` followed by a `requireStorePermission(...)` check, that's the correct shape — leave it.
- `create`/`createMany`/`upsert`/`groupBy` are out of scope for this pass (no `where` clause to scope, or not a realistic tenant-leak vector).

**`prismaSystem`** (also exported from `lib/prisma.ts`) is the raw, unwrapped Prisma client, for the small number of genuine cross-tenant SYSTEM queries that legitimately span every store at once — e.g. the sync scheduler's `getDueSyncs()` and the `/api/cron/status` endpoint, both reachable only via a `CRON_SECRET`-gated route, never from a request carrying a specific user's session. `$extends()` shares the base client's connection pool, so exporting both costs nothing extra. Use `prismaSystem` only at a call site gated the same way, with a comment saying so — everywhere else, use `prisma`.

---

## Integration Framework

**`lib/integrations/`** — a generic contract every external service connection implements, so adding a new one means writing a connector module, not new framework code.

- **`types.ts`** — the `IntegrationConnector` interface: `connect(storeId, userId, params?)`, `verify(storeId)`, `disconnect(storeId)`, `status(storeId)`. Deliberately generalized past OAuth: `connect()` returns a `ConnectResult` — `{kind: "redirect"}` for an OAuth-style provider, `{kind: "form"}` for an API-key-style one, `{kind: "connected"}` when done in one step. The framework never assumes *how* a connector authenticates; the connector decides.
- **`registry.ts`** — `provider -> connector` lookup, so route handlers and actions never hardcode which provider they're talking to. `STRIPE`/`PAYPAL` both registered.
- **`stripe.ts`** — real Stripe Connect OAuth (Standard accounts) rather than merchants pasting API keys, since Genesis is a multi-merchant platform. The `{kind: "redirect"}` reference implementation.
- **`paypal.ts`** (PH-06) — the second connector, and the first to actually exercise `{kind: "form"}`: each merchant creates their own PayPal Developer app and enters its Client ID/Secret directly, rather than an OAuth handoff. Chosen deliberately over PayPal's Partner/Connect OAuth (which would mirror Stripe Connect's one-click experience but requires PayPal to enable the platform as a "Partner" first — an external, non-instant approval, unlike Stripe Connect's self-serve dashboard toggle) — proving the framework's non-OAuth branch works with a real provider was judged more valuable than a second OAuth-flavored connector. Every PayPal REST call needs a bearer token regardless of credential source (`POST /v1/oauth2/token`, HTTP Basic auth); `verify()` uses a fresh token exchange as its proof of validity, since PayPal has no cheap "whoami" endpoint the way Stripe's `accounts.retrieve()` works. No revoke call exists for client-credentials — a merchant fully cuts access by regenerating their Secret in the PayPal dashboard.
- **`util.ts`** — `getBaseUrl()`/`integrationCallbackUrl()`, extracted out of `stripe.ts` during PH-06 so PayPal (or any future redirect-based connector) doesn't duplicate the same base-URL/callback-URL logic.

**Credential versioning**: every connector's stored `credentials` Json includes a `schemaVersion` field (starting at `1`), added per explicit user feedback during PH-06's design — cheap now, and avoids an intractable "which of three different credential shapes is this row" problem the day a provider's required fields change (e.g. PayPal someday requiring a Merchant ID + webhook ID + certificate alongside Client ID/Secret). Pre-existing Stripe credential rows from before this convention simply lack the field and are treated as implicit version 1 by absence — no backfill needed.

**`StoreIntegration`** (Prisma model) is one generic table for every provider — `provider`/`status` enums (`IntegrationProvider`: STRIPE/PAYPAL/GOOGLE/SLACK/USPS; `IntegrationStatus`: CONNECTED/NEEDS_ATTENTION/FAILED/DISCONNECTED), an opaque `credentials` Json column (provider-shaped, never a raw column per provider), and audit fields (`connectedByUserId`, `connectedAt`).

**Payment provider selection lives in one place, not inline in checkout** — `lib/payments/router.ts`'s `selectProvider(storeId)` is the sole place the "which connected provider does this store's checkout use" policy is expressed (today: prefer Stripe, then PayPal, then the platform-wide Stripe fallback). Added during PH-06 per explicit user feedback specifically so a third/fourth/fifth provider (Square, Authorize.net, Apple Pay, Google Pay, ...) means adding one case to this module, not re-touching `createCheckoutSession` every time. A visual provider-chooser UI at checkout is deliberately not built yet — the roadmap's original PH-06 criterion anticipated one, but with only two providers live it's a low-risk follow-up, not something to cram into this phase.

**`Order`** identifies a purchase by `(paymentProvider, externalOrderId)` — a composite unique key, not a bare unique column — added in PH-06 replacing the earlier Stripe-only `stripeSessionId` column (renamed, not dropped-and-recreated, to preserve existing order history). Composite over bare-unique specifically so two providers' external ids can never collide.

**Checkout resolves per-store**, not globally: `createCheckoutSession` (`app/store/[slug]/actions.ts`) calls `selectProvider()` then branches to a Stripe-specific or PayPal-specific checkout-session builder. Stripe: builds a `Stripe` client from the store's own OAuth access token if connected (a Standard Connect account's access token functions as that account's own secret key), else the platform-wide `STRIPE_SECRET_KEY` — so stores that predate this system keep working unmodified. PayPal: creates a PayPal Order (`POST /v2/checkout/orders`, `intent: "CAPTURE"`) using the store's own credentials, packing `storeId:productId` into PayPal's single-string `custom_id` field (unlike Stripe's multi-key `metadata` — a real mechanical difference between providers the framework doesn't try to paper over).

**Stripe webhook trust boundary**: `app/api/webhooks/stripe/route.ts` does **not** trust `session.metadata.storeId` for events that carry `event.account` (i.e. originated from a connected account's own activity) — a connected merchant's access token is a real API key, so metadata they can influence isn't a safe source of truth for which store an event belongs to. For those events, `event.account` (set by Stripe, not the merchant) is resolved to a store via `StoreIntegration.externalAccountId` instead. Metadata is only trusted for platform-key events, which the app controls end-to-end.

**Local Stripe webhook testing** requires the Stripe CLI (`stripe listen --forward-to localhost:3000/api/webhooks/stripe`) — Stripe can't reach `localhost` directly, so without it, checkout still completes but no `Order` gets created and the dashboard's "Payments" verification has nothing to react to. Real Connect-sourced events show up in the CLI output tagged `connect`, a useful signal that `event.account` is actually present when debugging.

**PayPal has no webhook at all — a deliberate PH-06 scope decision, not an oversight.** Capture happens synchronously in `app/api/checkout/paypal/return/route.ts` when the buyer is redirected back after approving on PayPal's site (`POST /v2/checkout/orders/{id}/capture`), and that capture response is the `Order` row's only source — arguably *more* robust than Stripe's flow (where the `Order` row is only ever written by webhook delivery) rather than a lesser version of it. A real PayPal webhook would require each merchant's own PayPal app to have a webhook subscription (yielding a per-merchant `webhook_id`) — a fourth credential field, genuine scope growth deferred to whenever refund/dispute tracking is actually needed. A double-hit on the return route (back button, reload) is handled by treating PayPal's `422 ORDER_ALREADY_CAPTURED` as success and re-fetching the order, mirroring the Stripe webhook's own no-op-on-redelivery `upsert`.

**A real PayPal response-shape inconsistency, found only by testing an actual live sandbox purchase, not by code review:** a fresh capture response includes `custom_id` both at the top level of `purchase_units[0]` and nested inside `purchase_units[0].payments.captures[0]`. Re-fetching an already-captured order via `GET /v2/checkout/orders/{id}` (the redelivery path above) only includes the nested copy — the top-level one is absent. `app/api/checkout/paypal/return/route.ts` checks the nested `captures[0].custom_id` first, falling back to the top-level one, to handle both response shapes.

Connect/Recheck/Reconnect/Disconnect (`app/dashboard/actions.ts`) route through the Execution & Verification Engine (see below) via a thin adapter — `IntegrationConnector` itself is untouched by that system; the adapter translates its `connect()`/`verify()` calls into the engine's standardized result shape. PayPal's form-based `connect()` needed a second dashboard entry point Stripe never did (`submitPaypalCredentials`, since there's no OAuth callback route to play that role) — the credentials form itself is rendered from `ExecutionLog.metadata.fields`, the same log row the engine already persists, not a new mechanism.

---

## Execution & Verification Engine

**`lib/execution/`** — a universal lifecycle (Request → Execute → Verify → Record Result → Display Status → Offer Recovery) any action Genesis or a merchant performs can flow through, so the dashboard, a future activity feed, and notifications can all speak one result language instead of every feature inventing its own success/failure shape. Originally scoped narrowly as an integration-only "Verification Engine"; reframed universal mid-design at the user's explicit direction.

- **`types.ts`** — `ExecutionResult<TMetadata>`: `executionId` (UUID, groups rows from one logical request), `action` (stable string id), `status` (`SUCCESS`/`WARNING`/`FAILED`/`PENDING`/`PARTIAL` — the last added in PH-07 Layer 4 for actions that do real work but only partly succeed; framework-level, not yet produced by any concrete `Executable`), `verified` (boolean, kept deliberately separate from `status` — a write succeeding isn't the same claim as independently confirming it stuck, the same "confirm what actually happened" principle Genesis's own conversational tone follows), `message`, `retryable`, `actorType` (`USER`/`GENESIS`/`SYSTEM`), `actorId`, `storeId`/`storeDraftId` (mutually exclusive — see below), `schemaVersion` (versions `metadata`'s shape so future code can interpret older rows correctly), `redirectUrl` (present only for a `PENDING` OAuth-style handoff).
- **`executable.ts`** — the `Executable<TInput, TMetadata>` contract an individual action implements (`action`, `requiredPermission`, `run()`, optional `verify()`) — analogous to PH-02's `IntegrationConnector`, but for "any action" rather than "any integration." `run()`'s outcome signals "not done yet" via either `redirectUrl` (an OAuth-style handoff) or `pending: boolean` (added in PH-06 — a form-based connect's first call is equally non-terminal, since nothing was actually connected yet, just discovered what input is needed next; forcing that case to `SUCCESS` would have been dishonest), or "partly done" via `partial: boolean` (added in PH-07 Layer 4, alongside the same reasoning).
- **`engine.ts`** — `execute(executable, input, opts)`: resolves permission via `requireStorePermission` (PH-01's existing chokepoint, called not replaced), runs the executable, catches any thrown error into a `FAILED` result (this is the actual point of the lifecycle's "Display Status" step — nothing should crash to a raw error boundary), persists one `ExecutionLog` row, returns the result. Next.js's own `redirect()`/`notFound()` errors are explicitly re-thrown via `unstable_rethrow()` rather than swallowed — a real bug found and fixed during implementation, since `requireStorePermission`'s internal `redirect("/login")` would otherwise have been silently caught and turned into a `FAILED` result instead of actually redirecting. **Phase 6** added `opts.preAuthorizedGrantId`, the one exception to "every execution needs a human session" — see *Delegated Authority* below for what it is and the important namespace pitfall discovered while building it.
- **`adapters/integrationExecutable.ts`** — `connectExecutable`/`verifyExecutable`, adapting `IntegrationConnector` into `Executable` rather than folding the two contracts into one; `ConnectResult`'s `redirect`/`form`/`connected` cases don't map onto a single `run()` call cleanly, and forcing them to would bloat `Executable` with integration-only concepts.
- **`genesis.ts`** — `recordGenesisExecution()`, a lightweight logging hook called directly by `applyGenesisMessage`/`applyGenesisMessageToStore` (see AI orchestration below) — deliberately **not** routed through `execute()`, since those functions' generation/diff/confirmation flow doesn't fit the single-`run()`-call `Executable` shape and isn't being refactored to.

**`ExecutionLog`** (Prisma model) is append-only — a row is never updated after insert, only ever `.create()`d (`lib/execution/log.ts` is the only writer). A logical request's status changing over time (an OAuth handoff going `PENDING` → `SUCCESS`) is a *new* row sharing the same `executionId`, not a mutated one — history shouldn't change shape after the fact. `storeId`/`storeDraftId` are both optional, mirroring `StoreGeneration`'s existing dual-phase pattern: most executions belong to a real `Store`, but Genesis's draft-side chat happens before one exists. `action` is a plain `String`, not an enum, for the same reason `StoreMessage.role` is — the action catalog grows with every feature; `IntegrationProvider` is a closed enum specifically because providers are added rarely and deliberately, the opposite case.

**Retrofit scope, deliberately narrow this phase** (same "prove it on something real first" precedent as PH-02's Stripe-first connector): `toggleStorePublished` and Stripe `connect`/`verify` route through `execute()` — chosen because `recheckStripe()` had a real, live bug (its `{ok, error}` result was discarded entirely; now it's persisted and actually displayed). Genesis's own AI-driven actions are explicitly **not** refactored onto `execute()` — only logged via the lightweight hook above, so the tuned two-call generation flow, `touches*` diff-tracking, and confirmation logic in `ai-actions.ts` stay untouched. Full engine adoption for Genesis is an open future decision, not assumed; `execute()` accepts `actorType` as an explicit parameter specifically so that path stays open without an engine redesign. As of PH-05, `createProduct`/`editProduct`/`deleteProduct`/`toggleProductActive`/`editStore` are retrofitted too (`lib/execution/executables/{products,storeEdit}.ts`), so the Owner Dashboard's Activity Feed reflects real day-to-day store management, not just publish/Stripe/Genesis events. Deliberately still not retrofitted: `createCheckoutSession`, `subscribeToNewsletter`, and the Stripe webhook — `Order` rows are surfaced on the dashboard by querying `Order` directly (see *Owner Dashboard* below), not by adding checkout events to `ExecutionLog`.

**Fixed in PH-06** (found during PH-05 design, deliberately left until this phase to keep PH-05's touch-surface disciplined): `engine.ts` previously wrote the final `actorType` on every `ExecutionResult` from the outer `opts.actorType ?? "USER"` constant rather than `ctx.actorType` (correctly `"SYSTEM"` for `requiredPermission: null` executables, but never read). Every PH-01–PH-05 caller had `requiredPermission` set, so this had zero live impact — but PH-06's PayPal connector was expected to be the first `requiredPermission: null` caller. It turned out not to need one (no PayPal webhook exists — see *Integration Framework* above), but the fix landed anyway since it was already agreed and cheap. The final `actorType` now comes from `ctx.actorType`, always correctly set by the time a result is built.

**Display**: `ExecutionStatusCard` (`app/dashboard/ExecutionStatusCard.tsx`) — colored dot (green/yellow/red/neutral for SUCCESS/WARNING/FAILED/PENDING) + message + verified/timestamp, fed by the latest relevant `ExecutionLog` row. Used today for the dashboard's Payments section, replacing both the old direct `StoreIntegration.status`/`lastError` derivation and the ephemeral query-string success/error banners. Falls back to deriving a synthetic log-shaped object from `StoreIntegration`'s own fields when no `ExecutionLog` row exists yet (any connection made before this phase existed) — `StoreIntegration` remains the source of truth for current connection state either way; `ExecutionLog` is what just happened and whether it was confirmed.

**Recovery**: no queue/job infrastructure — `retryable: true` on the latest log row just means the UI shows a "try again" affordance wired to the same server action, matching what a merchant already does today by clicking a button again.

A row-capped (not yet paginated) Activity Feed now exists — see *Owner Dashboard* below. **Still not built**: a per-`executionId` Timeline view (Requested → Executing → Verified → Completed) — explicitly deferred, a pure transform over existing data whenever wanted.

---

## Delegated Authority (Phase 6)

Lets Genesis handle a specific class of action without asking first — under bounded, owner-granted, immediately-revocable authority — without introducing a second automation system alongside the existing `GENESIS_ACTIONS` registry/`ApprovalRequest`/`execute()` lineage. **Architectural invariant, preserved deliberately**: Genesis's *judgment* (does Claude think this is a good idea), Genesis's *authority* (has the owner granted it for this action type), and the *permissions/execution/verification* stack (can this account do this, did it work, is it durably recorded) are three separate layers that must never collapse into one. A future change that makes Claude aware of its own authorization level, or that lets a measured outcome adjust what Genesis is allowed to do, would violate this — flag it rather than build it.

**Category ceilings are architectural maximums; individual action ceilings determine actual delegability.** `lib/execution/genesisActions.ts`'s `CATEGORY_MAX_TIER` is a hardcoded, non-owner-configurable cap per `GenesisActionCategory` (`content`→`auto`, `operations`→`always_ask`, `integration`→`auto_below_limit`, `communication`→`auto`, `money`/`destructive`→`always_ask`, hard) — it bounds what a category *could ever* allow, not what any specific action *does* allow. Each `GenesisActionDefinition` separately declares its own `maxAuthorityTier`, which must be `<=` its category's ceiling (enforced by an assertion that runs once at module load, failing loudly if a future action is mis-registered above its category's cap). This is why `update_brand_identity`/`update_store_identity` stay hard-locked to `always_ask` even though `content`'s ceiling permits `auto` — the category says "this kind of thing could be delegated," the action says whether *this one* actually is.

**`update_seo` was the first action eligible for autonomous execution; `update_goal_status`/`resolve_challenge` joined it during the J4 Cognitive Layer work** (all three `maxAuthorityTier: "auto"`) — every other registered content action, including `update_hero`/`update_brand_identity`/`update_store_identity`, stays hard-locked `always_ask`. The two newer ones are deliberately zero-customer-facing-risk: `category: "operations"`, Genesis's own internal understanding of a Goal/Challenge record, not storefront content — the intended first real proof that the autonomy ladder generalizes past content at all (see `genesisActions.ts`'s own `CATEGORY_MAX_TIER` comment for the full reasoning). `update_hero` remains deliberately locked pending its own review, given it's the storefront's single highest-visibility element.

**`DelegatedAuthority`** (Prisma model) is the smallest durable representation of "the owner has authorized Genesis to handle this kind of decision" — one row per `(storeId, actionType)`, `revokedAt` nullable. Deliberately scoped per action type, not per category: a category grouping is presentation-only (how the owner-facing toggle is *labeled*), never a stored grant — a brand-new action type never silently inherits an existing category's trust. Revocation is immediate: every check reads `revokedAt IS NULL` live, at the moment of decision, with no cache or propagation delay (today's Executables are single synchronous writes, so there's no meaningful "in-flight action" window to interrupt). Granting/revoking requires `PERMISSIONS.AUTHORITY_MANAGE` (OWNER-only) — an Employee cannot create, benefit from, or influence a grant.

**`lib/execution/genesisAutonomy.ts`'s `tryExecuteAutonomousAction`** is the one place that decides "may Genesis handle this without asking" and, if so, does it — a second *code path*, not a second Genesis: same `GENESIS_ACTIONS` registry, same `execute()` engine, same `ApprovalRequest`/`ExecutionLog` lineage, same `actorType: "GENESIS"`. Self-contained: re-validates the grant, the store owner's own permission for the underlying `Executable.requiredPermission`, the action's eligibility, and the proposed input's shape, all before ever calling `execute()` — never trusts a caller to have already done so. Wired into `runCognitiveReview()`'s own proposal loop (`lib/intelligence/cognitiveLayer.ts` — the file this originally described as `generateGenesisRecommendations.ts` was relocated and rewritten during the J4 Cognitive Layer work, see *J4 Cognitive Architecture — Reason* above); **deliberately never reachable from chat** — if the owner is actively chatting with Genesis, that turn's proposal always surfaces in-conversation for them to decide, never silently auto-applied.

**`execute()`'s `opts.preAuthorizedGrantId` is not a generic permission-bypass flag — it is independently re-validated, not trusted.** When set, `execute()` re-fetches that exact `DelegatedAuthority` row from the database and confirms it is unrevoked *and* resolves, through `GENESIS_ACTIONS[grant.actionType].executable`, to the exact same `Executable` object being run — only then does it skip `requireStorePermission` and build `ExecutionContext` from the grant's own `storeId`. **A real bug caught by live verification, worth understanding precisely**: the first implementation compared `grant.actionType` (a `GENESIS_ACTIONS` registry key, e.g. `"update_seo"`) against `executable.action` (the low-level `ExecutionLog` action string, e.g. `"store.update_seo"`) — two different, only-coincidentally-similar namespaces that are never equal. Every legitimate autonomous execution failed closed. The fix resolves the grant's actionType back through the registry and compares the resulting `Executable` object by *identity*, not by comparing any strings — immune to that namespace mismatch and to a caller separately asserting an actionType that doesn't actually describe what's being executed. Any future change to this check must preserve object-identity resolution through `GENESIS_ACTIONS`, not reintroduce a string comparison against `executable.action`.

**Undo is immutable-history, not a special "reverse" mode.** `revertApprovalRequest` (`ai-actions.ts`) re-runs the same `Executable` with `input = the original decision's previousValues`, creating a brand-new `EXECUTED` `ApprovalRequest` row (`decisionMode: "human"` — clicking revert is itself a real, immediate human decision, regardless of whether the original action was autonomous) — the original row is never rewritten or deleted. Shipped in Phase 6's first milestone rather than deferred, specifically because autonomous execution skips the moment a human could otherwise have caught something before it happened.

**Autonomous vs. human-approved decisions are permanently distinguishable, everywhere history is shown.** `ApprovalRequest.decisionMode` (`"human"` | `"autonomous"`) is a frozen snapshot alongside `delegatedAuthorityId` (which specific grant authorized it, for a permanent answer to "why was Genesis allowed to do this," even after the grant is later revoked). It surfaces in three places: the Marketing page's "Recently handled" list (with a Revert action), `ActivityFeed`'s message text ("— handled automatically, no approval needed", joined from `ApprovalRequest` by `executionId` at read time, never by mutating the append-only `ExecutionLog` row itself), and `runCognitiveReview`'s own prompt context (`getRecentDecisionOutcomes`, `lib/businessModel/reasoning.ts` — the current replacement for the original `recentGenesisHistory` proxy, see *J4 Cognitive Architecture — Reason* above) — there, `decisionMode` is explicitly informational only (the prompt tells Claude as much): it never changes what Genesis is currently allowed to do, and a string of successful autonomous outcomes can never grant more authority than the owner explicitly chose to give.

**Existing systems needed zero changes to work correctly with autonomous decisions** — a retroactive point in favor of the one-lineage design: Phase 5's `measureDueMeasurements`/`concurrentActionTypes` and Phase 4's dedupe/resolve machinery all key off `status`/`decidedAt`/`topicKey`, entirely agnostic to `decisionMode` — an autonomous execution is measured, deduped, and surfaced in learning context exactly like a manually-approved one, automatically. (`getRecentGenesisHistory`, referenced here in an earlier version of this file, was deleted during the J4 Foundation work below — see *J4 Cognitive Architecture — Learn* for what replaced it.)

---

## J4 Cognitive Architecture

Genesis's AI reasoning is not one undifferentiated "the AI" — it's a formally specified, four-subsystem architecture (Understand / Execute / Learn / Reason) adopted as the platform's permanent foundation and deliberately designed to be portable: Genesis is J4's first embodiment, not its only possible one (see `VISION.md` for the full Genesis/J4 product framing). This section documents the architecture as it actually runs today; it does not reproduce the full governing Constitution, only the parts realized in code.

**The root design rule every subsystem is checked against**: *the owner expresses intent; Genesis performs the mechanics.* Two invariants follow from it, enforced in code, not just convention:
- **Fact and belief never merge.** A single observed event (one declined proposal, one recent order) is a *fact*, read live from Understand's own durable records. A *belief* only exists once Learn has generalized across 2+ real, spaced-out occurrences of the same pattern. Reason is shown both, separately, and is instructed explicitly to weigh them differently — see `SYSTEM_PROMPT` in `lib/intelligence/cognitiveLayer.ts`.
- **Every effect outside the Cognitive Architecture — a business-changing mechanic or a purely communicative one — goes through Execute, with no exceptions.** Even a deterministic insight or an AI-authored explanation isn't durably real until it's a `CognitiveOutput` row created via `execute()`. This rule was retrofitted twice after two real, audit-found bugs (see *Execute* below) — worth knowing the failure mode it closes, not just the rule.

### Understand — what exists

The canonical, provider-independent model of "what is true about this business," separate from any one connected system's own vocabulary.

- **`lib/businessModel/entities.ts`** — `ENTITY_REGISTRY`, a registry (not a fixed schema) of canonical entity types: `contact`, `transaction`, `item`, `appointment`, `campaign`, `document`, `goal`, `challenge`, `employee`, `location`. A new entity type is a new registry entry — zero changes to storage, the mapping contract, or the reasoning layer. Relationships are a naming convention, not a join table: any field named `xxxId`/`xxxIds` is understood to reference another entity's id.
- **`BusinessRecord`** (Prisma) — one generic, polymorphic table (`entityType`/`sourceProvider`/`externalId`/`data` Json, validated against the entity's real Zod schema at write time) holding every entity from every source. `lib/businessModel/internalMapper.ts` computes Genesis's own Order/Product data into this same canonical shape live, on every read — no persisted copy, always fresh by construction. A real external connector (Google Calendar, QuickBooks, Mailchimp — `lib/integrations/`) persists into the same table via `persistSyncedRecords` (`lib/businessModel/sync.ts`), which validates and reports a malformed record rather than corrupting the table.
- **`lib/businessModel/reasoning.ts`** — the read layer: `queryRecords`/`findRelated`/`aggregate` (generic primitives, work over any registered entity type) plus a growing library of real domain functions — `getRevenue`, `getTopContacts`, `getCustomerSegments`, `getItemPerformance`, `getEntityHistory`, `getRecentDecisionOutcomes`, `predictGoalTrajectory`. A new business question is a new function here; the primitives themselves never change for it.
- **`getBusinessProfile()`** (`lib/businessModel/profile.ts`) — the single assembled read of "everything currently known about this business" (identity, offerings, revenue, customers, people, suppliers, connected systems, goals, challenges, locations) — the one place both chat and Reason draw from instead of each re-deriving their own subset.
- **`BusinessEvent`** — a standardized, append-only fact log (`entityType`/`eventType`/`recordId`/`occurredAt`) produced by Change Detection (`lib/intelligence/changeDetection.ts`): record-level rules comparing a synced record's before/after state, plus time-based sweeps for conditions that become true purely from time passing (an invoice crossing its due date, with no new sync data at all). Carries no severity judgment of its own — that's the Insight Engine's job, one layer downstream.

### Execute — what actually occurred

`lib/execution/engine.ts`'s `execute()` is the sole gateway through which anything has any effect outside the Cognitive Architecture. Every call resolves its `ExecutionContext` one of four ways, always independently re-verified, never trusted from the caller:
1. **A real human session** (`requireStorePermission`) — the default path.
2. **`preAuthorizedGrantId`** — an owner-granted `DelegatedAuthority` row, re-fetched and matched by *object identity* against the registry's own `Executable`, not a string comparison (a real namespace-mismatch bug was caught and fixed here — see *Delegated Authority* above).
3. **`systemStoreId`** — the scheduler's own bypass, the first path in this codebase that runs with genuinely zero human/request context; reachable only from `lib/intelligence/scheduler.ts`, itself only reachable from the `CRON_SECRET`-gated cron route.
4. **`authorityExemptAction`** — the narrowest bypass, valid only for a mechanic the registry itself marks `authorityExempt: true` (today: exactly one, `communicate_finding`), independently re-verified against the registry, never trusted from the caller.

Every execution writes one append-only `ExecutionLog` row and, for anything that's a genuine finding, one `CognitiveOutput` row via `communicateFinding()` (`lib/execution/genesisAutonomy.ts`) — the only legitimate caller of the `authorityExemptAction` bypass. `communicateFinding` exists specifically because two real, audit-found bugs originated findings and displayed them to the owner without ever recording them as `CognitiveOutput` first: the dashboard's deterministic observation sweep, and a challenge chat-capture path — both in `GenesisObservation`'s writer set (see *The Embodiment Layer* below), both fixed by routing through this function before ever touching the presentation cache.

### Learn — what have we learned

`lib/intelligence/learn.ts` continuously distills Understand's facts and Execute's outcomes into `Belief` rows — durable, revisable, evidence-backed generalizations, never facts, never judgments about what to do. Confidence (`computeConfidence`) and maturity (`describeMaturity`, derived at read time, never stored as a stage) are genuinely separate dimensions, so a fresh high-confidence hypothesis and a long-tested one are never conflated, and a belief whose most recent evidence *contradicts* it (Reconsideration) is a distinct, surfaced signal rather than an averaged-away number.

Three real detectors, all sharing one shape (group evidence by a stable identity → threshold → `upsertBelief`):
- **`detectInsightRecurrence`** — store-wide recurrence of the same `CognitiveOutput` insight `type` across 3+ distinct weeks.
- **`detectDecisionOutcomePattern`** — rejection patterns (2+ declines of the same `topicKey`) and outcome correlations (2+ measured executions agreeing in direction), from `ApprovalRequest`/`PostExecutionMeasurement`.
- **`detectRecordEventRecurrence`** — the first detector capable of forming a belief tied to *one specific record*, not a store-wide aggregate: groups `BusinessEvent` by `(eventType, recordId)`. `recordId` is already the canonical, entity-agnostic identity every registered entity type shares, so this works identically for a customer, an item, or a future entity type with no branching.

`distillBeliefs()` is the single entry point every trigger calls, run alongside `computeInsights()` — Learn stays continuous/ambient, never collapsed into "whatever Reason's own cadence happens to be."

### Reason — what should happen next

`runCognitiveReview()` (`lib/intelligence/cognitiveLayer.ts`) synthesizes Understand's current facts and Learn's beliefs into a judgment — insight/prediction/explanation/recommendation/opportunity — following one lifecycle (Observe → Explain → Recommend → Execute) regardless of business domain. Stateless by design: every field in `contextForPrompt` is a fresh read on every call, nothing cached or carried between invocations. Every conclusion — informational or action-bearing — exits exclusively through `communicateFinding()`/Execute; Reason itself never touches the Embodiment Layer directly.

A `proposedAction` attached to a recommendation/opportunity flows into `lib/execution/genesisActions.ts`'s `GENESIS_ACTIONS` registry — every action carries a `category` (content/operations/integration/communication/money/destructive), a hard per-category ceiling (`CATEGORY_MAX_TIER`), and its own `maxAuthorityTier`, enforced against each other at module load. `lib/execution/genesisAutonomy.ts`'s `tryExecuteAutonomousAction` decides whether the owner's own granted `DelegatedAuthority` covers a proposed action and, if so, executes it without asking — a second code path through the exact same registry/`execute()`/`ApprovalRequest` lineage, never a second Genesis, and deliberately unreachable from chat.

### The Embodiment Layer

Perception, Actuation, and Expression are everything specific to Genesis as J4's current body — kept separate so the same mind could, in principle, run through a different embodiment later without redesign. Nothing crosses the boundary except a canonical representation: Perception never hands Understand a raw provider payload, only a verified `SyncedRecord`/`BusinessEvent`; Execute never performs a technical operation itself, only emits an abstract mechanic a specific `Executable` fulfills. `GenesisObservation` (the dashboard's ambient Purple/Red badge state — see *Genesis Language Navigation Propagation* below) is a legitimate Expression-owned presentation cache, but every finding it displays must already exist as a real `CognitiveOutput` before Expression ever projects it — the exact rule the two `communicateFinding` compliance fixes above exist to enforce.

---

## Growth Credits — thinking is free, execution is invested

**Standing product principle, frozen by Sean, 2026-08-04**, before Business Intelligence Engine work began specifically because it governs everything that follows: *J4 never charges the owner for thinking. Growth Credits are only ever consumed when the owner approves J4 to actually perform work that changes or grows the business.*

Concretely: every real Understand computation, every Learn detector, every Reason judgment — planning, analysis, comparing strategies, forecasting, building a roadmap, explaining trade-offs, answering "what's the best plan" or "what would you do next" or "show me three strategies" — is free and unlimited, no matter how many times the owner asks. The only moment a Growth Credit is ever spent is the owner's own "let's do it" — a real execution through `execute()`.

This isn't a new rule bolted onto the architecture — it's an existing invariant, read as an economic policy rather than a purely architectural one. Understand/Learn/Reason are pure cognition, with no effect outside the Cognitive Architecture by construction; Execute is already the sole gateway through which anything real happens. "Thinking is free, execution is invested" is that same boundary. A direct consequence worth naming explicitly: the Business Intelligence Engine below — being entirely Understand/Learn work by its own frozen definition — can never cost Growth Points on its own, no matter how sophisticated it becomes. Only a future BI-Engine-informed recommendation's own *approved execution* ever does.

**The classification test, sharpened by Sean, 2026-08-04, before Growth Points Economy work began**: *Growth Points are an investment in the business, not a fee to use AI.* J4 stays always free to think, analyze, plan, brainstorm, forecast, explain, and teach — the owner should never feel like they're paying to have a conversation. The concrete test for every future call site: **if something is primarily understanding, planning, or reasoning, it stays free. If Genesis is creating, publishing, generating, connecting, or otherwise performing real work on behalf of the business, that's where Growth Points are invested.** This resolves what was previously named as real, unresolved scope below — most reasoning calls (`cognitive_review`, `store_chat_data_answer`, `recommendation_explanation`, every onboarding classification call) already map cleanly to "thinking" under this test; every call inside a registered `Executable`'s own `run()` already maps cleanly to "execution." The store-generation calls that produce a real deliverable directly (no separate owner-approval step today) are the clearest case this test was written to resolve: generating is real work performed on the business's behalf, not planning — they fall on the "invested" side, even though they don't currently flow through `execute()` the way every other real action does; whether that also means routing them through `execute()` for consistency, or just classifying them as chargeable where they already are, is real implementation work for Growth Points Economy planning, not decided here.

`lib/growthCreditCatalog.ts` stays deliberately empty — this principle governs the *shape* of every future entry (a pure-thinking feature must never be assigned a nonzero cost) and now the *test* for classifying every entry, without pre-assigning any real point value. Real per-action prices remain Sean's own deliberate decision, from real usage data, not implementation guesses — unchanged from the original AI Cost & Usage Infrastructure design.

**Two further standing principles, frozen by Sean, 2026-08-04, while approving Growth Points Economy Chapter 2 and reviewing its first real pricing proposal:**

**J4 must stay budget-aware, never budget-limited, in what it's willing to discuss.** A store with zero Growth Points must still get a real, complete answer to *"what should I do next," "build me a 90-day growth plan," "how would you spend 20 Growth Points," "how would you spend 100 Growth Points," "what's the fastest path to $10,000/month"* — Growth Points only ever matter at the moment of choosing to execute, never at the moment of asking. Beyond that, J4 should actively reason about the owner's real, current balance: when a store's balance can only fit a smaller plan, J4 should naturally propose the best plan that fits within it *while also transparently naming the higher-impact plan more Growth Points would unlock* — informing the trade-off, never pressuring a purchase. This is real, not-yet-built capability: nothing today threads `Store.growthPointBalance` into Reason's `contextForPrompt` or any chat prompt, so J4 currently has no way to reason about affordability at all. Implementing this is future Growth Points Economy work, not assumed to fall out of the mechanism already shipped (M1-M5).

**Growth Points should feel like investments, not consumables — a deliberate psychological frame, not just a cost model.** The felt experience should read *"I invested N Growth Points into improving my business,"* never *"I spent N points."* This is the same "Genesis creates the business / J4 understands the business" spirit applied to language: Genesis isn't selling AI usage, it's helping an owner decide where to invest in growing their own business. Concretely, this governs every place Growth Points are named going forward — UI copy (`app/dashboard/growth-points/page.tsx`'s "spent" labels predate this principle and need a pass), ledger descriptions, any future chat-surfaced cost explanation — "invested," never "spent" or "used."

**A further sharpening, frozen by Sean, 2026-08-04, while scoping the Marketing Engine (Chapter 3): Growth Points must never be tied to technical operations — never per platform, never per post, never per API call.** The entrepreneur shouldn't think about APIs or platforms; a Growth Point always represents a business outcome. Concretely: **connecting a channel/social account is always free** — infrastructure, not business growth, exactly like connecting Stripe or Mailchimp already costs nothing today. Where a chapter's own unit of work fans out across multiple connected platforms (the Marketing Engine's own campaigns are the first real case), Growth Points are invested **per unit of real work committed to, scaled by how much work that represents — never by how many platforms it happens to reach.** The Marketing Engine's own concrete application of this test lives in its own section below.

---

## J4's identity

Who J4 is — its voice, personality, how it teaches, challenges, delivers criticism, builds relationship continuity, and adapts to different owners while staying recognizably itself — is now consolidated in its own canonical document, **`J4_IDENTITY.md`**, frozen 2026-08-05. This includes "J4 is a trusted advisor, never a salesperson," "Recommend only the highest real probability, never merely the possible," and "J4 makes better entrepreneurs, not replacement entrepreneurs" — all formerly sections of this file, moved there rather than duplicated. Check that document, not this one, for anything about how J4 should behave, sound, or relate to an owner.

---

## Growth Points Economy — initial real pricing (Chapter 5)

**Frozen by Sean, 2026-08-05**, after every prior chapter's pricing proposal was deliberately left unset pending this exact decision (see *Growth Credits* above: "real per-action prices remain Sean's own deliberate decision, from real usage data, not implementation guesses"). These are real, initial values — subject to change with real usage data, but no longer placeholders.

**Subscription Plans** (`Plan.stripePriceId`, `Plan.monthlyGrowthPointAllowance`):
- **Builder** — $29.99/month, 12 Growth Points/month, plus a one-time onboarding allocation (exact amount deliberately not yet set — Sean's own words: "we'll finalize the exact number separately").
- **Growth** — $49.99/month, 25 Growth Points/month, plus a larger one-time onboarding allocation (amount also not yet set).
- **Business Partner** — $99.99/month, unlimited execution of every real `GENESIS_ACTIONS` entry priced at exactly 1 Growth Point in `lib/growthPoints/catalog.ts` — 2/3/5-point actions continue drawing from the normal balance/ledger unchanged, using the **same 25 Growth Points/month allowance as Growth** (Sean's explicit call: the premium isn't more points, it's removing friction from the routine 1-point tier entirely — unlimited *everything* would defeat the point of the economy representing meaningful business investment). Sean's own framing for *why*: "The purpose of the Business Partner plan is not to remove the Growth Point economy. It's to eliminate friction from the routine, day-to-day improvements... while preserving intentional investment for larger business decisions." **BUILT, and verified end to end 2026-08-22** (`scripts/verify-plan-unlimited.ts`). `lib/growthPoints/ledger.ts` reads `Plan.unlimitedActionCostCeiling` in both `checkGrowthPointBalance` and `deductGrowthPoints`, through one shared `isUnlimitedViaPlan` so the two can never disagree, and a covered action still writes its ledger row **at zero** — free is recorded, not unrecorded. This paragraph said "currently-unbuilt" until that verification found otherwise.

**The numbers above are the older ones.** `scripts/provision-pricing.ts` is what actually creates the Stripe Prices, and it now says Business Partner carries a **40**-point monthly allowance with an unlimited ceiling of **2**, against Growth's 28 — so the ceiling covers 1- AND 2-point actions, and "the same allowance as Growth" no longer holds. Treat provision-pricing as operative, exactly as the room bar in `navConfig.ts` is operative over the older prose in GENESIS_SURFACES.md.

**À la carte Growth Point packages** (`lib/growthPoints/purchaseCatalog.ts`): $9.99 → 4 points, $19.99 → 8 points, $49.99 → 20 points, $99.99 → 45 points. Deliberately priced so the effective per-point cost stays above every subscription tier's own effective rate — Sean's own reasoning: "That keeps subscriptions as the best long-term value while giving owners a convenient way to continue investing... when they need additional Growth Points."

**Explicitly not decided by this freeze**: which specific `GENESIS_ACTIONS` entries actually cost 1 vs. 2 vs. 3 vs. 5 Growth Points — `lib/growthPoints/catalog.ts` itself remains real, wired, and still empty. This freeze locks the *tier structure* (four real cost tiers now implied: 1/2/3/5) and the *subscription/package* pricing around it, not the per-action catalog assignment — that real mapping is still a separate, undecided product decision, not to be invented alongside this one.

---

## Growth Points measure business significance, not technical difficulty

**Frozen by Sean, 2026-08-05**, while reviewing the first real per-action catalog proposal. His own correction, worth preserving verbatim: *"The catalog shouldn't only measure difficulty. It should measure business significance."* His example: changing one product photo isn't the same as launching a seasonal campaign — the second touches revenue, branding, inventory, marketing, and social/email all at once, and *"those shouldn't cost the same simply because both are 'updates.'"*

**What this governs today**: every tier assignment in `lib/growthPoints/catalog.ts` is a judgment about how much of the business a real action actually moves, not how much engineering or AI work it took to build — the two happen to correlate for some actions (`create_product`'s real `$0.17` image-generation cost) and deliberately don't for others (`update_theme` costs nothing in AI/compute to execute, but touches every page — priced at the top tier anyway). Real observed AI cost (`AiUsageEvent`) is a floor to sanity-check against, never the basis for a price.

**What this governs long-term, named as a real, deliberately unbuilt future capability**: today's catalog is one fixed point-cost per `GenesisActionType` — a static lookup table. Sean's own framing for where this eventually needs to go: *"J4 should eventually understand scope... instead of hardcoding every action forever, it should ask itself: 'how much of the business am I about to change?'"* A future "launch a seasonal campaign" isn't one `GENESIS_ACTIONS` entry today and may never cleanly be one — it's several real actions (theme, marketing assets, product imagery, homepage content) dispatched together, and the real open question this principle leaves for later is whether the *combined* investment those add up to already captures "business significance" correctly, or whether J4 itself needs to reason about a request's scope before mapping it to a cost at all. Not designed yet — named so it isn't lost, the same discipline as every other deferred capability in this document.

**Marketing specifically**: `update_marketing_assets` is priced at the "campaign creation" tier (3pt) today because that's the one real thing it currently does — draft real, brand-voice campaign content. Sean's own expectation, once Marketing Engine deepens (video analysis, captions, email, ad copy, repurposing, scheduling, cadence, platform adaptation — see the Marketing Engine section below): this single action will need to fork into several real, separately-priced actions rather than staying one fixed-cost action forever, split by the same business-significance test as everything else in this catalog — **routine** (scheduled posting, content distribution, maintaining a healthy posting cadence) belongs at the low, Business-Partner-unlimited tier; **strategic** (campaign creation, major marketing-direction changes, positioning, larger creative initiatives) stays a higher-tier investment. Not built now — `update_marketing_assets` stays one action until Marketing Engine M3+ gives it real reasons to split.

**The real, locked catalog** (`lib/growthPoints/catalog.ts`, all 15 real `GENESIS_ACTIONS` entries):
- **Free** — `update_goal_status`, `resolve_challenge`, `communicate_finding`: bookkeeping and communication, not a change to the business itself. Deliberately absent from the catalog object (not a `0` entry) — matches the existing "no catalog entry = free" convention exactly, and avoids writing a real `$0` "Invested in..." transaction row for what should read as effortless.
- **1pt** (Business Partner's unlimited tier) — `update_seo`, `update_product_image`, `update_section_order`: narrow, single-concern, routine maintenance.
- **2pt** — `create_product`, `update_hero`, `update_homepage_content`, `update_store_content`: real creation or moderate content change.
- **3pt** — `update_store_identity`, `update_design_direction`, `update_marketing_assets`: strategic moves.
- **5pt** — `update_theme`, `update_brand_identity`: whole-brand transformation.

---

## Business Partner Preview — a real, once-per-store 7-day trial

**Frozen by Sean, 2026-08-05.** Every new store experiences the Business Partner plan's unlimited-1-point-action tier for a real 7-day window — not a feature tour, a lived week of not thinking about spending a point on routine day-to-day work. Sean's own framing for *why*: "I want people to experience a real business cadence, not just test features. The goal is for them to stop thinking about spending a point every time they ask J4 to help with everyday business work. At the end of the week they should naturally understand the value of Business Partner because they've experienced it — not because we sold it to them."

**When it ends**: the store returns to its normal plan. This must never read as something being taken away — it's simply the end of a different way of working the owner already experienced firsthand. If J4 ever surfaces the plan afterward, it observes real usage and advises, exactly like every other case under *"J4 is a trusted advisor, never a salesperson"* above — e.g. *"I've noticed you're using a lot of day-to-day optimization actions. You can absolutely continue on your current plan, but I think Business Partner would remove a lot of unnecessary friction for the way you work."* This is the same real, currently-unbuilt "J4 recommends a plan from observed usage" capability already named as its own deferred future milestone above — the trial doesn't need a second version of it.

**A second, distinct benefit, named by Sean 2026-08-05 while reviewing the trial's own economics**: the trial isn't only a demonstration of Business Partner's value — it's an education mechanism for the whole Growth Points economy. Freed from thinking about routine 1-point actions for a real week, an owner naturally discovers the real hierarchy (routine maintenance is inexpensive and frictionless; strategic changes require a larger investment) by living inside it, rather than reading about it in a help article. Sean's own words: *"The trial teaches the system instead of asking people to memorize it."* This is the same "show, don't tell" instinct already governing the Genesis Experience onboarding journey, extended for the first time into the economy itself.

**Sharpened once more, frozen by Sean 2026-08-05, while building the Beta Readiness checklist — the real purpose of the seven days, precisely**: *"The purpose of the first seven days isn't to ration Growth Points or teach scarcity. It's to let owners learn how Genesis works, experiment, make mistakes, and build trust without worrying that they'll accidentally waste their allocation before they understand the platform. Once they understand Genesis and how J4 fits into their business, then plan limits and Growth Points become meaningful."* The trial's real job is removing the *fear* of a mistake during the specific window when an owner doesn't yet know what a mistake even looks like — not rationing anything. Plan limits and Growth Points are only a meaningful signal once the owner already understands what they're weighing; asking them to weigh that before they understand the platform would be teaching scarcity, not partnership.

**How Business Partner should be marketed, frozen by Sean 2026-08-05**: never as "unlimited 1-point actions" — that's an implementation detail, not the value. The real value: *"Business Partner removes friction from routine business operations, not strategic business investments."* An illustrative example (explicitly a future-state description, not a claim about what's built today — see the "Marketing specifically" paragraph above): an owner maintaining a daily social presence spends roughly 28 routine posting actions a month. Under the normal economy, that's ~28 Growth Points spent purely on upkeep; under Business Partner, that upkeep becomes frictionless, leaving those same points available for strategic investment — a new product, a campaign, a brand redesign. Sean's own framing: *"You're not buying more AI. You're eliminating the constant micro-decision of 'is this routine task worth spending a point on?' so you can reserve your Growth Points for things that genuinely move the business forward."* This example becomes literally true once Marketing Engine's routine-posting capability exists (see "Marketing specifically" above) — not before.

**Grant trigger**: `Store.firstMeetingCompletedAt` — the same "onboarding genuinely finished" signal `Referral` rewards already wait for (never bare store creation; a real meaningful setup milestone, Sean's own words).

**Scope: once per store, not once per account** — Sean's explicit call, since a real account can legitimately run more than one real business (his own dogfooding plan: Tensor King plus a new Genesis/J4 store). Per-store scope alone would be trivially farmable (create empty stores, collect trials), so it's paired with three real technical guards, all Sean's own explicit requirements:
1. **Only one active trial per account at a time** — a new store's trial isn't granted while any of that owner's other stores has a live, unexpired trial window.
2. **Granted only at a meaningful milestone** (`firstMeetingCompletedAt`), never at bare store creation — raises the real cost of farming above "click create repeatedly."
3. **A deleted store must not erase that its trial was ever granted** — the grant record lives in its own table, independent of the `Store` row's lifecycle, so both guard #1 and any future fraud review stay correct even after a farmed store is deleted.

**Explicitly named, not solved by this freeze**: a numeric cap on total trials an account may ever farm (Sean's own words: "add internal fraud checks if someone creates dozens of stores solely to farm trials") is a real future decision once real abuse patterns (if any) are observed — this freeze makes that decision *possible* (the grant history survives deletion and is queryable per account) without guessing the actual threshold today. True cross-account abuse (the same person operating multiple real logins) remains an open, unsolved vector common to every trial-based product — not addressed by store- or account-scoped guards, named here rather than silently left out.

**Business Partner's value proposition, frozen 2026-08-05, Sean's own words**: *"Business Partner is not about giving owners 'more AI.' It's about removing friction from running their business. The value is that routine business improvements become effortless, allowing owners to stay focused on growing their business instead of constantly deciding whether a small improvement is worth spending Growth Points on."* This is the real reason the trial works as a conversion mechanism at all: it isn't demonstrating a feature, it's letting an owner live the difference between constantly weighing a small decision and not having to. Governs how J4 itself talks about the plan whenever the deferred "recommend from observed usage" capability above gets built — friction removed, never AI volume, is the only correct framing.

---

## Business Intelligence Engine

Not a fifth cognitive subsystem — a capability *distributed across* Understand and Learn, deepening how richly J4 understands real business performance so Reason gets better material at its two existing inputs (facts, beliefs), never a new pipeline of its own. Full empirical validation of this design bet — including what the evidence does and doesn't prove — is recorded separately in `J4_REASON_VALIDATION.md` and should be read alongside this section, not duplicated here.

**The build record lives in `BI_ENGINE.md`, not here** (added 2026-08-21, because this section had no pointer to it at all). That document specifies milestones M1–M9 and closes with section 15, *The milestone, closed* — the acceptance record, including what is verified live, what remains open, and what is externally blocked. Read it before assuming anything in this section is current: the 4-tier roadmap below is the *capability* framing and is still accurate as written, but it is a different and older axis than M1–M9, and this file's own "last updated" line predates all of that work. The open items named in `BI_ENGINE.md` §15 are recorded deliberately and are **not** a to-do list authorising new scope.

A frozen 4-tier capability roadmap governs what gets built, in order:

1. **Current Truth** (Understand) — deterministic snapshots of real state: `getItemPerformance`, `getCustomerSegments`, `getRevenue`, `getTopContacts` (`lib/businessModel/reasoning.ts`). Extended since, via the Integrations chapter, with the same discipline: `getInvoiceSummary`, `getCampaignPerformanceSummary`, `getAppointmentSummary`, `getUpcomingAppointments`, `getAverageOpenRate` — real standing summaries of connected-system data (QuickBooks, Mailchimp, Google Calendar), each honestly `null` when nothing's synced yet, never a fabricated zero.
2. **Temporal Understanding** (Understand) — one capability, two presentations: trend (backward-looking) and forecast (forward-projecting) both reduce to the same rate-of-change computation. `computeTrend`, `getRevenueTrend`, `getItemPerformanceTrend`, `getCustomerSegmentTrend` (via `getCustomerSegments`'s own `asOf` parameter — a point-in-time snapshot comparison, not a windowed sum, since customer segments are a state/level quantity, not a flow one, unlike revenue), `projectForward`/`predictGoalTrajectory`.
3. **Pattern Detection** (Learn) — the detector registry described under *Learn* above.
4. **Strategic/Opportunity Synthesis** (Reason) — explicitly *not* an implementation milestone. Emergent once Tiers 1-3 are rich enough; a future need to write new Reason logic for this is treated as a signal Tiers 1-3 aren't rich enough yet, never that Reason needs another layer.

**The standing architectural test this roadmap enforces on all future work**: before changing Reason's own logic, first ask whether the capability actually belongs in Understand or Learn. This is not just a design preference — `J4_REASON_VALIDATION.md` records a deliberate, live before/after test of the claim across 6 real scenarios, including the one real code change this required: making a new Understand capability visible to Reason takes an explicit, bounded extension of `contextForPrompt` (`lib/intelligence/cognitiveLayer.ts`) — it does not happen automatically just because Understand computed it.

**Audited against reality, 2026-08-05** — confirmed the 4-tier roadmap and `J4_REASON_VALIDATION.md` are both still accurate: Tier 3's detector registry is unchanged (still exactly `detectInsightRecurrence`/`detectDecisionOutcomePattern`/`detectRecordEventRecurrence`), Tier 4 remains genuinely unimplemented. Real, evidence-checked answer to "can this engine answer the questions an owner would actually ask" (why is a metric moving, what changed since last month, am I improving, what should I focus on today, what opportunities exist in my own data): **yes**, for all of these — Tier 1/2 trend data plus Tier 4's validated opportunity/explanation synthesis already cover them, per `J4_REASON_VALIDATION.md`'s own real scenarios. Opportunities framed as "what am I missing relative to other businesses" are the one explicit exception — external/benchmark comparison remains deliberately out of scope, named below.

**Explicitly out of scope: inventory/reorder recommendations — a real product/schema decision, not a BI Engine gap.** Checked directly: `Product` carries no stock-quantity field anywhere in the schema; the dashboard's own `getInventorySnapshot` (`lib/dashboard/inventory.ts`) is an active/inactive product *count*, an honest substitute, never real inventory tracking. This means "which products should I reorder" isn't answerable today — not because Understand/Learn/Reason lack the reasoning capability, but because the underlying fact (how many units exist) was never captured in the first place. Real future direction, per Sean's own framing (2026-08-05): the inventory model must support both AI-generated and manually-created products equally — an owner can always upload their own products, images, quantities, SKUs, pricing, and other detail by hand (see `J4_IDENTITY.md`'s "AI should assist, not be required"), and J4's job once that real data exists is insight and reorder recommendations on top of it, never control over the catalog itself. Not scoped or built here — a real schema decision for its own future milestone.

**The Business Event Pipeline (Phase 1)** wires commerce into `BusinessEvent` on a real per-store `sequence` (`BigInt`, strictly increasing, distinct from `occurredAt`) so multiple independent consumers can each resume exactly where they left off. `lib/intelligence/businessEvents.ts` is the one place events get written (`writeBusinessEvents`, callable with either the shared `prisma` client or a transaction's `tx`) and read by consumer (`getNewEventsForConsumer`/`advanceConsumerCursor`), with one `BusinessEventCursor` row per `(storeId, consumerName)` — the Insight Engine (`consumerName: "insight-engine"`), a future Genesis interpreter, and a future J4 write-action trigger each walk the log at their own pace with no shared state, so none can starve or race another. Commerce writes (the Stripe webhook, the PayPal capture handler) create the `Order` and its `transaction.created` `BusinessEvent` inside one `$transaction`, guarded by an existence check on `(paymentProvider, externalOrderId)` rather than inferred from an upsert's return value — both rows commit together or neither does, which is what keeps a webhook retry a genuine no-op instead of a duplicated event. Full design and the transition plan below: `PHASE1_DESIGN.md`.

`processedAt` (the pre-existing flag `computeInsights()` used to mark events considered) is **not yet retired** — it remains the one real, live mechanism for the Insight Engine; the `sequence`/cursor path runs in parallel alongside it purely to prove itself against real production data (comparing the two "new since last pass" sets every call, reporting any mismatch through Sentry) before an explicit, evidence-based cutover. A future contributor should not "simplify" this by deleting one path early — until cutover, `processedAt`'s own query and update must stay completely independent of the cursor system, by design (see `PHASE1_DESIGN.md` section 7, item 2's independence invariant).

---

## Marketing Engine (Chapter 3)

Deliberately built as an extension of existing systems, not a parallel one — researched and scoped this way on purpose (VISION.md's Chapter 3, planned 2026-08-04) before any code was written.

**What of this is actually BUILT, as of 2026-08-21** — the section below was written as a design, before any code, and reads in the present tense throughout, which is easy to mistake for a description of what exists:

| | State |
|---|---|
| Campaign planning (`planMarketingCampaign`, M1–M2) | **Built.** J4 plans a real campaign from real business understanding and brand voice, and persists each channel as a `campaign` `BusinessRecord` through `persistSyncedRecords`. Reachable from both chat paths via the `plan_campaign` tool |
| `campaign` as a first-class entity | **Built.** In the registry, extended additively so Mailchimp's existing sync is unchanged |
| The connected-data reads over campaigns | **Built and verified** — `scripts/verify-connected-summaries-live.ts` |
| `lib/marketing/channels/`, the `PublishChannel` interface | **Not built.** The directory does not exist. Described below as the intended shape, not as code |
| `execute_campaign` as a `GENESIS_ACTIONS` entry | **Not built.** No such action is registered; it appears only in a comment |
| Actually sending anything | **Externally blocked** on a real Resend account (M3) |

The design below stands unchanged — nothing about it has been revised. Only its tense was misleading.

**Campaign is the central abstraction; publishing channels are adapters beneath it.** A campaign is planned, drafted, and priced entirely independent of which platforms it will eventually reach — channel selection is a later, separate decision, and the architecture must never let one channel's shape (email's subject lines, a social platform's character limit) leak into how a campaign itself is modeled. Concretely: `campaign` is a real, pre-existing `EntityType` (`lib/businessModel/entities.ts`) — already populated today via Mailchimp's own real sync — extended additively (`status`, `content`, `scheduledAt`, `groupId`, every new field nullable) to also support planning, not just synced history. A planned campaign is written as a real `BusinessRecord` with `sourceProvider: "internal"`, the same precedent goals/challenges already established (`lib/businessModel/internalMapper.ts`) — campaign planning becomes real business understanding automatically, with no new top-level Prisma model and no parallel reasoning path.

**Publishing is a genuinely separate contract from the existing Connector Framework, not a branch inside it.** Every real `IntegrationConnector` (`lib/integrations/`) is strictly inbound — `sync()` only ever pulls data in, by explicit design. Outbound publishing needs its own interface, mirroring the precedent `lib/fulfillment/` already set by staying a separate registry from `lib/integrations/` specifically because Printful's own writes are outbound. `lib/marketing/channels/`'s `PublishChannel` interface is that same pattern applied a second time: a channel-agnostic content contract from day one (never shaped around email's own fields), so a future social-platform adapter is "write an adapter, add one registry line" — exactly how a new `IntegrationConnector` is added today.

**Execution reuses the existing pipeline with zero changes to it.** `execute_campaign` is a normal `GENESIS_ACTIONS` entry, flowing through the same `Executable`/`execute()`/`ApprovalRequest`/`ActionDiffRows` machinery every other action already uses — proof that the pipeline really was built generic, per the founder's own original instruction (preserved in `CHANGELOG.md`) that `ApprovalRequest` must stay generic because it would eventually hold "social posts."

**The concrete application of "Growth Points scale by real work, never by platform count"** (see the sharpened Growth Credits principle above): a campaign's Growth Point cost scales with its **posting cadence** (e.g. once-weekly vs. three-times-weekly), never with how many channels it fans out to. Connecting a channel is always free, matching every existing `IntegrationConnector` connection. The owner's approval of a campaign's cadence is the one real Growth Point investment in the whole flow; the actual per-occurrence, per-channel sends that follow are unattended system work (the proven due-timestamp scheduler pattern, a third sweep alongside `runDueSyncs`/`runDueGrowthPointRefreshes`) and never re-invest points — the commitment was already paid for once, at approval.

**Deliberately deferred, named so it isn't lost**: owner content-upload and repurposing (recording one real video/photo and having J4 multiply it across channels) is a genuinely separate problem — real media storage, transcription, and indexing infrastructure that doesn't exist anywhere today (the one real upload path in this app is a single still image, 8MB, used for a product photo or the onboarding logo). This foundation proves campaign planning, brand-voice-informed content generation, channel publishing, and cadence-based execution first; content repurposing is the next major marketing capability once it's live, not abandoned scope.

**Video (and later audio) upload is a foundational capability, not just another feature — standing product principle, frozen by Sean, 2026-08-05.** J4 needs to understand the owner's own original content, the same way it already understands orders, connected-system data, and business records — this is the same "understand before you act" discipline applied to a new input type, not a new philosophy. The intended long-term workflow, in order: the owner uploads one or more original videos; J4 analyzes them (transcript, topics, products, offers, tone, brand voice, key moments, calls to action); that understanding is stored as part of the business's own marketing knowledge, not thrown away after one use; and only then does repurposing happen — J4 intelligently adapting that real understanding into platform-appropriate posts, emails, blog articles, newsletters, short-form clips, captions, and future campaigns. Every future marketing-intelligence capability is meant to build on this, not treat it as optional.

**A direct, concrete consequence of this principle**: recommended posting cadence must be grounded in the business's own real content velocity — how much authentic original content actually exists — never an arbitrary number the owner picks or Genesis invents. When a business isn't producing enough original content to sustain a given cadence, J4's real answer is to recommend creating more original content, not to quietly increase posting frequency using thinner and thinner material. This sharpens (never contradicts) the existing "Growth Points scale by real work, never by platform count" principle above — cadence is priced by real posting frequency, and now that frequency itself must be honestly grounded in real content supply.

Still deliberately deferred as its own future milestone — real storage, processing, transcription, and analysis infrastructure for video/audio doesn't exist anywhere in this codebase today, and per this project's own standing rule, that infrastructure gets built when it's real, not stubbed or mocked ahead of need. Named here so the eventual milestone is scoped against a real, already-approved product principle rather than invented fresh when the time comes.

---

## Payments (Chapter 5)

Completes the economic layer — the platform's own billing of store owners (subscription plans, Growth Point purchases, billing/account management, card payments), integrated into the Growth Points economy so it never feels like a second, separate system. Crypto payments explicitly deferred to their own future milestone (Sean's own call, 2026-08-05: zero existing infrastructure, no provider account chosen — never invent that ahead of a real decision).

**Genesis IS the merchant of record here — the opposite direction from every other Stripe integration in this codebase.** `lib/integrations/stripe.ts` is Connect OAuth for a *merchant's* own connected account (accepting *their* customers' payments); `lib/billing/` is a direct, platform-key Stripe client billing the *store owner* directly. Same underlying Stripe account, same `STRIPE_SECRET_KEY`, deliberately separate modules so the two directions never tangle. A second, genuinely separate webhook endpoint (`app/api/webhooks/stripe-platform/route.ts`, its own `STRIPE_PLATFORM_WEBHOOK_SECRET`) follows the same reasoning — the existing merchant webhook's Connect-vs-platform disambiguation is dead weight for events that are always platform-key.

**Almost everything this chapter needed already existed, unpriced and unwired, from Chapter 2.** `Plan` (a real model, real rows created by Sean only when real pricing exists), `GrowthPointTransaction`'s own schema comment already reserved a `PURCHASE` type "once Chapter 5 wires a real payment rail," and `lib/growthPoints/refresh.ts`'s monthly-cadence sweep already granted `Plan.monthlyGrowthPointAllowance` to any store with a `planId` — Chapter 5's real job was narrower than it first sounded: get a real Stripe subscription to assign a real `planId`, and let the existing sweep do what it already did. `checkout.session.completed` (subscription mode) deliberately leaves `growthPointNextRefreshAt` untouched so that exact sweep picks the store up on its own next run — the clearest proof this integrates into Chapter 2 rather than reimplementing it.

**The recurring pricing tension, resolved the same way every prior chapter resolved it.** `Plan.stripePriceId` and `lib/growthPoints/purchaseCatalog.ts` (Growth Point purchase packages, mirroring `lib/growthPoints/catalog.ts`'s own "deliberately empty" discipline) both ship real and wired, with zero real rows/entries until Sean sets real prices. An unpriced plan or package is a real, honest error at checkout time, never a fabricated one.

**Billing and account management leans on Stripe's own hosted Billing Portal**, not custom payment-method/invoice UI — `/dashboard/billing` is a thin status summary plus one redirect button. Named "Billing," deliberately not "Payments" — `/dashboard/payments` already exists for the merchant's own outbound payment-provider connections; two different concerns sharing one name would have been a real, avoidable confusion.

**A real correctness gap closed, not just built alongside**: once `planId` meant "has a real Stripe subscription" rather than a hand-assigned label, the monthly refresh sweep's own due-query needed to stop granting free points to a canceled/unhealthy subscription — `getDueGrowthPointRefreshes` (`lib/growthPoints/refresh.ts`) now also requires `subscriptionStatus` to be `null` (never touched by real billing — a legitimate hand-assigned/comped case) or a real healthy Stripe status (`active`/`trialing`). `customer.subscription.deleted` deliberately never clears `planId` itself (keeps historical/display coherence, same "keep the past, gate future behavior separately" idiom `ExecutionLog` already uses) — this query is what actually stops further grants.

---

## Owner Dashboard

`app/dashboard/page.tsx` (Owner/Employee view of a live store) is a **decision dashboard, not a reporting dashboard** — every section answers one of three questions: **What happened? What needs attention? What should I do next?** Reframed from an earlier "reporting" conception at the user's explicit direction, with `ExecutionLog` as the structural backbone rather than one widget among several.

**`lib/dashboard/`** — the data layer, separate from `page.tsx`'s rendering:
- **`whatHappened.ts`** — `getOrderSummary` (windowed 30-day + all-time `Order` aggregates; the `_sum` dollar figure is only included in the Prisma query at all when the caller has `REVENUE_VIEW`, so it never reaches the component tree otherwise — not just hidden in the UI) and `getRecentActivity` (last 20 `ExecutionLog` rows for the store, row-capped not date-windowed, across every action type).
- **`needsAttention.ts`** — two distinct signal kinds, never blended: recent negative outcomes (`FAILED`/`WARNING` rows, 7-day window, plus stale `PENDING` handoffs >1hr old — correctly excluding any row later resolved under the same `executionId`, respecting the append-only design) vs. direct business-state checks (unpublished, zero active products, no connected payment method — pure, reuses data already fetched, no new queries).
- **`recommendations.ts`** — a **producer pattern**: `RecommendationProducer { name, produce(ctx) }`, each pure (never sees another producer's output); `getRecommendations()` alone merges/dedupes (by `Recommendation.id`, a stable string like `recommend.publish_store`)/sorts by priority. One producer ships today (`ruleBasedProducer`, deterministic heuristics over data the other modules already computed — zero added latency or cost). A future Genesis-generated producer (PH-07) is a new array entry, not a rewrite of dashboard logic.
- **`customers.ts`** / **`inventory.ts`** — derived views, no new models. Customers come from `Order.buyerEmail` grouping (no `Customer` entity exists); inventory is an honest active/inactive product count (no `Product.stockQuantity` exists, and none was invented to make this section look more complete than the schema actually is).

**Orders are surfaced by querying `Order` directly, not by adding checkout events to `ExecutionLog`** — a deliberate scope boundary: the Stripe webhook stays untouched (see *Integration Framework* above), so the Activity Feed only ever reflects store-management actions (see below) plus integration/Genesis events, never checkout events.

**CRUD retrofit**: as of this phase, `createProduct`/`editProduct`/`deleteProduct`/`toggleProductActive`/`editStore` also route through `execute()` (`lib/execution/executables/{products,storeEdit}.ts`), so the Activity Feed reflects real day-to-day store management, not just publish/Stripe/Genesis events. Deliberately bounded: storefront actions (checkout, newsletter) and the webhook were not retrofitted.

**Permissions, first real use of three PH-01-reserved constants**: `ORDERS_VIEW` gates Order Summary counts and the Customers list; `REVENUE_VIEW` additionally gates the dollar figures within those same sections (Employees have `ORDERS_VIEW` but not `REVENUE_VIEW` — an existing PH-01 distinction this phase honors rather than flattens); `ANALYTICS_VIEW` gates Recommendations. Activity Feed and Attention Panel are gated `STORE_MANAGE` (Owner-only) for now — **not architecturally permanent**: `ActivityItem.action` already carries enough to filter by row type later (e.g. show `product.*` to `PRODUCTS_MANAGE` holders while still hiding `integration.*`/`store.edit`), a page.tsx-level rendering change whenever wanted, not a query or schema change.

**Layout order is urgency before history, not a data-source reading order**: Attention → Recommendations → Activity → Business snapshot (Order Summary + Customers + Inventory). People address problems, then decide what to do, then review history, then check the broader picture.

**Genesis Intelligence, Layer 2 (PH-07): AI explanations of recommendations.** Per the user's explicit staged rollout for PH-07 — rule-based intelligence, then AI *explains* the rules, then AI *generates* its own recommendations, then AI *acts with approval* — this is layer 2. `RECOMMENDATION_MESSAGES` (`lib/dashboard/recommendations.ts`) holds the 6 rule-based recommendation strings as one exported map keyed by `Recommendation.id`; `ruleBasedProducer` reads from it instead of duplicating literals. `lib/dashboard/explainRecommendation.ts`'s `getRecommendationExplanation({recommendationId, storeId?, storeName})` resolves the message to explain from that same map — a client can select *which* known id to explain but never supply *what* gets explained — and returns a typed `{explanation: string}`, not a bare string, leaving room for future fields. This is deliberately **not** a second `RecommendationProducer`: PH-05's producer-purity rule exists for independent recommendation *generation*; narrating an already-decided recommendation is a transformation over existing output, a standalone on-demand enrichment step outside `getRecommendations()` entirely. It's also the first minimal-schema Anthropic call in the codebase and deliberately lighter than every other call site (`max_tokens: 1024`, `output_config.effort: "low"` vs. the uniform `16000`/`"high"` used everywhere else in `ai-actions.ts`) — the system prompt explicitly instructs the model not to propose new or different recommendations, only explain the one it's given, so this call can never become a backdoor around the rule-based producer. Triggered on-demand only (a "✨ Ask Genesis" pill button, styled like the Genesis chat launcher, in each recommendation's action column) — no eager call on dashboard load, no caching yet, but the service is a single pure function specifically so caching can wrap it later without touching the server action or UI. No `ExecutionLog` row — not a mutation with an outcome to verify. This pill only renders for `Recommendation.source === "rules"` — see Layer 3 below for why.

**Genesis Intelligence, Layer 3 (PH-07): AI-generated recommendations.** Unlike Layer 2 (narrates an existing rule, never proposes), Layer 3 genuinely proposes new recommendations from the store's real business data — exactly the independent-generation case `RecommendationProducer` was designed for since PH-05. `genesisProducer` (`lib/dashboard/recommendations.ts`) is a second producer alongside `ruleBasedProducer` (both are `getRecommendations()`'s default), reading `CognitiveOutput` rows (`kind: "recommendation" | "opportunity"`) rather than calling Claude itself, so it's safe on every dashboard load at zero added latency or cost — same shape as originally built, though the underlying store changed. **Superseded, not still accurate as originally written**: `generateGenesisRecommendations.ts`/`GeneratedRecommendation` (the table this paragraph originally described) no longer exist — that pipeline was relocated and rewritten as `runCognitiveReview()`/`CognitiveOutput` during the J4 Cognitive Layer work (see *J4 Cognitive Architecture — Reason* above), keeping the same "explicit 'Ask Genesis to Review My Business' button, no background/cron regeneration" trigger model and the same "replace the prior batch, don't accumulate" convention (now `status` transitions on `CognitiveOutput` rather than a delete-then-recreate transaction), but with the richer lifecycle/schema described in that section. There is no background/cron infrastructure for this specific trigger — real cron infrastructure exists elsewhere now (`lib/intelligence/scheduler.ts`, see *Business Intelligence Engine* above), but review-on-schedule is `runOpportunisticAiReviewIfStale`'s own staleness-gated concern, not this button's.

`RecommendationContext` was extended for this layer with `storeId`, `storeName`, a richer `products` shape (names/prices, not just active flags), `customerSummaries`, `inventorySnapshot`, `recentActivity`, and a minimal `Store.blueprint` subset (brand voice/personality, hero headline, about copy) — all of it already fetched elsewhere on every dashboard load for the Owner, so this is zero new queries, only a larger prompt available to whichever producer wants it; `ruleBasedProducer` simply ignores what it doesn't use. `generateGenesisRecommendations.ts` can't import `ai-actions.ts`'s full `Blueprint` type (a file with `"use server"` may only export async functions), so it defines its own small local subset and reads `store.blueprint` as loosely-typed JSON — the same opaque-JSON-cast-at-read-site pattern `ai-actions.ts` itself uses.

**The core design requirement for this layer, stated explicitly by the user**: recommendations must be grounded in the actual supplied business data, prioritized by real impact, not padded to fill a count — if the data doesn't support a specific recommendation, Genesis should say less, including nothing, rather than invent generic advice. Enforced via the system prompt (an explicit "prioritize impact over count... return fewer, including zero" instruction) and a bounded, constrained output schema (`max(4)` recommendations, `actionHref` restricted to a closed enum of the four real in-page anchors — never a free-form or invented link). The rule-based/Genesis boundary is held the same way, not via shared live data: the prompt lists what the deterministic system already flags (unpublished store, zero products, no payment method, stale connections, recent failures, zero orders) as static text, so Genesis avoids duplicating it without violating "no producer sees another producer's output."

**Genesis Intelligence, Layer 4 (PH-07): Approval & Execution Framework.** The final layer — Genesis stops only advising and starts *acting*, under explicit owner approval. Built as a **generic framework, not a feature**, per explicit user direction: any current or future Genesis capability plugs into one `Recommendation → Approval Request → Execute → Verify → Record Result → Report Outcome` lifecycle, the same way `RecommendationProducer` let any recommendation source plug into `getRecommendations()` without a rewrite.

The key finding that shaped this layer: PH-03's `execute()`/`Executable` machinery already implements "Execute → Verify → Record Result" completely — permission checks, optional `verify()`, and one append-only `ExecutionLog` write all already existed. What was missing was the piece *before* execution: a persisted approval gate. That gate — the new `ApprovalRequest` model (`prisma/schema.prisma`) — is the only genuinely new system this layer builds; `execute()` itself needed only one addition (the `PARTIAL` status, see *Execution & Verification Engine* above).

`ApprovalRequest` is deliberately generic, not recommendation-specific — explicit user instruction: *"Don't make this section specific to recommendations... later it'll hold marketing campaigns, product edits, homepage redesigns, social posts, inventory changes, booking changes."* `recommendationId` is a loose, optional reference (no FK — a hard one would risk an in-flight approval being cascade-deleted if the merchant refreshes recommendations mid-review) — a recommendation is only ever *one possible originator*, never a required one. Three statuses: `PENDING_APPROVAL`, `EXECUTED`, `REJECTED`. Approving and executing collapse into one state since the flow is synchronous (`execute()` never throws past its own boundary); the actual outcome quality lives on the linked `ExecutionLog` row via `executionId`, not duplicated on `ApprovalRequest`. **No `ExecutionLog` row is written at proposal or rejection time** — `ExecutionLog` represents things actually executed, and a proposal awaiting (or declined) a decision never was, which keeps PH-05's `getStaleExecutions` PENDING-row logic completely untouched.

`lib/execution/genesisActions.ts`'s `GENESIS_ACTIONS` registry is the plug-in point: any `Executable` becomes approvable by Genesis just by being registered (paired with a Zod `inputSchema` and a `getCurrentValues` function for the diff), with **zero changes to the `Executable` contract itself**. The two concrete actions this layer ships — `updateSeoExecutable` and `updateHeroExecutable` (`lib/execution/executables/`), targeting `Store.blueprint.marketingAssets` and `.homepageContent` respectively — are ordinary `Executable`s, structurally identical to `editStoreExecutable` (derive everything from `ctx.storeId`, no caller pre-fetch needed) and know nothing about `ApprovalRequest`, recommendations, or Genesis; either could be called via plain `execute()` from a future non-AI form with zero changes. Building two, not one, was a deliberate choice — proving the registry generalizes across two different blueprint sections with no special-casing between them.

**A fresh review supersedes, rather than accumulates alongside, any earlier still-pending proposal of the same action type.** `generateGenesisRecommendations()` (today: `runCognitiveReview()`, same behavior, see *J4 Cognitive Architecture — Reason* above) clears existing `PENDING_APPROVAL` `ApprovalRequest` rows for a given `(storeId, actionType)` immediately before creating a new one of that type — found necessary via real usage, not anticipated in the original design: two "Ask Genesis to Review My Business" runs on the same store otherwise produced two independent pending proposals for the same action instead of the second replacing the first. Only `PENDING_APPROVAL` rows are ever cleared this way; an `EXECUTED` or `REJECTED` row is resolved history and untouched, matching `ExecutionLog`'s own "never rewrite the past" discipline.

**The diff is trustworthy by construction.** Every `ApprovalRequest` shows a current-vs-proposed diff before the owner decides (explicit user reasoning: *"reinforces that Genesis is proposing a specific change, not making mysterious edits behind the scenes"*) — but `previousValues` is computed by code from the real, already-fetched blueprint data via each registry entry's `getCurrentValues`, never from the model's own restatement of what it was shown. `ApprovalRequestsPanel.tsx` renders the diff generically (one row per key in `input`, labeled via `FIELD_LABELS`), not with per-action JSX, so a third registered action needs no UI changes. Positioned as its own **"Awaiting Your Approval"** section between Attention and Recommendations — not folded into the existing Attention Panel, per explicit user reasoning: "something's broken," "something's waiting on your decision," and "here's what happened" are three different mental models that blending would make cognitively messy.

`approveGenesisAction`/`rejectGenesisAction` (`ai-actions.ts`) are plain `redirect`-based Server Actions, same as `reviewBusinessWithGenesis` — real-HTTP-testable via the same bound-action field extraction used throughout the app. Approving calls `execute()` with the registry's `Executable`, so authorization is genuinely two-layered: the page-level `ANALYTICS_VIEW` check only resolves visibility, while `execute()`'s own `requireStorePermission(STORE_MANAGE, ...)` is what actually authorizes the mutation — identical two-layer pattern to every prior phase, not just cosmetic. **Current behavior differs from how this was originally built**: the linked row is no longer deleted on decision — it's the `CognitiveOutput` row now (see *J4 Cognitive Architecture — Reason* above), marked `RESOLVED`/`SUPERSEDED` rather than removed, since `CognitiveOutput` is meant to be durable, queryable history (`getEntityHistory`), not a transient inbox row the way the original `GeneratedRecommendation` table was.

---

## Genesis Language Navigation Propagation

The dashboard shell (`app/dashboard/DashboardShell.tsx`/`layout.tsx`) carries the same 5-state Genesis Language (`idle`/`working`/`needs_decision`/`opportunity`/`urgent`, defined once in `lib/dashboard/genesisState.ts`'s `deriveGenesisState`/`GENESIS_STATE_META`) down through the navigation hierarchy — Genesis → "Your Business" → the owning sub-tab (Brand/Website/Products) → the actual item — rather than stopping at a single flat badge. This is presentation over the same data every other Genesis Language consumer already reads (`ApprovalRequest`, `GenesisObservation`); there is no second notification system.

**Reverse lookup, not a second config.** `layout.tsx` builds a `href → section key` map from the existing `YOUR_BUSINESS_SECTIONS` (`lib/dashboard/navConfig.ts`) and uses it to resolve each `ACTIVE` `GenesisObservation`'s `actionHref` to the Brand/Website/Products tab it belongs to — the same config the secondary nav already renders from, not a hand-written duplicate.

**Per-section state is computed once, in one place, and never independently re-derived by its parent.** Each of the three owned sections gets `{state, count, focusHref}`: `state` follows the same `urgent > needs_decision > opportunity > idle` priority order used everywhere else in this system; `count` sums that section's urgent observations, pending-approval groups, and opportunity observations; `focusHref` points at the single highest-priority item's real `?focus=` link. `sectionNavState.home` ("Your Business"'s own primary-nav badge) is derived purely from those three already-computed children — highest child state wins, counts sum — so parent and child can never disagree. This deliberately narrowed "Your Business" to its own three children only; the pre-existing store-wide pending-approval count (e.g. including a Marketing-only SEO approval) is kept as a separate signal (`sectionBadgeCounts.home`) for the things that still legitimately need a store-wide total (ambient `hasPendingDecision`), not conflated with this badge's meaning.

**One merged focus-resolution list, not a parallel one.** `focusableItems` extends the pre-existing `focusableApprovals` shape with a `kind: "approval" | "observation"` discriminator, so the same `?focus=` deep-linking mechanism resolves both kinds. `GenesisAssistant`'s contextual banner reads that `kind` too: an observation-sourced focus shows only "What I noticed: {summary}" — never a fabricated "What I recommend," since a raw observation has no separate proposed action behind it.

**Overview never owns an item, by construction.** No `ACTION_SECTIONS` entry and no `GenesisObservation` source ever targets plain `/dashboard` — verified by reading every source rather than assumed — so Overview's own nav tab never carries a badge; it only ever aggregates.

**The one per-page display gap this closed**: before this, a Red/Purple `GenesisObservation` had no surface to land on once you followed its badge to a section — only pending `ApprovalRequest`s had one (`ApprovalRequestsPanel`). `app/dashboard/ObservationsPanel.tsx` is the small, read-only counterpart (same `highlightId` convention, no Approve/Reject/dismiss — none exists for observations, resolution is automatic when the underlying condition stops recurring), mounted on Website/Products/Brand alongside — never merged into — the existing approval surface. Approvals and observations stay presented through their own distinct UI on every page that has both, matching the rest of this codebase's "don't force one concept through another's UI" discipline (e.g. `IntegrationConnector` vs. `Executable`, `ApprovalRequest` vs. `ExecutionLog`).

**Overview's own attention block rises to the top only when genuinely warranted.** The existing, already-gated Red/Yellow attention block on Home moved to directly after the Snapshot row (before Business Journey) — the same conditional block relocated, not a new condition or a second copy. When nothing is genuinely pending, the gate is false exactly as before and the page's order is unchanged; Purple recommendations and Recent Orders were not moved.

---

## Family Beta Instrumentation

Product-behavior instrumentation added for the first family beta round, layered entirely on top of the existing product without changing what Genesis does — every write is additive, and a failed instrumentation write can never break the real feature it's attached to (`lib/telemetry/events.ts`'s `logProductEvent` swallows its own errors). Before this, the codebase had zero telemetry of any kind: no middleware, no analytics package, no timing instrumentation, no session-instance concept — confirmed by a dedicated audit, not assumed.

**One new model, `ProductEvent`, not several bespoke tables.** `name`/`category` are plain, freely-growing strings (the same reasoning `EXECUTION_ACTIONS` already uses — the vocabulary grows with every feature, an enum would force a migration each time). `metadata` holds only small, allow-listed structured fields and *references* to other rows' own ids (an `ApprovalRequest.id`, a `StoreMessage.id`) — the real content stays in its own real row and is joined at reconstruction time, never duplicated into this table.

**Attempt/recovery sequences are reconstructed from real, already-meaningful identity — never an invented counter.** `attemptKey` is always something that already means "the same underlying thing" elsewhere in the system: `topicKey`/`groupId`/`actionType` for approvals, `dedupeKey` for observations, a `storeDraftId` for one whole creation journey, or a fixed flow name like `"stripe_connect:{storeId}"` for an integration connect flow. An "entered → attempt 1 → attempt 2 → recovered/abandoned" sequence is just every row sharing one `attemptKey`, ordered by `createdAt` — position in that ordered list *is* the attempt number. Interpretation (e.g. "3+ failed attempts" counts as stuck) happens at query/analysis time; nothing is classified or labeled at write time, so raw behavior is never turned into a premature conclusion.

**`ProductEvent.storeDraftId` is deliberately a loose reference, not a foreign key — the one real bug this phase's own verification caught.** `userId`/`storeId` are real FKs with cascade delete, since neither a `User` nor a `Store` is routinely deleted in normal operation. A `StoreDraft`, by contrast, is deleted as the *normal, successful last step* of `confirmStoreDraft` — not an edge case — so a hard FK there would silently destroy the very creation-journey history this table exists to preserve, and would reject the terminal `creation.confirmed` event's own insert outright (it's written *after* that delete). Fixed to a loose, unconstrained string, the same "might legitimately outlive its referent" reasoning `ApprovalRequest.recommendationId` already uses elsewhere in this codebase. Any future field referencing a row that can be deleted as part of normal, successful product flow (not just error/cleanup paths) should default to this loose-reference pattern, not a cascading FK.

**Session-instance correlation, sized to the beta, not built as general session infrastructure.** `auth.ts`'s `jwt` callback mints a `sessionInstanceId` (random UUID) only in the same `if (user)` branch that already sets `token.id` on real sign-in — never on token refresh. This groups "one sitting" for a small, trusted beta cohort without a session store, a cache, or any new infrastructure; it persists for the JWT's full lifetime (30 days) rather than resetting per browser tab, a stated and accepted tradeoff for this specific use, not a general-purpose session primitive.

**Business Journey's stage logic was extracted, not duplicated, so a real stage transition could become a durable event.** `lib/dashboard/journeyStage.ts`'s `deriveJourneyStage` is the exact same computation `BusinessJourney.tsx` already rendered from, moved out so both the component (unchanged rendering) and `logJourneyStageIfChanged` (a new stage-transition detector, called from an `after()` callback so it never adds latency to Home) read from one source. The detector reads the last `journey.stage_reached` event for the store before writing, so an unchanged stage never re-logs on every page view — this is the one place in the whole instrumentation layer that reads before it writes, specifically to stay a transition log rather than a page-view log.

**The chat rephrase signal is a stated heuristic, never an inference presented as fact.** `findLikelyRephraseOf` compares normalized word sets (Jaccard overlap) between a new chat message and the immediately preceding same-role message within a 10-minute window — deterministic, no embeddings, no AI call. Above a threshold it tags `metadata.likelyRephraseOf` with the prior message's id; below it, nothing is recorded. The field name says "likely" deliberately.

**Known, permanent limitation of this instrumentation, not worked around**: `nav.section_view`, `focus.route_resolved`/`route_unresolved` (`DashboardShell.tsx`), and `perf.action_pending` (`SubmitButton.tsx`'s opt-in `trackPerf`) are client-side `useEffect`s. This project has no headless-browser/screenshot tooling (an existing, already-documented gap), so none of the three can be exercised by a scripted HTTP request the way every server-side event in this layer can — verification for these three is necessarily code review plus a clean `tsc`/`eslint`/`next build`, the same limitation already accepted for `GenesisAssistant`'s Blue "working" indicator.

**`SubmitButton.tsx`'s `trackPerf` prop is opt-in and `undefined` by default** specifically because this one component is shared with the public storefront's own checkout/newsletter buttons — an unconditional perceived-loading measurement would have quietly started instrumenting real customers on a beta tester's demo store, well outside this phase's scope (testers using the Genesis dashboard, not their own storefront's visitors).

---

## AI orchestration / store generation pipeline

All generation and chat go through the Anthropic SDK (`app/dashboard/ai-actions.ts`) using structured outputs (Zod schemas + `zodOutputFormat`), `claude-opus-4-8`, streaming (`messages.stream()` + `.finalMessage()`), `thinking: { type: "adaptive" }`, and `output_config.effort: "high"`.

**The full brand blueprint schema is too large for the API's structured-output grammar compiler in one call** (a real 400 error hit and root-caused during the brand-content milestone, not assumed) — so every generation and chat-driven edit is split into two coordinated calls:
- **PRIMARY**: identity-defining fields — name, tagline, description, theme (including `presentation`, the structural styling driven by brand personality — card/button/shadow/spacing), products, brand identity, homepage content (including AI-chosen `sectionOrder`).
- **SECONDARY**: policies, marketing assets, design direction — generated with PRIMARY's output as context, so the result reads as one coherent brand rather than two disconnected halves.

**Draft-phase chat** (`applyGenesisMessage`) and **live-store chat** (`applyGenesisMessageToStore`) are separate code paths with different scopes — live-store chat deliberately excludes products (real relational data tied to `Order` history, edited through the existing per-product forms instead) and is permission-gated (see *Permissions & Roles*). Both write directly to Prisma rather than going through the human-facing server actions in `dashboard/actions.ts` — a real duplication (diff logic and Prisma writes exist separately per flow), accepted for now rather than unified, since a shared abstraction wasn't obvious without forcing one flow to bend toward the other. Both functions also call `recordGenesisExecution()` (see *Execution & Verification Engine* above) once they finish — applied, declined, pending-confirmation, or failed — so Genesis's own actions appear in the same unified `ExecutionLog` history as human-triggered ones, without any change to the generation/diff logic itself.

**Change tracking is computed, not self-reported.** `diffDraftChanges`/`diffStoreChanges` compute what actually changed by comparing before/after state field-by-field — never trusting the model's own claim of what it did. A real reliability gap was found here: an LLM reproducing an untouched field isn't guaranteed byte-identical, which caused false "X updated" diff entries even when nothing changed. Fixed with per-category `touches*` flags (`touchesIdentity`, `touchesTheme`, `touchesBrandContent`, `touchesProducts`, `touchesSecondaryContent`, plus finer per-field flags on the secondary schema) — the code uses the *existing stored value*, not the model's reproduction, for anything not flagged as actually touched that turn.

**Shared prompt guidance blocks** (reused across all five system prompts that touch the relevant fields, so the rules live in one place): `CALIBRATION_GUIDANCE` (distinguish facts from assumptions from recommendations — never state a guess with the same confidence as a verified fact), `PRESENTATION_GUIDANCE` (how brand personality maps to structural styling), `HOMEPAGE_STRUCTURE_GUIDANCE` (how to choose homepage section order per business type), `BRAND_PROMISE_GUIDANCE`.

**"Your Store's Vision"** is a permanent, store-lifetime history, not a draft-only feature — `StoreGeneration` rows get re-pointed from a `StoreDraft` to the real `Store` at confirmation time (`storeDraftId` cleared, `storeId` set) so history survives the draft being deleted. Milestones (`"original"`, `"first_refined"`) are tagged on specific generations so the UI can surface a curated 3-card view without losing full history.

---

## Database model

Prisma 7 with the driver-adapter pattern (`@prisma/adapter-pg`'s `PrismaPg`, connection string passed to the *adapter*, not `datasource` in `schema.prisma` — a breaking change from pre-7 Prisma; see `prisma.config.ts`).

**Core**: `User`, `Account`/`Session`/`VerificationToken` (NextAuth), `Store`, `Product`, `Order`.

**Pre-launch flow**: `StoreDraft` (one per user, unique `userId`) with parallel structures to `Store` (`theme`, `blueprint`, `productsDraft` as Json rather than relational rows, since nothing is real until confirmed), `StoreDraftMessage` (chat history), `StoreGeneration` (version history, shared between draft and live phases via the dual-nullable `storeDraftId`/`storeId` re-pointing pattern above).

**Live store**: `StoreMessage` (live-store chat history, parallel to `StoreDraftMessage`), `NewsletterSignup`.

**Access control**: `StoreMember` (Employee role attachments — see *Permissions & Roles*).

**External connections**: `StoreIntegration` (see *Integration Framework*).

**Execution history**: `ExecutionLog` — append-only, `storeId`/`storeDraftId` both optional (same dual-phase pattern as `StoreGeneration`) — see *Execution & Verification Engine*.

**Product-behavior instrumentation**: `ProductEvent` (Family Beta — see *Family Beta Instrumentation* above), append-only, `userId`/`storeId` real cascading FKs but `storeDraftId` a deliberately loose, unconstrained reference (a `StoreDraft` is routinely deleted as part of normal, successful confirmation — a hard FK there would destroy or reject the very events meant to survive it).

**Genesis proactivity, learning, and authority** (the "Genesis operates the business" pivot, Phases 4–6 — see `CHANGELOG.md`'s condensed pivot entry): `GenesisObservation` (Phase 4 — durable "Genesis noticed this," deduplicated by `dedupeKey`), `PostExecutionMeasurement` (Phase 5 — deterministic before/after `Order` data for one `EXECUTED` `ApprovalRequest`, never a causal/attribution claim), `DelegatedAuthority` (Phase 6 — see *Delegated Authority* above). `ApprovalRequest` itself gained `groupId`, `topicKey`, `decisionMode`, and `delegatedAuthorityId` across these same phases, additively.

**J4 Cognitive Architecture** (see the dedicated section above for the subsystem each belongs to): `BusinessRecord` (Understand's canonical entity storage — one generic, polymorphic table for every registered entity type and source), `BusinessEvent` (Understand's append-only fact log, produced by Change Detection), `CognitiveOutput` (Execute's durable record of every finding Reason has ever communicated — `kind`/`status`/`recordId`/`topicKey`/`relatedOutputIds`, superseded `GeneratedRecommendation`, see *Owner Dashboard*'s Layer 3 note above), `Belief` (Learn's own durable store — `confidence`/`evidenceCount`/`firstObservedAt`/`lastConfirmedAt`/`lastContradictedAt` tracked as genuinely separate fields, no stored maturity "stage"). `ApprovalRequest` gained `cognitiveOutputId` (parallel to, not replacing, `recommendationId`) and `authorizationTier` across this same work.

Most AI-generated content lives in `Json` columns (`Store.blueprint`, `Product.richContent`, etc.) rather than fully normalized tables — a deliberate choice verified to pay off: the entire brand-model expansion and the entire presentation-styling system were added with **zero Prisma migrations**, because the content shape could evolve inside existing Json columns. Migrations were only needed for genuinely new *relational* concepts (roles, integrations, newsletter signups) — a useful signal for where to draw that line on future schema decisions.

**Production migrations ARE part of the build. There is no gate.** Corrected 2026-09-01 — this paragraph said the opposite, and had said it since 2026-08-13.

`package.json`'s `build` script is `node scripts/migrate-deploy.mjs && next build`. The first half runs `prisma migrate deploy` against whatever `DATABASE_URL` is set, and `scripts/migrate-deploy.mjs` contains no environment check of any kind — so **every push that triggers a build applies every pending migration to production, with no review step**. This is stated correctly a few hundred lines above, under *The rule*, which is what made this the worst kind of documentation error: the same document disagreed with itself, and the wrong half was the reassuring one.

The gate did exist. It was removed on 2026-08-01, reinstated, and reversed again on 2026-08-13; this paragraph was written during the window when it was true and never updated. `DEPLOYMENT.md` carries the same correction with the build log that settles it, and `EXTERNAL_BLOCKERS.md` E6 tracks whether the gate comes back as a decision that is Sean's to make.

**The safe order in `DEPLOYMENT.md` is still the right procedure** — write the migration, read the generated SQL, apply it deliberately, then deploy the dependent code. What changed is that following it is now a discipline rather than something the tooling enforces.

Production Postgres is Neon (`Launch` plan) with automatic point-in-time recovery — up to 7 days, on by default. That is a real safety net for *recovering* from a bad migration and not a substitute for a gate that stops one landing. It is also, until `npm run verify:restore` is run against a real branch, a safety net **nobody has tested**.

---

## API design

**Current state: not API-first.** Nearly all mutation logic lives in Next.js Server Actions (`"use server"` files), called directly from Server/Client Components — there is no general-purpose REST or RPC API surface today, beyond the few Route Handlers that exist for things Server Actions can't do (Stripe webhooks, the OAuth callback route). This means the current backend could not cleanly power a future mobile app or voice client without real rework.

This is a known, tracked gap — PH-04 on the roadmap ("API Architecture") exists specifically to establish conventions so new work exposes a clean API surface going forward, applied starting with whichever phase is active when PH-04 lands, not retrofitted after the fact. Until then, treat "API-first" as aspirational for *new* code, not yet true of the codebase as a whole.

**Conventions already in real, consistent use** (documented here during PH-06 as PH-04's first concrete artifact — not a rewrite, just writing down what's already true):
- **Server Actions** (`"use server"` files): failure is a plain thrown `Error` with a user-facing message (validation, not-found); success is `redirect()`. No action ever returns a value its caller reads directly.
- **`execute()`-wrapped actions** (`lib/execution/engine.ts`): the same throw/redirect contract from the outside — `execute()` never lets an error escape uncaught, it's swallowed into a `FAILED` `ExecutionResult` and persisted, then the wrapping Server Action still redirects. Callers that need the *result* (e.g. `connectStripe` checking `result.redirectUrl`) read it directly off `execute()`'s return value in the same function, never across a request boundary.
- **Route Handlers** (webhooks, OAuth/return callbacks): always return a real HTTP response — `200`/`400`/`422` with a plain string body for webhooks (Stripe/PayPal both expect this), or a `redirect()` to a real page for browser-facing callbacks (OAuth callback, PayPal return). Never a JSON API response shape, since none of these are called by our own frontend code.

---

## Frontend architecture

Next.js App Router, Server Components by default. Client Components are the exception, used only where real interactivity is needed: `SubmitButton` (shared `useFormStatus`-based pending-state button), `GenesisAssistant` (the chat widget, needs open/closed state), `DeleteProductButton` (confirmation state).

**Two different theming treatments, by design, not inconsistency**: the public storefront (`app/store/[slug]/`) gets *full* brand theming — colors, fonts, and structural presentation (card/button/shadow/spacing) all driven by the generated theme, via CSS custom properties (`lib/theme.ts`'s `themeCssVars`) and dynamic Google Fonts loading. The merchant-facing workspace (`app/dashboard/`) gets deliberately *light* accent theming only (an accent-tinted header, a monogram avatar, the generated heading font, accent-colored primary buttons) — body text, form inputs, and card backgrounds stay neutral regardless of the generated palette, specifically because AI-generated colors are tuned for storefront hero sections, not dense admin forms, and the workspace must stay readable no matter what palette gets generated. This was an explicit user decision (a "light touch" vs. "full immersive" tradeoff), not an oversight.

The storefront's homepage section order (hero fixed first, footer fixed last, everything between chosen by Genesis per business type) is reconciled in code, not trusted blindly from the model — `resolveSectionOrder` (`app/store/[slug]/shared.tsx`) guarantees `customSection` and `sectionOrder` stay consistent even when the model doesn't keep them in sync itself (a real, verified reliability gap, not a hypothetical one).
