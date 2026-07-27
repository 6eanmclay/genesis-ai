import { prisma } from "@/lib/prisma";
import { PERMISSIONS, requireStorePageAccess } from "@/lib/permissions";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { ExecutionStatusCard } from "../ExecutionStatusCard";
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

const ACCENT_BUTTON =
  "rounded-full bg-[var(--brand-accent)] text-white transition hover:opacity-90 disabled:opacity-50";

export default async function PaymentsPage() {
  const { store } = await requireStorePageAccess(PERMISSIONS.PAYMENTS_MANAGE);

  const stripeIntegration = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId: store.id, provider: "STRIPE" } },
    include: { connectedBy: { select: { name: true, email: true } } },
  });

  const latestStripeLog = stripeIntegration
    ? await prisma.executionLog.findFirst({
        where: {
          storeId: store.id,
          action: {
            in: [EXECUTION_ACTIONS.INTEGRATION_STRIPE_CONNECT, EXECUTION_ACTIONS.INTEGRATION_STRIPE_VERIFY],
          },
        },
        orderBy: { createdAt: "desc" },
      })
    : null;

  // Falls back to StoreIntegration's own fields for a connection made
  // before this phase existed (no ExecutionLog row yet) — the card still
  // renders correctly, just without a "verified" message until the next
  // Recheck writes a real log row.
  const stripeStatusDisplay = latestStripeLog
    ? {
        status: latestStripeLog.status,
        message: latestStripeLog.message,
        verified: latestStripeLog.verified,
        createdAt: latestStripeLog.createdAt,
        retryable: latestStripeLog.retryable,
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
          retryable: stripeIntegration.status !== "CONNECTED",
        }
      : null;

  const paypalIntegration = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId: store.id, provider: "PAYPAL" } },
    include: { connectedBy: { select: { name: true, email: true } } },
  });

  // Unlike Stripe, PayPal's form-stage log row exists before any
  // StoreIntegration row does (connect() only upserts one once credentials
  // are actually submitted) — so this can't be gated on paypalIntegration
  // already existing the way latestStripeLog is.
  const latestPaypalLog = await prisma.executionLog.findFirst({
    where: {
      storeId: store.id,
      action: {
        in: [EXECUTION_ACTIONS.INTEGRATION_PAYPAL_CONNECT, EXECUTION_ACTIONS.INTEGRATION_PAYPAL_VERIFY],
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // A credentials form is still owed whenever the most recent action is a
  // connect attempt that only got as far as returning form fields (no
  // metadata.fields means the connect fully completed, or nothing happened
  // yet).
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
        retryable: latestPaypalLog.retryable,
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
          retryable: paypalIntegration.status !== "CONNECTED",
        }
      : null;

  return (
    <div className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Payments</h1>

      {!stripeIntegration || stripeIntegration.status === "DISCONNECTED" ? (
        <>
          <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
            Connect your own Stripe account to receive payments directly.
            Until then, checkout uses Genesis&apos;s shared test account.
          </p>
          <form action={connectStripe} className="mt-4">
            <SubmitButton
              pendingText="Redirecting to Stripe..."
              className={`px-5 py-2 ${ACCENT_BUTTON}`}
              trackPerf={{ label: "Connect Stripe", storeId: store.id, attemptKey: `stripe_connect:${store.id}` }}
            >
              Connect Stripe
            </SubmitButton>
          </form>
        </>
      ) : (
        <>
          <ExecutionStatusCard
            title="Stripe"
            log={stripeStatusDisplay}
            actions={
              <>
                <form action={recheckStripe}>
                  <SubmitButton
                    pendingText="Checking..."
                    className="rounded-full border border-black/[.08] px-4 py-1.5 text-xs disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50"
                    trackPerf={{ label: "Recheck Stripe", storeId: store.id, attemptKey: `stripe_connect:${store.id}` }}
                  >
                    Recheck
                  </SubmitButton>
                </form>
                {stripeIntegration.status !== "CONNECTED" && (
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
                    className="rounded-full border border-black/[.08] px-4 py-1.5 text-xs text-red-600 disabled:opacity-50 dark:border-white/[.145] dark:text-red-400"
                  >
                    Disconnect
                  </SubmitButton>
                </form>
              </>
            }
          />
          {stripeIntegration.connectedBy && stripeIntegration.connectedAt && (
            <p className="mt-1 max-w-md text-xs text-zinc-500">
              Connected by{" "}
              {stripeIntegration.connectedBy.name ?? stripeIntegration.connectedBy.email}{" "}
              on {stripeIntegration.connectedAt.toLocaleDateString()}
            </p>
          )}
        </>
      )}

      <h3 className="mt-6 text-sm font-semibold text-black dark:text-zinc-50">PayPal</h3>
      {!paypalIntegration || paypalIntegration.status === "DISCONNECTED" ? (
        paypalFormFields ? (
          <form action={submitPaypalCredentials} className="mt-4 flex max-w-md flex-col gap-3">
            <p className="text-xs text-zinc-500">
              Create a PayPal Developer app at developer.paypal.com and enter
              its credentials below.
            </p>
            {paypalFormFields.map((field) => (
              <input
                key={field.name}
                name={field.name}
                type={field.type}
                placeholder={field.label}
                required={field.name !== "environment"}
                defaultValue={field.name === "environment" ? "sandbox" : undefined}
                className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
              />
            ))}
            <SubmitButton
              pendingText="Connecting..."
              className={`self-start px-5 py-2 ${ACCENT_BUTTON}`}
              trackPerf={{ label: "Submit PayPal credentials", storeId: store.id, attemptKey: `paypal_connect:${store.id}` }}
            >
              Connect PayPal
            </SubmitButton>
          </form>
        ) : (
          <>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              Connect your own PayPal account as a second way to accept
              payments.
            </p>
            {latestPaypalLog?.status === "FAILED" && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                Last attempt failed: {latestPaypalLog.message}
              </p>
            )}
            <form action={connectPaypal} className="mt-4">
              <SubmitButton
                pendingText="Starting..."
                className={`px-5 py-2 ${ACCENT_BUTTON}`}
                trackPerf={{ label: "Connect PayPal", storeId: store.id, attemptKey: `paypal_connect:${store.id}` }}
              >
                Connect PayPal
              </SubmitButton>
            </form>
          </>
        )
      ) : (
        <>
          <ExecutionStatusCard
            title="PayPal"
            log={paypalStatusDisplay}
            actions={
              <>
                <form action={recheckPaypal}>
                  <SubmitButton
                    pendingText="Checking..."
                    className="rounded-full border border-black/[.08] px-4 py-1.5 text-xs disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50"
                    trackPerf={{ label: "Recheck PayPal", storeId: store.id, attemptKey: `paypal_connect:${store.id}` }}
                  >
                    Recheck
                  </SubmitButton>
                </form>
                <form action={disconnectPaypal}>
                  <SubmitButton
                    pendingText="Disconnecting..."
                    className="rounded-full border border-black/[.08] px-4 py-1.5 text-xs text-red-600 disabled:opacity-50 dark:border-white/[.145] dark:text-red-400"
                  >
                    Disconnect
                  </SubmitButton>
                </form>
              </>
            }
          />
          {paypalIntegration.connectedBy && paypalIntegration.connectedAt && (
            <p className="mt-1 max-w-md text-xs text-zinc-500">
              Connected by{" "}
              {paypalIntegration.connectedBy.name ?? paypalIntegration.connectedBy.email}{" "}
              on {paypalIntegration.connectedAt.toLocaleDateString()}
            </p>
          )}
          <p className="mt-1 max-w-md text-xs text-zinc-400">
            To fully revoke access, regenerate your Secret in the PayPal
            Developer Dashboard.
          </p>
        </>
      )}
    </div>
  );
}
