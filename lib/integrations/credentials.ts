import crypto from "crypto";
import type { Prisma } from "@prisma/client";

// Phase 3 Milestone 2 — closes a real, pre-existing gap: StoreIntegration
// .credentials has always been stored as plain JSON. Acceptable-ish for
// Stripe/PayPal (already-scoped, independently revocable processor keys),
// a real problem once this same column holds bank/accounting-adjacent
// OAuth tokens (QuickBooks) or a merchant-typed API key (Mailchimp).
//
// Applied explicitly at each connector's own read/write points, not via a
// Prisma middleware/extension — credentials are read in only a few real
// places (each connector's own methods), so an explicit call at the actual
// read/write site is honest about where encryption happens, matching this
// codebase's consistent preference for explicit code over query-intercepting
// magic.
const ALGORITHM = "aes-256-gcm";

function getKey(): Buffer {
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "INTEGRATION_ENCRYPTION_KEY is not set — required to store or read integration credentials."
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "INTEGRATION_ENCRYPTION_KEY must decode to exactly 32 bytes (base64-encoded AES-256 key)."
    );
  }
  return key;
}

interface EncryptedPayload {
  schemaVersion: "encrypted:1";
  iv: string;
  authTag: string;
  ciphertext: string;
  [key: string]: string;
}

export function encryptCredentials(data: object): Prisma.InputJsonValue {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(data), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const payload: EncryptedPayload = {
    schemaVersion: "encrypted:1",
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return payload;
}

export function decryptCredentials<T>(json: unknown): T {
  const payload = json as Partial<EncryptedPayload> | null;
  if (
    !payload ||
    payload.schemaVersion !== "encrypted:1" ||
    typeof payload.iv !== "string" ||
    typeof payload.authTag !== "string" ||
    typeof payload.ciphertext !== "string"
  ) {
    throw new Error(
      "Stored credentials are not in the expected encrypted shape — cannot decrypt."
    );
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(payload.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}
