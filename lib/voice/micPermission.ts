// WHETHER A MICROPHONE PROMPT CAN STILL APPEAR.
//
// ============ WHY ANDROID AND IPHONE BEHAVE DIFFERENTLY ====================
//
// Sean's mother sees "microphone is blocked" on Android and never gets a
// permission popup. On iPhone the popup appears normally. Both are correct
// behaviour, and the difference is not in our code paths — it is in what the
// two browsers do with a permission that has already been refused.
//
//   Android Chrome remembers a refusal PER SITE, and once it has one it stops
//   asking. getUserMedia() then rejects immediately with NotAllowedError and
//   NO dialog is shown. Nothing JavaScript can do makes it ask again — the
//   only route back is the browser's own site settings, or the OS-level
//   permission for the browser app itself, which is a second, separate layer.
//
//   iOS Safari has no equivalent sticky per-site denial in the same form, so a
//   fresh request generally prompts again. That is why iOS "works" and why
//   testing on iOS proves nothing about Android.
//
// SO THE ONE THING WORTH KNOWING BEFORE ASKING is whether a prompt can still
// appear. The Permissions API answers exactly that — and, tellingly, Android
// Chrome implements it for "microphone" while iOS Safari does not. The
// asymmetry in the platforms shows up as an asymmetry in the API too.
//
// Calling getUserMedia() when the state is already "denied" is the mistake this
// exists to prevent: it cannot produce a prompt, it rejects instantly, and the
// owner experiences a button that does nothing while being told they must
// allow something they were never asked about.

export type MicPermission =
  /** Never asked, or asked and dismissed. A prompt WILL appear. */
  | "prompt"
  /** Already allowed. No prompt needed. */
  | "granted"
  /** Refused and remembered. NO prompt will appear, however many times we ask. */
  | "denied"
  /** The browser will not say — iOS Safari, and anything older. Ask and see. */
  | "unknown";

/**
 * What the browser says about the microphone, without asking for it.
 *
 * NEVER THROWS and never prompts. A browser that does not implement this for
 * "microphone" answers "unknown", which callers treat exactly as they always
 * did: try, and interpret the rejection.
 */
export async function readMicPermission(): Promise<MicPermission> {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) return "unknown";
  try {
    // The cast is deliberate: "microphone" is a valid PermissionName at runtime
    // in Chromium but is absent from the DOM lib's union, and a browser without
    // it throws TypeError — caught below.
    const status = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    if (status.state === "granted" || status.state === "denied" || status.state === "prompt") {
      return status.state;
    }
    return "unknown";
  } catch {
    // iOS Safari lands here. So does any browser that knows the API but not
    // this permission name.
    return "unknown";
  }
}

/** Will asking actually produce a dialog the owner can answer? */
export function canPromptFor(permission: MicPermission): boolean {
  // "unknown" counts as yes: not asking would be worse than asking and finding
  // out, and on iOS that is exactly the right move.
  return permission !== "denied";
}

export type Platform = "android" | "ios" | "other";

/**
 * Which platform's settings to describe.
 *
 * A coarse User-Agent check, used only to choose wording — never for anything
 * security-relevant, where UA sniffing would not be acceptable.
 */
export function platformFromUserAgent(userAgent: string): Platform {
  if (/Android/i.test(userAgent)) return "android";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  return "other";
}

export interface MicGuidance {
  /** What went wrong, in the owner's terms. */
  headline: string;
  /** Where to go and what to change. */
  detail: string;
  /**
   * Whether offering "Try again" is honest.
   *
   * FALSE WHEN THE BROWSER WILL NOT PROMPT. A retry button that can only ever
   * fail is the cruellest control on the page — it implies the owner did
   * something wrong, when the browser simply stopped asking.
   */
  canRetry: boolean;
}

/**
 * What to tell somebody who cannot record, given what the browser said.
 *
 * PURE, so every branch is provable without a device — which matters more than
 * usual here, because the platform this is most needed on is the one that
 * cannot be tested from this machine.
 */
export function micGuidanceFor(permission: MicPermission, platform: Platform): MicGuidance {
  if (permission === "denied") {
    // THE CASE THAT LOOKS LIKE A BUG. There is no prompt coming, so the only
    // useful thing to say is where the switch is.
    if (platform === "android") {
      return {
        headline: "Android is no longer asking about the microphone",
        detail:
          "It was blocked for this site once, so Chrome stopped asking. Tap the lock or sliders icon " +
          "beside the address bar → Permissions → Microphone → Allow, then reload. If it is not listed " +
          "there, the browser itself may be blocked: Settings → Apps → Chrome → Permissions → Microphone.",
        canRetry: false,
      };
    }
    if (platform === "ios") {
      return {
        headline: "Microphone is blocked for this site",
        detail:
          'In Safari, tap "aA" in the address bar → Website Settings → Microphone → Allow. ' +
          "Or open Settings → Safari → Microphone and allow this website.",
        canRetry: false,
      };
    }
    return {
      headline: "Microphone is blocked for this site",
      detail:
        "Open your browser's site settings for this page — usually the lock icon beside the address " +
        "bar — allow the microphone, then reload.",
      canRetry: false,
    };
  }

  // Asked and refused in the moment, or dismissed. A prompt can still appear,
  // so the honest thing is to offer the ask again rather than send somebody
  // into their settings for no reason.
  return {
    headline: "Genesis needs your microphone",
    detail:
      platform === "android"
        ? "Tap Allow when Android asks. If nothing appears, the site's microphone permission may already be blocked in your browser settings."
        : "Tap Allow when your browser asks.",
    canRetry: true,
  };
}
