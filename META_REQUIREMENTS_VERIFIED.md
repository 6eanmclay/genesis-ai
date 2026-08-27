# Meta requirements, verified 2026-08-27

Everything below was re-checked against Meta's own current documentation on
2026-08-27, not carried over from the 2026-08-09 build. Sources are named per
claim so the next person can re-verify the same way rather than trusting this
file.

The headline, because it changes what happens next:

> **Sean can connect Cubit & Coil's own Facebook Page and Instagram account
> today, with no Meta approval of any kind.** Business Verification and App
> Review are what allow *other* Genesis merchants to connect. Those are two
> different gates, and only the second one has a queue.

---

## 1. What was already built

The Meta integration is **complete in code** and has been since 2026-08-09:
OAuth dialog, code→token exchange, short→long-lived user token upgrade, Page
token derivation, both connectors (`FACEBOOK`, `INSTAGRAM`) registered in the
integration catalog, and honest per-metric degradation.

Nothing about the architecture needed rebuilding. What it needed was
re-verification, and two things had genuinely moved.

## 2. What had gone stale, and was fixed

| Item | Was | Now | Why it mattered |
|---|---|---|---|
| Graph API version | `v21.0` | **`v26.0`** | v26.0 released 29 Jul 2026. v21.0 still works but **reaches end of life 21 Jan 2027** — a connection built on it would need moving within five months, before carrying a single merchant. |
| Instagram account metric | `impressions` | **`views`** | Meta deprecated `impressions` in **v22.0 on 21 Apr 2025**, replacing Impressions, Reel Plays, Reel Replays and Story Impressions with one unified `views`. On v22+ the old name **fails the whole call**. |

These two belong together: bumping the version without the metric rename would
have broken every account-level insight the moment it went live.

Sources: [Graph API changelog](https://developers.facebook.com/docs/graph-api/changelog),
[Instagram insights](https://developers.facebook.com/docs/instagram-platform/insights).

## 3. Permissions — confirmed still current

`pages_show_list`, `pages_read_engagement`, `instagram_basic`,
`instagram_manage_insights`.

All four names are **unchanged and valid**. Worth stating explicitly because the
Instagram platform did change underneath them: the **Instagram Basic Display
API was shut down in December 2024**, and personal accounts can no longer be
accessed at all. That is a *different product*. Genesis uses the **Instagram API
with Facebook Login**, which still carries these permission names and requires
an Instagram **Business or Creator** account **linked to a Facebook Page**.

## 4. Standard vs Advanced Access — the gate that actually matters

Meta's wording, quoted:

**Standard Access**
> "Business, Consumer, and Gaming apps are automatically approved for Standard
> Access for all permissions and features."
> "Permissions with Standard Access can only be requested from app users who
> have a role on the requesting app."

- No App Review. No Business Verification. Works in Development mode.
- Covers anyone with a **role on the app** — admin, developer, or tester.
- **This is enough to connect Sean's own Page and Instagram account and see real
  data.**

**Advanced Access**
> "Business Verification is required to get Advanced Access. In some cases
> additional App Review on an individual permission and feature basis might be
> required."
> "Permissions with Advanced Access can be requested from any app user."

- Requires **Business Verification** — this is where the **EIN** goes.
- May require per-permission App Review on top.
- Requires an annual **Data Use Checkup** once granted.
- **This is what lets every other Genesis merchant connect.**

Source: [Access levels](https://developers.facebook.com/docs/graph-api/overview/access-levels).

## 5. What Sean needs to do — in order

**Now, no waiting:**

1. [developers.facebook.com](https://developers.facebook.com/) → **My Apps** →
   **Create App** → type **Business**.
2. Add products: **Facebook Login for Business** and **Instagram** (the Facebook
   Login variant).
3. **Facebook Login → Settings → Valid OAuth Redirect URIs** — add both, since
   Facebook and Instagram are two separate connections in Genesis:
   - `https://genesis-ai-rho.vercel.app/api/integrations/facebook/callback`
   - `https://genesis-ai-rho.vercel.app/api/integrations/instagram/callback`
   - Add the `http://localhost:3000` equivalents for local testing.
4. **App Settings → Basic** → copy **App ID** and **App Secret**.
5. Put them in Vercel's environment variables (never the repo, never the client):
   ```
   FACEBOOK_CLIENT_ID=<App ID>
   FACEBOOK_CLIENT_SECRET=<App Secret>
   ```
   One pair covers both connectors — see `lib/integrations/metaShared.ts`.
6. Make sure the Facebook account that owns Cubit & Coil's Page has a **role on
   the app** (it will, as the app's creator). Standard Access covers it.
7. Confirm Instagram is a **Business or Creator** account **linked to the Page**.
   A personal account cannot be connected at all.

**Then, in parallel — this is the queue:**

8. **Business Verification** in Meta Business Manager, using the **EIN**. Meta
   asks for legal business name, address, and a document or public record that
   matches. This is the gate for other merchants, not for Sean's own store.
9. **App Review** for `instagram_manage_insights` (and any other permission
   still at Standard when Advanced is needed). Meta requires a screencast of the
   real flow and a written explanation of why each permission is needed.

## 6. What Genesis can do with the connection today

Once the two env vars exist and Sean authorises:

- Connect and store a Facebook Page and a linked Instagram Business account.
- Read Page identity, follower counts, and Page engagement.
- Read Instagram account profile, follower count, and day-period insights
  (`views`, `reach`, `profile_views`).
- Read the most recent 10 media with per-media insights.
- Surface all of it through the existing understanding layer — the same path
  every other connector uses.

Every insights call **degrades individually**: a metric Meta will not serve is
recorded as unavailable rather than failing the sync, so a partial answer is
still a connection.

## 7. What remains genuinely blocked

| Blocked | On what | Who unblocks it |
|---|---|---|
| Connecting at all | `FACEBOOK_CLIENT_ID` / `FACEBOOK_CLIENT_SECRET` not set in production | Sean — steps 1–5 |
| Any merchant other than Sean | Business Verification (EIN) + App Review | Meta, on its own timeline |
| Audience demographics | `audience_gender_age` / `audience_city` / `audience_country` are the metrics most likely to have been renamed under Meta's demographics migration. **Not verified** — the docs did not state a replacement clearly enough to change on. The call degrades to "unavailable" rather than failing, so this is safe to leave and confirm on first live connect. | First real connection |

## 8. Not verified from here

- **No live call has been made against Meta.** There are no credentials, so
  nothing in this integration has been exercised against the real Graph API.
- The demographics metric names, per the table above.
- Whether Meta's Business Verification accepts the EIN as-is — that is a
  judgment Meta makes on the documents, and no amount of code affects it.
