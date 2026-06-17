import { randomBytes } from "node:crypto";
import { encrypt, decrypt, type EncryptedPayload } from "./crypto.js";
// Type-only import: erased at compile time, so the AWS SDK is never loaded at
// runtime unless the AWS provider is actually selected (see AwsKms.client()).
import type { KMSClient } from "@aws-sdk/client-kms";

// Envelope encryption key management. Per-message data keys (DEKs) are wrapped by
// a master key (KEK). In production the master key lives in AWS KMS; when KMS is
// unavailable (local dev, the tokenless test harness) a local master key is used.

// A data key wrapped by the master key, tagged by the provider that wrapped it
// so it can be unwrapped by the right path.
export type WrappedDataKey =
  | { provider: "local"; payload: EncryptedPayload }
  | { provider: "aws-kms"; ciphertext: string };

export interface Kms {
  wrap(dataKey: Buffer): Promise<WrappedDataKey>;
  unwrap(wrapped: WrappedDataKey): Promise<Buffer>;
}

/** Local master-key provider: AES-256-GCM wrap of the data key. */
export class LocalKms implements Kms {
  constructor(private readonly masterKey: Buffer) {}

  async wrap(dataKey: Buffer): Promise<WrappedDataKey> {
    return {
      provider: "local",
      payload: encrypt(dataKey.toString("base64"), this.masterKey),
    };
  }

  async unwrap(wrapped: WrappedDataKey): Promise<Buffer> {
    if (wrapped.provider !== "local") {
      throw new Error(`LocalKms cannot unwrap a ${wrapped.provider} key`);
    }
    return Buffer.from(decrypt(wrapped.payload, this.masterKey), "base64");
  }
}

/** AWS KMS provider: the master key never leaves KMS; DEKs are wrapped via the
 *  Encrypt/Decrypt APIs. The SDK is imported lazily so it is only loaded when
 *  this provider is actually used. */
export class AwsKms implements Kms {
  private clientPromise?: Promise<KMSClient>;

  constructor(
    private readonly keyId: string,
    private readonly region: string,
  ) {}

  private async client(): Promise<KMSClient> {
    if (!this.clientPromise) {
      this.clientPromise = import("@aws-sdk/client-kms").then(
        ({ KMSClient }) => new KMSClient({ region: this.region }),
      );
    }
    return this.clientPromise;
  }

  async wrap(dataKey: Buffer): Promise<WrappedDataKey> {
    const { EncryptCommand } = await import("@aws-sdk/client-kms");
    const client = await this.client();
    const out = await client.send(
      new EncryptCommand({ KeyId: this.keyId, Plaintext: dataKey }),
    );
    if (!out.CiphertextBlob) throw new Error("KMS Encrypt returned no ciphertext");
    return {
      provider: "aws-kms",
      ciphertext: Buffer.from(out.CiphertextBlob).toString("base64"),
    };
  }

  async unwrap(wrapped: WrappedDataKey): Promise<Buffer> {
    if (wrapped.provider !== "aws-kms") {
      throw new Error(`AwsKms cannot unwrap a ${wrapped.provider} key`);
    }
    const { DecryptCommand } = await import("@aws-sdk/client-kms");
    const client = await this.client();
    const out = await client.send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(wrapped.ciphertext, "base64"),
      }),
    );
    if (!out.Plaintext) throw new Error("KMS Decrypt returned no plaintext");
    return Buffer.from(out.Plaintext);
  }
}

// Local master key. Production sets KMS_MASTER_KEY (base64, 32 bytes); dev/tests
// fall back to a process-stable random key (wrap+unwrap happen in one process).
const DEV_FALLBACK_MASTER_KEY = randomBytes(32);

function loadLocalMasterKey(): Buffer {
  const b64 = process.env.KMS_MASTER_KEY;
  if (b64) {
    const key = Buffer.from(b64, "base64");
    if (key.length !== 32) {
      throw new Error("KMS_MASTER_KEY must decode to 32 bytes");
    }
    return key;
  }
  return DEV_FALLBACK_MASTER_KEY;
}

/** Pick the KMS provider from the environment. */
export function createKms(): Kms {
  const keyId = process.env.AWS_KMS_KEY_ID;
  if (keyId) {
    return new AwsKms(keyId, process.env.AWS_REGION ?? "us-east-1");
  }
  return new LocalKms(loadLocalMasterKey());
}
