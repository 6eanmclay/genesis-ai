# Xero requirements, verified 2026-08-27

Checked against Xero's own current documentation. Sources are named per claim so
the next person can re-verify rather than trusting this file.

> **Xero is not connected.** No Xero application exists, so no client
> credentials exist and no consent screen has been reached. Everything below is
> built and proven by 95 assertions that need no account; §7 is the exact list
> of what you provide to finish it.

---

## 1. Why Xero

`CONNECTIONS_MILESTONE.md` records that **QuickBooks is the only connector that
has ever produced business data here** — 41 records, 43 of 47 business events —
and that it has been dead since 2026-08-01. Xero is the same capability for the
businesses that don't use QuickBooks. Not a new category; the other half of the
market for the one category that has demonstrably paid off.

## 2. THE THING THAT WOULD HAVE BEEN WRONG FROM MEMORY

**Xero replaced its two broad OAuth scopes with ten granular ones on 2 March
2026.** Apps created before then have until September 2027 to migrate. **Apps
created on or after that date have no access to the broad scopes at all.**

Genesis's app does not exist yet, so it will be created after that date. Every
pre-2026 tutorial, and any memory of this API, names `accounting.transactions` —
which would simply fail.

The scopes actually requested:

```
openid  profile  email  offline_access
accounting.settings.read   accounting.contacts.read   accounting.invoices.read
```

**`offline_access` is not optional.** Without it Xero issues no refresh token,
and the access token lasts thirty minutes — a connection needing re-consent
every half hour is not a connection.

**Every accounting scope ends `.read`.** Genesis explains a business's books; it
never writes to them. `capabilities.writes` is `[]` and the scopes are what make
that true.

Source: [Xero scope changes](https://www.apideck.com/blog/xero-scopes).

## 3. THE THING THAT KILLED QUICKBOOKS HERE

**Xero refresh tokens rotate.** Exchanging one invalidates it and returns a new
one. A connector that keeps refreshing with the token it first stored works
**exactly once** and then dies with `invalid_grant` — quietly, because nothing
was wrong at the moment of connecting.

That is not hypothetical. It is what took QuickBooks down in this codebase for
eighteen days, and it is why `capabilities.tokenLifetime` exists as a field at
all. Xero is declared `"rotating"`.

| | |
|---|---|
| Access token | **30 minutes** |
| Refresh token | 60 days unused; **rotates on every exchange** |
| Grace period | Xero honours the previous refresh token for **30 minutes**, so a failed round trip can be retried |

That grace period is why a refresh that **errors** must keep what it has.
Discarding on error would turn a recoverable network blip into a dead connection
the owner has to redo by hand.

Both rules are pure functions in `xeroProtocol.ts` (`rotatedCredentials`,
`credentialsAfterFailedRefresh`, `shouldRefresh`) so they are *proven* rather
than described. An earlier version of the suite asserted this by grepping the
connector's source for a comment — testing prose, not behaviour — and
comment-stripping quite rightly broke it.

## 4. A TOKEN NAMES NO ORGANISATION

Unlike every other connector here, a Xero access token is **not enough to read
anything**. One authorization can cover several organisations, and every API
call needs an explicit `Xero-Tenant-Id` header. There is no default.

So `connect()` makes a **second call** to `https://api.xero.com/connections`
before it can claim success, and picks the first tenant whose `tenantType` is
`ORGANISATION` — not simply the first entry, because Xero returns other tenant
types alongside them and reading one as if it were the business's books would
produce confident nonsense.

A consent that shares no organisation is a real outcome, and it fails the
connection with a message saying what to do, rather than storing a connection
that is connected in the database and unable to read anything in fact.

## 5. Endpoints

| | |
|---|---|
| Authorize | `https://login.xero.com/identity/connect/authorize` |
| Token | `https://identity.xero.com/connect/token` (HTTP Basic with client id/secret) |
| Connections | `https://api.xero.com/connections` |
| Revocation | `https://identity.xero.com/connect/revocation` |
| API | `https://api.xero.com/api.xro/2.0/…` |

Note the **three different hosts** — identity, connections and the API are not
one origin, which is easy to get wrong by assuming they are.

## 6. What Genesis can do once connected

- **Contacts** → `contact` records, where a business that is both customer and
  supplier keeps **both roles** — which is why `roles` is a list.
- **Invoices** → `document` records, where an **ACCPAY bill is not an invoice**.
  Recording one as the other would count an expense as revenue.
- Invoice status is derived properly: `AUTHORISED` past its due date is
  **overdue**, in date is **pending**. Xero does not fold that into `Status`.
- **Amounts are multiplied by 100** — Xero sends major units (`42.5` = $42.50).
  This is the **opposite of Square**, which already sends cents. Doing Xero's
  rule in Square's mapping would inflate every figure a hundredfold.

Disconnecting calls Xero's revocation endpoint, so ending the connection here
really ends it at Xero.

## 7. Exactly what you need to provide

1. [developer.xero.com/app/manage](https://developer.xero.com/app/manage) → **New app**.
2. Integration type: **Web app**.
3. Company or application URL: `https://genesis-ai-rho.vercel.app`
4. **OAuth 2.0 redirect URI**, exactly:
   ```
   https://genesis-ai-rho.vercel.app/api/integrations/xero/callback
   ```
   Add `http://localhost:3000/api/integrations/xero/callback` for local work.
5. Copy the **Client ID**, then **Generate a secret** and copy it — shown once.
6. Set in Vercel (never the repo, never the client):
   ```
   XERO_CLIENT_ID=<Client ID>
   XERO_CLIENT_SECRET=<Client Secret>
   ```

**No app review, no partner application, no waiting period** for a standard
integration against your own organisation. A Xero *demo company* is free and is
the fastest way to prove the connection end to end.

## 8. What remains blocked

| Blocked | On what | Who |
|---|---|---|
| Connecting at all | `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` unset | You — §7 |
| Nothing else | — | — |

Like Square, Xero has **no external approval queue**. Both are unblocked the
moment credentials exist, which is what makes them the right pair to have built
while Meta and AliExpress wait on other people.

## 9. End-to-end verification

`scripts/verify-xero.ts` — **95 assertions, no Xero account needed.**

Every record the connector would write is validated against the Foundation's
**real Zod schemas** — `persistSyncedRecords` validates on the way in, so an
almost-right mapping would look like a working sync that silently wrote nothing.

Three deliberate breaks, each confirmed to fail the suite:

| Break | Caught |
|---|---|
| Keeping the original refresh token (the QuickBooks bug) | 1 assertion |
| An unknown expiry treated as still-valid | 1 |
| An ACCPAY bill recorded as an invoice | 2 |

## 10. Not verified from here

- **No live call has been made to Xero.** No application exists.
- The live OAuth handoff and the real token rotation — the behaviour is proven
  as a pure decision, not against Xero itself.
- The exact shapes Xero returns in practice.
- The `connections` endpoint's response shape is written from Xero's published
  material; its documentation page timed out when fetched directly, so it is
  the one endpoint here confirmed from secondary sources rather than Xero's own
  page. `chooseTenant` never throws on shape, so a surprise degrades to "no
  organisation" rather than crashing.
