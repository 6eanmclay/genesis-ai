import { Resend } from "resend";

// Auth screens review (2026-08-07) — password reset needs real email
// delivery, and this codebase has never sent a real email before (the
// Marketing Engine's own send milestone was explicitly paused on this same
// real dependency — see CHANGELOG.md). Per Sean's own standing instruction
// ("never mock a real dependency"), this never pretends to send: with no
// RESEND_API_KEY configured, every call throws a real, honest error rather
// than silently succeeding. Callers (requestPasswordReset) are expected to
// catch this and tell the owner plainly that email isn't set up yet,
// instead of showing a false "check your email" confirmation.
export class EmailNotConfiguredError extends Error {
  constructor() {
    super("Email sending isn't configured yet (no RESEND_API_KEY set).");
    this.name = "EmailNotConfiguredError";
  }
}

export function isEmailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.EMAIL_FROM_ADDRESS;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  /**
   * WHOSE NAME THE CUSTOMER SEES (2026-08-29).
   *
   * Sean: the sender should read "[Store Name] <orders@…>". One
   * Genesis-controlled sending domain, store-specific display names — not
   * per-store domains, which would mean DNS verification per business.
   *
   * Optional, and omitting it sends from the bare address exactly as before:
   * a platform email (password reset, security) has no store behind it and
   * must not borrow one's identity.
   */
  fromName?: string;
}

/**
 * A display name that cannot become a second header.
 *
 * ============ THIS IS OWNER-CONTROLLED INPUT IN A HEADER ================
 *
 * A store name is typed by the business owner and would land, unescaped,
 * directly in the From header. A name containing a newline could append
 * headers of its own — a Bcc, a Reply-To — which is header injection, and the
 * fact that the author is our own customer rather than an anonymous attacker
 * does not make it safe: 16 stores today, and the name is editable.
 *
 * So: control characters are removed rather than escaped, because there is no
 * legitimate store name containing one; quotes and backslashes are escaped
 * because RFC 5322 quoted-strings allow them escaped; and the result is always
 * quoted so commas and colons in a real name ("Smith, Jones & Co.") cannot be
 * read as address separators.
 *
 * Returns null when nothing usable is left, and the caller falls back to the
 * bare address rather than sending from `"" <addr>`.
 */
export function displayNameFor(rawName: string): string | null {
  const stripped = rawName
    // eslint-disable-next-line no-control-regex -- the point is to remove them
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  if (stripped.length === 0) return null;
  // Long names get truncated rather than refused — a header is not the place
  // to enforce a product rule, and a truncated name still reads as the store.
  const bounded = stripped.slice(0, 78);
  const escaped = bounded.replace(/([\\"])/g, "\\$1");
  return `"${escaped}"`;
}

/**
 * An address that can never receive mail, refused before it costs us anything.
 *
 * ============ WHY THIS SHIPS BEFORE THE FIRST REAL SEND =============
 *
 * Sean, 2026-09-01, on E19a. Four of the seven orders in production belong
 * to beta-test stores whose buyer and owner addresses end in
 * @example.test. RFC 2606 reserves .test, .example, .invalid and
 * .localhost precisely so they can never resolve, so every one of those is
 * a guaranteed hard bounce — and they would be among the first messages a
 * brand-new sending domain ever produced. Bounce rate is the primary
 * signal a mailbox provider judges a new domain on, and roughly half the
 * first batch bouncing is how a domain starts its life in a spam folder.
 *
 * REFUSED, NOT QUIETLY MARKED SENT. This throws, so the caller's claim is
 * never written and the order screen keeps saying the customer has not
 * been told — which is true. Sean was explicit: do not mark those test
 * owners as notified falsely. Whether those four test stores are deleted
 * is a separate decision and nothing here deletes anything.
 */
export class UndeliverableAddressError extends Error {
  constructor(readonly address: string, readonly tld: string) {
    super(
      `.${tld} is a reserved domain that can never receive mail (RFC 2606), so ` +
        `nothing was sent to this address.`
    );
    this.name = "UndeliverableAddressError";
  }
}

/**
 * The four RFC 2606 / RFC 6761 reserved names. Deliberately a closed list
 * of what is reserved BY STANDARD, not a guess at what looks like a test
 * address: refusing anything that merely contains "test" would refuse real
 * customers at real domains.
 */
const RESERVED_TLDS: ReadonlySet<string> = new Set([
  "test",
  "example",
  "invalid",
  "localhost",
]);

/**
 * The reserved TLD an address ends in, or null when it is deliverable as
 * far as this check is concerned. Exported so the distinction is directly
 * testable without an email provider existing.
 */
export function reservedTldOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const domain = address.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  const dot = domain.lastIndexOf(".");
  // A bare domain with no dot at all is its own last label — "user@localhost".
  const tld = dot < 0 ? domain : domain.slice(dot + 1);
  return RESERVED_TLDS.has(tld) ? tld : null;
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.EMAIL_FROM_ADDRESS;
  if (!apiKey || !fromAddress) {
    throw new EmailNotConfiguredError();
  }

  // BEFORE THE PROVIDER IS EVEN CONSTRUCTED. A reserved address is not a
  // send that failed, it is a send that must never be attempted — the
  // bounce it would earn is charged to our sending reputation, not to the
  // caller.
  const reserved = reservedTldOf(input.to);
  if (reserved) {
    throw new UndeliverableAddressError(input.to, reserved);
  }

  // THE ADDRESS IS ALWAYS OURS. Only the name in front of it changes, so a
  // store cannot cause mail to be sent from a domain Genesis has not verified.
  const displayName = input.fromName ? displayNameFor(input.fromName) : null;
  const from = displayName ? `${displayName} <${fromAddress}>` : fromAddress;

  const resend = new Resend(apiKey);
  const result = await resend.emails.send({
    from,
    to: input.to,
    subject: input.subject,
    html: input.html,
  });

  if (result.error) {
    throw new Error(`Failed to send email: ${result.error.message}`);
  }
}
