# Data & Connections — the contract

**Status: CONTRACT, 2026-09-12.** The first surface of the Genesis Experience
Rebuild. Written before the page was built, from the real data model and the
real connector registry, because the failure mode of this whole phase is a
beautiful screen showing numbers nobody measured.

**The architecture lock is untouched.** Five rooms; Office is part of Business
and is not a tab; `GENESIS_SURFACES.md` and `verify-rooms.ts` are unchanged.
This surface lives where it already lived — the account area, configured
rather than visited — and inherits the shared chrome without claiming a room.

---

## The question this page answers

> What J4 knows → where that knowledge comes from → how it is connected →
> what is healthy → what is actionable → what J4 can do with it.

The reference calls this "Feed the Brain", and the idea is right: an owner
should be able to see that connecting a tool *feeds* something. The current
page cannot make that argument at all — it is a connector list with statuses,
which is a settings page wearing the name of a nervous system.

---

## What the reference shows that we must NOT copy

The reference composition is a design study, not a data source. Four of its
claims have no honest basis here, and reproducing them would be inventing
evidence:

| Reference shows | Reality |
|---|---|
| "Data Health 92%" | There is no denominator. Health is per connection and has **six named states**, not a percentage. A single number here would be a mood, not a measurement. |
| "24,831 Data Points" | A record count IS real and countable (`BusinessRecord`), so a count may be shown — but only the true one, which for most stores today is small or zero. |
| "Automations 12 · 4 active" | No such concept exists in this codebase. Nothing to count. |
| Shopify, Gmail, Notion tiles | Not connectors. `CONNECTOR_CATALOG` is the only list, and a tile for something unbuildable is a promise. |

**And the largest correction: in the reference, every tool flows into the
brain.** Here, most do not — and that is by design, not a gap. See below.

---

## 1. What J4 knows

`BusinessRecord` is the only store of connection-sourced knowledge. Every row
carries `sourceProvider`, `entityType` and `syncedAt`, so "what J4 knows" is
countable rather than asserted.

The real entity types written by real connectors today:

| entityType | Written by |
|---|---|
| `transaction` | QuickBooks, Square |
| `document` | QuickBooks, Xero |
| `contact` | Square, Xero |
| `item` | Square |
| `appointment` | Google Calendar |
| `campaign` | Mailchimp |
| `shipment` | EasyPost |

**Zero is a real answer and must be shown as one.** A store with no connected
sources knows nothing from connections, and the page says exactly that rather
than rendering an empty chart.

## 2. Where that knowledge comes from

Nine connectors implement `sync` and can write records: **EasyPost, Facebook,
Google Calendar, Instagram, Mailchimp, QuickBooks, Square, TikTok, Xero.**

Five deliberately do not, and never will: **Stripe, PayPal, Printful, Twilio,
AliExpress.** They are payment, fulfilment, messaging and sourcing *rails* —
`stripe.ts` says it in as many words, "the absence of `sync` here is the
answer". `ConnectionEvidence.syncs` exists precisely because seven production
connections were once told "Connected and syncing. This provider has not
returned any business data yet", which was false on both halves.

**So the page shows two populations, labelled differently.** A rail that has
never written a record is working perfectly. Presenting it as an underfed
input — which the reference's single flow diagram would — would repeat the
exact defect `syncs` was added to fix.

Facebook, Instagram and TikTok sync but write no `BusinessRecord`; they update
their own `StoreIntegration` row. They are sources whose product is currently
connection state rather than records, and are counted as syncing, not as
knowledge.

## 3. How it is connected

`StoreIntegration` is the durable connection: `status`, `lastSyncedAt`,
`nextSyncDueAt`, `syncFailureCount`, `lastError`, `connectedAt`,
`connectedByUserId`. Credentials are encrypted and **never rendered** — no
token, secret or account id reaches this page.

## 4. What is healthy

`connectionHealthOf()` is the single answer and this page must not compute a
second one. It is pure, takes evidence only, and returns one of six states in
precedence order:

- `unavailable` — no implementation, or OAuth credentials not configured
- `not_connected` — never connected, or deliberately disconnected
- `failed` — verification failed; the provider's own message is kept verbatim
- `needs_reconnection` — authenticated once, syncing has failed repeatedly
- `connected_no_data` — working, and has never returned business data
- `connected` — working, and has produced data

The provider's error string is shown **unrewritten**. "The account was a test
account created with a testmode key" tells an owner exactly what to fix, and
no sentence this codebase could generate would be more useful.

## 5. What is actionable

Two real sources, and no invented third:

- **Gaps** — `getConnectionGaps()` returns computed facts, each carrying its
  own `reason` in the owner's terms. A gap is a computed fact, never a guess,
  and the reason is what the page shows.
- **Broken connections** — any health state with `raisesAttention`.

## 6. What J4 can do with it

The consumption points are real and already wired into the Business
Understanding:

- `getInvoiceSummary` — outstanding and overdue counts and totals (QuickBooks,
  Xero)
- `getCampaignPerformanceSummary` — campaign performance (Mailchimp)
- `getAppointmentSummary` / `getUpcomingAppointments` — what is ahead (Google
  Calendar)

These flow into `connectedSummaries` on the one canonical
`getBusinessUnderstanding()`, which is what J4 reasons over. **This is the
proof the page exists to show**: connect a calendar and J4 can tell you what
is ahead; connect nothing and it cannot. When a summary is null, the page says
which connection would produce it, rather than hiding the capability.

---

## What this page must never do

1. **Invent a score.** No composite health percentage without a denominator.
2. **Imply a rail is underfed.** Stripe having written no records is correct.
3. **Show a tile for something unbuildable.** The catalog is the list.
4. **Render a credential.** Not a token, not a secret, not an account id.
5. **Claim a sync happened that did not.** `lastSyncedAt` is the only clock.
6. **Compute a second health answer.** `connectionHealthOf` or nothing.

## What must be preserved from the current page

- Connect / disconnect through the existing server actions and `ConnectorCard`
  — the functional core, unchanged.
- The category grouping from `CONNECTOR_CATALOG`, which is the real taxonomy.
- `declaredRead` accounting on the understanding read.
- Recommended connections driven by `getConnectionGaps`, in the order it
  produced them.

## Proof obligation

A suite must assert, against real database state: a store with no connections
says so; a rail that has written nothing is not described as failing; a
connector that has failed shows the provider's own message; record counts
match the rows; and no credential field appears in the rendered HTML.
