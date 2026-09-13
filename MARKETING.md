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

## RESOLVED — the production read, 2026-09-13

Run read-only with Sean's explicit approval, read-only transaction, SELECT
only, no writes, no cron. **Classification: A — attribution is populated.**

```
StoreVisit          524 rows, 8 stores, 2026-09-02 → 2026-09-13 (continuous)
StoreTrafficDay       0 rows
Order                14 total — 7 created before 2026-09-01, 7 since
                     all 7 created since the ship date carry attribution
```

Visits by kind and source host, as recorded:

| kind | source | visits |
|---|---|---|
| `direct_unknown` | — | 372 |
| `observed_referral` | facebook.com | 63 |
| `observed_referral` | m.facebook.com | 30 |
| `observed_referral` | t.co | 25 |
| `explicit_tracking` | ig | 14 |
| `observed_referral` | lm.facebook.com | 8 |
| `observed_referral` | l.facebook.com | 4 |
| `observed_referral` | youtube.com / m.youtube.com | 3 |
| `observed_referral` | verification.example.test | 2 |
| `explicit_tracking` | deployment-check | 2 |
| `observed_referral` | checkout.stripe.com | 1 |

Orders carrying attribution: `t.co` 3, direct 2, `m.facebook.com` 1,
`lm.facebook.com` 1. **`attributionCampaign` is set on zero orders.**

Per store: Cubit & Coil 511 visits / 10 orders / 7 attributed. Every other
store has exactly one visit.

### What the data proves about the build

1. **Count attributed orders by `attributionKind`, never `attributionSource`.**
   7 orders carry a kind; only 5 carry a source, because `direct_unknown` has
   a null source by design. `WHERE "attributionSource" IS NOT NULL` undercounts
   by 29% and would read as a defect in the recorder rather than the query.
2. **Read `StoreVisit`, never `StoreTrafficDay`.** The rollup is empty and
   correctly so: it is written by the prune, the prune is dormant, and nothing
   is yet 12 months old. A surface built on the rollup shows zero for ever.
3. **Hosts stay hosts.** The Facebook family is four rows totalling 105 visits.
   Grouping them is exactly what `classify.ts` forbids — "A HOST IS RECORDED AS
   THE HOST IT IS", "linktr.ee stays linktr.ee". Four rows, or nothing.
4. **The campaign table refusal is now evidence-backed**, not merely prudent:
   no order and no visit has ever carried a campaign.
5. **Build for n=0 and n=1 first.** 511 of 524 visits are one store; seven
   stores have a single visit. The typical owner's view is nearly empty, and
   that is the view that must read correctly.
6. **`direct_unknown` is 71% of all traffic** and must lead rather than be
   tucked behind the referrers. A page that shows 152 referred visits and hides
   372 unknown ones is a more flattering page and a false one.

### Two artefacts in the data, neither a defect

- `verification.example.test` (2) and `deployment-check` (2) are this project's
  own verification traffic, recorded in production exactly as any visit is.
- `checkout.stripe.com` (1) is a return from an abandoned Stripe checkout:
  `cancel_url` sends the customer back to the storefront root, and if their
  visit token is new at that moment the Referer is Stripe's. It **cannot**
  overwrite a real source — `recordVisit` never re-classifies an existing row
  ("THE STORED ROW IS NOT TOUCHED"), so a visitor who arrived from Instagram
  stays attributed to Instagram. One row in 524; named here so it is not
  rediscovered later as a mystery.

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
