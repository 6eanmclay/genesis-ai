"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { MapService } from "./BusinessMapCanvas";

// CONNECT OR CREATE, AS A CHOOSER RATHER THAN A CARD.
//
// ============ WHY THIS REPLACED THE CARD (2026-09-01) ==================
//
// Sean: "I do not like the current floating Connections card... When the user
// clicks/taps Connections, I want a proper connection chooser to appear."
//
// The card was one service at a time behind two taps. A merchant deciding what
// to connect is comparing, not inspecting, so the whole set is shown at once
// with both doors on every row.
//
// ============ THE ICONS ARE THE PROVIDERS' OWN ========================
//
// Sean: "Use the provider's favicon from its verified official domain... Do not
// use a third-party favicon service. Do not invent/draw brand logos from
// memory."
//
// So the icon is `https://<domain>/favicon.ico`, where <domain> is the one
// recorded in signupDestinations.ts and confirmed by fetching it. No Google
// s2, no bundled SVG copied from memory — I would get those marks wrong, and a
// wrong logo is worse than no logo.
//
// TWO SERVICES HAVE NO VERIFIED DOMAIN (QuickBooks and Facebook, whose signup
// pages could not be confirmed). They get the monogram, which is also what any
// provider falls back to when its favicon fails to load. The fallback is not a
// degraded state — it is the honest one.

function Monogram({ name }: { name: string }) {
  // Initials from the service's own name. Nothing invented, nothing branded.
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return (
    <span
      aria-hidden
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-black/[.10] bg-black/[.03] text-[11px] font-semibold text-zinc-600 dark:border-white/[.16] dark:bg-white/[.06] dark:text-zinc-300"
    >
      {initials}
    </span>
  );
}

// ============ THE MONOGRAM IS THE DEFAULT, THE FAVICON IS THE UPGRADE ===
//
// The first version rendered the <img> first and fell back on error. The row
// then showed NOTHING at all whenever the request was slow, blocked, or still
// in flight — which is every row on a machine that cannot reach the provider,
// and would be every row for a merchant behind a restrictive network.
//
// So the monogram renders immediately and always, and the provider's own icon
// replaces it only once it has genuinely decoded. An icon slot is never empty,
// and no state depends on a network call succeeding.
function ServiceIcon({ service }: { service: MapService }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <span className="relative flex h-8 w-8 shrink-0 items-center justify-center">
      {!loaded && <Monogram name={service.name} />}
      {service.iconDomain && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`https://${service.iconDomain}/favicon.ico`}
          alt=""
          aria-hidden
          width={32}
          height={32}
          onLoad={(e) => {
            // A server can answer 200 with something that decodes to nothing,
            // and onError never fires for that. Zero natural width is failure.
            if ((e.currentTarget as HTMLImageElement).naturalWidth > 0) setLoaded(true);
          }}
          className={
            loaded
              ? "absolute inset-0 h-8 w-8 rounded-lg bg-white object-contain p-1"
              : "sr-only"
          }
        />
      )}
    </span>
  );
}

export function ConnectionChooser({
  services,
  connectionsHref,
  onClose,
}: {
  services: MapService[];
  connectionsHref: string;
  onClose: () => void;
}) {
  // Escape closes, and the chooser takes focus off the map beneath it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const connected = services.filter((s) => s.connected);
  const connectable = services.filter((s) => !s.connected && s.available);
  const notYet = services.filter((s) => !s.connected && !s.available);

  const Row = ({ service }: { service: MapService }) => (
    // STACKS ON A PHONE. Side by side, the two actions squeezed the name down
    // to "Googl..." and "Q..." at 390px — a chooser whose whole job is telling
    // you what you are connecting.
    <li className="flex flex-col gap-2 rounded-xl border border-black/[.07] px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3 dark:border-white/[.10]">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <ServiceIcon service={service} />
        <div className="min-w-0">
        <p className="text-sm font-medium text-black dark:text-zinc-50">{service.name}</p>
        <p className="text-[11px] text-zinc-500">
          {service.connected
            ? "Connected — J4 uses this"
            : service.available
              ? "Not connected"
              : "Genesis cannot connect this yet"}
        </p>
        </div>
      </div>
      {service.connected ? (
        <Link
          href={service.manage?.href ?? connectionsHref}
          className="shrink-0 self-start rounded-full border border-black/[.12] px-3 py-1 text-[11px] font-medium text-black ml-11 sm:ml-0 sm:self-auto dark:border-white/[.20] dark:text-zinc-50"
        >
          Manage
        </Link>
      ) : service.available ? (
        <div className="flex shrink-0 items-center gap-2 pl-11 sm:pl-0">
          <Link
            href={connectionsHref}
            className="rounded-full border border-black/[.12] px-3 py-1 text-[11px] font-medium text-black dark:border-white/[.20] dark:text-zinc-50"
          >
            Connect
          </Link>
          {service.signupUrl ? (
            <a
              href={service.signupUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="whitespace-nowrap px-1 text-[11px] text-zinc-500 underline underline-offset-2"
            >
              Create account
            </a>
          ) : (
            // NEVER "go and search for it". The honest alternative to a
            // verified signup page is saying we do not have one.
            <span className="whitespace-nowrap text-[11px] text-zinc-400">No verified signup link</span>
          )}
        </div>
      ) : null}
    </li>
  );

  return (
    <div
      data-testid="connection-chooser"
      role="dialog"
      aria-modal="true"
      aria-label="Connect a service"
      className="absolute inset-0 z-20 flex flex-col bg-[var(--map-surface)]/97 backdrop-blur-sm"
    >
      <div className="flex items-center justify-between gap-2 border-b border-black/[.07] px-4 py-2.5 dark:border-white/[.10]">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-black dark:text-zinc-50">Connect a service</p>
          <p className="text-[11px] leading-snug text-zinc-500">
            Have it? Connect it. Don&apos;t have it? Create it here.
          </p>
        </div>
        <button
          type="button"
          data-testid="connection-chooser-close"
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded-full border border-black/[.10] px-2.5 py-1 text-[11px] text-zinc-500 dark:border-white/[.16]"
        >
          Close
        </button>
      </div>

      {/* SCROLLS RATHER THAN CROWDS. Sean: "If we eventually have more services
          than comfortably fit on a phone, make the popup scrollable so the user
          can browse them without making the interface cluttered." */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {connected.length > 0 && (
          <>
            <p className="mb-1.5 text-[10px] uppercase tracking-wide text-zinc-500">Connected</p>
            <ul className="mb-4 flex flex-col gap-2">
              {connected.map((s) => <Row key={s.id} service={s} />)}
            </ul>
          </>
        )}
        <p className="mb-1.5 text-[10px] uppercase tracking-wide text-zinc-500">Available</p>
        <ul className="flex flex-col gap-2">
          {connectable.map((s) => <Row key={s.id} service={s} />)}
        </ul>
        {notYet.length > 0 && (
          <>
            <p className="mb-1.5 mt-4 text-[10px] uppercase tracking-wide text-zinc-500">
              Not yet supported
            </p>
            <ul className="flex flex-col gap-2 pb-2">
              {notYet.map((s) => <Row key={s.id} service={s} />)}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
