# Social Connections setup (Facebook, Instagram, TikTok)

The code is fully built and typechecks/builds clean, but nothing can be verified live until real developer app credentials exist. This is exactly what to go create, and exactly where the resulting values go.

## 1. Meta (covers both Facebook and Instagram — one app)

1. Go to [developers.facebook.com](https://developers.facebook.com/) → **My Apps** → **Create App**.
2. Choose app type **Business**.
3. In the app dashboard, add these two products:
   - **Facebook Login for Business**
   - **Instagram Graph API** (this is what exposes Instagram Business/Creator account data via a linked Facebook Page — there is no separate "Instagram-only" login for this use case)
4. Under **Facebook Login for Business → Settings**, add this **Valid OAuth Redirect URI** (both are needed, since Facebook and Instagram are two separate connections in Genesis):
   - `https://<your-production-domain>/api/integrations/facebook/callback`
   - `https://<your-production-domain>/api/integrations/instagram/callback`
   - (add the same two with `http://localhost:3000` while testing locally)
5. Under **App Settings → Basic**, copy the **App ID** and **App Secret**.
6. **Permissions**: the app needs `pages_show_list`, `pages_read_engagement`, `instagram_basic`, and `instagram_manage_insights`. The first two are usually available immediately in development mode. **`instagram_manage_insights` requires Meta's App Review, and likely Business Verification** (proving you're a real business) before it works for anyone other than your own test accounts — this is a real Meta process that can take from a day to over a week, not something either of us can skip or speed up. You can test the connection flow itself (and basic follower counts) before that approval finishes; the deeper insights/demographics calls will fail honestly until it's granted.
7. Add these to your environment (`.env.local` for local dev; Vercel's Environment Variables for production — same as every other credential in this project):
   ```
   FACEBOOK_CLIENT_ID=<the App ID>
   FACEBOOK_CLIENT_SECRET=<the App Secret>
   ```
   (One pair covers both the Facebook and Instagram connectors — see `lib/integrations/metaShared.ts`.)

## 2. TikTok

1. Go to [developers.tiktok.com](https://developers.tiktok.com/) → **Manage apps** → **Connect an app** (or Create App).
2. Add the **Login Kit** product.
3. Under Login Kit settings, add this **Redirect URI**:
   - `https://<your-production-domain>/api/integrations/tiktok/callback`
   - (add `http://localhost:3000/api/integrations/tiktok/callback` while testing locally)
4. Request these **Scopes** for the app: `user.info.basic`, `user.info.stats`, `video.list`. Basic scopes are usually available right away in sandbox/development; production access for a real (non-test) account requires TikTok's own app review.
5. From the app's **Basic Information** page, copy the **Client Key** and **Client Secret**.
6. Add these to your environment:
   ```
   TIKTOK_CLIENT_KEY=<the Client Key>
   TIKTOK_CLIENT_SECRET=<the Client Secret>
   ```

## 3. What's honestly NOT available, by design

TikTok's standard Login Kit scopes above do not expose audience demographics, reach, or impressions — those live behind TikTok's separate, more restricted Business/Ads-adjacent API tiers. The TikTok connector reports this honestly (`unavailableMetrics` on every synced record) rather than estimating numbers TikTok doesn't actually provide. Facebook Pages don't expose audience age/gender/city/country breakdowns either (that data lives on the Instagram side) — same honest handling.

## 4. Once credentials exist

1. Set the four env vars above (locally first, for a real end-to-end test).
2. Go to `/dashboard/connections` → **Social Media** → connect Facebook, Instagram, and/or TikTok with a real account.
3. Hit **Sync now** on each connected card.
4. Ask J4 (in the J4 Portal or dashboard chat) something like "how's my social media doing?" — this is the real test of the whole point of this feature: J4 should compare/interpret, not just recite numbers.

Tell me once this is done and I'll do the live verification pass — checking the real OAuth round trip, a real sync, and confirming J4's answer is actually grounded in the real synced numbers rather than anything fabricated.
