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

  // For first-read messages, atomically fetch and delete the record so that
  // concurrent readers cannot both retrieve the ciphertext. The load+delete
  // gap is eliminated at the storage layer (Redis Lua script / Map pop).
  if (message.mode === "first-read") {
    const atomic = await store.fetchAndDelete(token);
    if (!atomic) return { status: "not_found" };

    const dataKey = await kms.unwrap(atomic.wrappedDataKey);
    let text: string;
    try {
      text = decrypt(atomic.encryptedPayload, dataKey);
    } finally {
      wipe(dataKey);
    }

    return { status: "ok", text, oneTimeView: true };
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

  // Time-limited: keep the message, record the view. Preserve the original
  // expiry by re-computing the remaining TTL so the Redis KEY's TTL is
  // maintained — a SET without EX would remove the existing expiry and
  // permanently leak the key.
  message.readCount += 1;
  const remainingTtl =
    message.expiresAt !== null
      ? Math.max(1, Math.ceil((message.expiresAt - now) / 1000))
      : undefined;
  await store.save(message, remainingTtl);
  return { status: "ok", text, oneTimeView: false };
}
