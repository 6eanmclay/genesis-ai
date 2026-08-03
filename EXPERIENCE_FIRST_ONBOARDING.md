# Experience-First Onboarding — amending the entry point

**Status: Frozen — v1. Approved by Sean, 2026-08-03.** Real learning from real users (Sean's mother and sister, independently) drove this — the exact bar `GENESIS_EXPERIENCE.md` itself set for revising it. Implementation begins next; further onboarding changes should wait until this ships and is verified with real users, not stack on top of an unbuilt design.

This document amends `GENESIS_EXPERIENCE.md`'s entry point. That document is frozen, with an explicit bar for changing it: *"a change earns its way in only by something real learned from building or observing actual users."* This clears that bar — it's a direct response to watching a real first-time user (Sean's mother) encounter a guided flow that assumed she already understood how Genesis worked.

## Why

**Genesis should never ask the user to commit before it has demonstrated value.**

Everything else in this document is downstream of that one sentence.

Today's real entry sequence: landing page → create an account → log in → dashboard → *then* the reference screen ("What's the business you've been meaning to start?"). A signup wall before any value has been shown.

The reframe: **the owner isn't creating a business yet — they're experiencing Genesis. The account is what turns that experience into a business they own.** Instead of asking "would you like to create an account?", the moment becomes "would you like to keep the business we just built together?" — a far easier decision, because there's already something real to keep. People aren't signing up for software; they're deciding to keep something Genesis already created with them.

```
Today:  Visitor → Account → Build Business
New:    Visitor → Experience Business → Decide → Account → Make It Real
```

New sequence — the **experience flow** (anonymous, no account, this document's real subject):
1. Open Genesis. "Tell me your business idea."
2. Genesis attempts to create something immediately from whatever's given. Only if confidence is genuinely low, or one specific answer would materially improve the result, does it ask **one** concise follow-up question — never an interview.
3. Genesis generates: business identity, creative direction, logo (generated or uploaded), a first product concept, a storefront preview, and an estimated price.
4. The owner sees the real result.
5. Only then, having earned it: **"Would you like to make this real?"**

The goal for steps 1–4 is momentum, not information. "The goal isn't maximum information. The goal is maximum momentum" (Sean's own framing) — if Genesis already has enough to create something exciting, it stops asking and starts building.

## A platform principle, not a website feature

The experience flow is not "what the website does before signup." It's **the first experience every brand-new Genesis user has, regardless of surface** — today's web, and the J4 app once it exists (`J4_APP_ROADMAP.md`). The real distinction is new vs. returning, not web vs. app: a new visitor experiences Genesis first, on whichever surface they arrive from; a returning user simply signs in. Any future entry point inherits this same shape by default, not as something to re-decide per-surface.

## The activation flow — not replaced, repositioned

Everything already built this session — account creation, real Printful connection, real Stripe connection, real product materialization, real publish — turns out to already be the right thing, just starting at the wrong moment. Renamed here, precisely, so future conversations don't conflate the two: that's the **activation flow**. It doesn't change. What changes is when it starts — after "would you like to make this real?" instead of before anything has been shown. The experience flow hands the activation flow an already-claimed, already-real-feeling draft instead of a blank one.

## Anonymous session ownership — confirmed: signed session token, no shadow User

No database `User` row gets created until real signup. A new `StoreDraft.anonymousSessionToken` (nullable, alongside the existing nullable-in-spirit `userId` relationship — `userId` becomes genuinely optional at the schema level for this phase) holds a signed, opaque token issued via an httpOnly cookie on first visit. Every anonymous action (submit idea, answer the one clarifying question, generate directions) is scoped to that token instead of a `userId`, mirroring the exact same shape `getOrCreateDraft`/`persistState` already use today — just keyed differently.

**Claiming**, at real signup: the `StoreDraft` matching the caller's anonymous session token gets `userId` set to the newly created real user, and the anonymous token is invalidated. No data migration, no re-generation — the exact same row just gains a real owner. This is a small, mechanical addition to the existing signup flow, not a rewrite of it.

## Deferred fulfillment — what's real vs. estimated before signup

The anonymous phase generates real business identity, real artwork (the exact same generation pipeline Creative Direction already built — `generateCreativeDirections`/`submitUploadedArtwork`, unchanged), and a **real, not heuristic, price estimate** — which requires one new thing: a **platform-level Printful credential**, used only for browsing the shared public catalog and cost data (not merchant-specific — every Printful account sees the same catalog), separate from any individual merchant's own OAuth connection. This is a new owner action (register or reuse a Printful account for exactly this purpose) — flagging it now since it wasn't needed for anything built so far.

The storefront preview during this phase reuses the real `/store/[slug]` route and rendering — same "never a mockup" principle Creative Direction already proved — but its access check (`getStoreRole` in `app/store/[slug]/page.tsx`) needs a small, real extension: accept a valid anonymous session token that matches the `Store`'s originating draft as an equally valid access grant, alongside the existing real-user check. A Store row *can* exist at this stage (unpublished, no real fulfillment or payment connected) — what's deferred is specifically the *external, merchant-identity-requiring* connections: real Printful order/product registration and Stripe/PayPal both wait for the real account.

At "let's make this real" (signup): claim the draft, then hand off directly into the activation flow's existing `fulfillment_connect` → `creative_product_building` → real materialization sequence — unmodified, just now starting from an already-claimed draft instead of a blank one.

## Abuse protection

Anonymous sessions are a real, if smaller, AI cost surface with no account to attribute or throttle against today. Reuses the existing cost-governance shape (`GenesisModelScope`, `lib/genesisModel.ts`) rather than inventing a new mechanism — extended to accept an anonymous session token as a third valid scope alongside `{storeId}`/`{userId}`, with real, deliberately tighter limits (a handful of generations per session, not the normal per-account daily budget). Once an account is created, normal platform limits take over — this is explicitly "an experience, not a free production account," in Sean's words.

## Bounded dynamic questioning

Not an open-ended interview, and not fully agentic either — a bounded extension of the generation call that already exists. The initial idea (plus any brand-positioning signal already present) goes into the same generation call Creative Direction already uses, with one addition: the model also outputs whether it has enough signal to produce something genuinely good, and if not, exactly one concrete, high-value question to ask (audience, style, "do you already have a logo"). If confident, it skips straight to generating. At most one follow-up round in the ordinary case; the model isn't given room to chain multiple questions.

**The tiebreaker, explicitly**: when it's genuinely close, Genesis should make a reasonable assumption and keep moving rather than ask. A wrong assumption costs one "actually, make the logo bolder"-style refinement after the reveal; an unnecessary question costs momentum, which is the entire thing being sold in this flow. The goal isn't maximum information — it's maximum excitement.

## What this reuses vs. what's genuinely new

**The activation flow is not replaced.** Account creation, real Printful connection, real Stripe connection, real product materialization, real publish — all of it, unmodified, just starting later than it does today.

**Reused unchanged, just relocated**: the entire Creative Direction generation pipeline (three directions, upload path, theme generation, real Printful blank selection, real Store/Product materialization) that already runs inside the activation flow — the experience flow calls the same real generation logic, earlier, anonymously.

**Genuinely new**: the experience flow itself — anonymous session tokens and draft-claiming; the platform-level Printful catalog credential; anonymous-scoped rate limiting; the confidence/one-question generation extension; the storefront preview's access-check extension; a new landing experience replacing today's marketing page entirely.

## What comes next (not this document's scope)

Once this ships and is verified with real users, the next milestone is deliberately not more onboarding surface — it's validating that J4 can actually reason about a real, already-operating business (explain its own branding decisions, answer questions about products/storefronts, make grounded recommendations, remember context appropriately) using the Cognitive Architecture already built. Intelligence, not interface. Its own document when that begins.

## Resolved at freeze

Pricing during the experience flow ships as an honestly-labeled **estimate** for v1 — no platform-level Printful credential required to start building. The real, per-blank catalog cost lookup (via each merchant's own connection, already built in the activation flow) becomes the fast-follow that replaces the estimate with a real number once this ships and is proven. Rate-limiting: a simple session/IP-based limit for v1, no elaborate abuse system — real numbers decided during implementation.

No open questions remain. Implementation planning begins next.
