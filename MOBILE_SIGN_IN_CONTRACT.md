# Signing in to J4 on the phone (M1)

**Status: Approved by Sean, 2026-09-27 — D1–D4 as recommended. Server side
built the same day** (`lib/auth/credentialSignIn.ts`, `lib/auth/mobileSession.ts`,
`app/api/mobile/v1/*`, verified by `scripts/verify-mobile-auth.ts`, 60/60).
Sean's note on D3: *"the initial mobile authentication implementation, not a
permanent limitation"* — Sign in with Apple and mapping Google/Apple identities
to existing accounts are a later milestone. It is the design for roadmap milestone M1 in
`J4_APP_ROADMAP.md`: *"you can log into the exact same real account on both the
web dashboard and the phone."*

## The four decisions

| # | Decision | Recommendation |
|---|---|---|
| **D1** | How the phone stays signed in | **One long random key per phone**, kept in the iPhone's Keychain, recorded as a normal row in the sessions list you already have. Details below. |
| **D2** | How long before an unused phone is signed out | **90 days without opening J4.** Every use renews it, so someone who uses J4 weekly is never asked again. (The website is 30 days.) |
| **D3** | Which sign-in buttons the phone gets first | **Email + password (+ your 2FA code) only.** "Continue with Google" and "Sign in with Apple" arrive together in a later step — Apple requires the second the moment the first exists. |
| **D4** | Can people create an account on the phone | **Not in M1.** Accounts are created on the website. The phone signs in to one. |

Everything below explains why, and exactly what gets built once these are approved.

---

## What the phone must inherit — every protection the website already has

The website's sign-in was hardened over August. None of it may be lost on a
second door into the same account. This is the checklist M1 is verified against:

| Protection | Where it lives today | On the phone |
|---|---|---|
| Wrong-password lockout per address and per device | `lib/auth/attemptThrottle.ts` | **Same function, same buckets.** A phone does not get a separate allowance. |
| Two-factor code required when enabled, including recovery codes | `verifySecondFactor` in `lib/security/twoFactor.ts` | **Same function.** No partially-signed-in state exists on the phone either. |
| One message for every refusal | `app/login/page.tsx` | **Same rule:** "That didn't work. Check your email, password, and code if you use one." The phone never says which part was wrong. |
| Sign-in, failure and lockout recorded in your security history | `recordSecurityEvent` | **Same events**, with the device shown as "iPhone · J4". |
| You can see every signed-in device and end one | `UserSession` + `lib/security/sessions.ts` | **The phone appears in that same list** and "End session" works on it. |
| A password change signs everyone out | `passwordChangedAt` check in `auth.ts` | **Same check** — a phone key issued before the change stops working on its next request. |
| Email capitalisation doesn't matter | `normalizeEmail` | **Same function.** |

The rule this table enforces: **the phone calls the website's own security code,
it never re-implements it.** A second copy of the lockout or the 2FA check would
be a second place for them to drift apart.

---

## D1 — Why a key per phone, not the website's session cookie

The website keeps you signed in with a browser cookie, managed by NextAuth. A
phone app is not a browser: it has no cookie jar NextAuth can rely on, and
NextAuth's sign-in flow is built around browser redirects and CSRF forms. Driving
that from a phone would work until an upgrade changed a detail it depended on.

So the phone gets its own credential, designed around what `UserSession` already is:

1. On a successful sign-in, the server generates a **256-bit random key** and
   returns it once.
2. The phone stores it in the **iOS Keychain** (`expo-secure-store`) — the same
   encrypted store Apple uses for saved passwords. It never touches ordinary app
   storage.
3. The server stores **only a SHA-256 hash** of the key, on a new nullable
   column `UserSession.tokenHash`, plus `kind = "mobile"`. Same discipline as
   password-reset tokens: a database leak alone cannot be used to sign in. A
   fast hash is correct here, as with reset tokens, because the key is random
   rather than chosen by a person.
4. Every request from the phone sends the key (`Authorization: Bearer …`). The
   server hashes it, finds the `UserSession` row, and refuses it if the row is
   revoked, has been idle past D2's limit, or predates a password change.

**Why a row on `UserSession` and not a new table:** it makes the phone appear in
your existing "where am I signed in" list and makes "End session" and "Sign out
of all other devices" work on the phone **with no new code on those paths**. The
website's rows simply have `tokenHash = null`.

**Why a random key and not a signed token (JWT) like the website's:** the
website already reads `UserSession` on every request to check for revocation, so
a self-contained token would save nothing — and a random key has no signing
secret to leak and no clock-skew rules to get wrong.

**Signing out on the phone** revokes that row. It is the same act as ending the
session from the website.

### Schema change

```prisma
model UserSession {
  // …existing fields unchanged…
  /// "web" for NextAuth sessions, "mobile" for the J4 app.
  kind       String  @default("web")
  /// SHA-256 of the phone's key. Null for every web session.
  tokenHash  String? @unique
}
```

Additive and nullable: every existing row stays valid, and no web user notices.

---

## D2 — Why 90 days

A phone is a personal device behind Face ID, and J4 is meant to be opened for a
conversation now and then, not all day. Asking an owner to type their password
every month would push them toward a weaker password. The backstops are the ones
you already have: the sessions list, remote "End session," and the password-change
sign-out.

If you'd rather match the website exactly, 30 days is a one-number change.

---

## D3 — Why Google and Apple sign-in wait

**Apple's rule (App Review Guideline 4.8):** an app that offers a third-party
sign-in such as Google must also offer an equivalent privacy-focused option —
in practice, **Sign in with Apple**. Adding Google alone gets the app rejected.

Sign in with Apple brings a real wrinkle: people can choose **"Hide My Email,"**
which gives Genesis a relay address like `x7k2@privaterelay.appleid.com`. That
address won't match an existing Genesis account, so a website user who taps it
on the phone would silently get a **second, empty account**. That needs its own
answer (for example, linking from the website's security page first) and is
worth deciding carefully, not bundled into M1.

**What this means for people who signed up with Google:** they have no Genesis
password yet. They can set one today with **"Forgot password" on the website**
(`app/forgot-password` works for Google-only accounts too), then sign in on the
phone. For your beta testers that is one extra step. It goes away when the
Google/Apple step ships.

**Also needed for that later step (owner actions):** a mobile Google OAuth
client in Google Cloud Console (roadmap §1c.3), and turning on the "Sign In with
Apple" capability for `ai.genesis.j4`.

---

## D4 — Why no sign-up on the phone yet

Creating a Genesis account starts onboarding — naming the business, the
storefront draft — which is website work by the roadmap's own rule. It also
keeps Apple's in-app account-deletion requirement (Guideline 5.1.1(v)) out of
M1: that rule applies once an app lets people *create* accounts. It will need
answering before public launch (M5) either way.

---

## What gets built, once approved

**Server (`genesis-ai`), new routes under `app/api/mobile/v1/`:**

| Route | Does |
|---|---|
| `POST auth/sign-in` | `{ email, password, code? }` → `{ token }` or the single refusal. Runs the exact checks the website's `authorize` runs, in the same order. |
| `POST auth/sign-out` | Revokes the calling phone's session. |
| `GET me` | Name, email, active business — the phone's first proof it's signed in. |

Plus one helper, `authenticateMobile(request)`, that every later mobile route
(M2's chat first) uses to turn a key into a user — the one place that enforces
revoked / idle / password-changed.

To avoid two copies of the sign-in checks, the body of `authorize` in `auth.ts`
moves into a shared function that both NextAuth and the mobile route call. The
website's behaviour does not change.

Guards per `API_BOUNDARY.md`: size limit, Zod schema, and the existing sign-in
throttle on `sign-in`. Added to that document's route table.

**Phone (`genesis-j4-app`):** a sign-in screen (email, password, optional code
field, the one error message), Keychain storage, a signed-in screen showing your
name and business, and a sign-out button.

**Verified by:**
- A `scripts/verify-mobile-auth.ts` suite, same style as the existing security
  suites, covering: wrong password, wrong code, lockout shared with the website,
  revoked session refused, idle-expired refused, password change evicts the
  phone, and a key for one account never reading another's data.
- By hand: sign in on the phone, see "iPhone · J4" in the website's sessions
  list, end it there, and watch the phone get signed out on its next request.

**Done when (roadmap M1):** the same real account is signed in on the website and
the phone at the same time.
