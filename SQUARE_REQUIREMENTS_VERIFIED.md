# Square requirements, verified 2026-08-27

Checked against Square's own current documentation. Sources are named per claim
so the next person can re-verify rather than trusting this file.

> **Square is not connected.** No Square application exists, so no client
> credentials exist and no consent screen has been reached. Everything below is
> built and proven by 90 assertions that need no account; §6 is the exact list
> of what you provide to finish it.

---

## 1. Why Square

`CONNECTIONS_MILESTONE.md` records that **QuickBooks is the only connector that
has ever produced business data here** — 41 records and 43 of the platform's 47
business events — and that it has been dead since 2026-08-01. Transactional data
is demonstrably where the value is.

Square is that data at its source for any business selling in person, and it
carries something **no other connector here provides: the product catalog**.

## 2. Permissions

Five, all read:

```
MERCHANT_PROFILE_READ   ORDERS_READ   ITEMS_READ   PAYMENTS_READ   CUSTOMERS_READ
```

**Every scope ends `_READ`, and the suite asserts it.** Square is a system the
business already operates; the non-goal this codebase has held since Phase 3 is
to leave the underlying software responsible for its own operational workflows.
Asking for a write scope Genesis never uses would be asking a merchant to grant
something on the off-chance. `capabilities.writes` is `[]`, and the scopes are
what make that claim true rather than merely stated.

Source: [OAuth permissions](https://developer.squareup.com/docs/oauth-api/square-permissions).

## 3. Approval requirements

**None to build, and none to connect your own account.** Square has no app
review for OAuth; you create an application in the Developer Dashboard and it
works. Sandbox is available immediately.

The only gate worth knowing: a **production** application needs the production
Application ID and Secret, which are separate values from the sandbox ones and
live on a different host.

## 4. What was verified, including two things easy to get wrong

| | Verified fact |
|---|---|
| Authorize | `https://connect.squareup.com/oauth2/authorize` — sandbox is `connect.squareupsandbox.com`, **a different host** |
| Token | `POST /oauth2/token` |
| Revoke | `POST /oauth2/revoke`, with `Authorization: Client APPLICATION_SECRET` — **not** `Bearer` |
| `Square-Version` | **Required**, dated, currently `2026-07-15`. Omitting it does not mean "latest" — it means whatever default Square picks |
| Access token | **30 days** |
| Refresh token | Code flow: **does not expire, does not rotate** |

**Money is already in the smallest unit.** Square's `Money.amount` is an integer
of the currency's minor unit — `4250` means $42.50. Most APIs send decimals, so
the instinct is to multiply by 100, which would inflate every figure a
hundredfold. `verify-square.ts` §5 asserts it, and breaking it fails four
assertions.

**This is the exact opposite of Xero**, which sends major units and *must* be
multiplied. The two connectors sit side by side and the rule is inverted in
each — which is why each has its own pure mapping module with the rule stated
at the top.

Sources: [OAuth overview](https://developer.squareup.com/docs/oauth-api/overview),
[revoke](https://developer.squareup.com/reference/square/o-auth-api/revoke-token),
[versioning](https://developer.squareup.com/docs/build-basics/versioning-overview).

## 5. What Genesis can do once connected

- **Customers** → `contact` records
- **Payments** → `transaction` records, with **a refund recorded as a refund**,
  not a sale. Counting one as the other would overstate revenue twice: once by
  adding it, once by never subtracting it.
- **Catalog items** → `item` records, with price and SKU read off the
  *variation* (Square puts them there, not on the item — reading `item_data`
  would silently produce null for every product)
- Everything flows into the same understanding layer every other connector uses.

**Each source degrades on its own.** A merchant who granted `CUSTOMERS_READ` but
declined `ITEMS_READ` gets their customers, not an empty sync.

**Disconnecting really disconnects.** Six connectors here honestly declare
`revokesOnDisconnect: false` because their providers offer nothing to call.
Square offers a revocation endpoint and `disconnect()` calls it — deleting a
stored token is not revoking it, and an owner told access ended while the token
stayed live has been misled.

## 6. Exactly what you need to provide

1. [developer.squareup.com](https://developer.squareup.com/) → **Applications** →
   **+** → name it *Genesis*.
2. **OAuth** page → **Redirect URL**, set to exactly:
   ```
   https://genesis-ai-rho.vercel.app/api/integrations/square/callback
   ```
   Add `http://localhost:3000/api/integrations/square/callback` for local work.
3. Copy the **Production Application ID** and **Production Application Secret**.
4. Set in Vercel (never the repo, never the client):
   ```
   SQUARE_CLIENT_ID=<Application ID>
   SQUARE_CLIENT_SECRET=<Application Secret>
   ```
5. **Optional, for testing first:** use the *Sandbox* Application ID and Secret
   instead and set `SQUARE_USE_SANDBOX=1`. Sandbox is a different host, so this
   is a deliberate switch rather than something guessed — and a sandbox token
   used against production fails as an auth error that looks exactly like bad
   credentials.

That is the whole list. Nothing else is needed and nothing waits on Square.

## 7. What remains blocked

| Blocked | On what | Who |
|---|---|---|
| Connecting at all | `SQUARE_CLIENT_ID` / `SQUARE_CLIENT_SECRET` unset | You — §6 |
| Nothing else | — | — |

Square is the **least blocked** of everything in flight: no app review, no
verification queue, no waiting period.

## 8. End-to-end verification

`scripts/verify-square.ts` — **90 assertions, no Square account needed.**

Every record the connector would write is validated against the Foundation's
**real Zod schemas** (`ContactSchema`, `TransactionSchema`, `ItemSchema`). That
matters more than it sounds: `persistSyncedRecords` validates on the way in, so
a mapping producing almost-right shapes would look like a working sync that
silently wrote nothing.

Three deliberate breaks, each confirmed to fail the suite:

| Break | Caught |
|---|---|
| Money multiplied by 100 | 4 assertions |
| A refund recorded as a sale | 2 |
| Scopes comma-separated instead of space-separated | 2 |

## 9. Not verified from here

- **No live call has been made to Square.** No application exists.
- The live OAuth handoff and the real token exchange.
- The exact shapes Square returns in practice, as opposed to what its reference
  documents.
- Whether `2026-07-15` is still the newest version by the time you connect —
  it ships roughly monthly, and being behind is safe; being unpinned is not.
