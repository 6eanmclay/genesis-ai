"use client";

// The one interactive thing on a page whose whole purpose is to become paper.
//
// A client component for a single reason: window.print() cannot be called from
// the server. It is kept in its own file so PackingSlip itself stays a server
// component and can read the order directly, rather than the whole sheet
// becoming a client component to accommodate one button.
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-full bg-black px-4 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
    >
      Print packing slip
    </button>
  );
}
