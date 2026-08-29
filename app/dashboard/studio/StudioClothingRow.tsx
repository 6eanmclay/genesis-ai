"use client";

import { useState } from "react";
import Link from "next/link";
import type { PortalItem } from "@/lib/creation/creatables";
import type { SavedDesignRow } from "@/app/b/[slug]/studio/create/actions";
import {
  availabilityLine,
  designHref,
  groupSavedWork,
  kindHref,
  lastEdited,
} from "@/lib/creation/creationPresentation";
import { CreatableArt } from "@/app/b/[slug]/studio/create/CreatableArt";
import { GENESIS_BLACK, GENESIS_GREEN } from "@/lib/brand/palette";

// CLOTHING, AS A SHELF RATHER THAN A ROOM.
//
// ============ WHY THIS IS NOT CreationPortal (2026-08-28) ==============
//
// CreationPortal is a full-viewport experience: it paints the whole screen
// black, floats one focused object under a light, and owns swipe and the arrow
// keys. That is right for a doorway you arrive in, and Sean kept it: "I don't
// want to sacrifice that experience just to make the Studio landing page work."
//
// It cannot also be one of three stacked sections. Dropping a screen-height
// carousel under a "Clothing" heading pushes Social and Graphics entirely below
// the fold, which is the opposite of the layout he asked for.
//
// So this is a second PRESENTATION of the same facts, not a second copy of
// them. Where it links and whether a supplier can make the thing both come from
// lib/creation/creationPresentation.ts, which the portal now reads too — one
// definition, two looks. The drawings are the same component as well.
//
// ============ SAVED WORK BELONGS TO THE PRODUCT =======================
//
// Sean: "I don't think we need a separate 'Saved Designs' area that users have
// to discover. Put the saved work directly into the creation flow for each
// product."
//
// So a card that has unfinished hoodies offers them ON the hoodie, next to
// making a new one. Nothing about how a design is stored changed to allow this
// — savedByCreatable joins what already exists.

export function StudioClothingRow({
  items,
  basePath,
  hasSupplier,
  catalogueUnreadable,
  savedFor,
}: {
  items: PortalItem[];
  basePath: string;
  hasSupplier: boolean;
  catalogueUnreadable: boolean;
  /** Saved designs by creatable id. Absent means none for that product. */
  savedFor: Record<string, SavedDesignRow[]>;
}) {
  // WHICH PRODUCT'S SAVED WORK IS OPEN, or null. One at a time: two open lists
  // in a row this narrow is a wall of thumbnails nobody can read.
  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId ? items.find((i) => i.creatable.id === openId) ?? null : null;
  const openSaved = openId ? savedFor[openId] ?? [] : [];
  const groups = groupSavedWork(openSaved);

  return (
    <div>
      {/* The shelf scrolls sideways; the page never does. The negative margin
          lets cards run to the screen edge on a phone, which is what makes it
          read as a scrollable row rather than a clipped grid. */}
      <div className="-mx-5 mt-3 overflow-x-auto px-5 pb-1">
        <div className="flex gap-3">
          {items.map((item) => {
            const line = availabilityLine(item, { hasSupplier, catalogueUnreadable });
            const saved = savedFor[item.creatable.id] ?? [];
            const isOpen = openId === item.creatable.id;

            return (
              <div
                key={item.creatable.id}
                className="flex w-[196px] shrink-0 flex-col rounded-2xl border border-black/[.08] bg-white p-3 dark:border-white/[.10] dark:bg-[#222226]"
              >
                {/* THE PRODUCT, ON ITS OWN GROUND. The drawings are near-white
                    with grey shading — they were made for the dark room, and on
                    a white card in light theme they would be close to
                    invisible. The dark tile is not decoration: it is the only
                    background these read against, and it carries a little of
                    the room's green so the shelf and the doorway are visibly
                    the same place. */}
                <div
                  className="relative grid h-[112px] place-items-center overflow-hidden rounded-xl"
                  style={{ background: GENESIS_BLACK }}
                >
                  <span
                    aria-hidden="true"
                    className="absolute inset-0"
                    style={{
                      background: `radial-gradient(circle at 50% 55%, ${GENESIS_GREEN}22 0%, transparent 70%)`,
                    }}
                  />
                  <CreatableArt id={item.creatable.id} className="relative h-[84%] w-[84%]" />
                </div>

                <p className="mt-2.5 text-[15px] font-medium">{item.creatable.label}</p>
                {/* THE COUNT AND THE DESCRIPTION, as one sentence. Composed by
                    the shared rule so this card and the doorway say the same
                    thing about the same hat. */}
                <p className="mt-0.5 text-[12px] leading-snug text-zinc-500">{line}</p>

                {/* ============ CONTINUE FIRST, THEN CREATE NEW ==========
                    Sean: "The user chooses the product → immediately sees
                    'Continue' or 'Create New' → their existing work is right
                    there. They should never have to go hunting through a
                    separate Saved Designs area to find something they already
                    made."

                    Continue leads because it is the cheaper answer: somebody
                    with a half-finished hoodie almost always wants that hoodie
                    rather than a sixth one. It is absent entirely when there is
                    nothing to continue, and then Create New takes the width —
                    a disabled control for work that does not exist is just a
                    question nobody asked.

                    Create New is offered even when the supplier makes none of
                    these: the doorway has always let the intention through and
                    let the create page explain, and this presentation does not
                    get to disagree with it. */}
                <div className="mt-2.5 flex gap-1.5">
                  {saved.length > 0 && (
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls="studio-continue-panel"
                      onClick={() => setOpenId(isOpen ? null : item.creatable.id)}
                      className="flex-1 rounded-lg border border-black/[.12] px-2 py-1.5 text-[12px] font-medium transition hover:border-black/35 dark:border-white/[.18] dark:hover:border-white/45"
                    >
                      Continue
                      <span aria-hidden="true" className="ml-1 inline-block text-[9px]">
                        {isOpen ? "▲" : "▼"}
                      </span>
                    </button>
                  )}

                  <Link
                    href={kindHref(basePath, item.creatable.id)}
                    className="flex-1 whitespace-nowrap rounded-lg px-2 py-1.5 text-center text-[12px] font-medium text-white transition hover:brightness-110"
                    style={{ background: GENESIS_GREEN }}
                  >
                    Create New
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ============ THE LIST OPENS BELOW THE SHELF, NOT OVER IT ========
          A panel positioned under its own card would be inside the horizontal
          scroller and clipped by it — an overflow container clips absolutely
          positioned children, so the list would be cut off at the card's edge
          on every screen. Opening full width underneath also gives a phone room
          to show a thumbnail somebody can actually recognise. */}
      {open && (
        <div
          id="studio-continue-panel"
          className="mt-3 rounded-2xl border border-black/[.08] bg-white p-3 dark:border-white/[.10] dark:bg-[#222226]"
        >
          <div className="flex items-center justify-between">
            <p className="text-[13px] font-medium">
              Continue a {open.creatable.label.toLowerCase()}
            </p>
            <button
              type="button"
              onClick={() => setOpenId(null)}
              className="rounded-lg px-2 py-1 text-[12px] text-zinc-500 transition hover:bg-black/[.05] dark:hover:bg-white/[.08]"
            >
              Close
            </button>
          </div>

          {/* ============ TWO GROUPS, BECAUSE THEY ARE TWO THINGS =====
              Sean asked for in-progress work and previously saved designs
              shown separately. The data already draws that line — `created` is
              true once a design has become a supplier product — so this is a
              read of what exists, not a new field.

              IN PROGRESS COMES FIRST. It is the work somebody came back for;
              a finished design is a reference, not an errand. */}
          {groups.inProgress.length > 0 && (
            <SavedGroup
              heading="In progress"
              designs={groups.inProgress}
              basePath={basePath}
            />
          )}
          {groups.saved.length > 0 && (
            <SavedGroup heading="Saved" designs={groups.saved} basePath={basePath} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One heading and the work under it.
 *
 * Extracted so "In progress" and "Saved" cannot drift into two different rows
 * showing the same fields differently — the whole panel exists so somebody can
 * compare their own designs at a glance.
 */
function SavedGroup({
  heading,
  designs,
  basePath,
}: {
  heading: string;
  designs: SavedDesignRow[];
  basePath: string;
}) {
  return (
    <div className="mt-3 first:mt-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{heading}</p>
      <ul className="mt-1 flex flex-col gap-1">
        {designs.map((design) => (
          <li key={design.draftId}>
            <Link
              href={designHref(basePath, design.externalProductId, design.draftId)}
              className="flex items-center gap-3 rounded-xl p-2 transition hover:bg-black/[.04] dark:hover:bg-white/[.06]"
            >
              {/* The artwork, on white, because artwork is usually transparent
                  and transparent artwork is invisible on a dark theme. */}
              <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-lg border border-black/[.10] bg-white dark:border-white/[.14]">
                {design.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- Blob-hosted
                  <img src={design.thumbnailUrl} alt="" className="h-full w-full object-contain p-1" />
                ) : (
                  <span className="text-[10px] text-zinc-400">empty</span>
                )}
              </span>

              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium">{design.name}</span>
                <span className="block truncate text-[12px] text-zinc-500">
                  {[
                    design.color,
                    design.sides.length > 0 ? design.sides.join(" and ") : "nothing on it yet",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>

              <span className="shrink-0 text-right">
                {/* ALREADY A PRODUCT stays on the row even though the heading
                    above says "Saved". Reopening a created design and pressing
                    Create again is the one mistake this panel could invite, and
                    the warning belongs where the tap happens rather than in a
                    heading somebody scrolled past. */}
                {design.created && (
                  <span className="block text-[11px] font-medium text-zinc-400">Already a product</span>
                )}
                <span className="block text-[11px] text-zinc-400">{lastEdited(design.updatedAt)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
