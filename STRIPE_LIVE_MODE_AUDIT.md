# Stripe Test → Live Production Readiness Audit

**Status: AUDIT ONLY. Nothing in this document has been switched, configured, or deployed. No code or environment changes were made while producing it.**

> **Status note added 2026-08-23: this audit is HISTORICAL.** It records what
> live-mode readiness required as of 2026-08-06, and **portions of the cutover it
> describes have since been executed** — live Prices were provisioned and
> deployed, and Stripe environment variables were set, during the cutover of
> 2026-08-11. Treat the blockers listed below as the state on the date above,
> not as the current state, and verify against the live Stripe account and the
> deployed environment before acting on any of them.
>
> The audit itself is unchanged.

Date: 2026-08-06
Scope: everything required to safely accept real customer payments through Stripe, across both real integrations that exist in this codebase.

---

## 0. There are two separate Stripe integrations — both need live credentials

Genesis uses Stripe in two structurally different ways, sharing one Stripe *account* but with independent code paths and independent secrets:

| | Merchant Connect (`lib/integrations/stripe.ts`) | Platform billing (`lib/billing/stripeClient.ts`) |
|---|---|---|
| Who it charges | Each store's own customers, at checkout | Store owners, for Genesis subscriptions + Growth Point purchases |
| Stripe mechanism | Standard Connect (OAuth) | Direct platform account |
| API key used | The connected account's own OAuth access token (`new Stripe(credentials.accessToken)`) | `STRIPE_SECRET_KEY` directly |
| Webhook | `app/api/webhooks/stripe/route.ts` | `app/api/webhooks/stripe-platform/route.ts` |
| Webhook secret | `STRIPE_WEBHOOK_SECRET` | `STRIPE_PLATFORM_WEBHOOK_SECRET` |

Both must be moved to live mode together, or Genesis ends up in a mixed state where store checkout works but billing doesn't (or vice versa).

---

## 1. Required secrets — full list

| Variable | Used by | Currently in `.env` (dev) | Currently in `.env.production.local` (local snapshot) |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | Both integrations (`lib/integrations/stripe.ts`, `lib/billing/stripeClient.ts`, both webhook routes, `app/store/[slug]/success/page.tsx`) | ✅ present (test key) | ✅ present |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Not currently referenced anywhere in `app`/`lib` — grep found zero usages. Either dead, or consumed client-side somewhere not yet built. **Confirm whether this is actually load-bearing before treating it as a live-mode blocker.** | ✅ present | ❌ absent |
| `STRIPE_CONNECT_CLIENT_ID` | `lib/integrations/stripe.ts` — required for the "Connect Stripe" button to work at all; throws a real error without it | ✅ present | ❌ absent |
| `STRIPE_WEBHOOK_SECRET` | `app/api/webhooks/stripe/route.ts` (merchant/Connect events) | ✅ present | ✅ present |
| `STRIPE_PLATFORM_WEBHOOK_SECRET` | `app/api/webhooks/stripe-platform/route.ts` (Growth Point purchases, Plan subscription lifecycle) | ❌ absent from every local `.env*` file found | ❌ absent |

**Action needed for each of the 5 rows above:** obtain the **live-mode** value from the Stripe Dashboard (toggle out of Test mode first) and set it in Vercel's real production environment variables — not just the local snapshot files, which may be stale or incomplete regardless of what's actually configured on Vercel.

**Before assuming anything is missing in production**: the `.env.production.local` file in this repo is a local snapshot, not the source of truth — verify directly against the Vercel dashboard's Production environment variables. If `STRIPE_CONNECT_CLIENT_ID` really is missing there, "Connect Stripe" is already broken in production today, independent of live/test mode — worth checking regardless of live-mode timing.

**`STRIPE_PLATFORM_WEBHOOK_SECRET` needs its endpoint created first.** Since it isn't in any local file, there's a real chance the Stripe webhook endpoint pointing at `/api/webhooks/stripe-platform` was never registered at all (test or live). Check the Stripe Dashboard's Webhooks list before assuming this is just a live-mode gap.

---

## 2. Webhook endpoints — what needs to exist in live mode

Two separate endpoints, two separate Stripe Dashboard webhook registrations, **in live mode specifically** (Stripe's test-mode and live-mode webhook endpoints are entirely separate configurations, even for the same URL):

1. `https://<production-domain>/api/webhooks/stripe`
   Events needed: `checkout.session.completed` (confirmed from reading the handler — this is the only event type it currently processes).
2. `https://<production-domain>/api/webhooks/stripe-platform`
   Events needed: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` (confirmed from reading the handler).

For each: create the live-mode endpoint in the Stripe Dashboard, copy its **signing secret** (starts `whsec_...`), and set it as the corresponding env var in production. A live-mode signing secret is different from the test-mode one even for the same endpoint URL — this can't be copied over from test mode.

---

## 3. OAuth callback / redirect URLs

The callback route (`app/api/integrations/[provider]/callback/route.ts`) is generic across all providers and builds its own URL at runtime from the real incoming request's host (`lib/integrations/util.ts`'s `getBaseUrl()` / `integrationCallbackUrl()`). **There is no hardcoded callback URL anywhere in the codebase to change.**

The action needed is entirely on Stripe's side: in the Stripe Dashboard's **Connect settings → OAuth settings**, the live-mode redirect URI allowlist needs `https://<production-domain>/api/integrations/stripe/callback` added explicitly. Stripe keeps separate redirect URI allowlists for test mode and live mode, so this will not carry over automatically even though the code path is identical.

---

## 4. Test-mode assumptions found in code

### 4a. Hardcoded test-mode Price IDs — real blocker

`lib/growthPoints/purchaseCatalog.ts` hardcodes four real Stripe Price IDs for Growth Point purchase packs:

```
pack_4:  price_1U16bJBo3H6St4fl1pVnA3ld
pack_8:  price_1U16bKBo3H6St4fl5giNboiY
pack_20: price_1U16bKBo3H6St4flAYfFSirU
pack_45: price_1U16bLBo3H6St4flBHEVlZb1
```

These are test-mode Price objects — they will not exist under a live-mode Stripe key, and `platformStripe.checkout.sessions.create` (`lib/billing/checkout.ts`) will fail outright for any Growth Point purchase attempt after switching. **New live-mode Price objects must be created and these four constants updated before or at the moment of switching.**

### 4b. `Plan.stripePriceId` — same shape of blocker, needs direct verification

`app/dashboard/billing/page.tsx` only lists a Plan as subscribable when `stripePriceId` is set (`prisma.plan.findMany({ where: { stripePriceId: { not: null } } })`), and `lib/billing/checkout.ts`'s `createPlanSubscriptionCheckoutSession` uses that stored ID directly. `scripts/provision-pricing.ts` is the script that originally wrote these rows, and its own header comment describes itself as "the template for provisioning live-mode Stripe objects once Sean makes that separate, deliberate decision" — meaning the Price IDs currently in the `Plan` table are almost certainly test-mode ones from when that script was first run.

**I attempted to directly query the current `Plan` rows to confirm their live/test status but hit a local Prisma/Postgres auth error unrelated to Stripe (`SASL: client password must be a string`) — this is a local script-environment issue, not a finding about the data itself.** Before switching, directly check each `Plan.stripePriceId` in the database (or Stripe Dashboard) and confirm none of them are test-mode IDs; re-run `scripts/provision-pricing.ts` against live mode if they are.

### 4c. Where there is *no* Price ID blocker

`app/store/[slug]/actions.ts`'s `createStripeCheckoutSession` (merchant customer checkout — the actual store-to-shopper purchase flow) builds its Stripe Checkout Session with inline `price_data`, not a pre-created Price object. This path has no stored Price ID anywhere and needs no re-provisioning — it will work correctly the moment the underlying key is live, with zero code changes.

### 4d. PayPal sandbox default (not Stripe, but adjacent and worth flagging)

`app/dashboard/payments/page.tsx`'s PayPal credentials form defaults the `environment` field to `"sandbox"` (line ~273). Store owners connecting PayPal today get a sandbox-defaulted field they'd need to manually change to go live. Not part of this Stripe audit's scope, but noted since it's the same "test-mode default" failure shape.

---

## 5. Payouts, refunds, and webhook-event correctness

**Payouts (to connected merchant accounts):** Standard Connect accounts (which this app uses — confirmed via `getStripeClientForStore` using the connected account's own OAuth access token directly, with no `application_fee_amount`, `on_behalf_of`, or `transfer_data` anywhere in the codebase) own their **entire balance and payout schedule directly** in Stripe — Genesis's code has no payout logic to audit because it doesn't own any of the money. This also means **Genesis currently takes a 0% platform fee on merchant transactions.** That's a real, deliberate-or-not business-model fact worth confirming with Sean before going live, not a bug — but it's the kind of thing that's much cheaper to decide now than after real transactions start flowing.

**Refunds:** No refund-issuing code exists anywhere in the app (`grep` found no `stripe.refunds` call). Refunds today would have to be issued manually from each connected account's own Stripe Dashboard. Not a live-mode blocker, but worth naming as a real product gap if refund support is expected at launch.

**Webhook handler correctness:** Both handlers were read in full.
- `app/api/webhooks/stripe/route.ts` — correctly distinguishes `event.account` (which connected account the event came from) from `session.metadata.storeId`, and uses the trust-boundary logic already fixed for the "shared `externalAccountId` across stores" case. Idempotent via a `$transaction` + existence check on `(paymentProvider, externalOrderId)` before creating an `Order`.
- `app/api/webhooks/stripe-platform/route.ts` — handles Growth Point purchases and Plan subscription lifecycle (`created`/`updated`/`deleted`), re-fetches the subscription directly from Stripe rather than trusting event payload fields for authoritative state.

No correctness issues found in either handler. Their only live-mode dependency is the signing secret described in section 2 and the Price IDs described in section 4.

---

## 6. Remaining blockers before accepting real customer payments — summary

| # | Blocker | Type | Must fix before switching? |
|---|---|---|---|
| 1 | Live values for all 5 env vars in section 1, set in Vercel Production (not just locally) | Config | **Yes** |
| 2 | `STRIPE_PLATFORM_WEBHOOK_SECRET` — confirm the live webhook endpoint is even registered in Stripe, not just the env var | Config | **Yes** |
| 3 | Two live-mode webhook endpoints created in Stripe Dashboard with correct event subscriptions (section 2) | Config | **Yes** |
| 4 | Live-mode OAuth redirect URI added to Stripe Connect settings (section 3) | Config | **Yes** |
| 5 | `purchaseCatalog.ts`'s 4 hardcoded Price IDs re-provisioned live and updated in code | Code + Stripe Dashboard | **Yes, if Growth Point purchases should work at launch** |
| 6 | `Plan.stripePriceId` DB rows re-provisioned live (verify first — script access blocked locally, needs direct DB or Dashboard check) | Data | **Yes, if paid Plan subscriptions should work at launch** |
| 7 | Confirm `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is actually used anywhere before treating it as required | Investigation | Should confirm, low risk either way |
| 8 | Decide platform fee policy (currently 0%, Standard Connect) before real transactions start | Business decision | Should decide, not a technical blocker |
| 9 | No refund-issuing code exists; refunds are dashboard-manual per connected account today | Product gap | Not a switch blocker, worth knowing |
| 10 | PayPal credentials form defaults to sandbox (unrelated to Stripe) | Minor UX gap | Not a Stripe blocker |

Items 1–4 are pure configuration and can be done in parallel any time. Items 5–6 are the two real go/no-go items: without them, Growth Point purchases and Plan subscriptions will fail immediately after the key switch, while merchant storefront checkout (the actual customer-facing payment flow) will keep working correctly with zero changes because it never depended on a stored Price ID.

**Recommended order when ready to proceed:** confirm the live Stripe account is fully activated (business details, bank account) → create both live webhook endpoints and grab their secrets → add the live OAuth redirect URI → provision live Price objects for Growth Points and re-run `provision-pricing.ts` for Plans → set all 5 env vars in Vercel Production → switch `STRIPE_SECRET_KEY` (and the platform stops being test-mode the moment that one key changes, since every Stripe client in this codebase reads it directly) → verify with one real low-value live transaction through each of the three paths (storefront checkout, Growth Point purchase, Plan subscription) before calling it done.
