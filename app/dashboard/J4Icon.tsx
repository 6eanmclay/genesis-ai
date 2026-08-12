// The J4 icon system (2026-08-12) — the monochrome visual language approved
// as part of the J4 interface direction. Three rules, all enforced by this
// file's shape rather than by convention:
//
//   1. Every icon is stroke-only line work on a 24px grid at 1.5px, round
//      caps and joins. No fills, no two-tone, no illustration.
//   2. Every icon inherits `currentColor`. An icon is therefore structurally
//      incapable of introducing a color — which is what keeps blue meaning
//      exactly one thing (J4) and red meaning exactly one thing (real
//      severity). A palette rule enforced by a prop would be a rule waiting
//      to be broken; this one can't be.
//   3. The icon is a visual anchor for information, never the message. It
//      earns its place by making a row scannable.
//
// This replaces emoji-as-iconography (📷 📄 🎬), which couldn't hold a
// consistent stroke weight, couldn't inherit color, and rendered differently
// on every platform.

export type J4IconName =
  | "home"
  | "products"
  | "orders"
  | "customers"
  | "store"
  | "analytics"
  | "marketing"
  | "payments"
  | "connections"
  | "tasks"
  | "settings"
  | "camera"
  | "photos"
  | "files"
  | "voice"
  | "add"
  | "send"
  | "more"
  | "search"
  | "alert"
  | "chevron"
  | "close";

// Paths only — every shared attribute (stroke, width, caps, joins) lives on
// the <svg> below so a single icon can never drift from the system.
const PATHS: Record<J4IconName, React.ReactNode> = {
  home: <path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />,
  products: (
    <>
      <path d="M4 8h16v12H4z" />
      <path d="M8 8V6a4 4 0 0 1 8 0v2" />
    </>
  ),
  orders: (
    <>
      <path d="M5 4h14l1 5H4z" />
      <path d="M6 9v11h12V9" />
      <path d="M10 13h4" />
    </>
  ),
  customers: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20c0-3.3 2.7-5.4 6-5.4s6 2.1 6 5.4" />
      <path d="M16 5.6a3.2 3.2 0 0 1 0 5.6M18 14.9c2 .8 3 2.6 3 5.1" />
    </>
  ),
  store: (
    <>
      <path d="M3 10h18l-1.5-5h-15z" />
      <path d="M5 10v10h14V10" />
      <path d="M9.5 20v-6h5v6" />
    </>
  ),
  analytics: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  marketing: (
    <>
      <path d="M3 7h13l5 5-5 5H3z" />
      <path d="M7 12h.01" />
    </>
  ),
  payments: (
    <>
      <path d="M2 6h20v12H2z" />
      <path d="M2 10h20" />
      <path d="M6 15h4" />
    </>
  ),
  connections: (
    <>
      <path d="M4 12a4 4 0 0 1 4-4h2M20 12a4 4 0 0 1-4 4h-2" />
      <path d="M8 12h8" />
    </>
  ),
  tasks: (
    <>
      <path d="M4 6h11l5 5v9H4z" />
      <path d="M8 12h6M8 16h4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v2.5M12 18.5V21M21 12h-2.5M5.5 12H3M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8M18.4 18.4l-1.8-1.8M7.4 7.4 5.6 5.6" />
    </>
  ),
  camera: (
    <>
      <path d="M3 8h4l2-2.5h6L17 8h4v11H3z" />
      <circle cx="12" cy="13" r="3.4" />
    </>
  ),
  photos: (
    <>
      <path d="M3 5h18v14H3z" />
      <path d="m3 16 5-4 4 3 3-3 6 5" />
      <circle cx="8.5" cy="9" r="1.4" />
    </>
  ),
  files: (
    <>
      <path d="M14 3H6v18h12V7z" />
      <path d="M14 3v4h4" />
    </>
  ),
  voice: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
  add: <path d="M12 5v14M5 12h14" />,
  send: <path d="M12 19V5M5 12l7-7 7 7" />,
  more: <path d="M4 6h10M4 12h16M4 18h7" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4 2.5 20h19z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  chevron: <path d="m9 5 7 7-7 7" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
};

export function J4Icon({
  name,
  size = 20,
  className,
}: {
  name: J4IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative by default — every caller pairs the icon with a real text
      // label, so announcing it again would just be noise for a screen reader.
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}
