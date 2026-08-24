// READING A PROVIDER DIRECTLY, ON PURPOSE AND ON THE RECORD.
//
// BUSINESS_UNDERSTANDING_CONTRACT.md invariant 3: a consumer may read a provider
// directly, **declared with a reason — never silently**. Silence is how two
// assemblers grew side by side without anybody deciding to have two.
//
// This is not a permission system and it does not gate anything at runtime. It
// is a place to say WHY, next to the read, in a form a test can find. The test
// is what enforces it: verify-canonical-understanding.ts fails on a direct
// provider read by a non-provider that is not wrapped here.
//
// TWO LEGITIMATE REASONS, and no third:
//
//   "presentation"  — a surface rendering one section. app/dashboard/customers
//                     needs customer segments and nothing else; making it
//                     assemble a 27-query understanding to draw a chart would
//                     be absurd. It presents; it does not reason.
//
//   "windowed"      — a reasoning consumer asking for a figure over a window the
//                     canonical model does not carry. The canonical model holds
//                     revenue for last-30-days and all-time; a briefing that
//                     says "since you were last here" needs revenue since an
//                     arbitrary timestamp, and a trend detector needs
//                     week-over-week. Neither is the canonical figure computed
//                     twice — they are different questions, and answering them
//                     from the canonical numbers would silently change what the
//                     consumer reports.
//
// WHAT THIS IS NOT A LICENCE FOR. Assembling a second understanding. A declared
// read fetches ONE fact for a stated reason; composing several into a picture of
// the business is what getBusinessUnderstanding is for, and invariant 1 says
// there is exactly one of those.

export type DeclaredReadReason = "presentation" | "windowed";

/**
 * Wrap a direct provider read with the reason it is not coming from the
 * canonical understanding.
 *
 * Deliberately returns the promise untouched: this changes nothing at runtime,
 * which is the point. It exists so the reason is written where the read is,
 * rather than in a document somebody has to remember to consult.
 */
export function declaredRead<T>(
  reason: DeclaredReadReason,
  /** Why THIS read, specifically. Not the category — the actual reason. */
  because: string,
  read: () => Promise<T>
): Promise<T> {
  void reason;
  void because;
  return read();
}
