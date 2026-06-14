// AWS KMS KEK custodian for the KMS seam (ADR-0002 cross-cloud deviation).
//
// The day-one production `KmsProvider`: a symmetric KMS key (the KEK) wraps/unwraps DEKs via
// AWS KMS `GenerateDataKey` / `Decrypt` over HTTPS, signed with SigV4 (aws4fetch — there is no
// AWS SDK small enough for a Worker bundle). It sits behind the exact same `KmsProvider`
// interface as `LocalKmsProvider`, so callers never branch on the custodian.
//
// Confused-deputy / tamper binding is delegated to KMS's own `EncryptionContext`: {org_id,
// endpoint_id, key_id} is passed on GenerateDataKey and MUST be passed identically on Decrypt
// or KMS refuses to unwrap — the cross-cloud analogue of the WebCrypto AAD in `LocalKmsProvider`.
// The plaintext DEK only ever exists transiently here: it is imported straight into a
// NON-EXTRACTABLE AES-GCM handle and the raw bytes are scrubbed immediately after. KMS
// never sees the secret or the plaintext DEK at rest — only the row's wrapped DEK + ciphertext do.

import { AwsClient } from "aws4fetch";

import { b64ToBytes, bytesToB64 } from "../bytes";
import { importDek, type EncryptionContext, type KmsProvider, type WrappedDek } from "../envelope";

/** Config for the AWS KMS custodian. Credentials are injected as wrangler secrets, never source. */
export interface AwsKmsConfig {
  /** The symmetric KMS key ARN (the KEK). Stamped onto every `WrappedDek` as its `kekRef`. */
  readonly keyArn: string;
  /** AWS region of the key (e.g. "us-east-2"). */
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Optional STS session token for temporary credentials. */
  readonly sessionToken?: string;
  /** Per-call request timeout in ms (default 5000). A hung KMS connection becomes an AwsKmsError. */
  readonly timeoutMs?: number;
  /**
   * Internal retry count for transient 5xx/429 KMS responses (default 2). aws4fetch retries with
   * exponential backoff; the whole sequence is still bounded by `timeoutMs`. Its own default is 10
   * — too many for a cold-path call — so we pin a small, predictable value.
   */
  readonly retries?: number;
}

/**
 * An operational fault talking to AWS KMS (throttling, auth, timeout, network, a malformed
 * response). Deliberately a plain Error subclass — NOT an auth-rejection type — so the
 * bearer-authorize decision propagates it as a 5xx instead of masquerading a KMS outage as a 401.
 */
export class AwsKmsError extends Error {
  /** The AWS error `__type` (e.g. "AccessDeniedException"), when the response carried one. */
  readonly awsType?: string;
  constructor(message: string, awsType?: string) {
    super(message);
    this.name = "AwsKmsError";
    this.awsType = awsType;
  }
}

const KMS_JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
/** KMS data-plane targets (the `X-Amz-Target` header; KMS's internal service name is TrentService). */
const TARGET_GENERATE_DATA_KEY = "TrentService.GenerateDataKey";
const TARGET_DECRYPT = "TrentService.Decrypt";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 2;

export class AwsKmsProvider implements KmsProvider {
  readonly #client: AwsClient;
  readonly #endpoint: string;
  readonly #keyArn: string;
  readonly #timeoutMs: number;

  private constructor(client: AwsClient, endpoint: string, keyArn: string, timeoutMs: number) {
    this.#client = client;
    this.#endpoint = endpoint;
    this.#keyArn = keyArn;
    this.#timeoutMs = timeoutMs;
  }

  /** The KMS key ARN stamped onto every `WrappedDek` this provider produces. */
  get kekRef(): string {
    return this.#keyArn;
  }

  static fromConfig(config: AwsKmsConfig): AwsKmsProvider {
    if (!config.keyArn) throw new Error("AwsKmsProvider: keyArn is required");
    if (!config.region) throw new Error("AwsKmsProvider: region is required");
    const client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
      service: "kms",
      region: config.region,
      retries: config.retries ?? DEFAULT_RETRIES,
    });
    const endpoint = `https://kms.${config.region}.amazonaws.com/`;
    return new AwsKmsProvider(
      client,
      endpoint,
      config.keyArn,
      config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  }

  async generateDek(context: EncryptionContext): Promise<{ dek: CryptoKey; wrapped: WrappedDek }> {
    const res = await this.#call(TARGET_GENERATE_DATA_KEY, {
      KeyId: this.#keyArn,
      KeySpec: "AES_256",
      EncryptionContext: kmsEncryptionContext(context),
    });
    const plaintext = decodeKmsBlob(res.Plaintext, "Plaintext");
    const wrappedDek = decodeKmsBlob(res.CiphertextBlob, "CiphertextBlob");
    // importDek validates the 32-byte length and imports NON-EXTRACTABLE by default.
    const dek = await importDek(plaintext);
    plaintext.fill(0); // scrub the raw DEK now that it lives only inside the opaque handle.
    return { dek, wrapped: { wrappedDek, kekRef: this.#keyArn } };
  }

  async unwrapDek(wrapped: WrappedDek, context: EncryptionContext): Promise<CryptoKey> {
    if (wrapped.kekRef !== this.#keyArn) {
      throw new Error(
        `AWS KMS kek ref mismatch: wrapped under "${wrapped.kekRef}", this provider is "${this.#keyArn}"`,
      );
    }
    const res = await this.#call(TARGET_DECRYPT, {
      CiphertextBlob: bytesToB64(wrapped.wrappedDek),
      EncryptionContext: kmsEncryptionContext(context),
      // Pin the key + algorithm so a swapped ciphertext can't redirect the unwrap to another key.
      KeyId: this.#keyArn,
      EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
    });
    const plaintext = decodeKmsBlob(res.Plaintext, "Plaintext");
    const dek = await importDek(plaintext);
    plaintext.fill(0); // scrub the raw DEK now that it lives only inside the opaque handle.
    return dek;
  }

  /** Sign + POST one KMS JSON action; throw `AwsKmsError` on any non-2xx, timeout, or bad response. */
  async #call(target: string, body: Record<string, unknown>): Promise<KmsResponse> {
    let res: Response;
    try {
      res = await this.#client.fetch(this.#endpoint, {
        method: "POST",
        headers: { "content-type": KMS_JSON_CONTENT_TYPE, "x-amz-target": target },
        body: JSON.stringify(body),
        // A grey/hung connection aborts here and lands in the catch as an AwsKmsError, rather
        // than stalling the calling request until the platform's hard wall-clock limit.
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      throw new AwsKmsError(`AWS KMS ${target} request failed: ${String(cause)}`);
    }
    const text = await res.text();
    if (!res.ok) {
      // KMS errors are JSON `{"__type": "...", "message"|"Message": "..."}`. Surface the type so
      // a 403 (bad creds / key policy) is diagnosable, without echoing any request material.
      const awsType = safeAwsErrorType(text);
      throw new AwsKmsError(
        `AWS KMS ${target} returned ${res.status}${awsType ? ` (${awsType})` : ""}`,
        awsType,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AwsKmsError(`AWS KMS ${target} returned a non-JSON body`);
    }
    return parsed as KmsResponse;
  }
}

interface KmsResponse {
  readonly Plaintext?: string;
  readonly CiphertextBlob?: string;
}

/** Map our `EncryptionContext` to the KMS encryption-context string map (snake_case keys). */
function kmsEncryptionContext(ctx: EncryptionContext): Record<string, string> {
  // KMS's EncryptionContext is the ONLY confused-deputy binding on the AWS path (there is no
  // separate WebCrypto AAD as in LocalKmsProvider), so an empty field would silently weaken it.
  if (!ctx.orgId || !ctx.endpointId || !ctx.keyId) {
    throw new Error(
      "AwsKmsProvider: EncryptionContext fields (orgId, endpointId, keyId) must be non-empty",
    );
  }
  return { org_id: ctx.orgId, endpoint_id: ctx.endpointId, key_id: ctx.keyId };
}

/** Decode a required standard-base64 KMS blob field to bytes; throw if missing/undecodable. */
function decodeKmsBlob(value: string | undefined, field: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0) {
    throw new AwsKmsError(`AWS KMS response missing ${field}`);
  }
  try {
    return b64ToBytes(value);
  } catch {
    throw new AwsKmsError(`AWS KMS response ${field} was not valid base64`);
  }
}

/** Extract the AWS `__type` from an error body without throwing on malformed JSON. */
function safeAwsErrorType(text: string): string | undefined {
  try {
    const t = (JSON.parse(text) as { __type?: unknown }).__type;
    return typeof t === "string" ? t : undefined;
  } catch {
    return undefined;
  }
}
