// Minimal inline stroke icons keyed by nav section — no icon library
// dependency for a fixed set of ~9 glyphs. Every path shares the same
// viewBox/stroke setup so new entries drop in without re-tuning.
const PATHS: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5",
  brand: "M12 2 L14.5 9 L22 9.5 L16 14.5 L18 22 L12 17.5 L6 22 L8 14.5 L2 9.5 L9.5 9 Z",
  website: "M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18ZM3 12a9 9 0 0 1 18 0 9 9 0 0 1-18 0Z",
  orders: "M7 3h10v18l-5-3-5 3V3ZM9 8h6M9 11h6",
  products: "m3 8 9-5 9 5-9 5-9-5Zm0 0v8l9 5 9-5V8M12 13v8",
  customers: "M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-6 9c0-3.3 2.7-6 6-6s6 2.7 6 6M17 11a3 3 0 1 0 0-6M23 20c0-2.8-2-5-5-5",
  marketing: "M3 11v2a2 2 0 0 0 2 2h1l2 5h2l-1.5-5H11l7 4V6l-7 4H6a2 2 0 0 0-2 2Zm14-4v10",
  payments: "M2 7h20v11H2V7Zm0 4h20M6 15h4",
  analytics: "M4 21V10M12 21V4M20 21v-7",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-3a8 8 0 0 1-.15 1.5l2 1.5-2 3.5-2.3-.9a8 8 0 0 1-2.6 1.5L14.5 22h-5l-.45-2.4a8 8 0 0 1-2.6-1.5l-2.3.9-2-3.5 2-1.5A8 8 0 0 1 4 12a8 8 0 0 1 .15-1.5l-2-1.5 2-3.5 2.3.9a8 8 0 0 1 2.6-1.5L9.5 2h5l.45 2.4a8 8 0 0 1 2.6 1.5l2.3-.9 2 3.5-2 1.5c.1.48.15.98.15 1.5Z",
};

export function NavIcon({ section, className }: { section: string; className?: string }) {
  const d = PATHS[section];
  if (!d) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
