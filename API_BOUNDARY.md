# The public boundary — every route, and what guards it

**Written 2026-08-30 during Item 3.** Twenty-six route handlers, audited one at
a time. This is the record of what each one needs and, where it needs nothing,
why — because "we decided not to" and "nobody looked" are indistinguishable
without it.

## The controls

| Control | Where it lives | What it stops |
|---|---|---|
| **Size** | `lib/http/guard.ts` | A body large enough to be expensive to read. Checks the declared `Content-Length` first, then bounds the actual read, because the header is a claim. |
| **Shape** | `lib/http/guard.ts` + a Zod schema per endpoint | A well-formed request with the wrong contents. Rejections name the fields, never the values. |
| **Rate** | `lib/http/rateLimit.ts` | Volume. Fixed window over the existing `AuthAttempt` ledger, keyed on a one-way hash — never the email or address itself. |
| **Address** | `lib/http/clientIp.ts` | One correct reading of `x-forwarded-for` instead of eleven. |
| **Trail** | `SIGNAL_KINDS.boundaryRejected`, `.rateLimited` | Every refusal leaves a record carrying the surface and the reason. Never the body. |

The order is `size → read → parse → shape → rate`, and it is the design: a rate
limit keyed on caller-supplied input that was never validated is a limiter with
an unlimited number of buckets.

## Every route

| Route | Who may call it | What guards it now |
|---|---|---|
| `register` | anybody | **size 4 KB · schema · 10/addr + 5/email per 15 min.** Unauthenticated, writes a row, and runs a bcrypt hash per call. |
| `chat` | signed in | **8000-char message cap · 120/user/hour.** The daily token ceiling caps spend per day; nothing capped the rate. |
| `j4/speak` | signed in, `GENESIS_CHAT` | **size · schema · 60/user/hour.** Every call is paid synthesis. |
| `generate-store-draft` | signed in | **20/user/hour.** Each call is a ~100-second model generation. Shape stays with `generateStoreDraftForApi`, which is the authority on it. |
| `blob/product-image-upload` | signed in | **600/user/hour.** Mints a token authorising a billed write. |
| `blob/business-asset-upload` | signed in | **600/user/hour.** Same. |
| `creation/blank` | anybody | **600/addr per 10 min.** Host allow-list already stopped it being a general fetcher; nothing stopped the volume. |
| `diag-client-log` | signed in | **size · `logSafeText` · 300/user per 10 min.** Was writing caller-supplied text straight into production logs. |

## Deliberately not rate limited — and why

| Route | Reason |
|---|---|
| `webhooks/stripe`, `webhooks/paypal/[storeId]`, `webhooks/easypost`, `webhooks/stripe-platform`, `integrations/[provider]/webhook` | **A provider burst is legitimate traffic.** Refusing one drops an order, a refund or a chargeback. The signature is the control, and it is stronger than a limit: an unsigned request is rejected at zero cost and recorded. The suite asserts these stay unlimited, so nobody adds one later without thinking. |
| `cron/sync`, `cron/tick`, `cron/status` | **Throttling our own scheduler is self-harm.** `CRON_SECRET` is the control and it fails closed when unset. |
| `storage/cleanup`, `storage/ledger`, `storage/report` | Platform-admin only. The allowlist is the control; a limit on an operator diagnostic protects nothing and hides an incident. |
| `auth/[...nextauth]` | NextAuth's own handler. Sign-in throttling already lives inside the credentials provider (`lib/auth/attemptThrottle.ts`) where it can see success and failure — the thing a route-level limiter cannot. |
| `checkout/paypal/return` | A redirect the customer's browser follows once, carrying a PayPal order token. The token is single-use and the capture is idempotent; a limit here would strand a real buyer mid-purchase. **Open item: its query parameters are still unvalidated.** |
| `integrations/[provider]/callback`, `onboarding/fulfillment/callback` | OAuth returns, protected by state. **Open item: query parameters unvalidated.** |
| `creation/blank-trace`, `creation/product-trace`, `draft-status`, `chat/recent-messages` | Authenticated reads that touch no third party and mint nothing. Cheap by construction. |

## What this pass did not do

- ~~Query-string validation on the GET callbacks~~ — **done.** Three routes read
  a query string that a stranger can put text into: the two OAuth returns and
  the PayPal return. (An earlier draft of this document said "four"; the count
  was wrong. Seven routes read `searchParams` in total — `storage/ledger`
  already compared strictly against a literal, and the two trace routes are
  platform-gated diagnostics.) `state` remains verified by
  `completeOAuthHandoff` and the PayPal token remains single-use; what was added
  is a bound, because `code` reaches a token exchange and `slug` reaches a
  database lookup, and neither had a length or a character class. Every route
  keeps its own failure path — a redirect a person can act on, not a 400.
- **`diag-client-log` still exists.** Its own comment says it was never meant to
  ship long-term. Bounded rather than deleted, because removing a diagnostic
  somebody may still rely on is a decision.
- **Email is unique but not normalised.** Deliberately untouched — see
  `EXTERNAL_BLOCKERS.md` **E11** for the exact current behaviour and what a safe
  migration requires. Registration and authentication semantics are unchanged by
  this commit.
- **Account enumeration on registration** is unchanged and now documented in the
  route. The honest fix needs an email provider this platform does not have.
