# The AliExpress Open Platform application

**What to submit, and the honest justification for each capability requested.**
Researched 2026-08-27. Companion to `ALIEXPRESS_REQUIREMENTS_VERIFIED.md`, which
covers the protocol; this covers the application itself.

The governing rule, Sean's own: **ask for the full legitimate capability set
first and negotiate down if necessary, rather than voluntarily limiting Genesis
before we have even tried — and misrepresent nothing.**

---

## 1. The short answer to the app-URL question

> **Yes. Genesis's existing production website is exactly what the form wants.
> No native app is needed, and building one to satisfy the form would be both
> unnecessary and a misrepresentation.**

The URL AliExpress asks for is a **callback URL** — the redirect target for
seller authorization. Its documented purpose:

> "After the seller completes the authorization, AliExpress Open Platform will
> return the authorization code to the callback URL address, and your
> application can retrieve the code and use it to get the Access Token."

That is an OAuth redirect URI. It is inherently a web address, it must be
reachable over HTTPS, and a native mobile app is not the shape being asked for.

**Use:**

```
https://genesis-ai-rho.vercel.app/api/integrations/aliexpress/callback
```

Genesis is a real, deployed, publicly reachable web application. Describing it
as one is accurate.

⚠️ **Two caveats, stated rather than glossed.**

**The callback only matters for the dropshipping group.** DS authorises per
AliExpress *account*. The affiliate group — search, product detail, freight —
authenticates with the app key and secret alone and needs no redirect at all. If
AliExpress grants only the affiliate group, this URL goes unused. Supplying it
is still correct: it is where authorization *would* land.

**That URL does not work yet, and this is a real gap rather than a formality.**
The path pattern is genuine — `app/api/integrations/[provider]/callback/route.ts`
is a live generic route — but it resolves the provider through
`getConnectorByName`, which today **throws `Unknown integration provider
"aliexpress"`**. AliExpress is currently a *sourcing source*
(`lib/sourcing/registry.ts`), not a registered *connector*
(`lib/integrations/registry.ts`), and those are two different registries serving
two different purposes.

So **if capabilities 4–5 are granted, an AliExpress connector has to be built**:
an `IntegrationProvider` enum value, an OAuth connect/verify/disconnect
lifecycle, and encrypted per-merchant token storage — the shape Printful already
has. That is real work, it does not exist, and it is not implied by anything
built so far. Supplying the URL on the form is still right: it is the address
that handler will live at, and AliExpress does not test it at application time.
It must not be described to anyone as working today.

## 2. What Genesis is — the description to submit

Written to be true, specific, and checkable. Nothing here overstates what
exists.

> **Genesis** is an AI-first e-commerce platform for small business owners. An
> owner describes their business in plain English and Genesis generates and
> operates a real storefront for them — products, payments, shipping, customer
> communication — with an AI business partner ("J4") that reasons over the
> business's actual data.
>
> Genesis is a live production application at
> `https://genesis-ai-rho.vercel.app` with real merchants, real customers and
> real orders. It already integrates Stripe and PayPal for payments, Printful
> for print-on-demand fulfillment, EasyPost and USPS for shipping and labels,
> QuickBooks, Mailchimp, Google Calendar, Facebook, Instagram and TikTok.
>
> **What we want AliExpress for.** Genesis has a product-sourcing system that
> recommends what a business could sell, based on what that business actually
> is — its own description, what it already sells, and which of its products
> have genuinely earned money. Today the only supplier behind it is Printful,
> which only does print-on-demand. AliExpress would be our wholesale/dropship
> source: the owner is shown candidate products matched to their business,
> inspects one properly, approves it, and Genesis creates it in their store.
>
> **We are an application developer integrating on behalf of the merchants who
> use our platform**, not a single merchant automating our own store.

**Do not claim**: existing AliExpress sales volume, an existing dropshipping
operation, or a merchant base already ordering from AliExpress. None of that is
true, and none of it is needed.

## 3. The capability set to request

Ask for all five. Each has a real product reason, a real call site planned, and
a stage in a lifecycle that already exists for another supplier.

| # | Capability | API group | Method | Why Genesis needs it |
|---|---|---|---|---|
| 1 | **Product search** | affiliate | `aliexpress.affiliate.product.query` | Match products to the business's own description so "What could you sell?" returns real candidates. Without it there is no integration. |
| 2 | **Product detail** | affiliate | `aliexpress.affiliate.productdetail.get` | The owner inspects a candidate — images, variants, specifications, current price — before committing. Judging a product from a search thumbnail is how people list things they regret. |
| 3 | **Freight / shipping cost** | affiliate | `aliexpress.affiliate.product.shipping.get` | Tell the owner what an item costs to deliver **before** they sell it, so margin is a fact rather than a hope. Genesis already does this for Printful and will not show a wholesale product with an unknown landed cost. |
| 4 | **Order placement** | dropshipping | `aliexpress.ds.order.create` | When a customer buys, place the supplier order automatically instead of the owner re-typing it into AliExpress. |
| 5 | **Order tracking** | dropshipping | *(DS order tracking)* | Tell the customer where their parcel is. Genesis has a delivery-state model already and currently has nothing to fill it from for a wholesale item. |

### Justification for the broad request

1–3 are one coherent capability: **discovery you can act on.** Search without
detail gives an owner a thumbnail and a guess; detail without freight gives them
a product whose real cost is unknown. Genesis's sourcing model **refuses to show
a cost it does not know** rather than defaulting it to zero — so freight is not a
nice-to-have, it is what stops the system staying silent.

4–5 are the fulfillment half. They are honestly a **later stage**, and the
application should say so: Genesis wants them for the full lifecycle and does
not need them on day one. Asking now means the approval is not a second
multi-week wait later.

## 4. The architectural line — worth knowing before applying

**The two groups authenticate completely differently, and it is not a detail.**

| | Affiliate group (1–3) | Dropshipping group (4–5) |
|---|---|---|
| Authenticates as | the **app** | an AliExpress **account** |
| Credential | app key + secret | OAuth access token, per account |
| Needs a callback URL | no | yes |
| Whose account? | Genesis's | **an open question — see below** |

**The open question, which is Sean's to answer, not AliExpress's.** If Genesis
places orders through the DS API, whose AliExpress account pays for them? Either
each merchant connects their own AliExpress account — a real per-merchant OAuth
connection, the shape Printful already has — or Genesis holds one account and
fronts the cost.

The second is the model Sean has already ruled out for postage: *"Genesis should
not become the party holding, fronting, recovering, refunding, or reconciling"*
supplier money. The same reasoning applies here, so **per-merchant OAuth is the
architecture** if capabilities 4–5 are granted. Nothing in the code assumes
otherwise — `aliexpressCapabilities.ts` records `needsOAuth: true` for both DS
capabilities precisely so this cannot be forgotten.

Requesting 4–5 does not commit to building them. It removes a queue from the
path.

## 5. Application specifics

| Field | What to put |
|---|---|
| Developer type | **Third-party / ISV** — Genesis integrates on behalf of the merchants who use it. **Not** "Self Developer", which describes automating your own store, and would be inaccurate. |
| App name | Genesis |
| App description | §2 above |
| Callback URL | `https://genesis-ai-rho.vercel.app/api/integrations/aliexpress/callback` |
| Solution / capability | Dropshipping, plus affiliate product APIs |
| Company info | Legal business name, address, EIN — the same details Meta's Business Verification wants |

**Timeline:** 1–2 business days for the app application (some sources say 2–5).
Then the finished app is **audited** before it may call production.

## 6. If AliExpress refuses part of it

**Not a failure, and the code already expects it.**
`lib/sourcing/aliexpressCapabilities.ts` models the grant as data, so a partial
approval is a configuration value rather than a rewrite:

```
ALIEXPRESS_GRANTED_CAPABILITIES=search,product_detail,freight
```

Anything not listed is reported as denied, **with a reason**, rather than
silently missing — and a capability Genesis was refused never becomes a call
that fails in front of an owner. `verify-aliexpress.ts` §12–13 assert both.

**When a refusal arrives, record here:** which capability, AliExpress's exact
wording, and what additional requirement they name. Then either meet that
requirement or apply for the narrower capability — but only after they have
actually said no.

### Refusals so far

*None — the application has not been submitted.*

## 7. Where this sits in the end state

```
business understanding          built
  → "What could you sell?"      built
  → J4 recommendations          built
  → browse / swipe              needs SEARCH
  → product analysis            needs PRODUCT_DETAIL
  → owner approval              built  (lib/sourcing/adopt.ts)
  → product creation            built
  → sourcing                    needs FREIGHT
  → fulfillment                 needs ORDER + TRACKING
```

Every stage that does not name a capability **already exists and is proven
against Printful.** AliExpress is a second supplier shape underneath machinery
that is built — which is why the capability list is what it is, and why none of
it is speculative.
