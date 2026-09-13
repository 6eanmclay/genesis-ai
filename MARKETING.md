# Marketing — the contract

**Status: CONTRACT, 2026-09-13.** The next surface of the Genesis Experience
Rebuild after Data & Connections and the Office. Written before the page is
touched, from the real schema and the real recording path, for the same reason
`DATA_AND_CONNECTIONS.md` was: the failure mode of this phase is a beautiful
screen showing numbers nobody measured.

**The architecture lock is untouched.** Five rooms; Marketing is an existing
primary destination in `NAV_SECTIONS` and stays exactly where it is. No new
room, no new navigation, no new taxonomy, no parallel state model.

**Nothing here is authorization to build.** It is the evidence and the
direction, for Sean to approve or reject as a whole.

---

## The question this page answers

> How do people find this business, what did that produce, and what is J4
> doing about it?

The current page cannot answer any of the three. It shows six blueprint
strings, a list of subscriber email addresses, the SEO approval queue, and
J4's SEO authority. That is a settings page for marketing *assets* — the
words the business uses — with nothing about marketing *reach*.

This is not a styling problem and must not be fixed by restyling it.

---

## What is already true and already shown

| Shown today | Source | Honest? |
|---|---|---|
| SEO title, meta description | `blueprint.marketingAssets` | yes, read-only, J4-editable via approval |
| Brand keywords, Instagram/Facebook/X bios | `blueprint.marketingAssets` | yes, same path |
| Pending `update_seo` / `update_marketing_assets` proposals | `ApprovalRequest` | yes |
| J4's SEO authority, present and absent | `DelegatedAuthority` + tier | **yes — verified 2026-09-13** |
| Recently handled SEO decisions, with `decisionMode` + Revert | `ApprovalRequest` EXECUTED | yes |
| Newsletter subscribers | `NewsletterSignup` | yes, real rows |

The authority block was audited on 2026-09-13 and is correct in both branches:
`update_seo` is the **only** one of 26 registered actions at tier `auto`, and
the conversational path requires the grant as well as the tier
(`ai-actions.ts`, 2026-09-11). Marketing states it because Marketing is the
only room that has any autonomous capability to state. **Do not add equivalent
wording to other rooms** — `navConfig.ts` already rules on why: authority "is
not a capability inside Storefront or Commerce; it is a statement about all of
them, and putting it inside any one room would say the opposite."

---

## What is real, recorded in production since 2026-09-01, and shown NOWHERE

This is the finding. The attribution pipeline shipped and deployed on
2026-09-01 (`759459b`, migration 115) and is wired into the live request path:

- `app/store/[slug]/page.tsx` → `recordVisit` on every storefront view
- `app/store/[slug]/products/[productId]/page.tsx` → `recordVisit` +
  `recordProductView`
- `app/store/[slug]/actions.ts` → `attributionForCheckout` at checkout
- `lib/payments/stripeEvent.ts`, `lib/bag/checkoutDraft.ts` → freeze it onto
  the order

It writes three things:

| Model | What it holds |
|---|---|
| `StoreVisit` | one row per visit token: `attributionKind`, `source` (host or token), `campaign`, `evidence`, `landingPath`, `viewedProductIds` |
| `StoreTrafficDay` | the daily rollup that survives the 12-month prune of raw visits |
| `Order.attributionKind/Source/Campaign` | **frozen at purchase**, indexed `[storeId, attributionSource]` |

**Zero UI reads any of it.** Not Marketing, not Analytics, not the Business
Map, not the arrival. Grep for `attributionSource` in `app/` returns nothing.
So the platform knows where every visit and every sale came from, has known
since 2026-09-01, and has never told the owner.

That is precisely the question a Marketing room exists to answer, and the data
is already there, already frozen onto orders, already indexed for the query.

### It belongs here, not on Analytics

Analytics shows products, integration status, recent activity and J4's output.
It does not show traffic either — so this is not a case of one room taking
another's content. And the Gap A lesson applies in the other direction: **it
must appear in exactly one place.** If it goes on Marketing it does not also
go on Analytics.

---

## What must NOT be invented

| Tempting | Why it would be a lie |
|---|---|
| A conversion rate from visits to orders | Only computable where both sides are attributed. A store whose visits predate attribution, or whose orders were created by other paths, would produce a ratio of two differently-scoped counts. State the two numbers or state neither. |
| "Top channel" / "best performing source" | Ranking implies comparison against effort the platform knows nothing about. A host with one referred visit is not a channel. |
| A campaign performance table | `campaign` is populated only when a link supplied one. Most rows will have none, and an empty table headed "Campaigns" promises a feature. |
| Anything about email *sends* | There is no working email provider (E19). "No confirmation has been sent" ≠ "sending failed", and the same rule applies here: a subscriber list is not a campaign capability. |
| Social reach, followers, post performance | No platform connection returns it today. The bios are strings in a blueprint, not a presence. |
| A full referring URL | `StoreVisit.source` is deliberately the **host only** — the schema says why: "a referring URL carries the path and query of somebody else's page." Never widen this. |

**Zero is a real answer and must be shown as one.** A store with no attributed
visits knows nothing about how people find it, and the page says exactly that
rather than rendering an empty chart. This is the same rule Data & Connections
set and it is not negotiable.

---

## The one thing this contract cannot yet assert

**Whether production actually holds meaningful attribution volume.** The
recording path is verified live by reading the code; the row counts are not.
A read-only production check was attempted on 2026-09-13 and **blocked by the
environment's permission classifier**, so it has not been run, and nothing
here claims a number.

Before any build, one read-only query decides the shape:

```sql
SELECT count(*) FROM "StoreVisit";
SELECT "attributionKind", source, count(*) FROM "StoreVisit" GROUP BY 1,2;
SELECT count(*), count("attributionKind") FROM "Order";
```

Three outcomes, three different correct builds:

1. **Real volume across several stores** — the surface is worth building as
   described, leading with where visits came from and which sources produced
   orders.
2. **Rows exist but thin** — build the same thing; the honest numbers are
   small, which is a true statement about a young business and exactly what
   Data & Connections already does.
3. **Effectively empty** — the finding is not "Marketing needs a traffic
   section", it is "attribution has been recording nothing for two weeks",
   which is a different and more urgent investigation and **not a UI task at
   all**.

Outcome 3 is why this contract does not proceed to implementation on its own.

---

## Explicitly out of scope

- Any change to the attribution recording path, the prune, or the schema.
- Any Commerce surface, held until the Commerce observation cycle is captured.
- Any change to the observation/action representation, or to LOSS 1 in
  `lib/commerce/conditions.ts`, which is a confirmed defect deliberately left
  unfixed so it does not contaminate that verification.
- Restyling Marketing onto `GenesisChrome`. Chrome is the last step of a
  rebuild, never the first, and the page's problem is that it answers no
  question — not that its headings are the wrong size.
