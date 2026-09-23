"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { connectIntegration } from "@/app/dashboard/connectionsActions";
import { SubmitButton } from "./SubmitButton";
import type { MapService } from "./BusinessMapCanvas";

// CONNECTING ONE SERVICE, WHERE THE OWNER ALREADY IS.
//
// ============ WHAT THIS REPLACED (2026-09-23) =========================
//
// Sean: "The Business Map Facebook card must never navigate to the Connections
// page... The Facebook card in the Business Map is itself the connection entry
// point."
//
// The Social branch draws a Facebook card that already says "Not connected"
// and already carries its own serviceId. Its Connect button called
// `onConnect` — and the canvas ignored the id it was handed and opened the
// whole connection chooser, so an owner who had found Facebook was shown a
// list of every service and asked to find Facebook in it a second time.
//
// Nothing was missing but the wiring. This is the card's own dialog: one
// service, named, with the action that connects it.
//
// ============ IT IS NOT A SECOND CONNECTION IMPLEMENTATION ============
//
// The button binds `connectIntegration`, the same server action the
// Connections page's own ConnectorCard submits. Permission, the execution log,
// the signed OAuth state, the callback and the redirect all stay in one place.
// A second path from here would be a second place for authorization behaviour
// to drift, which is the last thing an OAuth flow should have.
//
// The handoff to Meta happens when the form is submitted, not when the dialog
// opens — so the owner sees what they are about to connect and chooses it,
// rather than being thrown at a provider by a single tap.

export function ConnectServiceDialog({
  service,
  slug,
  onClose,
}: {
  service: MapService;
  /**
   * Which business is connecting. Threaded rather than read from the URL: the
   * map renders under both /dashboard and /b/[slug], and a connect that
   * guessed wrong would attach the account to a different business.
   */
  slug: string | undefined;
  onClose: () => void;
}) {
  // WHERE THE OWNER WAS, so the callback returns them to this map rather than
  // to the Connections page. connectIntegration's own safeReturnTo refuses
  // anything that is not a same-origin path, so this adds no new trust.
  const returnTo = usePathname();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      data-testid="connect-service-dialog"
      data-service={service.id}
      role="dialog"
      aria-modal="true"
      aria-label={`Connect ${service.name}`}
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-sm rounded-2xl border border-black/[.08] bg-white p-5 shadow-xl dark:border-white/[.14] dark:bg-zinc-900">
        <p className="text-[11px] uppercase tracking-wide text-zinc-500">Connect a service</p>
        <h2 className="mt-1 text-lg font-semibold text-black dark:text-zinc-50">
          Connect {service.name}
        </h2>

        {/* THE PROVIDER'S OWN SENTENCE, from the catalogue. Nothing about what
            it will report is written here — see connectionDomains.ts on why a
            line invented at the call site would lose the provider's own
            limits. */}
        {service.description && (
          <p className="mt-2 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
            {service.description}
          </p>
        )}

        <p className="mt-3 text-[12px] text-zinc-500">
          You&apos;ll sign in with {service.name} and come straight back here.
        </p>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-4 py-1.5 text-[12px] font-medium text-zinc-600 hover:bg-black/[.04] dark:text-zinc-400 dark:hover:bg-white/[.06]"
          >
            Not now
          </button>
          {/* THE CANONICAL ACTION. `service.provider` is non-null here — the
              caller only opens this dialog for a service Genesis can connect —
              but the guard keeps that a compile-time fact rather than a
              convention, and renders nothing clickable if it ever changes. */}
          {service.provider && (
            <form action={connectIntegration.bind(null, slug, service.provider, returnTo)}>
              <SubmitButton
                pendingText="Connecting…"
                className="rounded-full bg-black px-4 py-1.5 text-[12px] font-medium text-white disabled:opacity-60 dark:bg-zinc-50 dark:text-black"
              >
                Connect {service.name}
              </SubmitButton>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
