import Stripe from "stripe";

// Chapter 5 (Payments) — the platform's own direct-charge Stripe client:
// Genesis IS the merchant of record here (billing the store owner), the
// opposite direction from lib/integrations/stripe.ts's Connect-OAuth client
// (the merchant's own connected account, billing THEIR customers). Same
// underlying Stripe account and the same STRIPE_SECRET_KEY env var — a
// platform account can be a Connect platform and sell its own things at
// the same time — but a deliberately separate client/module so the two
// concerns never get tangled in one file.
export const platformStripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
