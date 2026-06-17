import { decrypt, wipe } from "./crypto.js";
import type { Kms } from "./kms.js";
import type { Message, MessageStore } from "./messages.js";

// Reading a shared message. This is the service the web frontend (and the bot's
// /read command) call to view a message by its public token. It enforces the
// expiry policy: first-read messages are deleted immediately after one
// successful read; time-limited messages are kept until expires_at and count
// each view.

export type ReadResult =
  | { status: "ok"; text: string; oneTimeView: boolean }
  | { status: "not_found" }
  | { status: "expired" };

/**
 * readMessage — decrypt and return a message by token, applying the expiry
 * policy as a side effect (delete-on-read for first-read; expiry + read count
 * for time-limited).
 */
export async function readMessage(
  store: MessageStore,
  kms: Kms,
  token: string,
  now: number = Date.now(),
): Promise<ReadResult> {
  const message: Message | null = await store.load(token);
  if (!message) return { status: "not_found" };

  // Time-limited messages past their expiry are gone — clean up and report.
  if (message.expiresAt !== null && now >= message.expiresAt) {
    await store.delete(token);
    return { status: "expired" };
  }

  // Decrypt: unwrap the per-message data key, then decrypt the payload. The key
  // material is wiped from memory as soon as the plaintext is recovered.
  const dataKey = await kms.unwrap(message.wrappedDataKey);
  let text: string;
  try {
    text = decrypt(message.encryptedPayload, dataKey);
  } finally {
    wipe(dataKey);
  }

  if (message.mode === "first-read") {
    // One-time view: securely delete the record immediately after a successful
    // read so the ciphertext can never be retrieved again.
    await store.delete(token);
    return { status: "ok", text, oneTimeView: true };
  }

  // Time-limited: keep the message, record the view.
  message.readCount += 1;
  await store.save(message);
  return { status: "ok", text, oneTimeView: false };
}
