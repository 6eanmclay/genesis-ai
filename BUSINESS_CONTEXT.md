# Business context

*One Genesis account, several businesses. The architecture, and the exact plan
for finishing it.*

**Status (2026-08-27). Phase E is complete; the suite is finished.**
scripts/verify-multi-business-suite.ts runs three deliberately different
businesses on one account -- Cubit & Coil, Genesis, Creator Presence -- through
isolation, differentiation, switching, the two-tab test and a real browser: 51
assertions. Phase B item 5 (an entry that creates another business when you
already have one) shipped as app/create-business. The tenant guard gained the
eight store-scoped models that had drifted out of it, and now reads the schema
so it cannot drift again.

Still deliberately excepted: onboarding and the legacy /dashboard composer.
Still outstanding: the legacy actionHref data migration.

**Status (2026-08-21).** Phases 0, A, B, C and D are complete. Phase B was
answered by testing — it turned out not to be needed. Phase C is done, including
the five route handlers and `/j4/room`, and it surfaced five real defects rather
than being a mechanical rebase (see below). Phase D shipped the switcher and the
chooser: `setActiveBusiness` and `accessibleBusinesses` had **no callers**, so an
ambiguous account was told to choose and given nowhere to do it.

What remains is Phase E — broadening adversarial coverage across every surface —
and the deliberate exceptions: onboarding and the legacy `/dashboard` composer.

---

## The principle

> **Authorization context must be explicit. A navigation default may be
> remembered. Recency is never either.**

Those are different things and collapsing them is what caused the original
defect: 47 call sites resolved "the" business as *whichever store was updated
most recently*, so a second business became the active one by being **touched**
rather than by being **chosen**.

Phase 0 removed the recency heuristic. What remains is removing the *ambience*:
today the business is still an ambient fact resolved per request rather than
something each screen and action names. That is why two tabs on two businesses
are impossible, and why a link cannot address a business.

---

## Target architecture

```
/b/[slug]/                     the business is in the route
   ├── page.tsx                home
   ├── products/ orders/ …     every section
   └── layout.tsx              resolves the slug ONCE, verifies access

/dashboard/*                   preserved, redirects to /b/<active>/*
/store/[slug]/*                unchanged — the public storefront
```

**The slug, not the id.** It is already the public storefront identifier and
already unique, so a business has one name in one place. Renaming a business
already changes its storefront URL; this adds no new breakage.

**Three ways context arrives, all explicit:**

| Surface | How it gets the business |
|---|---|
| Pages | `params.slug` — the route segment |
| Server actions | `action.bind(null, slug)` at the call site in the page |
| Route handlers (`/api/*`) | the business named in the request |
| Webhooks, cron | resolved from the data (an order, a capture, a store id) |

Nothing reads ambient state. That is what makes two tabs work: each request
carries its own business, so a request in tab B cannot be affected by what tab A
is doing.

**`User.activeStoreId` stops being an authorization input.** Its only remaining
job is answering *where do I send someone who just opened the app* — a landing
decision, which is allowed to be a remembered preference. It is written only by a
deliberate switch or by creating a business.

---

## Migration plan

Each phase is independently shippable and independently verifiable. Nothing
in a later phase is required for an earlier one to be correct.

### Phase A — the route exists

1. `app/b/[slug]/layout.tsx` — resolve slug → `accessTo` → 404 if unreachable.
   Renders the existing shell. **One resolution per request.**
2. `requireBusiness(permission, slug)` and `requireBusinessPage(permission, slug)`
   in `lib/permissions.ts` — the explicit counterparts.
3. `/dashboard/*` → `redirect('/b/<active-slug>/*')`, so existing links,
   bookmarks and emails keep working and there is one canonical URL.
4. `/dashboard` with no business → onboarding, unchanged. With an ambiguous
   account → the chooser (Phase D), and until then it fails closed.

**Done so far:**

- `requireBusiness(permission, slug)` and `requireBusinessPage(permission, slug)`
  — the explicit counterparts, additive rather than a rewrite, so 28 call sites
  can migrate against a working API instead of all at once. A slug the account
  cannot reach is refused with the same message as one that does not exist:
  telling somebody a business exists but is not theirs is an answer they did not
  have before.
- `sectionHref` / `sectionsFor` — the same section list addressed inside a
  business, so no second list of sections exists to drift. Proven pure in
  `scripts/verify-business-paths.ts`, including that rebasing is idempotent
  (`/b/x/b/x/orders` is the bug that would otherwise appear) and that the legacy
  base is byte-for-byte unchanged, which is what keeps unmigrated screens working.

- **The layout split** (2026-08-20). `app/dashboard/layout.tsx` did two jobs:
  work out which business this is, and render the shell around it. Only the
  first six lines were the first job, and it was the job that had to change.
  `BusinessWorkspace` is the render half, extracted rather than duplicated — a
  second copy of four hundred lines is a second copy that drifts, and the half
  that drifts is whichever one is opened less often. The legacy layout went from
  401 lines to 119, all of them resolution.
- **`app/b/[slug]/layout.tsx`** — resolves the slug, refuses a business the
  account cannot reach with `notFound()` rather than a redirect somewhere that
  works, and renders the same workspace with `basePath = /b/<slug>`.
- **`basePath` threaded into the shell.** Its two "am I on home" checks were the
  literal `/dashboard`; inside a business that would have meant home never
  highlighted and the home layout never applied.

- **`app/b/[slug]/page.tsx`** (2026-08-20). The home page was 864 lines opening
  with *does this account have a business at all* — onboarding. That branch
  stayed on the legacy route, where it belongs: an account with no business has
  no slug to be at. `HomeWorkspace` is the rest, and both routes render it.

**Phase A is complete.**

### Phase B — an account can own several businesses ~~(lift the draft constraint)~~

**Corrected 2026-08-20, after testing rather than assuming.** This phase was
written on the belief that `StoreDraft.userId @unique` blocked an account from
owning several businesses. **It does not**, and the difference matters enough to
record rather than quietly drop.

Confirming a draft deletes it, which frees the constraint. So an account creates
a business, confirms it, and creates another — proven against real Postgres in
`verify-business-context-live.ts` §11: two businesses, both reachable, the newest
active.

What the constraint actually blocks is **two businesses being created at the same
time**. Nobody has asked for that, and lifting it has a real cost: every
`findUnique({ where: { userId } })` on a draft would have to become "the draft
this user is currently working on", and the obvious implementation of that is
*the most recent one* — which is the exact recency guess Phase 0 removed. Trading
a real constraint for a recency lookup to unblock a case nobody wants is a bad
trade.

**Left in place, deliberately.** If simultaneous creation is ever wanted, the
right fix is an explicit active-draft pointer of the same shape as
`User.activeStoreId`, not an ordering.

Still required from this phase:

5. A "create another business" entry that works when you already have one.
   Creation already calls `adoptNewBusiness`, so the new business becomes the
   active one.

### Phase C — thread the context through

7. Migrate the 28 implicit call sites, section by section, from
   `requireStorePermission(PERMISSION)` to `requireBusiness(PERMISSION, slug)`.
   Each section is one commit: pages take `params`, actions are bound.
8. Route handlers (`/api/chat`, `/api/j4/speak`, both upload routes,
   `/api/chat/recent-messages`) take the business explicitly from the request
   rather than resolving it.

**The primitive** (2026-08-20): `requireBusinessOrActive(permission, slug?)`. A
slug means the caller named its business and that is authoritative; no slug means
the legacy route. Each site migrates by adding one optional parameter rather
than being rewritten, and both routes share one action while it happens.

**This is scaffolding, and it has an end.** When the last screen has moved the
parameter becomes required and the function disappears — an action that can still
fall back to the active business is an action that can be called from a page
which named a different one.

**Migrated so far: 5 of 15 screens, 9 call sites.**

| Screen | How |
|---|---|
| **Home** (`/b/[slug]`) | `HomeWorkspace` extracted. The onboarding branch stayed behind: under `/b/[slug]` "does this account have a business" is already answered, so it is unreachable there by construction rather than by a check |
| **Products** | takes `slug`/`basePath`; links rebased |
| **Connections** | takes `slug`; `ConnectorCard` binds it into disconnect |
| **Billing** | takes `slug`; both forms bound |
| **Growth Points** | takes `slug`; purchase bound, link to Billing rebased |
| Orders | `OrdersWorkspace` extracted; both routes render it |

Actions bound to the named business: `disconnectUsps`, `saveReturnAddress`,
`manageBilling`, `subscribeToPlan`, `purchaseGrowthPoints`,
`addGrowthPointsForTesting`, `disconnectIntegration`.

Two screens were extracted (Home, Orders) and three were migrated in place
(Products, Connections, Billing, Growth Points). In place is the better move
where it works: moving several hundred lines of JSX to change one line of
resolution is a bigger diff with more room to be wrong. Home and Orders needed
extraction because their pages genuinely branch before resolving.

The redirect detail is not incidental. A slug-bound action that sent the owner
back to `/dashboard/orders` would have disconnected the right business and then
shown them a different one.

**Phase C is complete (2026-08-21).** All 15 screens, every write in
`actions.ts` and `connectionsActions.ts`, the seven chat-turn actions in
`ai-actions.ts`, the four proposal decisions, all five route handlers and
`/j4/room`. Onboarding and the legacy `/dashboard` composer stay implicit
deliberately — they send no slug and resolve the active business exactly as
before.

**`engine.ts` was never the problem.** This document said it "resolves the
business internally". It does not, and never did: it has always accepted
`opts.storeId` and forwards it. Twelve actions resolved `businessId` from the
slug and then **did not pass it**, so permission was checked against the business
named in the URL while the executable ran against the active one. Seven of them
write real payment or carrier credentials. That is the direction "refused, never
substituted" cannot catch, because both businesses are reachable: nothing is
denied, the write simply lands somewhere else.

**Four more defects the migration surfaced**, each the same shape from a
different angle:

| Where | What it did |
|---|---|
| `/api/chat` POST | The surface was fixed in August to render the named business; **sending** a message still resolved the active one, so the conversation on screen and the turn that was written belonged to different businesses |
| The four proposal decisions | Looked up `findFirst({ id, storeId: active })`, so a proposal in the owner's *other* business returned `not_found` — J4 offered a real change and approving it said it had vanished |
| `/j4/room` | Sent an ambiguous account to `/onboarding` — telling an owner to create a business when they have several |
| Four route handlers | `resolveUserStore` returns null for both "no business" and "several, none named", so the two were indistinguishable everywhere |

**Verified against real Postgres:** `verify-execute-binding-live.ts` (the engine
contract: an explicit storeId decides where the write lands, and is still not a
capability), `verify-route-business-live.ts` (a named business beats the active
one; naming is not choosing), `verify-business-switcher-live.ts` (including the
two-tab test).

**Still resolving implicitly, deliberately:** onboarding, the legacy `/dashboard`
page and its composer. **Not yet executed:** the proposal-decision path needs a
signed-in session, so it is typechecked and built but covered only by the browser
suite.

**Verified by:** the adversarial suite in Phase E, run after each section.

### Phase D — the switcher

9. A switcher that **navigates**. It sets the active business (so the next
   landing is right) and then changes the URL. It does not hold state; the URL
   is the state.
10. The chooser page for the ambiguous case, which after Phase B is only
    reachable by an account whose businesses were created outside the normal
    path.

### Phase E — adversarial coverage

11. Two businesses, one account, real Postgres, for every surface Sean named:
    switching, **two concurrent requests naming different businesses**, products,
    orders, connections, billing, Growth Points, J4 understanding, uploads,
    analytics, recommendations.

The two-tab test is the one that decides whether this worked. It is expressed as
two concurrent resolutions naming different slugs, asserting neither sees the
other's business — which fails against any implementation that reads ambient
state, and passes only when the context is genuinely carried per request.

---

## Known, and not yet migrated

- **Stored `actionHref` values are legacy-based.** Recommendation rows carry
  `"/dashboard/products"` as data, written when they were created. The Products
  screen queries on that string, so rebasing the filter would stop it matching
  any existing row. Their own migration, and a data one rather than a code one.
- ~~**`lib/execution/engine.ts`** resolves the business internally.~~ **Wrong,
  corrected 2026-08-21.** It has always accepted `opts.storeId`. The implicitness
  was twelve callers omitting it, all now bound and the contract proved live.
- ~~No screen has been exercised through a real browser session.~~ **Done**
  (§50). A real server, a real Postgres, a real browser, a real sign-in through
  the login form. It found a defect nothing else could: `J4Surface` resolved the
  account's *active* business rather than the one being viewed, so J4 talked
  about Iron Gym on Copper & Coil's pages. Fixed.

---

## What must never regress

- A business is never active because it was **touched**. Only because it was
  **chosen**, or because it is the only one.
- A named business the account cannot reach is **refused, never substituted**.
  Succeeding with a different business than the one asked for is worse than
  failing, because it succeeds.
- Ownership and membership are decided in **one place** (`accessTo`), so they
  cannot drift between call sites.
- An owner who is also a member of their own business is still an **owner**.
- Every business keeps its own identity, catalogue, orders, connections, Growth
  Points, plan, recommendations and J4 understanding. Connecting a supplier to
  one connects it to one.

---

## Then, and only then: product sourcing

The catalog is the discovery layer of J4's business understanding, and it is
**per business** — its own recommendations, sourcing relationships, catalog
selections and brand context. That model already exists and is verified
(`PRODUCT_SOURCING.md`), including two businesses on one account where the same
supplier listing fits one and is ruled out of the other.

It is blocked on this work for one concrete reason: a discovery screen that
recommends products for "the business" is only correct if the platform knows
which business that is.
