import type { ReactNode } from "react";
import { GENESIS_BLACK, GENESIS_GREEN } from "@/lib/brand/palette";

// THE ROOM, BOUNDED.
//
// ============ WHY A FRAME AND NOT A FULL PAGE (2026-08-28) =============
//
// The doorway at /studio/create paints the whole viewport black and floats one
// object under a light. That is right for a place you arrive in, and it stays
// exactly as it is.
//
// The Studio landing has to hold two of these one after another — Product
// Creation, then Social Creation — plus everything below them. So the room
// becomes a panel: the same black ground, the same single soft light behind the
// focused object, the same green aura, at a height a section can afford.
//
// It is deliberately ONE component shared by both carousels. Sean: "It should
// feel like the same Creation Station experience, not four generic blue
// buttons." Two hand-built dark panels would drift apart within a week.

export function StageFrame({ children }: { children: ReactNode }) {
  return (
    <div
      className="relative mt-3 overflow-hidden rounded-3xl px-4 pb-5 pt-6"
      style={{ background: GENESIS_BLACK }}
    >
      {/* The space itself. A single soft light behind the focused object, so
          the object is lit rather than the panel being decorated. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-[38%] h-[420px] w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-70 blur-3xl"
        style={{ background: `radial-gradient(circle, ${GENESIS_GREEN}22 0%, transparent 68%)` }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}
