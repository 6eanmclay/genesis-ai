import { mapTrackerToShipment, type TrackerLike } from "@/lib/integrations/easypost";
import { ShipmentSchema } from "@/lib/businessModel/entities";

// Phase 2 (EasyPost) — delivery-status handling, proved without an EasyPost
// account, a network call or a database:
//
//   npx tsx scripts/verify-easypost-shipments.ts
//
// The rule this defends: Genesis already stored a tracking NUMBER. What it
// never knew is what happened next. Every field below either comes from a real
// carrier scan or is null — a parcel with no scans must never borrow a date
// from somewhere else.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const DELIVERED: TrackerLike = {
  tracking_code: "9400111899223197428490",
  carrier: "USPS",
  status: "delivered",
  status_detail: "arrived_at_destination",
  est_delivery_date: "2026-08-14T00:00:00Z",
  tracking_details: [
    { datetime: "2026-08-12T14:02:00Z", message: "Accepted at USPS Origin Facility", status: "in_transit", tracking_location: { city: "Denver", state: "CO", country: "US" } },
    { datetime: "2026-08-14T16:41:00Z", message: "Delivered, Front Door/Porch", status: "delivered", tracking_location: { city: "Boulder", state: "CO", country: "US" } },
    { datetime: "2026-08-13T09:15:00Z", message: "In Transit to Next Facility", status: "in_transit", tracking_location: { city: "Aurora", state: "CO", country: "US" } },
  ],
};

// ---------------------------------------------------------------------------
console.log("\n1. A delivered parcel reports when it actually arrived");
{
  const s = mapTrackerToShipment(DELIVERED, "order_1");
  check("status", s.status, "delivered");
  check("isDelivered", s.isDelivered, true);
  check("not an exception", s.isException, false);
  // The delivery time comes from the DELIVERED scan, not from the newest row in
  // the array and not from "now".
  check("delivered at the real scan time", s.deliveredAt, "2026-08-14T16:41:00.000Z");
  check("latest scan is the newest by time, not by position", s.lastScanAt, "2026-08-14T16:41:00.000Z");
  check("with its real description", s.lastScanDescription, "Delivered, Front Door/Porch");
  check("and its real location", s.lastScanLocation, "Boulder, CO, US");
  check("carrier carried through", s.carrier, "USPS");
  check("order linked", s.orderId, "order_1");
}

// ---------------------------------------------------------------------------
console.log("\n2. A parcel in transit claims nothing about delivery");
{
  const s = mapTrackerToShipment(
    { ...DELIVERED, status: "in_transit", status_detail: "in_transit", tracking_details: [DELIVERED.tracking_details![0]] },
    "order_1"
  );
  check("not delivered", s.isDelivered, false);
  check("no delivery time invented", s.deliveredAt, null);
  check("not an exception either", s.isException, false);
  check("but the real scan survives", s.lastScanDescription, "Accepted at USPS Origin Facility");
}

// ---------------------------------------------------------------------------
console.log("\n3. A label bought but never scanned has honest nulls");
{
  // pre_transit is the state right after a label is purchased: EasyPost knows
  // the parcel exists, the carrier has not touched it.
  const s = mapTrackerToShipment(
    { tracking_code: "9400111899223197428490", carrier: "USPS", status: "pre_transit", tracking_details: [] },
    "order_1"
  );
  check("status is real", s.status, "pre_transit");
  check("no scan time", s.lastScanAt, null);
  check("no scan description", s.lastScanDescription, null);
  check("no location", s.lastScanLocation, null);
  check("no delivery time", s.deliveredAt, null);
  check("no estimate invented", s.estimatedDeliveryAt, null);
  check("not delivered, not an exception", [s.isDelivered, s.isException], [false, false]);
}

// ---------------------------------------------------------------------------
console.log("\n4. Real problems are marked as problems");
{
  for (const status of ["failure", "error", "return_to_sender", "cancelled"]) {
    const s = mapTrackerToShipment({ ...DELIVERED, status, tracking_details: [] }, "order_1");
    check(`${status} is an exception`, s.isException, true);
    check(`${status} is not delivered`, s.isDelivered, false);
  }
  // And ordinary progress is not.
  for (const status of ["pre_transit", "in_transit", "out_for_delivery", "available_for_pickup", "unknown"]) {
    check(`${status} is not an exception`, mapTrackerToShipment({ ...DELIVERED, status, tracking_details: [] }, null).isException, false);
  }
}

// ---------------------------------------------------------------------------
console.log("\n5. An unknown carrier status is carried through, not forced");
{
  const s = mapTrackerToShipment({ ...DELIVERED, status: "held_at_customs", tracking_details: [] }, null);
  check("verbatim status", s.status, "held_at_customs");
  check("not silently called delivered", s.isDelivered, false);
  check("and not silently called an exception", s.isException, false);
  const missing = mapTrackerToShipment({ tracking_code: "X" }, null);
  check("a tracker with no status at all reads unknown", missing.status, "unknown");
}

// ---------------------------------------------------------------------------
console.log("\n6. Malformed dates never become fake ones");
{
  const s = mapTrackerToShipment(
    {
      tracking_code: "X",
      status: "in_transit",
      est_delivery_date: "not-a-date",
      tracking_details: [{ datetime: "also-not-a-date", message: "Scanned" }],
    },
    null
  );
  check("bad estimate becomes null", s.estimatedDeliveryAt, null);
  check("bad scan time becomes null", s.lastScanAt, null);
  // The scan had no usable time, so it cannot be the "latest" one.
  check("and an untimed scan is not presented as the latest", s.lastScanDescription, null);
}

// ---------------------------------------------------------------------------
console.log("\n7. The output is a valid canonical shipment record");
{
  const s = mapTrackerToShipment(DELIVERED, "order_1");
  const parsed = ShipmentSchema.safeParse(s);
  assert("passes the canonical schema", parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues[0]));
  // persistSyncedRecords validates against exactly this schema, so a mapper
  // that drifts from it would be rejected at write time rather than silently
  // stored — this asserts they agree now.
  check(
    "and carries exactly the canonical fields",
    Object.keys(s).sort(),
    ["carrier", "deliveredAt", "estimatedDeliveryAt", "isDelivered", "isException", "lastScanAt", "lastScanDescription", "lastScanLocation", "orderId", "status", "statusDetail", "trackingCode"]
  );
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
