import { prisma } from "@/lib/prisma";
import { PERMISSIONS, requireStorePageAccess } from "@/lib/permissions";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { SubmitButton } from "../SubmitButton";
import {
  connectStripe,
  disconnectStripe,
  recheckStripe,
  connectPaypal,
  submitPaypalCredentials,
  disconnectPaypal,
  recheckPaypal,
} from "../actions";
import { DEFAULT_THEME, themeCssVars, type Theme } from "@/lib/theme";
import { decryptCredentials } from "@/lib/integrations/credentials";
import type { StripeCredentials } from "@/lib/integrations/stripe";

const ACCENT_BUTTON =
  "rounded-full bg-[var(--brand-accent)] text-white transition hover:opacity-90 disabled:opacity-50";
const GHOST_BUTTON =
  "rounded-full border border-black/[.08] px-4 py-1.5 text-xs disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50";

// Real, recognizable brand wordmarks (2026-08-09 redesign, Sean: "people
// already know the Stripe and PayPal logos — use that familiarity instead
// of making them read a paragraph"). Rendered as styled text in each
// brand's own color rather than a traced/embedded copy of their vector
// logomark — recognition comes overwhelmingly from the color + wordmark
// pairing, and this avoids any risk of a hand-approximated icon looking
// subtly wrong. No external logo asset/CDN dependency either.
function StripeWordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`font-sans text-3xl font-bold tracking-tight text-[#635bff] ${className}`}>
      stripe
    </span>
  );
}

function PaypalWordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`font-sans text-3xl font-bold tracking-tight ${className}`}>
      <span className="text-[#003087]">Pay</span>
      <span className="text-[#009cde]">Pal</span>
    </span>
  );
}

function ConnectedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
      <span aria-hidden="true">✓</span> Connected
    </span>
  );
}

function NotConnectedBadge() {
  return (
    <span className="inline-flex items-center rounded-full bg-black/[.04] px-2.5 py-0.5 text-xs font-medium text-zinc-500 dark:bg-white/[.06] dark:text-zinc-400">
      Not connected
    </span>
  );
}

function AttentionBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
      {label}
    </span>
  );
}

// Real gap closed as part of this redesign (2026-08-09) — Stripe's own
// OAuth response already tells us whether a connected account is live or
// test mode (token.livemode, captured in lib/integrations/stripe.ts), but
// nothing ever displayed it. Sean's own real report ("Stripe redirected me
// to a page that says I'm using a test account") had no way to have been
// caught from inside the app itself before this — this makes that
// permanently self-verifying instead of a one-time manual fix.
function StripeModeBadge({ livemode }: { livemode: boolean | null }) {
  if (livemode === null) return null;
  return livemode ? (
    <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
      Live mode
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
      Test mode — not receiving real payments
    </span>
  );
}

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ integration_error?: string; integration_connected?: string }>;
}) {
  const { integration_error: integrationError, integration_connected: integrationConnected } =
    await searchParams;
  const { store } = await requireStorePageAccess(PERMISSIONS.PAYMENTS_MANAGE);
  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;

  const showContinueToLaunch =
    !store.published &&
    (await prisma.order.count({ where: { storeId: store.id } })) === 0;

  const stripeIntegration = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId: store.id, provider: "STRIPE" } },
    include: { connectedBy: { select: { name: true, email: true } } },
  });

  const latestStripeLog = await prisma.executionLog.findFirst({
    where: {
      storeId: store.id,
      action: {
        in: [EXECUTION_ACTIONS.INTEGRATION_STRIPE_CONNECT, EXECUTION_ACTIONS.INTEGRATION_STRIPE_VERIFY],
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const stripeStatusDisplay = latestStripeLog
    ? {
        status: latestStripeLog.status,
        message: latestStripeLog.message,
        verified: latestStripeLog.verified,
        createdAt: latestStripeLog.createdAt,
      }
    : stripeIntegration
      ? {
          status:
            stripeIntegration.status === "CONNECTED"
              ? "SUCCESS"
              : stripeIntegration.status === "NEEDS_ATTENTION"
                ? "WARNING"
                : "FAILED",
          message: stripeIntegration.lastError ?? "Stripe connected",
          verified: stripeIntegration.lastVerifiedAt !== null,
          createdAt:
            stripeIntegration.lastVerifiedAt ?? stripeIntegration.connectedAt ?? stripeIntegration.createdAt,
        }
      : null;

  // Best-effort — a decrypt failure (e.g. a pre-encryption-era row, or a
  // rotated INTEGRATION_ENCRYPTION_KEY) should never break the page, just
  // fall back to no mode badge rather than a crash.
  let stripeLivemode: boolean | null = null;
  if (stripeIntegration?.credentials) {
    try {
      stripeLivemode = decryptCredentials<StripeCredentials>(stripeIntegration.credentials).livemode;
    } catch {
      stripeLivemode = null;
    }
  }

  const paypalIntegration = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId: store.id, provider: "PAYPAL" } },
    include: { connectedBy: { select: { name: true, email: true } } },
  });

  const latestPaypalLog = await prisma.executionLog.findFirst({
    where: {
      storeId: store.id,
      action: {
        in: [EXECUTION_ACTIONS.INTEGRATION_PAYPAL_CONNECT, EXECUTION_ACTIONS.INTEGRATION_PAYPAL_VERIFY],
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const paypalFormFields =
    latestPaypalLog?.action === EXECUTION_ACTIONS.INTEGRATION_PAYPAL_CONNECT
      ? ((latestPaypalLog.metadata as { fields?: { name: string; label: string; type: string }[] } | null)
          ?.fields ?? null)
      : null;

  const paypalStatusDisplay = latestPaypalLog
    ? {
        status: latestPaypalLog.status,
        message: latestPaypalLog.message,
        verified: latestPaypalLog.verified,
        createdAt: latestPaypalLog.createdAt,
      }
    : paypalIntegration
      ? {
          status:
            paypalIntegration.status === "CONNECTED"
              ? "SUCCESS"
              : paypalIntegration.status === "NEEDS_ATTENTION"
                ? "WARNING"
                : "FAILED",
          message: paypalIntegration.lastError ?? "PayPal connected",
          verified: paypalIntegration.lastVerifiedAt !== null,
          createdAt:
            paypalIntegration.lastVerifiedAt ?? paypalIntegration.connectedAt ?? paypalIntegration.createdAt,
        }
      : null;

  const flashProvider =
    integrationError === "stripe" || integrationConnected === "stripe"
      ? "stripe"
      : integrationError === "paypal" || integrationConnected === "paypal"
        ? "paypal"
        : null;
  const flashLabel = flashProvider === "stripe" ? "Stripe" : flashProvider === "paypal" ? "PayPal" : null;
  const flashLog = flashProvider === "stripe" ? latestStripeLog : flashProvider === "paypal" ? latestPaypalLog : null;

  const stripeConnected = stripeIntegration && stripeIntegration.status !== "DISCONNECTED";
  const paypalConnected = paypalIntegration && paypalIntegration.status !== "DISCONNECTED";

  return (
    <div style={themeCssVars(theme)} className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Payments</h1>
      <p className="mt-1 max-w-md text-sm text-zinc-500">
        Connect a payment provider to receive payments directly from your customers.
      </p>

      {showContinueToLaunch && (
        <div className="mt-4 max-w-md rounded-lg border border-violet-200 bg-violet-50 p-4 text-sm dark:border-violet-900/40 dark:bg-violet-950/30">
          <p className="font-medium text-violet-900 dark:text-violet-200">Your store isn&apos;t live yet.</p>
          <p className="mt-1 text-violet-700 dark:text-violet-400">
            Pick up right where you left off.{" "}
            <a href="/onboarding/launch" className="font-semibold underline">
              Continue to launch
            </a>
          </p>
        </div>
      )}

      {integrationError && flashLabel && (
        <div className="mt-4 max-w-2xl rounded-lg border border-red-200 bg-red-50 p-4 text-sm dark:border-red-900/40 dark:bg-red-950/30">
          <p className="font-medium text-red-800 dark:text-red-300">{flashLabel} couldn&apos;t connect.</p>
          <p className="mt-1 text-red-700 dark:text-red-400">
            {flashLog?.status === "FAILED"
              ? flashLog.message
              : "Something went wrong during the connection. Please try again."}
          </p>
        </div>
      )}
      {integrationConnected && flashLabel && (
        <div className="mt-4 max-w-2xl rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm dark:border-emerald-900/40 dark:bg-emerald-950/30">
          <p className="font-medium text-emerald-800 dark:text-emerald-300">{flashLabel} connected.</p>
          <p className="mt-1 text-emerald-700 dark:text-emerald-400">You&apos;re ready to accept payments.</p>
        </div>
      )}

      <div className="mt-6 grid max-w-2xl grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Stripe */}
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-black/[.08] p-6 text-center dark:border-white/[.145]">
          <StripeWordmark />
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {/* HONEST BADGE (2026-08-20). This read `stripeConnected`, which is
                only "not DISCONNECTED" — so a connection that had FAILED
                verification still displayed "Connected". Six real stores were
                being told they could take payments through test-mode or
                revoked accounts that could not take a cent. Only a connection
                that actually verifies says Connected now. */}
            {stripeIntegration?.status === "CONNECTED" ? (
              <ConnectedBadge />
            ) : stripeConnected ? (
              <AttentionBadge
                label={stripeIntegration?.status === "NEEDS_ATTENTION" ? "Needs attention" : "Not working"}
              />
            ) : (
              <NotConnectedBadge />
            )}
            {stripeIntegration?.status === "CONNECTED" && <StripeModeBadge livemode={stripeLivemode} />}
          </div>

          {!stripeConnected ? (
            <form action={connectStripe} className="mt-1">
              <SubmitButton
                pendingText="Redirecting..."
                className={`px-5 py-2 text-sm ${ACCENT_BUTTON}`}
                trackPerf={{ label: "Connect Stripe", storeId: store.id, attemptKey: `stripe_connect:${store.id}` }}
              >
                Connect Stripe
              </SubmitButton>
            </form>
          ) : (
            <div className="mt-1 flex flex-wrap justify-center gap-2">
              <form action={recheckStripe}>
                <SubmitButton
                  pendingText="Checking..."
                  className={GHOST_BUTTON}
                  trackPerf={{ label: "Recheck Stripe", storeId: store.id, attemptKey: `stripe_connect:${store.id}` }}
                >
                  Recheck
                </SubmitButton>
              </form>
              {stripeIntegration?.status !== "CONNECTED" && (
                <form action={connectStripe}>
                  <SubmitButton
                    pendingText="Redirecting..."
                    className={`px-4 py-1.5 text-xs ${ACCENT_BUTTON}`}
                    trackPerf={{ label: "Reconnect Stripe", storeId: store.id, attemptKey: `stripe_connect:${store.id}` }}
                  >
                    Reconnect
                  </SubmitButton>
                </form>
              )}
              <form action={disconnectStripe}>
                <SubmitButton
                  pendingText="Disconnecting..."
                  className={`${GHOST_BUTTON} text-red-600 dark:text-red-400`}
                >
                  Disconnect
                </SubmitButton>
              </form>
            </div>
          )}

          {latestStripeLog?.status === "FAILED" && !stripeConnected && (
            <p className="text-xs text-red-600 dark:text-red-400">Last attempt failed: {latestStripeLog.message}</p>
          )}
          {stripeConnected && stripeIntegration && stripeIntegration.status !== "CONNECTED" && (
            <p className="text-xs text-red-600 dark:text-red-400">
              This store can&apos;t take payments through Stripe right now. Reconnect to fix it.
            </p>
          )}
          {stripeStatusDisplay && stripeConnected && (
            <p className="text-xs text-zinc-500">
              {stripeStatusDisplay.message}
              {stripeStatusDisplay.verified ? " · verified" : ""} · {stripeStatusDisplay.createdAt.toLocaleDateString()}
            </p>
          )}
          {stripeIntegration?.connectedBy && stripeIntegration.connectedAt && (
            <p className="text-xs text-zinc-400">
              Connected by {stripeIntegration.connectedBy.name ?? stripeIntegration.connectedBy.email} on{" "}
              {stripeIntegration.connectedAt.toLocaleDateString()}
            </p>
          )}
        </div>

        {/* PayPal */}
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-black/[.08] p-6 text-center dark:border-white/[.145]">
          <PaypalWordmark />
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {paypalConnected ? <ConnectedBadge /> : <NotConnectedBadge />}
            {paypalConnected && paypalIntegration?.status === "NEEDS_ATTENTION" && (
              <AttentionBadge label="Needs attention" />
            )}
          </div>

          {!paypalConnected ? (
            paypalFormFields ? (
              <form action={submitPaypalCredentials} className="mt-1 flex w-full flex-col gap-2.5 text-left">
                <p className="text-xs text-zinc-500">
                  Create a PayPal Developer app at developer.paypal.com and enter its credentials below.
                </p>
                {paypalFormFields.map((field) => (
                  <input
                    key={field.name}
                    name={field.name}
                    type={field.type}
                    placeholder={field.label}
                    required={field.name !== "environment"}
                    defaultValue={field.name === "environment" ? "sandbox" : undefined}
                    className="rounded-lg border border-black/[.08] px-4 py-2 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                  />
                ))}
                <SubmitButton
                  pendingText="Connecting..."
                  className={`self-start px-5 py-2 text-sm ${ACCENT_BUTTON}`}
                  trackPerf={{ label: "Submit PayPal credentials", storeId: store.id, attemptKey: `paypal_connect:${store.id}` }}
                >
                  Connect PayPal
                </SubmitButton>
              </form>
            ) : (
              <>
                <form action={connectPaypal} className="mt-1">
                  <SubmitButton
                    pendingText="Starting..."
                    className={`px-5 py-2 text-sm ${ACCENT_BUTTON}`}
                    trackPerf={{ label: "Connect PayPal", storeId: store.id, attemptKey: `paypal_connect:${store.id}` }}
                  >
                    Connect PayPal
                  </SubmitButton>
                </form>
                {latestPaypalLog?.status === "FAILED" && (
                  <p className="text-xs text-red-600 dark:text-red-400">Last attempt failed: {latestPaypalLog.message}</p>
                )}
              </>
            )
          ) : (
            <>
              <div className="mt-1 flex flex-wrap justify-center gap-2">
                <form action={recheckPaypal}>
                  <SubmitButton
                    pendingText="Checking..."
                    className={GHOST_BUTTON}
                    trackPerf={{ label: "Recheck PayPal", storeId: store.id, attemptKey: `paypal_connect:${store.id}` }}
                  >
                    Recheck
                  </SubmitButton>
                </form>
                <form action={disconnectPaypal}>
                  <SubmitButton
                    pendingText="Disconnecting..."
                    className={`${GHOST_BUTTON} text-red-600 dark:text-red-400`}
                  >
                    Disconnect
                  </SubmitButton>
                </form>
              </div>
              {paypalStatusDisplay && (
                <p className="text-xs text-zinc-500">
                  {paypalStatusDisplay.message}
                  {paypalStatusDisplay.verified ? " · verified" : ""} · {paypalStatusDisplay.createdAt.toLocaleDateString()}
                </p>
              )}
              {paypalIntegration?.connectedBy && paypalIntegration.connectedAt && (
                <p className="text-xs text-zinc-400">
                  Connected by {paypalIntegration.connectedBy.name ?? paypalIntegration.connectedBy.email} on{" "}
                  {paypalIntegration.connectedAt.toLocaleDateString()}
                </p>
              )}
              <p className="text-xs text-zinc-400">
                To fully revoke access, regenerate your Secret in the PayPal Developer Dashboard.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
