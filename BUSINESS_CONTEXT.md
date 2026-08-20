# Business context

*One Genesis account, several businesses. The architecture, and the exact plan
for finishing it.*

**Status.** Phase 0 complete and live (`933db80`, `385370a`, `COMPLIANCE.md`
§49). Phase A's foundations are in: the explicit permission layer
(`requireBusiness`, `requireBusinessPage`) and business-scoped navigation paths,
both verified. Phase B is answered — by testing, it turned out not to be needed.
The route itself and the 28-screen migration are the remaining bulk.

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

**Still to do:** the `/b/[slug]` layout itself. The dashboard layout currently
does two jobs — resolve the business, and render the shell — and only the first
six lines are the first job. Splitting them is what lets both routes exist
without a second copy of a 400-line layout.

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
