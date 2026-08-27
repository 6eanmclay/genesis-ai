# Twilio requirements, verified 2026-08-27

Checked against Twilio's own current documentation on 2026-08-27. Sources are
named per claim so the next person can re-verify rather than trusting this file.

The headline, because it decides what this connector is worth today:

> **Twilio is the only one of the six unbuilt catalog entries that needs no
> third-party app review to connect.** Toast, Square, Calendly, Xero and HubSpot
> are all OAuth — an app registration and somebody else's queue before a single
> line can be exercised. Twilio authenticates with credentials the owner already
> has. **But sending to US numbers has its own gate**, and it is the slower one:
> A2P 10DLC campaign registration, currently 10–15 days.

---

## 1. Why this connector, and why now

Six catalog entries have had `connector: null` since the catalog was written.
This one closes something that has been on COMPLIANCE.md's *Action Required*
list for a while: **with no `RESEND_API_KEY`, customers are never told their
orders shipped.** SMS is a second rail for exactly that, and it does not depend
on the first one arriving.

It is also the first connector that produces **no business data at all** — a
case `IntegrationConnector` has always allowed ("not every connector produces
business data") and nothing had exercised. Twilio is a way to say something, not
a thing to learn from. It has `reads: []` and **no `sync()`**, and
`verify-twilio.ts` §8 asserts those two agree — a connector claiming a read it
does not implement reads as working right up until a caller believes it.

## 2. Two things that would have been wrong from memory

| Assumption | Reality | Why it matters |
|---|---|---|
| "Twilio has no OAuth, so `api_key` needs no justification" | **OAuth went GA 2026-04-06.** | The `apiKeyExceptionReason` would have been a false statement in a field that exists specifically to stop unjustified API-key use. |
| "Ask for Account SID + Auth Token" | **API keys (`SK…`) are Twilio's stated preference**; SID + Auth Token is positioned as the local-testing alternative. | An API key can be deleted in the owner's console without rotating the master credential every other integration they own is also using. |

Sources: [OAuth GA](https://www.twilio.com/en-us/changelog/oauth-apis-ga),
[API keys](https://www.twilio.com/docs/iam/api-keys).

**The `api_key` exception is still correct, for a narrower reason.** Twilio's
account-level OAuth apps support only the **client-credentials** grant, and the
app is created *inside the merchant's own account* — so the merchant still ends
up in their console generating a secret and pasting it into Genesis. That is the
same handoff as an API key with more steps and no extra safety. Worth revisiting
if Twilio opens an authorization-code flow to third parties, which its token
endpoint suggests exists for someone.

## 3. The protocol

| | |
|---|---|
| Base URL | `https://api.twilio.com/2010-04-01` — the version string looks like a typo and is not; Twilio has never versioned Messages or Accounts past it |
| Auth | HTTP Basic: API key SID as username, key secret as password |
| Send | `POST /Accounts/{Sid}/Messages.json` |
| Content type | **`application/x-www-form-urlencoded`** — a JSON request body is refused outright, and the refusal does not look like a content-type problem when it arrives |
| Required | `To` (E.164), plus `From` **or** `MessagingServiceSid`, plus `Body` |
| Success | HTTP 201, JSON with `sid`, `status`, `num_segments` (**a string**) |
| Credential check | `GET /Accounts/{Sid}.json` — validates credentials *and* returns `type` (Trial/Full) and `status` (active/suspended/closed) in one call |

## 4. Failures, and why they are kept apart

**Classified on Twilio's `code`, never the HTTP status.** `21211` (that is not a
phone number) and `21608` (your account is not upgraded) are **both HTTP 400**
and have nothing to do with each other — one is a typo the owner fixes in a
form, the other is a billing decision at Twilio.

| Twilio code | Genesis kind | Whose move |
|---|---|---|
| `20003`, `20404` | `auth` | Owner — credentials |
| `20429` | `rate_limit` | Nobody; safe to retry after backoff |
| `21211`, `21214` | `bad_recipient` | Owner — the number |
| `21608`, `30032`, `30007` | `not_permitted` | Owner, at Twilio — upgrade or verify |
| anything else | `provider`, carrying Twilio's words verbatim | — |

Sources: [error reference](https://www.twilio.com/docs/api/errors/20003) and the
per-code pages for each.

⚠️ Twilio's pages for 21211 and 21608 do **not** print the HTTP status. The 400
mapping is inferred from their general response doc. This does not affect the
classifier, which reads the code.

## 5. What remains blocked

| Blocked | On what | Who unblocks it | How long |
|---|---|---|---|
| Connecting | Sean has no Twilio account yet | Sean | minutes |
| **Sending to any US number** | **A2P 10DLC**: Customer Profile → Brand → Campaign → attach number | The Campaign Registry | Brand "within a few minutes"; **campaigns 10–15 days** |
| Sending from a toll-free number | Toll-free verification — since 2024-01-31 unverified toll-free traffic is **blocked**, error 30032 | Twilio | ~3–5 business days |
| A2P at all on a trial account | **"Twilio trial accounts can't register for A2P 10DLC"** — the account must be upgraded first | Sean | — |

Sources: [A2P 10DLC](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc),
[quickstart](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/quickstart),
[toll-free blocking](https://www.twilio.com/en-us/changelog/messaging-on-unverified-u-s--toll-free-phone-numbers-now-fully-b).

### The trap this connector is built to avoid

**A trial account authenticates perfectly and cannot notify a customer.** Twilio
permits trial accounts to message only numbers the owner has personally verified
(at most five), and as of 2026 only using Twilio's own templates rather than a
custom body.

So `verify()` returning ok and "this connection will tell your customers their
order shipped" are **different claims**, and reporting the first as the second is
exactly the quiet lie the connection-truthfulness work exists to prevent.
`accountReadiness()` is the split: `verify()` answers *are the credentials
valid*, `twilioReadiness()` answers *can this actually reach a customer*, and
`sendSms()` refuses with the specific reason rather than failing silently.

A trial account is **not** escalated as a failure — nothing is broken and there
is nothing to reconnect. `lib/integrations/connectionHealth.ts` is untouched.

Source: [trial limitations](https://www.twilio.com/docs/usage/trials).

## 6. What Sean needs to do — in order

1. Create a Twilio account at [twilio.com](https://www.twilio.com/).
2. **Upgrade it.** A trial account cannot register for A2P and cannot message
   customers, so this is not an optional step.
3. Console → **Account → API keys & tokens → Create API key**. Copy the **SID**
   and the **Secret** — the secret is shown once.
4. Buy a phone number, or create a Messaging Service.
5. Connect in Genesis: Connections → Twilio. It asks for Account SID, API key
   SID, API key secret, and the from-number. **The credentials are verified
   against Twilio before anything is stored** — a connection that saved
   unverified credentials and reported success is how a store ends up
   "connected" to something that has never worked.
6. **Start A2P 10DLC registration immediately**, because the campaign step is
   the 10–15 day one. Console → Messaging → Regulatory Compliance.

To revoke Genesis's access later: delete the API key in the Twilio console.
Disconnecting in Genesis forgets the key here but **cannot** delete it at Twilio
— `revokesOnDisconnect: false` says so honestly rather than implying otherwise.

## 7. What Genesis can do once connected

- Send an SMS on a store's behalf, with every refusal carrying its own reason:
  not connected, no from-number, malformed number, bad credentials, rate
  limited, or an account that is not permitted to send.
- Report honestly whether the connection can actually reach a customer, rather
  than only whether the credentials work.
- Count what a message costs before sending it — see below.

### Segments are money

Twilio bills per **segment**, not per message, and the boundaries are not
obvious. `segmentsFor()` implements the real **GSM 03.38** table.

**A bug found by writing the test**, recorded because the shape recurs: the
first implementation used "is it Latin-1" as a stand-in for "is it GSM". The two
are not the same set **in either direction** — accented vowels are GSM (so
ordinary Spanish or French copy stays at 160, and the approximation reported
double the real cost), while `ÿ` and `þ` are Latin-1 and not GSM (so the
approximation reported half). An assertion disagreed with the implementation and
the assertion was right.

One curly apostrophe pasted from a word processor — invisible in review —
switches an entire message to UCS-2 and drops the limit from 160 to 70.
`verify-twilio.ts` §7 asserts that specific case.

## 8. End-to-end verification

`scripts/verify-twilio.ts` — **109 assertions, no Twilio account needed.**

Six deliberate breaks, each confirmed to fail the suite:

| Break | Caught |
|---|---|
| Classify failures by HTTP status instead of Twilio code | 4 assertions |
| `toE164` guesses `+1` for a bare national number | 2 |
| Trial account reported as able to send | 2 |
| Messaging Service SID sent as `From` | 2 |
| The API key secret rendered as a plain text field | 2 |
| Connector claims it revokes on disconnect | 1 |

## 9. Not verified from here

- **No live call has been made to Twilio.** No account exists.
- The real error codes Twilio returns in practice, as opposed to the ones its
  error reference documents.
- Whether `price` is null on message creation — the field is documented, the
  timing is not.
- Current A2P throughput caps and 2026 fee amounts.
