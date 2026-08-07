import { sendEmail } from "./sendEmail";

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  await sendEmail({
    to,
    subject: "Reset your Genesis password",
    html: `
      <p>Someone requested a password reset for this Genesis account.</p>
      <p><a href="${resetUrl}">Reset your password</a></p>
      <p>This link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password hasn't been changed.</p>
    `,
  });
}
