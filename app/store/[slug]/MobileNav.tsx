"use client";

import { useState } from "react";

// The one client-side island in an otherwise fully server-rendered
// storefront — a hamburger toggle needs local open/closed state, which a
// server component can't hold. `links` is plain data computed server-side
// in page.tsx (from real store content, never invented), not duplicated
// logic — this component only renders it and tracks open/closed.
export function MobileNav({ links }: { links: { label: string; href: string }[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="md:hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--brand-text)]"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          className="h-6 w-6"
        >
          {open ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 6h16M4 12h16M4 18h16" />}
        </svg>
      </button>
      {open && (
        <div className="absolute inset-x-0 top-full z-30 border-b border-[var(--brand-text)]/[.08] bg-[var(--brand-background)] px-8 py-3 shadow-md">
          <ul className="flex flex-col gap-1">
            {links.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-lg px-2 py-2 text-sm text-[var(--brand-text)] hover:bg-[var(--brand-text)]/[.05]"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
