import type { StoreRole } from "@prisma/client";

// WHAT A ROLE IS CALLED, IN ONE PLACE.
//
// ============ ZERO VALUE IMPORTS, ON PURPOSE ===========================
//
// lib/security/members.ts is where the rest of this vocabulary lives
// (PERMISSION_LABEL, capabilitiesOf), and this would belong beside them except
// that it reaches a CLIENT component: AccessControls.tsx renders the roster.
// members.ts imports prisma, so a value import of it from the client would
// drag the database client into the browser bundle. The type import above is
// erased at compile time and costs nothing.
//
// Same contract lib/j4/officeSections.ts holds and says so for the same
// reason. If anything here ever needs a value from members.ts, it does not
// belong here.
//
// ============ AND WHY IT IS SHARED RATHER THAN WRITTEN TWICE ===========
//
// The Access screen renders two things that name roles: the roster, and the
// "What each role can do" table underneath it. The table used to spell its own
// labels inline (`r === "OWNER" ? "Owner" : "Employee"`) while the roster
// spelled none at all. One map means a person's row and the column explaining
// what that row can do cannot come to call the same role two different things.

export const ROLE_LABEL: Record<StoreRole, string> = {
  OWNER: "Owner",
  EMPLOYEE: "Employee",
};
