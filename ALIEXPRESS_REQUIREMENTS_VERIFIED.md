# AliExpress requirements, verified 2026-08-27

Checked against AliExpress Open Platform's current published documentation and
the established client implementations of its signing algorithm. Sources are
named per claim so the next person can re-verify rather than trusting this file.

The headline, because it changes what happens next:

> **AliExpress cannot be connected today, and unlike Meta there is no
> equivalent of Standard Access that lets Sean connect his own account first.**
> Credentials come only after an application, and the app is audited before it
> may call production. Everything is built and tested against the documented
> protocol; the first live call is what confirms it.

---

## 1. What changed

`lib/sourcing/aliexpress.ts` was a declared-but-unimplemented source that always
answered `not_configured`. That answer is what an owner saw as **"Places I
couldn't look — AliExpress"** on *What you could sell*.

It now performs a real signed search whenever `ALIEXPRESS_APP_KEY` and
`ALIEXPRESS_APP_SECRET` are set, and reports four distinct outcomes when it
cannot.

**What did not change** is the rule that produced the old behaviour, because it
was never a placeholder: there is still no mock catalog, and there will not be
one. "No results" and "I was never able to look" remain different answers with
different next actions.

| File | What it is |
|---|---|
| `lib/sourcing/aliexpressProtocol.ts` | **Pure.** Signing, request shaping, response parsing, failure classification. No network, no environment, no secret. |
| `lib/sourcing/aliexpressClient.ts` | `server-only`. The only file that reads the secret and the only one that makes a request. |
| `lib/sourcing/aliexpress.ts` | The `ProductSource` the registry holds. Maps AliExpress failures to owner-facing ones. |
| `scripts/verify-aliexpress.ts` | 85 assertions, no credentials needed. |
| `scripts/check-aliexpress-live.ts` | One real search, when credentials exist. **Never run.** |

## 2. The signature, exactly

Four steps, and each is a place to get it wrong quietly — a wrong one still
produces a plausible 32-character string that the gateway simply refuses:

1. Sort every parameter **by key**
2. Concatenate key and value in that order, **with no separators at all**
3. Wrap the result in the app secret on **both** sides
4. **MD5, hex, UPPERCASE**

```
MD5( SECRET + "app_key12345methodaliexpress.affiliate.product.queryv2.0" + SECRET )
```

The signature covers the **system parameters and the method's own arguments
together**. Signing only the system half is another way to produce a string that
looks right and is refused.

Every parameter goes to AliExpress. **The secret is not one of them** — it is
used only to compute the MD5 on Genesis's side.

**The limit of this verification, stated rather than implied.** This matches the
algorithm as documented publicly and implemented by the established client
libraries. AliExpress's own reference sits behind a developer login this project
does not have. `verify-aliexpress.ts` proves the implementation against a vector
computed by hand from that specification — not against output captured from the
code under test, which would have agreed with any bug the code contains. Only a
real call settles which is right, and `check-aliexpress-live.ts` is the thing
that will settle it.

## 3. Request format

| | |
|---|---|
| Gateway | `https://api-sg.aliexpress.com/sync` — **HTTPS**; the endpoint is also published over plain HTTP, and signing a request does not encrypt the body it is attached to |
| Method | POST, `application/x-www-form-urlencoded` |
| System params | `app_key`, `method`, `timestamp`, `sign_method=md5`, `format=json`, `v=2.0`, `sign` |
| Timestamp | `yyyy-MM-dd HH:mm:ss` in **UTC** — not an ISO 8601 string |
| Search method | `aliexpress.affiliate.product.query` |

## 4. Failures, and why they are kept apart

**AliExpress answers HTTP 200 for almost everything, including failures**, and
puts the real outcome in the body. A client trusting the status code would read
an authentication failure as a successful search with no results — exactly the
confusion this sourcing layer exists to prevent.

| AliExpress says | Genesis says | Whose move |
|---|---|---|
| `IllegalAppKey`, `InvalidSignature`, code 27 | `not_connected` — "AliExpress rejected Genesis's app credentials" | Sean, at AliExpress |
| `InsufficientIsvPermissions` | `not_connected` — "not approved for catalog search yet" | AliExpress |
| `AppCallLimit`, code 7 | `provider_error` — "will work again shortly" | Nobody; it resolves |
| Anything unrecognised | `provider_error`, carrying AliExpress's own words | — |
| No credentials set | `not_configured`, naming both variables | Sean, here |

**A bug found and fixed while building this**, recorded because the shape
recurs: the first implementation matched error codes by substring. A bare `7`
for the call-limit code also matches the 7 inside **27** — invalid session — so
an authentication failure was classified as throttling. The owner would have
been told to "try again shortly" about the one thing they could have fixed.
Codes are compared as numbers now, and `verify-aliexpress.ts` §4 asserts it.

## 5. Where the credentials live

AliExpress issues **one** app key and secret to Genesis, **not one per
merchant** — platform credentials of exactly the same kind as USPS's. So they
follow the same rule: server environment variables, read at call time, never
asked of an owner, never belonging to a store.

```
ALIEXPRESS_APP_KEY=<App Key>
ALIEXPRESS_APP_SECRET=<App Secret>
ALIEXPRESS_TRACKING_ID=<optional>
```

Four things enforce that the secret stays server-side, and all four are
asserted in `verify-aliexpress.ts` §10 rather than left as intentions:

- `aliexpressClient.ts` opens with `import "server-only"` — a **build error**,
  not a lint warning, for any client component that imports it however
  indirectly.
- It is the **only** file that reads `ALIEXPRESS_APP_SECRET`.
- The pure protocol module reads **no environment at all**.
- No file hard-codes a credential value.

`aliexpress.ts` reads the two variables to answer `blockedOn`, and imports the
client **dynamically** — a top-level `server-only` import would not fail loudly
outside Next; it would stop the module loading, which is how a source silently
disappears from discovery.

## 6. Why `blockedOn` had to become a getter

`discoverProducts()` checks `blockedOn.length > 0` and, when non-empty, reports
the source as unavailable **without calling `search()` at all**. That is the
right design — a known configuration gap should not become a provider error in
the logs — but a static array would have made every line of the search
implementation unreachable forever, **with nothing failing to say so**. The
source would have kept answering "not configured", which is exactly what it did
before.

So `blockedOn` answers from the environment as it is now. `verify-aliexpress.ts`
§8 and §11 assert both directions, and reverting it to a static array fails four
assertions.

## 7. What Sean needs to do — in order

1. [openservice.aliexpress.com](https://openservice.aliexpress.com/) → register a
   developer account.
2. Sign the **Open Platform Agreement** and complete the **company information**
   form. The EIN and legal business name go here, the same details Meta's
   Business Verification wants.
3. Create an app. Request the **affiliate / dropshipping** API scope —
   `aliexpress.affiliate.product.query` is the method Genesis searches with.
4. Wait for approval: **1–2 business days**, stated by AliExpress.
5. Copy **App Key** and **App Secret** into Vercel's environment variables
   (never the repo, never the client).
6. Run the live check before trusting anything:
   ```
   npx tsx scripts/check-aliexpress-live.ts .env.livecheck
   ```
   It performs one read-only search, writes nothing on either side, and prints
   which of the four failure kinds came back if it fails. The secret is passed
   by file, never on the command line — so it never enters shell history.
7. **App audit.** AliExpress audits the finished app before it may call
   production. Genesis's usage is a catalog search on the owner's behalf; there
   is nothing to change in the code for it.

## 8. What Genesis can do once connected

- Search the AliExpress catalog from the business's **own words** — the sourcing
  contract carries no raw customer query.
- Surface results on **What you could sell** (`/dashboard/catalog`) through the
  same path Printful already uses: `catalogView` → `discoverProducts` →
  `getProductSources` → `aliexpressSource.search`.
- Stop listing AliExpress as somewhere Genesis could not look.

Wholesale is a different **shape** from print-on-demand and the model already
knows it: nothing is customisable, no listing is created, the supplier ships
direct, and Genesis states no economics for it. Offering "add your logo" on a
wholesale listing would be a promise to a customer the supplier never heard.

An unreadable price is recorded as **unknown, never zero** — zero would let an
owner list an item at a loss believing it cost nothing.

## 9. What remains blocked

| Blocked | On what | Who unblocks it |
|---|---|---|
| Connecting at all | No AliExpress app; `ALIEXPRESS_APP_KEY` / `ALIEXPRESS_APP_SECRET` unset | Sean — steps 1–5 |
| Calling production | App audit | AliExpress, on its own timeline |
| Re-quoting one item | `quote()` answers honestly that the search price is the price. A wholesale supplier does quote, and the method exists, but the per-item call is not built | Genesis, once search is confirmed live |

## 10. Not verified from here

- **No live call has been made against AliExpress.** There are no credentials.
  Nothing in this integration has touched the real gateway.
- **The signature**, per §2 — proven against the published specification, not
  against the vendor's own reference or a real response.
- **The response nesting** in `readProducts()` is written against the documented
  shape and defends against every variant it might be instead: it never throws
  on shape, and returns an empty list rather than crashing a search. Which
  nesting is actually returned is a fact only a live call produces.
- Whether AliExpress's approval accepts the company details as submitted — a
  judgment AliExpress makes, which no amount of code affects.
