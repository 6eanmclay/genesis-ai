import { CONFIG, type ConfigEntry, type Requirement } from "./registry";

// WHAT THIS DEPLOYMENT IS MISSING, AND WHAT THAT MEANS.
//
// ============ THE REPORT NEVER CONTAINS A VALUE (2026-08-30) ===========
//
// Not once, not truncated, not "the first four characters". A configuration
// report is exactly the thing somebody pastes into a chat window when they are
// debugging at midnight, and a report that carries a fragment of a live Stripe
// key has made the incident worse than the one it was helping with.
//
// So a secret is `set` or it is `missing`, and that is the whole vocabulary.
// Length is not reported either: for a fixed-format key it narrows the guess.
//
// ============ AND IT DOES NOT REFUSE TO BOOT ==========================
//
// A tempting design is to throw on a missing variable and refuse to start. It
// would be wrong here. Almost nothing in the registry is needed to serve a
// request — most of it disables one feature — and a platform that will not
// start because nobody has registered a TikTok app is worse than one that
// starts and says TikTok is unavailable.
//
// The two that genuinely cannot be worked around are marked `essential`, and
// even those are reported rather than thrown: without a database the failure is
// immediate and obvious anyway, and a startup crash with a stack trace is a
// worse message than a line naming what is missing.

export interface ConfigStatus {
  name: string;
  group: ConfigEntry["group"];
  requirement: Requirement;
  purpose: string;
  /** Present and non-empty. Never the value itself. */
  present: boolean;
  /** What is not working because it is absent. Null when it is present. */
  consequence: string | null;
}

export interface ConfigReport {
  statuses: ConfigStatus[];
  /** Absent and essential. The platform cannot serve requests. */
  essentialMissing: ConfigStatus[];
  /** Absent and expected in production. Real features are off. */
  productionMissing: ConfigStatus[];
  /** Absent, and one feature is off. Ordinary for this platform. */
  featureMissing: ConfigStatus[];
  /** True when nothing essential or production-expected is absent. */
  ready: boolean;
}

/** Whether a variable is set to something. Whitespace is not a value. */
function isPresent(name: string): boolean {
  const raw = process.env[name];
  return typeof raw === "string" && raw.trim().length > 0;
}

export function configReport(): ConfigReport {
  const statuses: ConfigStatus[] = CONFIG.map((entry) => {
    const present = isPresent(entry.name);
    return {
      name: entry.name,
      group: entry.group,
      requirement: entry.requirement,
      purpose: entry.purpose,
      present,
      consequence: present ? null : entry.absence,
    };
  });

  const missing = (requirement: Requirement) =>
    statuses.filter((s) => !s.present && s.requirement === requirement);

  const essentialMissing = missing("essential");
  const productionMissing = missing("production");

  return {
    statuses,
    essentialMissing,
    productionMissing,
    featureMissing: missing("feature"),
    ready: essentialMissing.length === 0 && productionMissing.length === 0,
  };
}

/**
 * Say it once, at startup, in the log somebody actually reads.
 *
 * ============ WHY THIS IS NOT AN ALERT ==========================
 *
 * A missing variable is a deployment fact, not an incident: it is true from the
 * moment the process starts and stays true until somebody changes it. Sending
 * it to the alert path would fire on every cold start for a condition nobody
 * can fix from a phone.
 *
 * Feature-level absences are counted rather than listed. Fifteen unregistered
 * providers is the expected state of this platform today, and a startup banner
 * naming all of them is one people learn to scroll past.
 */
export function logConfigReport(report = configReport()): void {
  const lines: string[] = ["[config] startup check"];

  for (const status of report.essentialMissing) {
    lines.push(`  MISSING (essential)  ${status.name} — ${status.consequence}`);
  }
  for (const status of report.productionMissing) {
    lines.push(`  MISSING (production) ${status.name} — ${status.consequence}`);
  }

  const features = report.featureMissing;
  if (features.length > 0) {
    lines.push(`  ${features.length} feature credential(s) absent: ${features.map((f) => f.name).join(", ")}`);
  }

  if (report.ready && features.length === 0) {
    lines.push("  everything the registry knows about is set");
  } else if (report.ready) {
    lines.push("  nothing essential or production-expected is missing");
  }

  // One call, so a log line is one entry rather than fifty interleaved with
  // whatever else is starting.
  console.log(lines.join("\n"));
}
