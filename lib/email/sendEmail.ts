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

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.EMAIL_FROM_ADDRESS;
  if (!apiKey || !fromAddress) {
    throw new EmailNotConfiguredError();
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
