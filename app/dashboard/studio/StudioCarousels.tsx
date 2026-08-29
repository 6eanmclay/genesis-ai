"use client";

import { useJ4Ask } from "@/app/dashboard/J4AskContext";

// THE ROWS THAT ARE NOT CLOTHING YET.
//
// ============ A CARD MUST NOT BE A DEAD END (2026-08-28) ===============
//
// Sean: "The cards should not lead to dead ends. Clicking one should open J4
// with the appropriate intent prefilled so the user can immediately ask for
// that type of creation. We can build dedicated Social/Graphics creation flows
// later."
//
// So these do not pretend to be flows. Social Creation is a locked contract
// with nothing built behind it (SOCIAL_CREATION.md) and there is no graphics
// builder, so a card routing to a dedicated screen would be a promise the
// product cannot keep — the thing every other part of this codebase has been
// corrected for.
//
// What they DO reach is real: useJ4Ask puts the sentence into the actual
// conversation, through the composer's own send pipeline. One conversation, one
// history, reached from one more place.
//
// ============ AND THE INTENTS ASK FOR WHAT J4 CAN DO ==================
//
// "Write an Instagram post" rather than "post to Instagram". J4 can create the
// content today; publishing to a platform is the unbuilt half. A prefilled
// sentence is a promise too, and it should be one that gets answered.

export interface CreationCard {
  key: string;
  label: string;
  hint: string;
  /** The sentence that reaches J4. */
  intent: string;
}

export const SOCIAL_CARDS: CreationCard[] = [
  { key: "instagram", label: "Instagram", hint: "Visual, on brand", intent: "Write an Instagram post for my business, and make the image for it" },
  { key: "facebook", label: "Facebook", hint: "Starts conversations", intent: "Write a Facebook post for my business that invites people to reply" },
  { key: "x", label: "X", hint: "Short and direct", intent: "Write a post for X for my business, in my own voice" },
  { key: "tiktok", label: "TikTok", hint: "For video", intent: "Help me plan a TikTok for my business and write the caption" },
];

export const GRAPHICS_CARDS: CreationCard[] = [
  { key: "promo", label: "Promotional graphic", hint: "For an offer", intent: "Create a promotional graphic for my business" },
  { key: "collage", label: "Collage", hint: "From your photos", intent: "Make a collage from my product photos" },
  { key: "flyer", label: "Flyer", hint: "Print or share", intent: "Create a flyer for my business" },
  { key: "banner", label: "Banner", hint: "For the storefront", intent: "Create a banner image for my storefront" },
];

export function CreationCardRow({ cards }: { cards: CreationCard[] }) {
  const { ask, available } = useJ4Ask();

  // RENDER NOTHING RATHER THAN A DEAD CONTROL. J4AskContext's own words, and
  // the reason this component can be trusted not to strand anybody: where the
  // conversation cannot be reached, the row simply is not there.
  if (!available) return null;

  return (
    <div className="-mx-5 mt-3 overflow-x-auto px-5 pb-1">
      <div className="flex gap-3">
        {cards.map((card) => (
          <button
            key={card.key}
            type="button"
            onClick={() => ask(card.intent)}
            className="w-[150px] shrink-0 rounded-2xl border border-black/[.08] bg-white p-4 text-left transition hover:border-black/25 dark:border-white/[.10] dark:bg-[#222226] dark:hover:border-white/30"
          >
            <span className="block text-[15px] font-medium">{card.label}</span>
            <span className="mt-1 block text-[13px] text-zinc-500">{card.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
