"use client";

import { useState, type ReactNode } from "react";

// THE SEVEN TOOLS, AND WHICH OF THEM ARE REAL.
//
// ============ ORGANISATION, NOT A REWRITE ==============================
//
// Sean: "The existing functionality can be reused where it already exists.
// This is primarily a better organization of the controls, not a reason to
// rewrite working behavior."
//
// So every tool here is a door onto something that already worked — the
// colour swatches, the asset grid, centre/bigger/smaller/rotate, the flip
// operation, the front/back views. What changed is that they are now seven
// named places instead of one row of nine buttons and a sidebar.
//
// ============ AND ONE OF THEM IS NOT BUILT =============================
//
// Paint is named in the design and has no implementation. It is shown, and it
// says so, rather than being quietly dropped from the row or wired to
// something that merely looks like painting. A tool that does nothing and
// admits it is a promise; a tool that does nothing and pretends is a bug
// somebody has to discover.
//
// `ready: false` is the whole mechanism, so a future tool cannot be added to
// this row without deciding which it is.

export interface Tool {
  id: string;
  label: string;
  icon: ReactNode;
  /** False for a tool that is designed but not implemented. */
  ready: boolean;
  /** What it will do, shown when it is not ready. */
  soon?: string;
  /** Acts immediately instead of opening a panel. */
  onAct?: () => void;
  /** Rendered in the sheet above the toolbar. */
  panel?: ReactNode;
  /** Greys the tool when the thing it acts on is not there. */
  disabled?: boolean;
  /** Why it is greyed, so a dead control is never a mystery. */
  disabledReason?: string;
}

export function DesignToolbar({ tools }: { tools: Tool[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = tools.find((t) => t.id === openId) ?? null;

  return (
    <div className="sticky bottom-0 z-20 mt-6">
      {/* THE PANEL, ABOVE THE ROW. It pushes nothing around: the toolbar keeps
          its place so a tool is always where it was last time. */}
      {open ? (
        <div className="mx-auto max-w-3xl rounded-t-2xl border border-b-0 border-black/[.10] bg-white/95 p-4 backdrop-blur dark:border-white/[.14] dark:bg-zinc-950/95">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[13px] font-medium text-zinc-500">{open.label}</h2>
            <button
              type="button"
              onClick={() => setOpenId(null)}
              className="rounded-full px-2 py-1 text-[12px] text-zinc-500 transition hover:bg-black/[.05] dark:hover:bg-white/[.08]"
            >
              Done
            </button>
          </div>
          {open.ready ? (
            open.panel
          ) : (
            // NOT BUILT, AND SAYING SO.
            <p className="text-[13px] text-zinc-500">{open.soon ?? "Not built yet."}</p>
          )}
        </div>
      ) : null}

      <div className="mx-auto flex max-w-3xl items-stretch justify-between gap-1 rounded-2xl border border-black/[.10] bg-white/95 p-1.5 backdrop-blur dark:border-white/[.14] dark:bg-zinc-950/95">
        {tools.map((tool) => {
          const active = openId === tool.id;
          return (
            <button
              key={tool.id}
              type="button"
              disabled={tool.disabled}
              title={tool.disabled ? tool.disabledReason : tool.label}
              aria-pressed={active}
              onClick={() => {
                if (tool.onAct) {
                  tool.onAct();
                  return;
                }
                setOpenId(active ? null : tool.id);
              }}
              className={[
                "flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl px-1 py-2 text-[11px] transition",
                active
                  ? "bg-zinc-900 text-white dark:bg-white dark:text-black"
                  : "text-zinc-600 hover:bg-black/[.05] dark:text-zinc-300 dark:hover:bg-white/[.08]",
                tool.disabled ? "opacity-35" : "",
              ].join(" ")}
            >
              <span aria-hidden="true" className="grid h-5 w-5 place-items-center">
                {tool.icon}
              </span>
              <span className="truncate">{tool.label}</span>
              {/* A dot rather than a word: the row is seven items wide on a
                  phone and there is no room for "soon". */}
              {!tool.ready && (
                <span aria-hidden="true" className="h-1 w-1 rounded-full bg-amber-500" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Line icons, drawn rather than imported: seven glyphs is less code than a
// dependency, and they inherit the row's colour in both themes.
const s = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const ToolIcons = {
  color: (
    <svg viewBox="0 0 20 20" className="h-full w-full" {...s}>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 3a7 7 0 0 0 0 14 3.5 3.5 0 0 0 0-7 3.5 3.5 0 0 1 0-7Z" />
    </svg>
  ),
  add: (
    <svg viewBox="0 0 20 20" className="h-full w-full" {...s}>
      <path d="M10 4v12M4 10h12" />
    </svg>
  ),
  pad: (
    <svg viewBox="0 0 20 20" className="h-full w-full" {...s}>
      <rect x="3" y="3" width="14" height="14" rx="2" />
      <rect x="6.5" y="6.5" width="7" height="7" rx="1" strokeDasharray="2 2" />
    </svg>
  ),
  edit: (
    <svg viewBox="0 0 20 20" className="h-full w-full" {...s}>
      <path d="M13.5 3.5 16.5 6.5 7 16H4v-3l9.5-9.5Z" />
    </svg>
  ),
  flip: (
    <svg viewBox="0 0 20 20" className="h-full w-full" {...s}>
      <path d="M10 3v14" strokeDasharray="2 2" />
      <path d="M7.5 6 3.5 10l4 4V6ZM12.5 6l4 4-4 4V6Z" />
    </svg>
  ),
  paint: (
    <svg viewBox="0 0 20 20" className="h-full w-full" {...s}>
      <path d="M4 13.5 12.5 5a2.1 2.1 0 0 1 3 3L7 16.5l-3.5 1 .5-4Z" />
    </svg>
  ),
  spin: (
    <svg viewBox="0 0 20 20" className="h-full w-full" {...s}>
      <ellipse cx="10" cy="10" rx="7" ry="3.2" />
      <path d="M3 10a7 7 0 0 0 14 0" />
      <path d="M13.4 7.2 16 5.6l.6 3" />
    </svg>
  ),
};
