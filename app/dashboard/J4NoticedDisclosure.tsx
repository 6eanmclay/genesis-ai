"use client";

import { useState } from "react";
import { J4Icon } from "./J4Icon";

// "What J4 noticed" as a door, not a dashboard (2026-08-12) — the approved
// J4 interface direction. On mobile the observations collapse behind one
// quiet row; tapping it opens them. Sean's correction, and the reasoning
// worth keeping: the problem was never which three observations or their
// ordering, it was that they permanently occupied the screen at all. J4 can
// have things to tell you without putting three of them in your face every
// time you open the app.
//
// Two things this deliberately does NOT do:
//
//   1. It doesn't render a second copy of the list for desktop. There is one
//      instance of `children` — a duplicate would mean two sets of the same
//      server-action forms in the DOM, each with its own approve/reject
//      buttons for the same real proposal.
//   2. It doesn't hide anything at md:+. Desktop keeps rendering exactly what
//      it rendered before, expanded, with no summary row — that treatment is
//      its own design pass and is explicitly out of scope here.
//
// The count is deliberately monochrome. Blue means J4 and only J4, and a blue
// number on a collapsed row would read as a notification badge — something to
// be cleared rather than a door to be opened.
export function J4NoticedDisclosure({
  count,
  children,
}: {
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-6 md:mt-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 border-t border-black/[.08] py-4 text-left dark:border-white/[.145] md:hidden"
      >
        <span className="text-[15px] font-medium text-black dark:text-zinc-50">What J4 noticed</span>
        <span className="ml-auto text-[13px] tabular-nums text-zinc-500 dark:text-zinc-400">{count}</span>
        <J4Icon
          name="chevron"
          size={16}
          className={`text-zinc-400 transition-transform dark:text-zinc-500 ${open ? "rotate-90" : ""}`}
        />
      </button>

      {/* One instance. Hidden on mobile until the door is opened; always
          visible from md: up, regardless of that state. */}
      <div className={`${open ? "block" : "hidden"} md:block`}>{children}</div>
    </div>
  );
}
