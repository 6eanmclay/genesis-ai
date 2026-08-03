# J4 Mobile App — Implementation Roadmap

**Status: Frozen — v1. Approved by Sean, 2026-08-03.** This is the sequencing/architecture/ownership document for taking J4 from nothing to a real, live app on the App Store and Google Play — same permanence discipline as `GENESIS_EXPERIENCE.md` and `COLLABORATIVE_WORKSPACE.md`. A change earns its way in by something real learned from actually building or observing beta users, not continued polishing.

This roadmap deliberately does not try to build everything `COLLABORATIVE_WORKSPACE.md` describes. It builds the smallest real version of J4 — genuinely talking to your business partner from your phone — while making sure nothing built now has to be thrown away when Shared Context, voice, and meetings arrive later.

## This is not Genesis on a smaller screen — it's J4

**We are not building a mobile version of the dashboard. We are building J4.**

The website is Genesis — the operational workspace, where the business is *managed*: products, analytics, orders, the storefront itself. The app is where the owner *relates to* J4 — meetings, conversation, notifications, approvals, strategy, and eventually Shared Context and Collaborative Workspace.

This is the exact same standing bar `COLLABORATIVE_WORKSPACE.md` already froze — *"does this expand the relationship, or just add another dashboard feature?"* — applied here as the literal filter for every milestone below: **if a capability is fundamentally about managing the business, it belongs on the website, full stop, even if it would technically fit on a phone screen.** If it's fundamentally about the owner's ongoing relationship with their partner, it belongs here, even in its very first, smallest form.

The concrete risk this guards against: `BusinessEvent`/`CognitiveOutput`/`ApprovalRequest` are real, existing data the dashboard already renders as feeds and lists. It would be technically easy — and philosophically wrong — to port those same list views to a phone screen and call it "the app." M3 below is written to explicitly avoid that; see its own note.

## J4 is proactive — the relationship starts conversations, not alerts

**J4 doesn't wait to be asked.** The owner can talk to J4 anytime, but J4 also knows when it's appropriate to start the conversation itself — a daily meeting, a real sales drop worth reviewing, a stalled setup step, a finished product ready to publish, low inventory. In Sean's own words, every one of these should read like a partner speaking, never like software generating an alert:

> "Good morning. Ready for our daily meeting?"
> "I noticed yesterday's sales dropped 18%. I'd like to review three possible reasons."
> "We're still waiting to connect Stripe. It'll only take about a minute."
> "Your hoodie version is ready if you'd like me to publish it."
> "Your inventory is getting low."

This is not a new mechanism to invent — it's the real payoff of M4 (push notifications) built correctly instead of generically. The underlying triggers already exist (`GenesisObservation`, `CognitiveOutput`, stalled-setup checks already powering the dashboard's own "Needs your attention" panel) — what changes is the **voice**: a push notification's copy is J4 speaking in first person about something specific and real, not a generic "You have a new notification" that opens onto a list. This is the same discipline as M3's rewrite above — the data already exists; the failure mode to guard against is presenting it like software instead of like a partner. Every notification and every proactive conversation-starter should be written and reviewed against this bar before M4 is called done, the same way copy has been reviewed throughout `GENESIS_EXPERIENCE.md`'s screens all along.

---

## 0. Framework recommendation

**React Native via Expo**, not Flutter, not bare React Native, not fully native Swift/Kotlin.

Why this specific choice, not just "React Native in general":
- Every engineer on this project already thinks in TypeScript/React — that transfers directly. Flutter would mean learning Dart and a different component model from zero.
- **Expo's managed tooling exists specifically to absorb the parts you said you know nothing about.** `EAS Build` handles code signing and provisioning in the cloud — you don't need Xcode certificate wizardry on your own machine. `EAS Submit` automates the actual upload to App Store Connect and Play Console. `EAS Update` can ship JavaScript-only fixes to everyone's phone without waiting for a new App Store review, which matters a lot during beta.
- **Real, honest tradeoff to name now, not discover later**: Expo's managed workflow covers the large majority of what J4 needs (chat UI, push notifications, secure token storage, camera/photo picker for future artwork upload parity). If a future capability needs something genuinely exotic at the native layer (e.g. custom real-time audio processing for voice), Expo supports "config plugins" and a custom dev client to add native code without leaving Expo entirely — it's not a wall, but it is a real seam worth knowing exists.

---

## 1. Owner actions (Sean)

Everything here requires your identity, your payment, or your legal signature — I cannot do any of it for you, but I'll tell you exactly what to click when you get there, the same way we handled Stripe/Printful/Sentry.

### 1a. Apple
1. **Apple Developer Program enrollment** — currently $99/year (confirm current pricing when you get there, Apple adjusts this occasionally). Needs a real Apple ID. **Real decision before you start**: enroll as an **Individual** (fast, your own name shown as the developer) or as an **Organization** (shows "Genesis AI" as the developer, but requires a D-U-N-S number — a real business identity lookup that can itself take several business days if Genesis AI doesn't already have one). Given the timeline impact, this is worth deciding first — I'd start the D-U-N-S lookup immediately if you want the Organization path, since it can be the single slowest step in this entire roadmap and everything else can run while it's pending.
2. **App Store Connect** — once enrolled, register the app's bundle identifier and reserve the app name (iOS app names are globally unique — worth checking early whether "J4" alone is available, or whether it needs to be "J4 by Genesis" or similar).
3. **App Privacy questionnaire** ("nutrition label") — a real, detailed disclosure of what data the app collects. Given J4 handles real business and financial data, this needs honest, specific answers, not boilerplate — I'll help you draft accurate answers once the API surface is defined, but you're the one who submits it.
4. **Age rating and export compliance questionnaires** — standard for any app using HTTPS; usually qualifies for the standard encryption exemption, but the declaration itself is yours to make.
5. **APNs (push notification) key** — generated in the Apple Developer portal, tied to your account. I'll tell you exactly which screen and button.
6. **TestFlight testers** — add yourself and anyone else (your mother, for instance) by their real Apple ID email once we have a build to test.

### 1b. Google
1. **Google Play Console registration** — currently a one-time $25 fee. Real identity verification is required and Google has been tightening this over time (sometimes requesting a real ID/organization documents) — worth starting early in case it takes a review cycle.
2. **Play Console app record** — package name registration (Android's equivalent of the bundle ID).
3. **Data Safety form** — Google's equivalent of Apple's privacy nutrition label. Same honesty requirement.
4. **Content rating questionnaire** (IARC) — a real, short questionnaire Google requires before public listing.
5. **Internal Testing track testers** — added by Google account email, same idea as TestFlight.

### 1c. Shared across both
1. **App icon and screenshots** — real assets in exact required pixel dimensions per device size. I can generate draft creative directions the same way we did for storefront artwork, but final art direction is yours.
2. **Privacy policy and support URLs** — both stores require live, real URLs. `/privacy` already exists; worth confirming it's reachable from a real custom domain rather than the `vercel.app` subdomain before submission — this ties into the custom-domain item still open from the Beta Readiness roadmap.
3. **Google Cloud Console — mobile OAuth client** — Google Sign-In on a native app needs its own OAuth client registration (separate from the web one already configured), created in the same Google Cloud project. I'll walk you through the exact screen.

---

## 2. Engineering actions (me)

### Repository structure — a real decision, not a default

**Option A — separate repo** (`genesis-j4-app`), talking to the existing backend over the API layer below. Fully independent release cadence (mobile app store review cycles are days-to-weeks; the web app deploys continuously) — no risk of mobile work destabilizing the live production web app.

**Option B — monorepo** (Turborepo or pnpm workspaces), `apps/web` + `apps/mobile` + `packages/shared` for types genuinely used by both (`ApprovalRequest`, `StoreMessage`, `CreativeDirectionOption`, etc.). Real type-sharing value, but migrating the *existing, live, production* Next.js app into a monorepo shape is itself a nontrivial, real-risk refactor of something currently working.

**Recommendation: start with Option A.** Duplicate the handful of shared types by hand for now (they're small and stable) rather than taking on a monorepo migration of the production web app at the same time as starting a brand-new mobile project. Revisit the monorepo question once the mobile app is real and the amount of duplicated logic actually starts to hurt — a real "rule of three" call, not a guess.

### The two real architectural gaps — these need solving before any screen gets built

**Gap 1 — Server Actions don't reach a native app.** Nearly everything in the web app today (`app/onboarding/actions.ts`, `app/dashboard/actions.ts`, etc.) is a Next.js Server Action — tightly bound to the App Router's RSC protocol, not callable from an external client. The mobile app needs a real, versioned HTTP API surface. The codebase already has the *pattern* for this (`app/api/*` Route Handlers already exist for webhooks/OAuth callbacks), just not a general-purpose one yet. Build this **incrementally, scoped to what the MVP milestones below actually need** — not a sweeping "convert everything to an API" rewrite. Concretely, a small `app/api/mobile/v1/*` surface wrapping the *same* underlying logic (the Execution Engine, chat, `ApprovalRequest` queries) Server Actions already call — the business logic doesn't get rewritten, just given a second, HTTP-reachable entry point.

**Gap 2 — Shared authentication.** `auth.ts` uses NextAuth with JWT-strategy sessions delivered via browser cookies — not directly usable by a native client. The real fix: a small `app/api/mobile/auth/{login,refresh,logout}` set of endpoints reusing the *exact same* credential-verification logic already in `auth.ts`'s `authorize()` callback (extracted into a shared function, not duplicated), returning a JSON access/refresh token pair instead of a cookie. The mobile app stores these via `expo-secure-store` (backed by Keychain on iOS, Keystore on Android) — the actual secure-storage equivalent of a browser's httpOnly cookie. Google Sign-In on mobile reuses the same `User` model but needs the separate mobile OAuth client from 1c above.

### Mobile design system

Reuse `GENESIS_ATMOSPHERE`'s real color tokens (`#8b7cf6` violet, the dark palette) for brand continuity, but build genuinely native components — React Native's styling model isn't CSS/Tailwind. `NativeWind` (Tailwind-syntax for React Native) is worth using specifically because the team already has real muscle memory with Tailwind class names from the web app. `GenesisAvatar`'s visual design gets recreated as a native component (the orb, the state-driven glow) — not literally ported, since today's implementation is web-only React/CSS/canvas, but built to look and feel identical.

### Build pipeline
- `EAS Build` for cloud-based, signed builds (iOS + Android from the same command).
- `EAS Submit` to automate the actual App Store Connect / Play Console upload.
- `EAS Update` for shipping JS-only fixes between full store reviews.
- CI: a GitHub Actions workflow triggering EAS builds on a release branch — a separate cadence from the web app's continuous Vercel deploys, on purpose.

### Push notifications backend
A real new piece: server-side logic to send a push (via Expo's push service, which wraps APNs/FCM) when something genuinely worth the owner's attention happens — hooking into the *existing* `GenesisObservation`/`CognitiveOutput` creation points rather than inventing a new "what's worth telling someone" mechanism.

---

## 3. Dependencies — what can run in parallel, what has to wait

**Start immediately, in parallel, no dependencies:**
- Apple Developer Program enrollment (start now — this can take the longest, especially the Organization/D-U-N-S path)
- Google Play Console registration
- Repo scaffolding, Expo project init, mobile design system groundwork
- Mobile auth endpoints + the initial API surface (backend work, independent of store accounts)

**Blocked on something above:**
- App Store Connect app record ← Apple Developer Program must be *approved*, not just submitted
- Play Console app record ← Google Play Console must be *approved*
- Real mobile screens beyond a static shell ← mobile auth + API surface must exist
- APNs key generation ← Apple Developer account approved
- TestFlight distribution ← app record exists AND a real signed build exists (EAS Build) AND testers are added
- Play Internal Testing distribution ← same shape, Google side
- Public submission ← all of the above, plus real icons/screenshots, plus both privacy/data-safety questionnaires answered, plus a build that's actually been used in internal testing

---

## 4. Milestones

**M0 — Accounts & environment.** Apple Developer Program approved. Google Play Console approved. Repo scaffolded, Expo project boots. *Done when*: a blank app with the J4 splash screen runs on your own physical phone via a real EAS build.

**M1 — Shared auth.** Mobile login (email/password + Google) against the real production backend. *Done when*: you can log into the exact same real account on both the web dashboard and the phone.

**M2 — Talk to J4 (the MVP core).** Real text chat with J4 on the phone, backed by the new API layer wrapping the same chat mechanism the web app already uses. *Done when*: a message sent from the phone shows up in the same conversation history visible on desktop, and J4's real reply appears on the phone.

**M3 — J4 brings things to you.** The same real data the dashboard's Discovery feed and Attention panel already surface (`BusinessEvent`/`CognitiveOutput`/`ApprovalRequest`) — but **not ported as a list or an inbox.** J4 raises it in conversation, the way a real partner would ("Good morning — since we last talked, X happened, and I think we should do Y about it"), and a proposed action is said and confirmed inline, in the same conversational surface M2 already built, not a separate approvals screen with checkboxes. This is the milestone where the guiding principle above gets tested for real: if the honest build ends up being a scrollable list of cards, that's the dashboard-on-a-smaller-screen failure mode, and it should be rebuilt conversationally before this milestone is called done. *Done when*: J4 raises something real and unprompted in the conversation, the owner responds in the same conversation, and — if it was an approval — it executes for real through the same Execution Engine and is reflected on desktop.

**M4 — Push notifications.** *Done when*: a real `GenesisObservation` (something urgent or worth noticing) triggers a real push notification on a real device.

**M5 — Store submission readiness.** Real icons/screenshots, both privacy questionnaires answered honestly, TestFlight + Play Internal builds in the hands of you and your mother for real use.

**M6 — Public launch.** Submitted, approved, live on both stores.

---

## What's explicitly NOT in this version, and why

Matching `COLLABORATIVE_WORKSPACE.md`'s own scope discipline — these are real, named, and deliberately parked, not forgotten:
- **Shared Context / live desktop sync** — the API layer built for M2/M3 is designed so this can plug in later without a rewrite, but no real-time transport gets built now.
- **Voice conversations.**
- **Scheduled/recurring meetings** (daily/weekly cadence).
- **Team/multi-user collaboration.**

The bar from here on, same as the rest of Genesis: does this version genuinely let an owner feel like they're talking to their business partner from their pocket? If yes, ship it and learn from real use before building the next layer.

---

## Resolved at freeze

1. **Organization** Apple Developer enrollment, attributed to Genesis AI — the D-U-N-S lookup is Sean's confirmed first owner task, starting immediately, in parallel with everything else, precisely because it's the longest pole in the roadmap.
2. Repo structure: **Option A, a separate repo** — confirmed.

## Still deliberately open, not blocking the freeze

1. Whether "J4" is the final public app-store name — same open-naming status `GENESIS_EXPERIENCE.md` already carries for "Partner"/"Partnership." Doesn't block M0-M4; needs a real answer before M5 (store listing requires a real name).
