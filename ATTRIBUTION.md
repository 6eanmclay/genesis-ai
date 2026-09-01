# Traffic attribution — the contract

**Built 2026-09-01.** Where a storefront visitor came from, recorded from what
the request actually supplied, and never guessed.

## The rule everything else serves

> Never infer a platform merely because we think the visitor probably came from
> there. — Sean, 2026-09-01

A merchant deciding where to spend their time on the strength of a guessed
source is worse off than one with no data at all, because they do not know to
doubt it. Everything below exists to make that rule mechanical rather than a
matter of care.

## The three kinds, and there is no fourth

| Kind | Recorded when | Stored |
|---|---|---|
| `explicit_tracking` | A tracking parameter was present — `via` or `utm_source` | The source verbatim, lower-cased |
| `observed_referral` | The browser supplied a `Referer` that parsed to a host that is not this shop | **The host only** |
| `direct_unknown` | Everything else — a typed address, an app with no referrer, a stripped header | No source. The absence is the answer |

Precedence is strict: explicit beats observed beats direct. Explicit wins
because somebody meant it; observed beats direct because a header is evidence
and an absence is not.

**Every visit also records `evidence`** — `via parameter`, `Referer host`, `no
Referer header`. The kind says what class of evidence; the evidence says what it
actually was. Two visits can share a source and have arrived at it differently,
and the Business Map has to be able to explain which.

### linktr.ee stays linktr.ee

A host is recorded as the host it is. A visitor arriving from a link-in-bio page
came from that page; Genesis does not know what they tapped before it. There is
no mapping table from "where people usually post links" to a platform, and
`scripts/verify-attribution-db.ts` asserts the classifier's source mentions no
platform name at all — so one cannot be added quietly.

The only ways a visit becomes `instagram.com` are that the referrer host **is**
Instagram's, or that an explicit parameter says so.

### The host only, never the URL

A full referrer carries the path and query of the page somebody was on: a search
they typed, a private document, another site's session id. The host answers the
business question. The rest is other people's data we have no reason to hold.

## Where it is captured

`proxy.ts` — **not `middleware.ts`**. This Next version renamed the convention,
and the docs say so plainly: *"The `middleware` file convention is deprecated
and has been renamed to `proxy`."*

The proxy does as little as possible, because its own documentation says it may
be deployed to a CDN and *"you should not attempt relying on shared modules or
globals."* So it mints an opaque token into a per-store cookie — the one thing a
Server Component cannot do — and forwards the query string on a header. Every
database write happens in `lib/attribution/visit.ts`, called from the storefront
route after its `notFound` guards, so a shop nobody could reach records no
traffic.

**The cookie is `sameSite: lax`, and that is load-bearing.** `bagStore.ts` says
why for the bag: a customer returning from Stripe or PayPal arrives via a
cross-site redirect, and under `strict` the cookie is not sent. For attribution
it would be worse than an emptied bag — every paid order would look like direct
traffic, and the subsystem would report nothing while appearing to work.

**`via`, not `ref`.** `ref` was the obvious short name and is already taken:
`app/api/checkout/paypal/return/route.ts` redirects a paying customer to
`?payment_pending=1&ref=<token>` and the storefront shows it as their payment
reference. Had this claimed `ref`, every PayPal return would have been recorded
as a tracked source with a transaction token as its name — garbage arriving only
for customers who actually paid.

## The attribution model

**Last-touch, at the visit that created the checkout draft.** One model, named,
and replaceable.

It is the only model today's data supports without pretending. First-touch and
assisted attribution need a visit history joined across sessions; the records
keep enough to add them later, and nothing written now would have to be undone
first.

**The first arrival's attribution wins within a visit.** Somebody who arrives
from Instagram and then browses came from Instagram — re-classifying on each
page would turn every visit into whatever its last request happened to look
like, and most later requests carry no referrer at all.

## How it reaches an order

```
proxy mints a token   ->  StoreVisit row, classified once
checkout begins       ->  frozen onto CheckoutDraft
order created         ->  copied onto Order, beside a store-verified visit id
```

The order's attribution fields are **copies, not foreign keys.**
`stripeEvent.ts` states the reason in its own words about the promotion link: a
referenced row deleted between a customer paying and the webhook arriving makes
`order.create` violate the constraint, and *"the ENTIRE order is lost — money
taken, nothing recorded."* Raw visits are pruned at twelve months; an order from
thirteen months ago must still say where it came from.

Both payment rails do this identically. A merchant's traffic report must not
depend on which button the customer pressed.

## Retention

**Raw visits: 12 months** (`RAW_VISIT_RETENTION_DAYS`), configurable per call
rather than hard-coded into a delete.

`pruneStoreVisits()` **rolls up before it deletes, in the same call.** A separate
nightly rollup would work right until the day it did not run, and the prune
would then destroy counts nothing had recorded. The destructive step cannot run
without the preserving one because it is the same step.

`StoreTrafficDay` is what survives: visits per store, per day, per kind, per
source. Together with the frozen attribution on orders it supports traffic by
source, orders by source, revenue by source, conversion rate and revenue per
visitor — after the visitor records are gone.

**Nothing schedules the prune.** It is callable, proven and dormant, per Sean's
standing instruction that no retention task is enabled without his say-so.

## What is deliberately not collected

- No IP address, stored or hashed
- No user-agent string or fingerprint
- No full referrer URL — the host only
- No cross-store identifier; the cookie is per store, like the bag cookie
- Nothing that would make this saleable as a data product

The visit token is opaque and random. It joins a purchase to the visit that
produced it and can answer no other question. `StoreVisit` is excluded from the
account export for that reason — the durable business facts it produces are
exported instead.

## What is not built

- **J4-minted source links.** The ingestion side is done: an explicit `via` link
  works today. What is not built is J4 proposing one, which rides the existing
  approval machinery and is future work.
- **Custom domains.** Not part of this milestone. The storefront is
  `/store/<slug>` and attribution works on whatever address it has.
- **First-touch or assisted attribution.** One model, deliberately.

## Verification

| Lane | File | Proves |
|---|---|---|
| Database | `verify-attribution-db.ts` | The classifier exhaustively, the `ref` collision, retention arithmetic, cross-store isolation, revenue by source |
| HTTP | `verify-attribution-live.ts` | Real requests with real headers: the naked URL, a real `Referer`, a tracked link, refresh idempotency, navigation, 404s recording nothing |

**Ten sabotage breaks, ten red**, including mapping `linktr.ee` to Instagram,
guessing a source for direct traffic, storing the full referring URL, and
deleting raw visits without rolling them up first.

Two of those breaks stayed green on the first run and both were real findings:
one test read the wrong day's rollup row and could only ever pass, and one
sabotage target was surface nothing consumed — removed rather than left
untestable.
