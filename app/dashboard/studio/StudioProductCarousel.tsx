"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
import { CreationStage, StageDots } from "@/app/b/[slug]/studio/create/CreationStage";
import { StageFrame } from "./StageFrame";
import { GENESIS_GREEN } from "@/lib/brand/palette";

// PRODUCT CREATION — the immersive carousel, in a section.
//
// ============ THE CAROUSEL CAME BACK (2026-08-28) =====================
//
// This was briefly a row of small cards. Sean, on seeing it: "I want the
// Product Creation section to retain the same visual carousel experience we
// originally had — the immersive product imagery, focused center item,
// surrounding products, swipe/navigation, etc."
//
// He is right, and the earlier objection was to the wrong thing. What could not
// be a section was the full-VIEWPORT page: the doorway paints the whole screen
// and pushes everything after it below the fold. The carousel itself was never
// the problem — it is a fixed-height stage — so it is here unchanged, and the
// page around it is what got shorter.
//
// The stage, the depth maths, the axis-locked swipe and the drawings are the
// SAME code the doorway runs. See CreationStage.
//
// ============ AND THE ACTIONS ARE UNDER THE FOCUSED OBJECT ============
//
// Sean: "underneath the selected product, the actions should now be
// Continue ▾ | Create New... If there are no saved/in-progress designs for that
// product, don't show Continue."
//
// A carousel has exactly one focused object, which is what makes this work: the
// actions belong to the thing in front of you, so there is no question of which
// hoodie "Continue" means.

export function StudioProductCarousel({
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
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [openSaved, setOpenSaved] = useState(false);

  const count = items.length;
  const focused = count > 0 ? items[((index % count) + count) % count] : null;
  const saved = focused ? savedFor[focused.creatable.id] ?? [] : [];
  const groups = groupSavedWork(saved);

  if (count === 0) return null;

  const stageItems = items.map((item) => ({
    id: item.creatable.id,
    label: item.creatable.label,
    art: <CreatableArt id={item.creatable.id} className="relative h-[86%] w-[86%]" />,
  }));

  return (
    <div>
      <StageFrame>
        <CreationStage
          items={stageItems}
          index={index}
          onIndexChange={(next) => {
            // CHANGING PRODUCT CLOSES THE LIST. It belongs to the hoodie, and
            // leaving it open over a t-shirt would offer hoodies under the
            // wrong heading.
            setOpenSaved(false);
            setIndex(next);
          }}
          onChoose={() => {
            // Tapping the object is the same as Create New. The object has
            // always been the control here; the buttons are the explicit way to
            // say the same thing.
            // router.push, never location.assign: a full page reload would
            // throw away the whole workspace to move one screen.
            if (focused) router.push(kindHref(basePath, focused.creatable.id));
          }}
          ariaLabel="What to make"
          height="h-[270px] sm:h-[320px]"
        />

        {/* WHAT IS SELECTED, AND WHAT TO DO WITH IT. Name, then what it is,
            then the actions, then the dots — the indicator is the least
            important thing here and reads as such rather than competing. */}
        <div className="relative z-10 mt-3 text-center">
          <p className="text-[20px] font-medium text-zinc-100">{focused?.creatable.label}</p>
          <p className="mx-auto mt-1 max-w-xs text-[13px] text-zinc-400">
            {focused ? availabilityLine(focused, { hasSupplier, catalogueUnreadable }) : null}
          </p>

          <div className="mt-4 flex items-center justify-center gap-2">
            {saved.length > 0 && focused && (
              <button
                type="button"
                aria-expanded={openSaved}
                aria-controls="studio-continue-panel"
                onClick={() => setOpenSaved((o) => !o)}
                className="rounded-full border border-white/25 px-5 py-2.5 text-[14px] font-medium text-zinc-100 transition hover:border-white/60"
              >
                Continue
                <span aria-hidden="true" className="ml-1.5 inline-block text-[10px]">
                  {openSaved ? "▲" : "▼"}
                </span>
              </button>
            )}

            {focused && (
              <Link
                href={kindHref(basePath, focused.creatable.id)}
                className="rounded-full px-5 py-2.5 text-[14px] font-medium text-white transition hover:brightness-110"
                style={{ background: GENESIS_GREEN }}
              >
                Create New
              </Link>
            )}
          </div>

          <div className="mt-5 pb-1">
            <StageDots count={count} index={index} ids={items.map((i) => i.creatable.id)} />
          </div>
        </div>
      </StageFrame>

      {/* ============ THE LIST OPENS BELOW THE STAGE, NOT OVER IT =======
          A panel positioned inside the stage would sit among absolutely
          positioned, transformed objects with their own z-indexes — and the
          stage clips. Opening underneath also gives a phone room to show a
          thumbnail somebody can actually recognise. */}
      {openSaved && focused && (
        <div
          id="studio-continue-panel"
          className="mt-3 rounded-2xl border border-black/[.08] bg-white p-3 dark:border-white/[.10] dark:bg-[#222226]"
        >
          <div className="flex items-center justify-between">
            <p className="text-[13px] font-medium">
              Continue a {focused.creatable.label.toLowerCase()}
            </p>
            <button
              type="button"
              onClick={() => setOpenSaved(false)}
              className="rounded-lg px-2 py-1 text-[12px] text-zinc-500 transition hover:bg-black/[.05] dark:hover:bg-white/[.08]"
            >
              Close
            </button>
          </div>

          {/* ============ TWO GROUPS, BECAUSE THEY ARE TWO THINGS =======
              Sean asked for in-progress work and previously saved designs shown
              separately. The data already draws that line — `created` is true
              once a design has become a supplier product — so this is a read of
              what exists, not a new field.

              IN PROGRESS COMES FIRST. It is the work somebody came back for; a
              finished design is a reference, not an errand. */}
          {groups.inProgress.length > 0 && (
            <SavedGroup heading="In progress" designs={groups.inProgress} basePath={basePath} />
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
 * showing the same fields differently — the panel exists so somebody can
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
