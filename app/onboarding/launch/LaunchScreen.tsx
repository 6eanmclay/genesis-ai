"use client";

import { useState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { GenesisAvatar } from "@/app/dashboard/GenesisAvatar";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { setGenesisWorking } from "@/lib/dashboard/genesisActivity";
import { launchConfirmStore, launchConnectStripe, launchConnectPaypal, launchGoLive } from "./actions";

// The Genesis Experience — Partnership/Launch act (Implementation roadmap
// Milestone 2). Real implementation of the approved mockup: confirm ->
// build store -> choose Stripe/PayPal -> everything's ready -> go live ->
// the real link. Same standard as IdeaScreen/BusinessScreen: idle avatar
// state throughout, real "thinking" activity tempo carrying the aliveness
// during real async work, no fabricated data or fake progress.
//
// Scope decisions Sean approved on the mockup: Stripe and PayPal are named
// explicitly (unlike fulfillment, which stays invisible — see BusinessScreen);
// declining at the "everything's ready" beat leaves the store built but
// unpublished, resumable anytime; the "share this with someone" payoff
// lives here, after real launch, rather than as a pre-commitment preview
// (no such preview infrastructure exists); "Partner"/"Partnership" is
// deliberately never named in the copy — that's still an open naming
// decision, not a blocker for building the experience itself.

type Beat =
  | "commitment"
  | "building"
  | "payment_choice"
  | "stripe_connecting"
  | "paypal_form"
  | "ready"
  | "publishing"
  | "live";

export type LaunchData =
  | {
      phase: "commitment";
      storeName: string;
      recap: { costInCents: number; priceInCents: number; profitInCents: number };
    }
  | { phase: "payment"; storeName: string }
  | { phase: "ready"; storeName: string }
  | { phase: "live"; storeName: string; storeUrl: string };

function initialBeat(data: LaunchData): Beat {
  switch (data.phase) {
    case "commitment":
      return "commitment";
    case "payment":
      return "payment_choice";
    case "ready":
      return "ready";
    case "live":
      return "live";
  }
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const shell =
  "fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 px-8 text-center overflow-y-auto py-12";

const primaryButton =
  "rounded-full px-7 py-3 text-sm font-semibold transition-transform hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100";

const ghostButton = "rounded-full border px-6 py-2.5 text-sm transition-colors";

export function LaunchScreen({ data }: { data: LaunchData }) {
  const router = useRouter();
  const [beat, setBeat] = useState<Beat>(() => initialBeat(data));
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const [storeUrl, setStoreUrl] = useState<string | null>(data.phase === "live" ? data.storeUrl : null);
  const [copied, setCopied] = useState(false);

  const storeName = data.storeName;

  // Beat: building — real work (confirmStoreDraftCore), never a fixed timer.
  useEffect(() => {
    if (beat !== "building") return;
    let cancelled = false;
    setGenesisWorking(true);
    (async () => {
      try {
        await launchConfirmStore();
        if (cancelled) return;
        setGenesisWorking(false);
        setBeat("payment_choice");
      } catch {
        if (cancelled) return;
        setGenesisWorking(false);
        setError("Something went wrong building your store — try again.");
        setBeat("commitment");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [beat]);

  // Beat: publishing — real work (publishStoreExecutable).
  useEffect(() => {
    if (beat !== "publishing") return;
    let cancelled = false;
    setGenesisWorking(true);
    (async () => {
      try {
        const { storeUrl: url } = await launchGoLive();
        if (cancelled) return;
        setGenesisWorking(false);
        setStoreUrl(url);
        setBeat("live");
      } catch {
        if (cancelled) return;
        setGenesisWorking(false);
        setError("Something went wrong going live — try again.");
        setBeat("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [beat]);

  function handleStripeConnect() {
    setError(null);
    startTransition(async () => {
      try {
        const { authorizeUrl, failed } = await launchConnectStripe();
        if (authorizeUrl) {
          window.location.href = authorizeUrl;
          return;
        }
        setError(failed ? "Stripe couldn't start the connection — try again." : "Something went wrong — try again.");
      } catch {
        setError("Stripe couldn't start the connection — try again.");
      }
    });
  }

  function handlePaypalSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      try {
        const result = await launchConnectPaypal(formData);
        if (result.ok) {
          setBeat("ready");
        } else {
          setError(result.error ?? "PayPal couldn't connect — check your credentials and try again.");
        }
      } catch {
        setError("PayPal couldn't connect — try again.");
      }
    });
  }

  return (
    <div className={shell} style={{ backgroundColor: GENESIS_ATMOSPHERE.bg }}>
      {beat === "commitment" && data.phase === "commitment" && (
        <>
          <GenesisAvatar state="idle" className="aspect-square w-[min(42vw,220px)]" />
          <p className="max-w-sm text-xl font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            Ready to make {storeName} real?
          </p>
          <div
            className="flex gap-6 rounded-2xl border px-6 py-4"
            style={{ backgroundColor: GENESIS_ATMOSPHERE.violetGlow, borderColor: GENESIS_ATMOSPHERE.border }}
          >
            <div>
              <div className="text-sm font-bold tabular-nums" style={{ color: GENESIS_ATMOSPHERE.text }}>
                {formatDollars(data.recap.costInCents)}
              </div>
              <div className="mt-1 text-[10px] uppercase tracking-wide" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
                cost
              </div>
            </div>
            <div>
              <div className="text-sm font-bold tabular-nums" style={{ color: GENESIS_ATMOSPHERE.text }}>
                {formatDollars(data.recap.priceInCents)}
              </div>
              <div className="mt-1 text-[10px] uppercase tracking-wide" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
                price
              </div>
            </div>
            <div>
              <div className="text-sm font-bold tabular-nums" style={{ color: "#4ade80" }}>
                {formatDollars(data.recap.profitInCents)}
              </div>
              <div className="mt-1 text-[10px] uppercase tracking-wide" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
                profit
              </div>
            </div>
          </div>
          <button onClick={() => setBeat("building")} className={primaryButton} style={{ backgroundColor: GENESIS_ATMOSPHERE.violet, color: GENESIS_ATMOSPHERE.bgElevated }}>
            Let&rsquo;s launch it
          </button>
        </>
      )}

      {beat === "building" && (
        <>
          <GenesisAvatar state="idle" className="aspect-square w-[min(30vw,120px)]" />
          <p className="max-w-sm text-xl font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            Building {storeName}.
          </p>
          <p className="max-w-sm text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
            Creating your store, listing your first product, and locking in your fulfillment connection.
          </p>
        </>
      )}

      {beat === "payment_choice" && (
        <>
          <GenesisAvatar state="idle" className="aspect-square w-[min(30vw,120px)]" />
          <p className="max-w-sm text-xl font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            How should {storeName} get paid?
          </p>
          <p className="max-w-sm text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
            This is the one connection worth choosing by name — you may already have one of these.
          </p>
          <div className="flex w-full max-w-xs gap-3">
            <button
              onClick={() => setBeat("stripe_connecting")}
              className="flex flex-1 flex-col items-center gap-2 rounded-xl border px-4 py-4 text-sm font-semibold transition-transform hover:-translate-y-0.5"
              style={{ borderColor: GENESIS_ATMOSPHERE.border, color: GENESIS_ATMOSPHERE.text }}
            >
              Stripe
            </button>
            <button
              onClick={() => setBeat("paypal_form")}
              className="flex flex-1 flex-col items-center gap-2 rounded-xl border px-4 py-4 text-sm font-semibold transition-transform hover:-translate-y-0.5"
              style={{ borderColor: GENESIS_ATMOSPHERE.border, color: GENESIS_ATMOSPHERE.text }}
            >
              PayPal
            </button>
          </div>
        </>
      )}

      {beat === "stripe_connecting" && (
        <>
          <GenesisAvatar state="idle" className="aspect-square w-[min(30vw,120px)]" />
          <p className="max-w-sm text-xl font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            You&rsquo;ll finish this on Stripe&rsquo;s site.
          </p>
          <p className="max-w-sm text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
            Since it&rsquo;s your real payment account, their form asks a few questions of its own. Take your time — Genesis will be right here when you&rsquo;re back.
          </p>
          <button onClick={handleStripeConnect} className={primaryButton} style={{ backgroundColor: GENESIS_ATMOSPHERE.violet, color: GENESIS_ATMOSPHERE.bgElevated }}>
            Continue to Stripe
          </button>
          <button onClick={() => setBeat("payment_choice")} className={ghostButton} style={{ borderColor: GENESIS_ATMOSPHERE.border, color: GENESIS_ATMOSPHERE.textSecondary }}>
            Back
          </button>
        </>
      )}

      {beat === "paypal_form" && (
        <>
          <GenesisAvatar state="idle" className="aspect-square w-[min(30vw,120px)]" />
          <p className="max-w-sm text-xl font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            Connect your PayPal account.
          </p>
          <p className="max-w-sm text-xs" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
            Create a PayPal Developer app at developer.paypal.com and enter its credentials below.
          </p>
          <form onSubmit={handlePaypalSubmit} className="flex w-full max-w-sm flex-col gap-3">
            <input
              name="clientId"
              placeholder="Client ID"
              required
              autoComplete="off"
              className="rounded-lg border px-4 py-2.5 text-sm outline-none"
              style={{ backgroundColor: "rgba(244,242,251,0.04)", borderColor: GENESIS_ATMOSPHERE.border, color: GENESIS_ATMOSPHERE.text }}
            />
            <input
              name="clientSecret"
              type="password"
              placeholder="Client Secret"
              required
              autoComplete="off"
              className="rounded-lg border px-4 py-2.5 text-sm outline-none"
              style={{ backgroundColor: "rgba(244,242,251,0.04)", borderColor: GENESIS_ATMOSPHERE.border, color: GENESIS_ATMOSPHERE.text }}
            />
            <select
              name="environment"
              defaultValue="sandbox"
              className="rounded-lg border px-4 py-2.5 text-sm outline-none"
              style={{ backgroundColor: "rgba(244,242,251,0.04)", borderColor: GENESIS_ATMOSPHERE.border, color: GENESIS_ATMOSPHERE.text }}
            >
              <option value="sandbox">Sandbox</option>
              <option value="live">Live</option>
            </select>
            <button type="submit" className={primaryButton} style={{ backgroundColor: GENESIS_ATMOSPHERE.violet, color: GENESIS_ATMOSPHERE.bgElevated }}>
              Connect PayPal
            </button>
          </form>
          <button onClick={() => setBeat("payment_choice")} className={ghostButton} style={{ borderColor: GENESIS_ATMOSPHERE.border, color: GENESIS_ATMOSPHERE.textSecondary }}>
            Back
          </button>
        </>
      )}

      {beat === "ready" && (
        <>
          <GenesisAvatar state="idle" className="aspect-square w-[min(42vw,220px)]" />
          <p className="max-w-sm text-xl font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            Everything&rsquo;s ready.
          </p>
          <p className="max-w-sm text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
            Your store is built. Payments are connected. The only thing left is you.
          </p>
          <button onClick={() => setBeat("publishing")} className={primaryButton} style={{ backgroundColor: GENESIS_ATMOSPHERE.violet, color: GENESIS_ATMOSPHERE.bgElevated }}>
            Go live
          </button>
          <button onClick={() => router.push("/dashboard")} className={ghostButton} style={{ borderColor: GENESIS_ATMOSPHERE.border, color: GENESIS_ATMOSPHERE.textSecondary }}>
            Not yet
          </button>
        </>
      )}

      {beat === "publishing" && (
        <>
          <GenesisAvatar state="idle" className="aspect-square w-[min(30vw,120px)]" />
          <p className="max-w-sm text-xl font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            Going live.
          </p>
        </>
      )}

      {beat === "live" && storeUrl && (
        <>
          <GenesisAvatar state="idle" className="aspect-square w-[min(42vw,220px)]" />
          <p className="max-w-sm text-xl font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            {storeName} is open.
          </p>
          <p className="max-w-sm text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
            The link you can send anyone, right now.
          </p>
          <div
            className="flex max-w-full items-center gap-2 rounded-full border py-2 pl-5 pr-2"
            style={{ borderColor: GENESIS_ATMOSPHERE.violetSoft, backgroundColor: GENESIS_ATMOSPHERE.bg }}
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: "#6ee7a8", boxShadow: "0 0 8px #6ee7a8" }}
            />
            <span className="truncate text-xs tabular-nums" style={{ color: GENESIS_ATMOSPHERE.text }}>
              {storeUrl.replace(/^https?:\/\//, "")}
            </span>
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(storeUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold"
              style={{ backgroundColor: GENESIS_ATMOSPHERE.violetGlow, color: GENESIS_ATMOSPHERE.violet }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button onClick={() => router.push("/dashboard")} className={`mt-2 ${primaryButton}`} style={{ backgroundColor: GENESIS_ATMOSPHERE.violet, color: GENESIS_ATMOSPHERE.bgElevated }}>
            Go to dashboard
          </button>
        </>
      )}

      {error && (
        <p className="max-w-sm text-sm" style={{ color: "#f87171" }}>
          {error}
        </p>
      )}
    </div>
  );
}
