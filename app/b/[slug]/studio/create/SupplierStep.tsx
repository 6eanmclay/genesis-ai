"use client";

import { connectIntegration } from "@/app/dashboard/connectionsActions";
import { GENESIS_BLACK, GENESIS_GREEN } from "@/lib/brand/palette";
import { CreatableArt } from "./CreatableArt";

// WHERE YOUR PRODUCTS GET MADE — A STEP IN CREATING, NOT A DETOUR OUT OF IT.
//
// ============ THE DEAD END THIS REPLACES ================================
//
// Sean: "T-shirt → Connect a print supplier → Connections → dead end. That's
// backwards." And the line that decides the shape of this file: "The user
// should never click Make a T-shirt and get dumped into a generic Connections
// page with no relevant supplier available."
//
// The old screen sent somebody to a page listing twelve integrations, where
// they had to work out which of them was the one their T-shirt needed. That is
// asking a person to understand the platform's architecture in order to make a
// shirt.
//
// So the supplier choice happens HERE, in the flow, named: this is who makes
// and ships the thing you just chose. The button starts Printful's real
// authorisation — the same server action the Connections screen uses, so there
// is one connect path rather than a second one that can drift.
//
// ============ WHAT IS STILL HONEST ABOUT IT =============================
//
// It does not pretend the choice is optional. Nothing about a T-shirt can be
// designed against a real catalogue until somebody makes it, and inventing
// colours and print areas to fill the gap would produce a design nobody could
// order — the rule this whole surface is built on.
//
// What changed is that the requirement is now part of creating rather than an
// interruption to it, and it names the one supplier that matters instead of
// handing over a directory.

export function SupplierStep({
  slug,
  creatableId,
  creatableLabel,
  /** Present when a supplier IS connected but could not be reached. */
  problem,
  /** Whether this deployment holds Printful's OAuth credentials at all. */
  configured,
  /** Set when an attempt just came back from Printful having failed. */
  attemptFailed,
}: {
  slug: string;
  creatableId: string;
  creatableLabel: string;
  problem?: string | null;
  configured: boolean;
  attemptFailed?: string | null;
}) {
  // WHERE PRINTFUL SENDS THE OWNER BACK TO — this exact step, still holding
  // what they chose. Signed into the OAuth state by the connector, never put on
  // the wire, so it cannot be turned into an open redirect.
  const returnTo = `/b/${slug}/studio/create${
    creatableId ? `?kind=${encodeURIComponent(creatableId)}` : ""
  }`;

  return (
    <div className="relative min-h-[calc(100vh-4rem)] text-zinc-100" style={{ background: GENESIS_BLACK }}>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-[30%] h-[420px] w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-60 blur-3xl"
        style={{ background: `radial-gradient(circle, ${GENESIS_GREEN}22 0%, transparent 68%)` }}
      />

      <div className="relative mx-auto flex max-w-md flex-col items-center px-6 py-14 text-center">
        {/* THE THING THEY CHOSE, STILL ON SCREEN. Losing it here is what made
            the old screen feel like being thrown out of the flow rather than
            moved along it. */}
        <CreatableArt id={creatableId} className="h-28 w-28 text-zinc-300" />

        <h1 className="mt-7 text-[22px] font-semibold">
          {problem
            ? `Your supplier didn't answer`
            : attemptFailed
              ? `That didn't connect`
              : configured
                ? `Where should your ${creatableLabel.toLowerCase()} be made?`
                : `Printful isn't available here yet`}
        </h1>

        {/* THE ACTUAL REASON, WHERE THE ATTEMPT HAPPENED (2026-08-27).
            A connection that fails silently and re-offers the same button is
            indistinguishable from one that never ran. This is the connector's
            own recorded message, not a guess made here. */}
        {attemptFailed ? (
          <p className="mt-2.5 max-w-sm text-[13px] leading-relaxed text-amber-300/80">{attemptFailed}</p>
        ) : null}

        <p className="mt-2.5 text-[14px] leading-relaxed text-zinc-400">
          {problem ? (
            <>
              Printful is connected, but the catalogue could not be read just now. It said:{" "}
              <span className="text-zinc-300">{problem}</span>
            </>
          ) : configured ? (
            <>
              Printful prints and ships it for you — no stock, no minimum. Connecting them brings their
              real blanks, colours, sizes and print areas into the designer, so what you make is
              something somebody can actually order.
            </>
          ) : (
            <>
              This deployment doesn&apos;t hold Printful&apos;s app credentials, so there is nothing to
              sign in to yet. That is ours to fix, not yours — everything else about creating is ready
              and waiting on it.
            </>
          )}
        </p>

        {/* THE REAL CONNECTION, STARTED HERE — WHEN THERE IS ONE TO START.
            Bound to this business and to Printful specifically, through the
            same action the Connections screen uses, so there is one connect
            path rather than a second that drifts.

            Absent when the deployment has no Printful credentials, because
            that button could only fail and then redirect to the connections
            screen with an error — the dead end coming back through the one
            door left open. A missing button that says why beats a present one
            that cannot work. */}
        {configured ? (
          <>
            <form action={connectIntegration.bind(null, slug, "PRINTFUL", returnTo)} className="mt-7 w-full">
              <button
                type="submit"
                className="w-full rounded-full px-6 py-3 text-[15px] font-medium text-white transition hover:brightness-110"
                style={{ background: GENESIS_GREEN }}
              >
                {problem ? "Reconnect Printful" : attemptFailed ? "Try connecting again" : "Connect Printful"}
              </button>
            </form>

            <p className="mt-4 text-[12px] text-zinc-500">
              You&apos;ll sign in to Printful and come straight back. Nothing is charged to set it up.
            </p>
          </>
        ) : null}

        {/* A way back to choosing, which is where they were. Deliberately not a
            link to the Connections directory: that is the detour this replaces. */}
        <a
          href={`/b/${slug}/studio/create`}
          className="mt-8 text-[13px] text-zinc-500 underline-offset-4 hover:text-zinc-300 hover:underline"
        >
          Pick something else to make
        </a>
      </div>
    </div>
  );
}
