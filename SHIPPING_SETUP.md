# USPS Shipping Setup (Priority 2 — Cubit & Coil Live)

Real USPS rates, labels, and tracking for paid orders — built via [EasyPost](https://www.easypost.com), the standard way small businesses get real USPS access through one API (USPS itself has no self-serve API for a business this size). The app calls this connection "USPS Shipping" throughout, since that's what it does for you — EasyPost is just the real mechanism underneath.

## What you need to do

1. **Create a free EasyPost account** at [easypost.com](https://www.easypost.com/signup) (no credit card required to start — USPS labels are billed to a card you add later, or you can fund a small balance).
2. **Get your API key**: EasyPost Dashboard → API Keys. There are two keys — a **Test** key (fake rates/labels, free, for trying it out) and a **Production** key (real rates, real postage cost). Start with the **Test** key to confirm everything works, then switch to the **Production** key when you're ready to ship real orders.
3. **Connect it in Genesis**: go to `/dashboard/orders`, find the "USPS Shipping" card near the top, paste your API key, and click Connect.
4. **Add your ship-from address**: same page, right below the USPS card — this is the real return address USPS will print on every label (your business name, phone, and address). Required before any label can be bought.

## How buying a label works

On any paid, unfulfilled order with a shipping address, click **"Buy shipping label"**, enter the package's real weight (and dimensions if you have them — optional but improves the rate), and click Buy. This:

- Gets real USPS rates for that exact package and address
- Buys the cheapest USPS rate automatically (no rate-shopping UI in this first version — a later, separate addition if you ever want to compare carriers/services)
- Saves the tracking number, tracking link, and label (PDF/PNG) directly on the order
- Marks the order as fulfilled
- Emails the customer their tracking info — **only if real email sending is configured** (see the note below)

This is always something **you** trigger per order — it never happens automatically, since it spends real money on postage the moment you click Buy.

## Real, honest limitations (V1)

- **One carrier (USPS), one rate (cheapest available)** — no multi-carrier comparison, no rate-shopping UI. A real, separate addition if you want it later.
- **No refund/void-label flow yet** — if you buy a label by mistake, void/refund it directly in your EasyPost dashboard (EasyPost supports label refunds for most unused labels within 30 days).
- **Customer email notification depends on `RESEND_API_KEY`/`EMAIL_FROM_ADDRESS` being configured** — this is the same real dependency the password-reset flow already has, and it isn't set up in this environment yet. Without it, the label still gets bought and tracking still saves to the order — the customer just doesn't get an automatic email. This needs a real Resend account, same as Marketing Engine's own paused email milestone.
- **Not yet verified against a real EasyPost account** — everything up through "get a rate and buy it" is built against EasyPost's own current, real API and type definitions, and every guard clause (missing address, missing return address, not connected, invalid weight) is verified against the real database. The actual "call EasyPost, get a rate, buy a label" step needs your own real API key to verify end to end.
