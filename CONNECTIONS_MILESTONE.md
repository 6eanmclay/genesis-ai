# The Connections milestone — evidence before scope

**Investigation only, 2026-08-25. Production baseline `6650011`. No production
code changed.** Every claim names its evidence. Nothing here is proposed from
the roadmap.

Stop for approval before implementation.

---

## 1. The finding that should decide the scope

Read from the production database, read-only:

**BusinessRecords by source**

| Source | Records | |
|---|---|---|
| `genesis_upload` | 164 | first-party |
| `genesis_promotion` | 48 | first-party (yesterday's identity facts) |
| **`quickbooks`** | **41** | 25 document, 16 transaction |
| `genesis_design` | 21 | first-party |
| `genesis_storefront_media` | 18 | first-party |
| `genesis_generated` | 4 | first-party |

**BusinessEvents by source**

| Source | Events |
|---|---|
| **`quickbooks`** | **43** |
| `internal` | 4 |

**QuickBooks is the only connector that has ever produced business data — and it
has been dead since 2026-08-01.** 43 of the platform's 47 business events came
from it. Nothing has arrived from any connector in 24 days.

And the two connectors that *are* alive have produced nothing at all:

| Connector | State | Records ever written |
|---|---|---|
| **Mailchimp** | CONNECTED, synced today, **0 failures** | **0** |
| **Google Calendar** | CONNECTED, 11 failures, dead since 08-06 | **0** |

Mailchimp reports success every single day and has never written a record. That
is either an empty account or a silent no-op, and **nothing in the system can
currently tell those apart** — a successful sync that writes nothing looks
identical to a successful sync that had nothing to write.

---

## 2. What is already built, and works

Not to be rebuilt.

| | Evidence |
|---|---|
| Six real connectors with OAuth, encrypted credentials, signed single-use state | `lib/integrations/`, `COMPLIANCE.md` §2–4 |
| Scheduler with exponential backoff, rate-limit handling, per-store isolation | `lib/intelligence/scheduler.ts` |
| Evidence-grounded connection recommendations — real revenue, real customers, never a category match alone | `lib/integrations/gaps.ts` (Ch.4 M1) |
| Connection gaps that J4 *speaks* rather than lists | `a21130b` |
| Honest staleness on connector-derived summaries | `df23719`, `176da57`, `9bcdada` |
| **A dead connection now asks to be reconnected** | `6650011`, deployed today |
| Change detection → insights → the intelligence cycle | `lib/intelligence/changeDetection.ts` |

---

## 3. What is blocked, and cannot be unblocked by engineering

| | Blocked by |
|---|---|
| Mailchimp / Facebook / Instagram / TikTok — new connections | client credentials absent (U5) |
| QuickBooks — the only productive connector | owner re-consent (U2) |
| Google Calendar | OAuth app unpublished (U3) |
| Toast POS, Square, Calendly, Xero, HubSpot, Twilio | `connector: null` — never built; Square additionally needs credentials |

**6 of 12 catalog entries have no implementation. Of the 6 that do, 4 cannot be
newly connected and 1 is dead.** Any milestone whose value depends on connecting
a new provider cannot proceed.

---

## 4. Where the product contradicts its own vision

`VISION.md` Chapter 4 is explicit:

> *"Never presented as raw settings to configure — J4 recommends each connection
> as a real, earned capability unlock, grounded in the business's own real
> state… never a generic settings-page checklist."*

`app/dashboard/connections/page.tsx` renders a "Recommended for your business"
section — which *is* the earned-unlock idea, and it works — and then, below it,
**every one of the 12 catalog entries grouped under all 7 category headings**,
including the 6 that cannot be connected at all.

So the screen is the earned unlock *and* the generic checklist, stacked. The
checklist half is the larger half.

---

## 5. Three candidate scopes

### A — Connection truthfulness *(recommended)*

Make the system honest about connections it already has, since that is the part
not blocked by anything.

- **A sync that writes nothing says so.** Mailchimp's daily success is currently
  indistinguishable from a sync that found data. Record what a sync actually
  wrote, so "connected and producing nothing" becomes a visible state rather
  than an assumption.
- **The catalog stops advertising what cannot be connected.** Six entries with
  no implementation are rendered as cards today.
- **Connection value is stated in business terms** — what a connection has
  actually contributed, not that it is connected.

*Unblocked by anything. Directly serves VISION Chapter 4. Builds on `gaps.ts`
and the health work deployed today rather than beside it.*

### B — Recover the one connector that works

Make QuickBooks reconnection a guided path rather than a warning, and make the
41 records and 43 events it produced visible as what was lost.

*Partially blocked: the reconnection itself is U2 and only Sean can do it. The
guided path can be built; it cannot be proved end to end.*

### C — Build a new connector

Square, Xero, HubSpot, Calendly.

*Blocked by credentials for every candidate. Also contradicts your standing
instruction not to expand the connector catalog, and `VISION.md` line 76 puts
additional integrations in P2, off the critical path.*

---

## 6. Open decisions for Sean

**C1 — Which scope?** Recommendation: **A**. It is the only one that can be
finished and proved with what exists today, and it is what Chapter 4 actually
asks for. B is worth doing but cannot be completed without you. C is blocked and
out of scope by your own instruction.

**C2 — Does the catalog keep its unbuildable entries?** Six entries render as
cards for providers with no implementation. Options: remove them; keep them
behind an explicit "not available yet" that the recommendation engine never
surfaces; or keep as-is. This is a product call, not a cleanup.

**C3 — Is "connected but producing nothing" a finding J4 should raise?** A
connection that has succeeded daily for weeks and written nothing may be an
empty account, which is fine and not worth mentioning — or a connector that
silently does nothing, which is not. Whether J4 says something, and after how
long, is a judgment about interrupting an owner.

**No production code changes until these are answered.**
