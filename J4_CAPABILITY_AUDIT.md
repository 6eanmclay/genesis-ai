# J4 Capability Audit

**Status: AUDIT. No code changed to produce this — every row below is traced against the real, current code (`GENESIS_ACTIONS`, the unified chat tools, `businessProfile`/data-answer context, and every real Server Action in `app/dashboard/ai-actions.ts`), not assumed from what the UI appears to support.**

Date: 2026-08-08. Requested after multiple real-device tests each surfaced a different capability gap one at a time (asset persistence, product renaming, product deletion before this session's fix) — this audit exists so gaps get found and prioritized together instead of patched one real-user complaint at a time.

---

## How to read this

Each row distinguishes two genuinely different problems, per Sean's explicit instruction:

- **Capability gap** — the underlying mechanism (an `Executable`, a database write, a real action) does not exist at all. J4 cannot do this no matter how the request is phrased.
- **Routing gap** — the mechanism exists and works (often already used by a manual dashboard form), but nothing in the conversational tool-routing layer (`lib/execution/genesisTools.ts` / `STORE_CHAT_UNIFIED_SYSTEM_PROMPT` / the unified call's branches) can reach it. J4 has the capability; the conversation can't find it.

**Approval level** uses the real, existing vocabulary from `lib/execution/genesisActions.ts` — `auto` (executes immediately), `always_ask` (creates a real `ApprovalRequest`, needs a click), or `read-only` (nothing to approve, it's just an answer). Category ceilings are hard-coded and already enforce that `money`/`destructive` actions can never be delegated past `always_ask` — that boundary is not up for revision here.

**Priority** is mine, explained in the closing section — Critical / High / Medium / Low, weighted by how often a real owner would naturally ask for it and how confusing it is when J4 can't.

---

## 1. Business Identity

| Capability | Can J4 do it? | How | Why not / what's missing | Approval | Priority |
|---|---|---|---|---|---|
| Answer "what's our brand story / mission / target audience" | Yes | `businessProfile.identity` in the data-answer context | — | read-only | — |
| Rename the store, change tagline/description | Yes | `update_store_identity` via `edit_store_content` → PRIMARY | Just fixed this session (routing gap: a second, independent classification call could silently disagree with the first and downgrade a real rename into pure conversation) | always_ask | — |
| Change brand story/mission/vision/values/personality/voice/USP | Yes | `update_brand_identity`, same routing | — | always_ask | — |
| Change visual/design direction (mood, photography style, icon style) | Yes | `update_design_direction`, same routing | — | always_ask | — |

**This area is solid.** No open gap — it's the one area this session's own work already hardened.

---

## 2. Products

| Capability | Can J4 do it? | How | Why not / what's missing | Approval | Priority |
|---|---|---|---|---|---|
| Answer "what do we sell / what's the price of X" | Yes | `currentProducts` in context | — | read-only | — |
| Create a new product from an uploaded photo | Yes | `create_product`, triggered by `classifyAndExtractAsset`'s product-proposal detection | — | always_ask | — |
| **Create a new product from a plain instruction** ("add a ring, $45, hand-hammered copper") | **No** | — | **Routing gap.** `create_product`'s `Executable` and `GENESIS_ACTIONS` entry already exist and work — nothing in the unified tool router can reach them from a direct instruction. `edit_store_content` explicitly excludes products ("You do not handle individual product edits"); no other tool covers it. | always_ask | **High** |
| **Edit an existing product's name/price/description** ("change the ring's price to $50") | **No** | — | **Routing gap.** `editProductExecutable` already exists (used by the manual Products page form) and is fully functional — it is simply never registered in `GENESIS_ACTIONS`, the same exact shape `delete_product` was in before this session's fix. | always_ask | **Critical** — this is the most natural "talk to your business partner" sentence in the whole audit and it currently goes nowhere. |
| Replace/regenerate a product's photo | Yes | `update_product_image` via `request_image_change` | — | always_ask | — |
| Remove an obsolete product | Yes | `delete_product` via `request_product_removal` | Fixed this session | always_ask | — |
| **Activate/deactivate a product** ("hide the wipes, don't delete them") | **No** | — | **Capability gap in the conversational layer, but not in the system** — `toggleProductActiveExecutable` exists (manual form only), never registered in `GENESIS_ACTIONS`, no tool routes to it. Same shape as the edit gap above. | auto or always_ask (low blast radius — reversible) | **Medium** |

**Products is the single most inconsistent area in the product** — creation, deletion, and image changes all work conversationally; the single most common everyday edit (price/description) does not.

---

## 3. Storefront / Website

| Capability | Can J4 do it? | How | Why not / what's missing | Approval | Priority |
|---|---|---|---|---|---|
| Change hero headline/subheadline | Yes | `update_hero` via `edit_store_content` | — | always_ask (deliberately locked — "storefront's single most visible element") | — |
| Change homepage content (about us, why choose us, FAQ, newsletter, footer, featured collections) | Yes | `update_homepage_content`, same routing | — | always_ask | — |
| Reorder homepage sections | Yes | `update_section_order`, same routing | — | always_ask | — |
| Change theme (colors, typography, layout, card/button style) | Yes | `update_theme`, same routing | — | always_ask | — |
| Publish/unpublish the storefront | **No** | — | **Routing gap.** `toggleStorePublished` exists and works (manual toggle on Website), no conversational path — "put the store live" or "take it down for maintenance" has nowhere to go. | always_ask (a real, highly visible state change) | **High** |
| Change shipping/return/privacy policy or terms | Yes | `update_store_content`, `edit_store_content` routing | — | always_ask | — |
| SEO title/meta description | Yes | `update_seo`, same routing | — | **auto** (the one action that's earned autonomous execution) | — |

---

## 4. Images and Documents

| Capability | Can J4 do it? | How | Why not / what's missing | Approval | Priority |
|---|---|---|---|---|---|
| Receive an uploaded photo/document, see it, describe it | Yes | `uploadBusinessAssetFromChat` + `classifyAndExtractAsset` | — | read-only (ingestion, not a decision) | — |
| Receive a large batch reliably | Yes | Fixed this session — chunked, retryable, real progress | — | — | — |
| Regenerate/replace a product photo | Yes | `request_image_change` → `update_product_image` | — | always_ask | — |
| **Persist an uploaded image/document as a designated business asset** ("save this as our primary logo") | **No** | — | **Real capability gap**, not routing — there is no designation concept anywhere in the schema. Full architecture recommendation already given and approved in principle; explicitly the next milestone after this audit. | TBD (see the asset-designation memo) | **Critical** — this is the exact real-device finding that prompted this whole audit. |
| Generate new artwork/imagery on request ("can you draw a new logo") | **No** | — | **Real capability gap.** No image-generation-on-demand tool exists in chat (product-photo sourcing exists, but it searches/generates for an existing product, it isn't a general "draw me X" capability). Already named as a known, deferred gap earlier this session. | always_ask | Medium |

---

## 5. Business Assets (the persistent library, not the upload event)

| Capability | Can J4 do it? | How | Why not / what's missing | Approval | Priority |
|---|---|---|---|---|---|
| Recall a recently uploaded asset in conversation | Yes | `businessProfile.assets` (`recentAssets`) | — | read-only | — |
| **Designate an asset as "the" primary logo / brand guide / supplier agreement** | **No** | — | Same gap as row above — this is that gap's real, general form. See the approved architecture direction (role + relationship/scope + supersession). | TBD | **Critical** |
| **"Show me the assets I've given you for this product"** | **No** | — | **Capability gap.** `relatedRecordId`/`relatedEntityType` already exist on the Asset entity for exactly this kind of link, but nothing queries by it conversationally today — recall is recency-based, not relationship-based. | read-only | High (bundled with the designation milestone — same underlying query need) |
| Browse/search all uploaded assets | **No** | — | **Capability gap.** Approved in `BUSINESS_ASSETS_ARCHITECTURE.md` (M4) but never built. | read-only | Medium |

---

## 6. Orders

| Capability | Can J4 do it? | How | Why not / what's missing | Approval | Priority |
|---|---|---|---|---|---|
| Answer "how many orders, how much revenue, what's recent" | Yes | `buildChatDataContext` (revenue, recent transactions) | — | read-only | — |
| **Mark an order fulfilled / check fulfillment status conversationally** | **No** | — | **Routing gap.** `toggleOrderFulfilled` exists and works (manual Orders page only); order fulfillment state isn't part of the data-answer context either, so J4 can't even *answer* "is order #1234 fulfilled" today, let alone act on it. | always_ask or auto (routine, reversible) | Medium |
| Refund an order | **No** | — | **Real capability gap.** No refund executable exists anywhere in the codebase yet. | always_ask, hard-locked (`money` category ceiling) | Medium — real, but genuinely money-risk, deserves its own careful design, not a quick add |

---

## 7. Customers

| Capability | Can J4 do it? | How | Why not / what's missing | Approval | Priority |
|---|---|---|---|---|---|
| Answer "who are my top customers / repeat buyers / lapsed customers" | Yes | `topContacts`, computed segments in `businessProfile` | — | read-only | — |
| Add a customer/contact manually (not synced from an order or connected system) | **No** | — | **Real capability gap** — `capture_business_fact`'s tool only covers goal/challenge/employee/location; `contact` isn't a conversational-capture entity type today. Arguably correct as-is (customers should come from real orders/syncs, not be fabricated) — flagged, not necessarily a real gap to close. | always_ask | Low |
| Message/email a specific customer | **No** | — | See Communications (§13) — same underlying gap. | always_ask | see §13 |

---

## 8. Payments

| Capability | Can J4 do it? | How | Why not / what's missing | Approval | Priority |
|---|---|---|---|---|---|
| Connect/disconnect Stripe or PayPal | No, by design | Manual only (`connectStripe`/`connectPaypal`) | **Correctly out of conversational scope** — this is a real OAuth/credential flow; it should never be conversational. Not a gap. | N/A | — |
| **Answer "is Stripe/PayPal connected, is anything wrong with my payment setup"** | **No** | — | **Real capability gap.** Unlike QuickBooks/Mailchimp/Google Calendar, payment connection status isn't part of `businessProfile.connectedSystems` at all — J4 has no visibility into this even to *describe* it, despite it being one of the most operationally important questions a business partner should be able to answer. | read-only | **High** |
| Purchase Growth Points / manage billing / change plan | No, by design | Manual only | **Correctly out of conversational scope** — real payment action. | N/A | — |

---

## 9. Integrations

| Capability | Can J4 do it? | How | Why not / what's missing | Approval | Priority |
|---|---|---|---|---|---|
| Connect/disconnect QuickBooks, Mailchimp, Google Calendar, etc. | No, by design | Manual only (credential/OAuth) | Correctly out of conversational scope. | N/A | — |
| Answer "what's connected, is anything stale/broken" | Yes | `businessProfile.connectedSystems` (`syncedAgoLabel`, `isStale`) | — | read-only | — |
| Trigger a manual re-sync | **No** | — | **Routing gap.** `syncIntegration` exists and works (manual button only); "resync my QuickBooks" has no conversational path. | auto (low-risk, no state change beyond refreshing data) | Low |

---

## 10. Business Information / Knowledge

| Capability | Can J4 do it? | How | Why not / what's missing | Approval | Priority |
|---|---|---|---|---|---|
| Remember a stated goal, challenge, new employee, new location | Yes | `capture_business_fact` | — | auto (a durable-fact write, not a storefront change) | — |
| Answer almost anything about the business from what it's been told | Yes | Full `businessProfile` in the data-answer context | — | read-only | — |
| **Remember an arbitrary reminder/note/todo** ("remind me to call the supplier next week") | **No** | — | **Real capability gap.** Doesn't fit goal/challenge/employee/location; there's no general-purpose "remember this for later" entity. See §12 Tasks — same real gap. | auto | High |

---

## 11. Recommendations

| Capability | Can J4 do it? | How | Why not / what's missing | Approval | Priority |
|---|---|---|---|---|---|
| Surface a real, ranked next-best-action | Yes | `getNextBestAction` (Growth Engine), now a card in the unified Home zone | — | matches the underlying action's own tier | — |
| Explain the reasoning behind a recommendation | Yes | `explainRecommendation` | — | read-only | — |
| Give a genuine planning answer ("build me a 90-day plan") | Yes | `look_up_business_data`'s planning-capable data-answer prompt | — | read-only | — |

**This area is solid.** No open gap found.

---

## 12. Tasks

| Capability | Can J4 do it? | How | Why not / what's missing | Approval | Priority |
|---|---|---|---|---|---|
| Surface a system-detected task (missing logo, unpublished store, etc.) as a real, clickable, context-seeded conversation | Yes | `Task` model + `startTaskConversation`, just unified into the Home redesign | — | matches the underlying action's own tier | — |
| **Create a task from a conversational instruction** ("remind me to follow up with the supplier") | **No** | — | **Real capability gap** — every `Task` today is system-detected (`runTaskDetection`); there is no owner-authored task creation path at all. Same underlying gap as §10's "remember a reminder." | auto | **High** |

---

## 13. Communications

| Capability | Can J4 do it? | How | Why not / what's missing | Approval | Priority |
|---|---|---|---|---|---|
| Plan/draft a marketing campaign | Yes | `plan_campaign` | — | read-only (planning) / always_ask to actually schedule | — |
| **Actually send a campaign or message a customer** | **No** | — | **Real capability gap, deliberately deferred** — explicitly paused pending a real Resend account ("never mock the real dependency," Sean's own earlier instruction). Not an oversight; a known, intentional dependency block. | always_ask (`communication` category, but a real send is high-consequence) | Blocked on a real credential, not a priority-ordering question |

---

## 14. Analytics / Insights

| Capability | Can J4 do it? | How | Why not / what's missing | Approval | Priority |
|---|---|---|---|---|---|
| Answer revenue/order/customer/inventory questions with real numbers | Yes | `buildChatDataContext` + `businessProfile` | — | read-only | — |
| Answer questions about connected-system data (invoices, campaign performance, appointments) | Yes | Same context, with honest staleness framing | — | read-only | — |
| Synthesize a real recommendation from beliefs/decisions/trends | Yes | `understanding.beliefs`/`recentDecisions`/`activeThoughts` | — | read-only | — |

**This area is solid.**

---

## 15. Future Automations

| Capability | Can J4 do it? | How | Why not / what's missing | Approval | Priority |
|---|---|---|---|---|---|
| Execute a real action automatically, without a click, once trusted | Yes (mechanism), barely used (in practice) | `DelegatedAuthority` + `authorizationTier: "auto"` — real, live, code-enforced | Only `update_seo` has actually earned `auto` today; every other action defaults to `always_ask` even where the category ceiling would allow more | auto (per-action, real, deliberate) | Ongoing, not a gap — a trust-earning process, not a missing mechanism |

---

## Priority order (mine, for review)

**Critical — the exact class of gap that keeps surfacing in real testing, one at a time:**
1. **Product editing** (§2) — a fully-built executable, zero conversational reach. The single most natural sentence in the whole audit currently fails.
2. **Asset designation** (§4/§5) — already scoped as the next milestone; this audit doesn't change that, it confirms it's the right call.

**High — real, frequently-plausible requests with no path today:**
3. Direct conversational product creation (§2)
4. Publish/unpublish the storefront conversationally (§3)
5. Payment connection status visibility (§8) — J4 can't even *describe* Stripe/PayPal state today
6. General-purpose reminders/tasks from conversation (§10/§12 — one real gap, appears in two areas)
7. "Show me the assets for this product" (§5) — same underlying work as the designation milestone, worth bundling

**Medium — real, but lower frequency or genuinely needs its own careful design:**
8. Product activate/deactivate conversationally (§2)
9. Order fulfillment visibility + toggling (§6)
10. On-demand image generation ("draw me a new logo") (§4)
11. Asset browse/search library (§5, already-approved M4)

**Low / not gaps:**
- Manual re-sync trigger (§9) — real but rare, low cost of the current friction
- Adding a customer/contact manually (§7) — plausibly correct to leave manual
- Payment/integration credential connection (§8/§9) — correctly out of conversational scope, not a gap
- Campaign sending (§13) — blocked on a real Resend account, not a prioritization question
- Refunds (§6) — real money risk, deserves deliberate design later, not a quick add

**The pattern worth naming directly:** every "Critical" and most "High" items are **routing gaps, not capability gaps** — the underlying `Executable` already exists for product edit, activate/deactivate, publish/unpublish, and re-sync; it's simply never registered in `GENESIS_ACTIONS` or reachable from the unified tool router. That's the same exact shape as `delete_product` before this session's fix. Closing the product-editing gap alone would very likely be the highest-leverage single fix in this entire audit — it's a known pattern, low architectural risk, and the most obviously "reasonable thing an owner would say."
