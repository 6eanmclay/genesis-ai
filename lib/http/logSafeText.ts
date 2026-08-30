import { z } from "zod";

// TEXT THAT IS SAFE TO PUT IN A LOG LINE.
//
// ============ IN ITS OWN FILE SO IT CAN BE TESTED (2026-08-30) =========
//
// This rule lived inside app/api/diag-client-log/route.ts, and the suite that
// "tested" it declared an identical schema inline — so sabotage removed the
// route's rule entirely and the suite stayed green, because it had been
// checking its own copy the whole time. A second declaration of a rule is not
// a test of the rule.
//
// ============ WHAT IT IS DEFENDING AGAINST ===========================
//
// An authenticated caller writing into production logs. Two things make that
// dangerous and neither is exotic:
//
//   newlines   a log line the caller controls, containing a newline, is two log
//              lines — the second of which they wrote. Anything that reads
//              those logs can be fed fabricated entries.
//   length     a megabyte of text per request buries every real line around it,
//              which is how an attacker hides what they were actually doing.
//
// The character class is deliberately narrow rather than a denylist. Naming
// what is allowed survives contact with the next encoding somebody thinks of.

/** One line of plain, boring text. Never anything a log reader could mistake for structure. */
export function logSafeText(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[\w.:@ -]+$/, "unexpected characters");
}
