# Talking to J4 on the phone (M2)

**Status: Approved by Sean, 2026-09-27 — D1–D5 as recommended. Server side
built the same day** (`lib/j4/chatTurn.ts`, `lib/j4/phoneChat.ts`,
`app/api/mobile/v1/chat`, `app/api/mobile/v1/messages`, verified by
`scripts/verify-mobile-chat.ts`, 32/32, and every existing suite that reads the
chat turn, repointed to its new home). It is the design for roadmap milestone M2 in
`J4_APP_ROADMAP.md`: *"a message sent from the phone shows up in the same
conversation history visible on desktop, and J4's real reply appears on the
phone."* It builds on M1 (`MOBILE_SIGN_IN_CONTRACT.md`) for who is asking.

## The five decisions

| # | Decision | Recommendation |
|---|---|---|
| **D1** | How the phone reaches J4 | **The website's own chat turn, moved into one shared function** that both the website's `/api/chat` and a new `/api/mobile/v1/chat` call. One J4, not two. |
| **D2** | Which conversation the phone shows | **The website's main J4 thread** — the ungrouped history your dashboard opens on. Last 50 messages, refreshed when you open J4 or pull down. |
| **D3** | How replies appear | **Word by word as J4 writes them**, with the same "Working on your request…" lines the website shows. |
| **D4** | When J4 needs the website to finish something | **J4 says so in the conversation, and it's kept in the history.** Storefront edits are reviewed and approved on the website; the phone says that plainly instead of failing silently. |
| **D5** | What's not in M2 | **Voice, photos and files, named conversations, J4 starting conversations (M3), push notifications (M4), live sync between devices.** |

---

## D1 — One J4, two doors

The website's `/api/chat` route is 830 lines: it reads the conversation, asks
the model, runs whatever J4 decided to do (look something up, capture a fact,
plan a campaign, change something) under the same permission checks, writes both
sides of the turn to the history, and streams the reply.

**The phone must not get a second copy of any of that.** Same rule as M1's
sign-in: two copies drift, and a J4 that behaves differently on the phone than on
the website is the thing the roadmap says we are not building.

So the body of that route moves, unchanged, into
`lib/j4/chatTurn.ts` as `runChatTurn({ userId, sessionInstanceId, body })`, and:

- `app/api/chat/route.ts` becomes: sign-in check with the browser cookie → call it.
- `app/api/mobile/v1/chat/route.ts` is: `authenticateMobile` (M1's key check) → call it.

Everything else is identical by construction: the model, the tools, the
per-tool permission check, the 120-messages-an-hour limit (**shared** between
phone and website — one account, one allowance), the 8,000-character cap, the
daily spending ceiling, the history J4 reads, and what gets written.

The website's behaviour does not change. The move is verified the way M1's was:
the moved code is compared line by line with the original, and the only
difference allowed is where the user id comes from.

## D2 — The same thread as the dashboard

The dashboard's J4 opens on the **ungrouped history** — every message not filed
under a named conversation. The phone shows and writes to exactly that thread, so
a message sent on the phone is there on the website, and the reverse.

A new `GET /api/mobile/v1/messages` returns the last 50 messages of that thread
for the business J4 is working on (the same business the signed-in screen shows,
resolved by the website's own `resolveBusiness`). It is scoped by business on the
server, never by anything the phone sends.

**No live sync in M2** (roadmap: *"no real-time transport gets built now"*). A
message typed on the website appears on the phone the next time you open J4 or
pull down to refresh. That is the honest minimum; live sync is Shared Context,
later.

Voice memos already in the history show on the phone as their transcript with a
small "voice memo" label — they can't be played on the phone yet.

## D3 — Word by word

The website streams J4's reply as it is written, and the phone can too: Expo SDK
57's `fetch` supports streamed responses. The phone shows the same status lines
("J4 received your message…", "Working on your request…") and then the words.

If the connection drops mid-reply (a tunnel, the app backgrounded), the server
**keeps going and still saves the full reply** — the website route already
guarantees that. The phone then shows what it had, and the complete reply is
there on the next refresh.

## D4 — When the website has to finish the job

Today, two kinds of turn are handed back from `/api/chat` to a second,
website-only path (a Next.js Server Action the phone cannot call):

1. **Storefront edits** — "change my headline", "rewrite the About section".
   These produce a proposed change you review and approve on the dashboard. That
   is managing the business, which the roadmap puts on the website.
2. **Turns the model couldn't resolve** — no usable reply, or the model provider
   failed. The website quietly retries these on the slower path.

On the phone:

- **Storefront edits:** your message and a J4 reply are both saved to the
  thread — *"That's a change to your storefront, and I'll want you to see it
  before it goes live. Send it to me from Genesis on the web and I'll draft it
  there."* It is in the history, so it's waiting for you on the dashboard.
- **Couldn't resolve:** the phone shows *"I couldn't answer that just now — try
  again,"* keeps what you typed in the box, and **nothing is saved** — so the
  history never holds a question with no answer.

Running storefront edits from the phone (with approval inline, in the
conversation) is exactly what M3 is about, and belongs there.

## D5 — Not in M2

| Left out | Why |
|---|---|
| Voice (talking, or J4 speaking) | Roadmap parks voice. The screenshot of LM Studio's live transcription is noted for when it's picked up. |
| Photos and files | The website's upload path is its own flow; it comes later. |
| Named conversations | The phone uses the main thread only. |
| J4 raising things first | M3. |
| Push notifications | M4. |
| J4 moving you to a dashboard page | The website's J4 can open a page for you; on the phone that instruction is ignored for now. |

---

## Also found, not changed

- **A website bug, recorded rather than fixed here.** In a *named* conversation
  on the website, a purely conversational reply is saved to the ungrouped
  history instead of that conversation (the read is scoped, the write is not —
  `app/api/chat/route.ts`, the "conversational" branch). It does not affect the
  thread the phone uses. Worth its own small fix, with your OK.

## What gets built, once approved

**Server (`genesis-ai`):**

| Piece | Does |
|---|---|
| `lib/j4/chatTurn.ts` | The chat turn, moved unchanged out of `app/api/chat/route.ts`. |
| `app/api/chat/route.ts` | Cookie sign-in → the shared turn. |
| `POST /api/mobile/v1/chat` | Phone key → the shared turn, with D4's phone behaviour. |
| `GET /api/mobile/v1/messages` | The main thread's last 50 messages for the phone's business. |
| `API_BOUNDARY.md` | Both routes added to the table. |

**Phone (`genesis-j4-app`):** a conversation screen replacing the "coming next"
line — the thread, a message box, streamed replies, pull to refresh, the D4
messages, and the same sign-out as now.

**Verified by:**
- `scripts/verify-mobile-chat.ts`: the phone's key reaches the same business and
  thread as the website; a revoked key is refused before any model call; one
  account's key never reads another business's messages; the rate limit is
  shared; D4's storefront-edit turn is saved and its unresolved turn is not.
- The existing chat suites (`verify-first-token`, `verify-conversations`,
  `verify-brevity-and-streaming`) still pass against the moved code.
- By hand, on your phone: send "what sold this week?" from J4, watch the reply
  stream, then open the dashboard and see both messages there.

**Done when (roadmap M2):** a message sent from the phone is in the dashboard's
J4 history, and J4's real reply appeared on the phone.
