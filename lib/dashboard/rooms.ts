import {
  NAV_SECTIONS,
  COMMERCE_SECTIONS,
  STOREFRONT_SECTIONS,
  sectionHref,
  isSentinelHref,
  type NavSection,
} from "./navConfig";

// WHAT A ROOM IS MADE OF (decision 1 of the locked room architecture, Level B,
// approved 2026-08-22).
//
// The design question GENESIS_SURFACES.md reserved was "how the rooms actually
// feel different from one another while remaining one Genesis", with two failure
// conditions named: "rooms that look identical are tabs with better names, and
// rooms that look unrelated are separate products."
//
// The answer that was locked: a room's character comes from what it is MADE OF,
// not from what colour it is. Three variables, none of which the owner has to
// learn — the lead (what the eye lands on first), the density (how much is on
// screen at once) and the ground (what the content sits on).
//
// THE CONSTRAINTS THIS FILE EXISTS TO HOLD, all of them from the locked
// architecture rather than from taste:
//
//   * Blue is J4's and nothing else's. No room's identity may depend on hue —
//     "a room that glows blue steals the one signal the owner has learned to
//     read. Rooms get light without colour." Every ground below is neutral.
//   * The navigation never changes. Four labels, same place, same tap, every
//     time. Distinctiveness lives inside the room, never in the way you reach
//     it.
//   * ONE PLACE. Locking Level B locked the prohibition that comes with it: no
//     per-page styling. A screen that painted its own ground would be how three
//     rooms quietly become three products, so the ground is resolved here and
//     applied once by DashboardShell.
//   * The Office is exempt, permanently (decision 3). It renders ON TOP of a
//     room, so anything about it that varied with what is underneath would read
//     as belonging to the room — which is how it becomes a fifth room.
//     GENESIS_ATMOSPHERE stays its single source and nothing here touches it.

/** The rooms that carry visual character. Account is a sheet; arrival is not a room. */
export type RoomKey = "storefront" | "studio" | "commerce";

export interface RoomCharacter {
  /**
   * What the room's content sits on. Tailwind classes for <main>, and the only
   * place a room is allowed to differ in surface.
   */
  ground: string;
  /**
   * How the room packs information — a class applied alongside the ground, so a
   * screen can inherit its room's rhythm instead of choosing one.
   */
  density: string;
}

// The three grounds, and why each is what it is.
export const ROOM_CHARACTER: Record<RoomKey, RoomCharacter> = {
  // A NEUTRAL MAT. The storefront IS the canvas — "not a settings panel, not a
  // mock" — so the room's job is to recede until the owner's own site is the
  // brightest thing on screen. A slightly deeper ground than the default does
  // that without adding a single visible element, the way a mat around a print
  // is not itself part of the picture.
  storefront: {
    ground: "bg-zinc-100 dark:bg-zinc-950",
    density: "[--room-gap:1.5rem]",
  },
  // THE DARKEST ROOM, so that work in progress is the light source. A workbench
  // is lit by what is on it; a bright room around an unfinished piece makes the
  // piece look like the darker thing.
  studio: {
    ground: "bg-zinc-200 dark:bg-black",
    density: "[--room-gap:2rem]",
  },
  // A FLAT SHEET — ruled, not carded. Commerce is a ledger and a catalogue in
  // one room, and its density is set by its densest content: rows of orders,
  // customers and figures. A tinted ground makes cards float, and floating
  // cards are what turn a ledger into a feed. So the ground is the paper
  // itself, and rows are separated by rules rather than by gaps between
  // objects. tabular-nums is here rather than on any one screen because a
  // column of money that does not line up is the single most legible failure a
  // ledger can have.
  commerce: {
    ground: "bg-white tabular-nums dark:bg-zinc-950",
    density: "[--room-gap:0px]",
  },
};

/**
 * The default ground, for everywhere that is not one of the three rooms.
 *
 * Arrival and Account both land here, and that is correct rather than a gap:
 * arrival is "a third kind of surface, neither a room nor a tab", and Account
 * is configured rather than visited. Giving either a character would be
 * inventing work — see the design proposal's own note that a surface you visit
 * twice a year needs to be findable and boring.
 */
export const DEFAULT_GROUND = "bg-zinc-50 dark:bg-black";

/** Which room's sections are which. Derived from navConfig, never restated. */
const ROOM_MEMBERS: Record<RoomKey, NavSection[]> = {
  storefront: STOREFRONT_SECTIONS,
  commerce: COMMERCE_SECTIONS,
  // Studio has no section list, deliberately — "a room with one section shows
  // no section row at all". Its own nav entry is therefore its whole membership.
  studio: NAV_SECTIONS.filter((s) => s.key === "studio"),
};

/**
 * Which room the owner is standing in, or null for arrival and everywhere else.
 *
 * Prefix matching, matching the shell's own isActive exactly: /b/x/products/123
 * is still Products, and therefore still Commerce. That is the opposite of
 * workspaceContext's exact matching, and deliberately so — the two answer
 * different questions. "Which room am I in" has a safe wrong answer (the
 * default ground) and a useful loose one; "what is the owner looking at" has a
 * confidently wrong answer that J4 would then say out loud.
 *
 * Arrival is an exact match on the base, so a business root never inherits a
 * room from a prefix.
 */
export function roomForPath(pathname: string, basePath: string): RoomKey | null {
  if (pathname === basePath) return null;
  for (const key of Object.keys(ROOM_MEMBERS) as RoomKey[]) {
    const inRoom = ROOM_MEMBERS[key].some((section) => {
      if (isSentinelHref(section.href)) return false;
      const href = sectionHref(section.href, basePath);
      return href === basePath ? pathname === basePath : pathname.startsWith(href);
    });
    if (inRoom) return key;
  }
  return null;
}

/** The ground and density for wherever the owner is standing. */
export function roomSurface(pathname: string, basePath: string): string {
  const room = roomForPath(pathname, basePath);
  if (!room) return DEFAULT_GROUND;
  const character = ROOM_CHARACTER[room];
  return `${character.ground} ${character.density}`;
}
