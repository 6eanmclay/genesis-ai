// Renders nothing when the J4 slot has no active route — which is every
// dashboard page, every time, until the owner actually summons J4. Required
// by parallel routes: without a default, a hard load of any dashboard URL
// would 404 on the unmatched slot rather than simply rendering no sheet.
export default function J4SlotDefault() {
  return null;
}
