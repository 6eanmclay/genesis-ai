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
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.EMAIL_FROM_ADDRESS;
  if (!apiKey || !fromAddress) {
    throw new EmailNotConfiguredError();
  }

  const resend = new Resend(apiKey);
  const result = await resend.emails.send({
    from: fromAddress,
    to: input.to,
    subject: input.subject,
    html: input.html,
  });

  if (result.error) {
    throw new Error(`Failed to send email: ${result.error.message}`);
  }
}
