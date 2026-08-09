import { withRetry } from "../lib/concurrency";

// Real verification (2026-08-09) — the actual new logic behind "add
// automatic retry for transient failures": confirms withRetry really
// retries a failing task up to the configured attempt count, succeeds if
// a later attempt clears, gives up honestly after exhausting attempts,
// and never retries once a task genuinely succeeds. No DB/network needed
// — this is the real unit of new behavior, independent of which upload
// path calls it.
async function main() {
  // Case 1: fails twice, succeeds on the 3rd attempt.
  let attempts1 = 0;
  const result1 = await withRetry(
    async () => {
      attempts1 += 1;
      if (attempts1 < 3) throw new Error(`transient failure ${attempts1}`);
      return "recovered";
    },
    { attempts: 3, baseDelayMs: 10 }
  );
  if (result1 !== "recovered" || attempts1 !== 3) {
    throw new Error(`Case 1 FAILED: expected 3 attempts ending in "recovered", got ${attempts1} attempts, result=${result1}`);
  }
  console.log("Case 1 (recovers after 2 failures): PASS —", attempts1, "attempts");

  // Case 2: fails every time, exhausts all attempts, throws the last real error.
  let attempts2 = 0;
  try {
    await withRetry(
      async () => {
        attempts2 += 1;
        throw new Error(`permanent failure ${attempts2}`);
      },
      { attempts: 3, baseDelayMs: 10 }
    );
    throw new Error("Case 2 FAILED: expected withRetry to throw after exhausting attempts");
  } catch (err) {
    if (attempts2 !== 3) throw new Error(`Case 2 FAILED: expected exactly 3 attempts, got ${attempts2}`);
    if (!(err instanceof Error) || !err.message.includes("permanent failure 3")) {
      throw new Error(`Case 2 FAILED: expected the LAST real error to propagate, got: ${err}`);
    }
  }
  console.log("Case 2 (exhausts attempts, throws real last error): PASS —", attempts2, "attempts");

  // Case 3: succeeds on the first try — never retries a real success.
  let attempts3 = 0;
  const result3 = await withRetry(async () => {
    attempts3 += 1;
    return "first try";
  });
  if (attempts3 !== 1 || result3 !== "first try") {
    throw new Error(`Case 3 FAILED: expected exactly 1 attempt, got ${attempts3}`);
  }
  console.log("Case 3 (never retries a real success): PASS —", attempts3, "attempt");

  // Case 4: onRetry callback fires once per retry, not once per attempt.
  let onRetryCalls = 0;
  let attempts4 = 0;
  await withRetry(
    async () => {
      attempts4 += 1;
      if (attempts4 < 3) throw new Error("retry me");
      return "done";
    },
    { attempts: 3, baseDelayMs: 10, onRetry: () => (onRetryCalls += 1) }
  );
  if (onRetryCalls !== 2) {
    throw new Error(`Case 4 FAILED: expected onRetry called exactly 2 times (before attempts 2 and 3), got ${onRetryCalls}`);
  }
  console.log("Case 4 (onRetry fires once per retry, not per attempt): PASS —", onRetryCalls, "calls");

  console.log("\nAll withRetry assertions passed.");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exitCode = 1;
});
