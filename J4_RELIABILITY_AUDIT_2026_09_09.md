# J4 reliability audit — 2026-09-09

**Investigation only. Nothing here is fixed yet.** Sean asked for findings before
the Office rebuild, and asked specifically that confirmed bugs, likely causes and
unverified guesses be kept apart. Every claim below is labelled:

- **CONFIRMED** — measured against production data or proven in the code path.
- **LIKELY** — strong evidence, one inference away from proof.
- **UNVERIFIED** — plausible, not yet tested. Named so it is not mistaken for a
  finding.

All production queries were read-only.

---

## 1. THE REPETITION — two separate bugs, neither is the model

Sean: *"Did J4 generate the phrase twice, or did we receive/render/speak the same
generated phrase twice? Those are completely different bugs."*

**Answer: we spoke it twice. J4 generated it once.**

### 1a. Every turn is spoken twice — CONFIRMED

`j4_voice_output` fires **twice per turn**, 2–3 seconds apart:

```
09-09T10:38:51  j4_voice_output   61ms
09-09T10:38:53  j4_voice_output   45ms   <- same turn
09-09T10:39:04  j4_voice_output   58ms
09-09T10:39:07  j4_voice_output   44ms   <- same turn
```

Across the last 15 turns: **12 spoke twice, one spoke four times**, three spoke
once. Every one of those turns had exactly **one** transcription, so it is not
the user's input triggering two turns — one turn produces two speech calls.

This is the audible *"Let me find that out for you. Let me find that out for
you."* The second playback starts while the first is still going, so the opening
is what overlaps.

**LIKELY cause:** the acknowledgement path. `project_j4_voice_responsiveness`
deliberately decoupled an early spoken ack from transcription so J4 responds
immediately. If the ack and the real reply are both sent to TTS, and the reply
opens with the same phrasing, the owner hears the opening twice.
**Not yet proven** — proving it needs the two TTS payloads compared, which are
not stored today. That is itself a gap: **we cannot currently see what was
spoken**, only that speech happened.

### 1b. The user's own words are being duplicated — CONFIRMED

The stored user message is literally:

```
09-09T10:38:50  user  "OK. 834. OK. 834."
```

Duplicated **before storage**, so this is the input path, not rendering and not
TTS. Sean said it once.

### 1c. Silence is becoming a user turn — CONFIRMED

```
09-09T10:39:05  user  "Thank you for watching."
```

Sean did not say this. It is a well-documented Whisper hallucination on silence
or noise. J4 then earnestly answered it (*"That one came through as sign-off
text, so nothing to act on there"*) — which is a *good* honest answer to a
message that should never have existed.

**Both 1b and 1c point at the same place:** the audio segment handed to Whisper.
Duplicated content and phantom content are the two classic symptoms of sending
overlapping or silent buffers.

### 1d. The same assistant message written ten times — CONFIRMED

```
09-06T21:07:15 .. 21:08:33   the SAME 181-character failure message, x10
gaps: 273ms, 441ms, 618ms, 722ms, 752ms, 763ms, 324ms, 3.0s, 71s
```

*"I tried to apply that and it did not go through. 'warm cream base with
copper-toned section bands' is not a re…"* — a proposal retrying and writing an
identical failure message each time. Sub-second gaps mean a loop, not a person
retrying. **Distinct from the speech bug** and still present in the data J4
reads back, which is why J4 kept raising the same warm-up proposal on 09-09.

---

## 2. THE "87" — traced, and it is not in anything we send

Sean: *"Do not assume it's just hallucination. Trace it."* Traced:

| Where it could have entered | Result |
|---|---|
| Stored messages (1,069 rows) | **1 hit**, and it is a filename from 08-07 (`…8710e1.png`). No standalone 87. |
| Execution logs | 0 |
| Business counts (products 14, orders 6, messages 377, GP balance 562) | none equal 87 |
| The digest injected every turn | every number in it: **14, 5, 26, 11, 2, 3, 47** — no 87 |
| `businessContext` (7,417 chars) | no standalone 87 |
| Full `understanding` JSON (90,870 chars) | no standalone 87 |

**CONFIRMED: 87 did not come from stored conversation, business data, or any
part of the context we assemble.** That eliminates six of the eight sources Sean
listed.

**Remaining possibilities, all UNVERIFIED:** it was in a tool result not
persisted; it was spoken by TTS and never stored as text; or it was model output
in a turn whose assistant message failed to save. **I cannot close this without
knowing the turn.** If Sean can say roughly when, the turn can be isolated —
and the fix for §1a (storing what was spoken) would make this answerable in
future rather than a dead end.

**Note:** the only "87" anywhere in this project's recent history is
**"Business Health 87" in the Office mock image** — a made-up number in a design
reference. It has never existed in the product.

---

## 3. RUNTIME HEALTH — the tool outage is genuinely over

**CONFIRMED: the fix works.** `store_chat_unified_triage` succeeded five times
on 09-09 — the first successful triage calls since **2026-08-27**:

```
10:38:50  in=1128  out=247  5133ms
10:39:05  in=1124  out=121  4343ms
10:39:47  in=1137  out= 92  2743ms
10:40:51  in=1137  out=182  5374ms
10:41:27  in=1141  out= 90  2394ms
```

**And `primary` did not fire once.** The full-store regeneration that made every
turn 22–27 seconds is no longer on the conversational path.

**Turn duration collapsed**: 2.7s, 4.8s, 6.0s, 7.3s, 13.4s — against a p50 of
9.4s and p90 of 25.2s over the previous 60 turns.

**No stage failures recorded** on any 09-09 turn.

### One genuine outlier — CONFIRMED

```
09-09T10:39:56  store_chat_data_answer  in=79,278 tokens  out=355  8,123ms  $0.41
```

**79,278 input tokens for one question** (*"what happened with paypal"*). That is
six times the whole tool payload and cost 41 cents in a single turn. By
comparison the same session's triage calls run ~1,130 tokens. **This is the
single biggest remaining latency and cost item on the chat path** and it is not
explained by the context assembled above (digest 167 tokens, businessContext
~2,000, understanding ~24,600). Something is inlining far more than the digest —
**UNVERIFIED which**, and worth tracing next.

---

## 4. LATENCY — where the time actually goes now

Measured on the 09-09 turns:

| Stage | Time | Note |
|---|---|---|
| Whisper transcription | **2.3–3.4 s** | fires before anything else can start |
| unified triage (model) | **2.4–5.4 s** | 1,130 tokens in, 90–247 out |
| ElevenLabs TTS | **39–61 ms** | not a problem, and never was |
| `dbFetch` | 17 ms p50 | not a problem |
| whole turn | **2.7–13.4 s** | |

**So a simple spoken turn is roughly 2.5s of transcription + 3–5s of model.**

**What Sean asked for and does not exist yet:** there is no measurement of
*first token* or *TTS start*. `stageDurationsMs` records whole-call durations
only. **We cannot currently answer "when did the first usable word arrive"**,
which is exactly the number that decides whether J4 *feels* immediate.

**CONFIRMED structural cause of the felt delay:** the chat path calls
`.finalMessage()` — it waits for the **entire** response before anything is
spoken or shown. `onTextDelta` exists in `callGenesisModel` and is used by
`app/api/chat/route.ts`, but **not by the dashboard/Office path**. So even a
fast response is delivered all-at-once at the end.

**A realistic budget** (proposal, not yet agreed):

| | now | target |
|---|---|---|
| audio → transcript | 2.5 s | 1.0 s (stream partials) |
| transcript → first token | 3–5 s | < 1.0 s |
| first token → first audio | n/a (waits for all) | < 0.5 s (sentence-level TTS) |
| **owner hears something** | **6–9 s** | **< 2.5 s** |

---

## 5. VISION — J4 genuinely cannot see images in conversation

Sean: *"Do not assume that because the file was successfully stored that J4 can
see it."* It cannot.

**CONFIRMED root cause.** Exactly one place in the entire codebase builds an
image content block for a model:

```
lib/businessAssets/classify.ts:192   { type: "image"; source: { type: "url"; url: string } }
```

That is the **asset classification** call — a separate one-shot on upload. **The
conversation path never constructs an image block.** Answering Sean's ten
questions directly:

1. **Does J4 receive image bytes/reference?** No. In conversation, never.
2. **What is in the model request?** Text only — the stored message was literally
   `"Uploaded 1 photos"`.
3. **Which model?** `claude-opus-4-8` — vision-capable. The model is not the gap.
4. **Invoked with an image block?** **No** — only `classify.ts` does that.
5. **Is the URL reachable by the model?** Yes; classification uses
   `{ type: "url", url: storageUrl }` and works.
6. **Stripped when building history?** Not stripped — **never attached**.
7. **Saving the file but passing only metadata?** **Yes. This is the bug.**
8. **A vision capability that exists but isn't invoked?** **Yes** — classification
   already sends the image to a vision model and stores a real `summary`
   ("1-2 real, specific sentences describing what's actually in it").
9. **Size/type/auth problem?** No evidence of one.
10. **Minimal end-to-end test?** Not yet written — see §8.

**So J4's answer to Sean was honest and correct.** It said it could not make out
the contents, and it could not. That is the right failure mode; the capability is
what is missing.

**The fix uses what already exists** (no second system):
- **Immediate**: inject the stored asset `summary` for recently uploaded assets
  into the turn context. Already-captured real visual understanding, currently
  unused by chat.
- **Proper**: when the turn references an uploaded image, attach the same
  `{ type: "image", source: { type: "url" } }` block `classify.ts` already
  builds.

---

## 6. BUSINESS INTELLIGENCE — the reasoning is not the gap, the source is

Sean's testimonial example: a customer emailed *"you really do make a superior
product"*.

**CONFIRMED: J4 cannot see that email, because no email source is connected.**

```
PRINTFUL   CONNECTED   externalAccountId=18669140              verified 2026-08-27
PAYPAL     CONNECTED   externalAccountId=Aaj2VSW7-…            verified 2026-08-10
STRIPE     CONNECTED   externalAccountId=acct_1U6HDsBsxuQENanJ verified 2026-08-31
```

**Three connections. No Gmail, no email, no support inbox.** The digest J4 reads
every turn says exactly this: `Connected: Printful (stale), PAYPAL (stale),
STRIPE (stale)`.

So the gap is **not** that J4 fails to reason from customer communication to a
testimonial opportunity. **It has never been given a single customer
communication.** Proactive J4 already exists and already surfaces findings
unprompted — on 09-08 it raised five unprompted observations, including a stale
Google Calendar sync and products rendering as blank cards. The machinery for
"notice something and raise it" is built and working.

**What is missing is a source.** Until an email/inbox connection exists, no
amount of intelligence work will surface that testimonial.

**UNVERIFIED:** whether Proactive J4's finding types would cover
"customer praise → testimonial opportunity" once a source exists, or whether a
new finding type is needed. Worth checking before assuming either.

---

## 7. PAYPAL — identity is wrong, verification does not exist

### What is actually connected

```
STRIPE   externalAccountId = acct_1U6HDsBsxuQENanJ   <- a real account identity
PAYPAL   externalAccountId = Aaj2VSW7-xO9O_577PWxq74H7-vKuiyNWUGTdLTDCCd53wSEZ…
```

**CONFIRMED: the PayPal value is the REST app CLIENT ID, not a merchant
identity.** It tells the owner nothing about which PayPal account is connected,
and being credential-adjacent it should not be shown to them either. Stripe's is
a genuine account id that `accounts.retrieve()` can resolve to a business name.

`lib/integrations/paypal.ts` says so in its own comment: *"PayPal has no
'whoami' endpoint the way Stripe's accounts.retrieve() works."* **True, but not
the end of the story** — a capture lookup returns `payee.merchant_id` and
`payee.email_address`, so merchant identity **is** obtainable from a transaction
we already hold. UNVERIFIED against the live account.

### The order Sean asked about

```
Fri Sep 04   paymentProvider=PAYPAL   status="paid"
             externalOrderId  = 4CW51075L02817250
             externalPaymentId = 74L44930P3583640U     <- the capture id
             fulfillmentStatus = "unfulfilled"
```

**We hold the capture id.** `GET /v2/payments/captures/74L44930P3583640U` would
return the real money state and the payee identity.

**CONFIRMED: nothing reads it.** `lib/integrations/paypal.ts` exports only token,
webhook create/delete/verify. Capture happens **inline in the checkout return
route** (`app/api/checkout/paypal/return/route.ts`) and is never exposed as a
reusable capability — so **there is no J4 tool that can verify a PayPal payment**.

**J4's answer to Sean was therefore correct and honest**: *"I don't have PayPal's
capture-level detail on my side, so I can't see why it's showing pending there."*
It did not infer payment from the existence of an order. **That is the behaviour
Sean asked for, already holding.**

### PayPal versus Stripe, on Sean's lifecycle

| | Stripe | PayPal |
|---|---|---|
| CONNECT | yes | yes |
| IDENTIFY ACCOUNT | `acct_…`, resolvable | **client id only — no merchant identity** |
| VERIFY CONNECTION | `accounts.retrieve()` | token exchange only |
| SHOW ACCOUNT IDENTITY | possible | **not possible today** |
| SHOW CAPABILITIES | — | **no schema field exists** |
| READ TRANSACTIONS | financials layer | order rows only |
| VERIFY PAYMENT | yes | **no** |
| REPORT TO J4 | partial | **no** |

**`StoreIntegration` has no `scopes` or `capabilities` column at all**, so
"show what permissions Genesis has" cannot be answered for *any* provider today.

---

## 8. WHAT I RECOMMEND, IN ORDER

**Fix now — reliability, small, provable:**

1. **Stop speaking every turn twice.** Highest annoyance per line of code.
   Store the spoken text alongside each TTS call so this is provable rather than
   inferred, and so §2 is answerable next time.
2. **Fix the transcription duplication and the silence hallucination.** Do not
   send overlapping buffers; drop segments Whisper returns for silence.
3. **Stop the duplicate assistant writes** (ten identical rows in 78 seconds).

**Fix next — capability:**

4. **Give chat the asset summary**, then real image blocks. Uses the existing
   classification output; no second system.
5. **A PayPal `verifyPayment(captureId)` capability + a J4 tool**, and replace
   the stored client id with a real merchant identity from the capture payee.

**Then — latency:**

6. **Stream.** `onTextDelta` already exists and the dashboard path ignores it.
   Speak the first sentence as soon as it lands rather than waiting for the whole
   response.
7. **Trace the 79k-token `data_answer` call.**

**Needs a decision, not code:** connect an email source, or accept that
testimonial detection is impossible.

**Tests that would prove each fix** — one TTS call per turn asserted against the
usage table; a transcript with no leading repeat; an image the model describes
back correctly; a PayPal capture verified against a real capture id; and a
first-token measurement that did not exist before.
