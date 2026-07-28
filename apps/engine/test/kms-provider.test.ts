import { toCachedSealedSecret } from "@webhook-co/db";
import {
  AwsKmsProvider,
  LocalKmsProvider,
  SecretStore,
  type EncryptionContext,
} from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import { buildVerifyFn, getVerifyFn, kmsProviderFromEnv, type Env } from "../src/index";

// Slice A — the engine's KEK custodian is AWS KMS (ADR-0007/0009), wired behind the KmsProvider seam.
// These exercise the two extracted seams in WORKERD:
//   - kmsProviderFromEnv: the prod construction site selects AwsKmsProvider + fails fast on bad config.
//     (Constructing AwsKmsProvider makes NO network call, so the suite stays hermetic — it never
//     reaches GenerateDataKey/Decrypt.)
//   - buildVerifyFn: the verify composition (SecretStore + the isolate DEK cache + adapter) over an
//     INJECTED provider, so the engine's prod wiring is proven against a hermetic Local custodian
//     rather than AWS.

// AWS's own documented placeholder credentials (account 111122223333, the AKIA…EXAMPLE key): clearly
// fake, and the `…EXAMPLE` suffix matches the gitleaks allowlist so a secret scanner won't flag them.
// No AWS call is made by any test here, so the values are only ever shape-checked. They are PLAIN
// STRINGS even though Env now types these as SecretsStoreSecret — readSecretBinding bridges the two
// (the prod path is a real binding's .get(); tests inject strings), so the cast is the test seam.
const KEY_ARN = "arn:aws:kms:us-east-2:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";
const AWS_ENV = {
  KMS_KEY_ARN: KEY_ARN,
  AWS_REGION: "us-east-2",
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
} as unknown as Env;

describe("kmsProviderFromEnv (prod KEK custodian = AWS KMS)", () => {
  it("builds an AwsKmsProvider whose kekRef is the configured key ARN", async () => {
    const kms = await kmsProviderFromEnv(AWS_ENV);
    expect(kms).toBeInstanceOf(AwsKmsProvider);
    expect(kms.kekRef).toBe(KEY_ARN);
  });

  it.each(["KMS_KEY_ARN", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const)(
    "rejects fail-fast when %s is missing (no provider built under partial config)",
    async (field) => {
      const env = { ...AWS_ENV, [field]: "" } as unknown as Env;
      await expect(kmsProviderFromEnv(env)).rejects.toThrow(/AWS KMS config incomplete/);
    },
  );
});

// ── KMS_MODE=local — the hermetic dev custodian ──────────────────────────────────────────────────
//
// LocalKmsProvider has existed and been tested since the seam was built, but nothing could reach it
// at RUNTIME: kmsProviderFromEnv threw unless all four AWS variables were set. So creating an
// endpoint — the product's core object — required real AWS IAM credentials on a developer laptop,
// and a contributor without them could not exercise the product at all.
//
// The fence matters more than the feature. A local KEK in production would seal secrets under a key
// nobody custodies, so this must be impossible to reach by accident.

const LOCAL_KEK_B64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const LOCAL_ENV = { KMS_MODE: "local", LOCAL_KEK: LOCAL_KEK_B64 } as unknown as Env;

/**
 * Assert a rejection by catching it, rather than `expect(promise).rejects`.
 *
 * The `.rejects` form left one unhandled rejection per assertion in the workerd pool, and Vitest
 * warns those "might cause false positive tests" — an assertion whose own plumbing is unreliable is
 * not worth keeping.
 */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a rejection, but the call resolved");
}

describe("kmsProviderFromEnv (KMS_MODE=local — dev custodian)", () => {
  it("builds a LocalKmsProvider when KMS_MODE=local and a KEK is supplied", async () => {
    const kms = await kmsProviderFromEnv(LOCAL_ENV);
    expect(kms).toBeInstanceOf(LocalKmsProvider);
  });

  it("REFUSES local mode when the environment is also provisioned for real KMS", async () => {
    // The prod fence. An environment carrying AWS KMS config is provisioned for a real custodian;
    // honouring KMS_MODE=local there would silently seal secrets under a throwaway key. Two
    // independent failures would be needed to reach it, and this is the first.
    const env = { ...AWS_ENV, KMS_MODE: "local", LOCAL_KEK: LOCAL_KEK_B64 } as unknown as Env;
    expect(await rejection(kmsProviderFromEnv(env))).toMatch(/refusing/i);
  });

  it("refuses local mode even when only ONE AWS variable is present", async () => {
    // Partial AWS config still means "this environment was provisioned for AWS".
    for (const field of [
      "KMS_KEY_ARN",
      "AWS_REGION",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ]) {
      const env = {
        KMS_MODE: "local",
        LOCAL_KEK: LOCAL_KEK_B64,
        [field]: (AWS_ENV as unknown as Record<string, string>)[field],
      } as unknown as Env;
      expect(await rejection(kmsProviderFromEnv(env))).toMatch(/refusing/i);
    }
  });

  it("REFUSES local mode when AWS config arrives as Secrets Store BINDINGS, not strings", async () => {
    // The shape that actually ships. Every other test here injects plain strings — the file says so
    // itself — so without this case the production branch of kmsBindingPresent
    // (`typeof value?.get === "function"`) is the one input the fence is load-bearing for and is
    // exercised by nothing. In prod all four AWS fields are `secrets_store_secrets` objects.
    const asBinding = (v: string) => ({ get: async () => v });
    const env = {
      KMS_MODE: "local",
      LOCAL_KEK: LOCAL_KEK_B64,
      KMS_KEY_ARN: asBinding(KEY_ARN),
      AWS_REGION: asBinding("us-east-2"),
      AWS_ACCESS_KEY_ID: asBinding("AKIAIOSFODNN7EXAMPLE"),
      AWS_SECRET_ACCESS_KEY: asBinding("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
    } as unknown as Env;
    expect(await rejection(kmsProviderFromEnv(env))).toMatch(/refusing/i);
  });

  it("a bound-but-empty secret still counts as provisioned — presence, not value", async () => {
    // A half-provisioned Secrets Store must still REFUSE local rather than quietly substituting a
    // throwaway KEK. Fails in the safe direction.
    const env = {
      KMS_MODE: "local",
      LOCAL_KEK: LOCAL_KEK_B64,
      KMS_KEY_ARN: { get: async () => "" },
    } as unknown as Env;
    expect(await rejection(kmsProviderFromEnv(env))).toMatch(/refusing/i);
  });

  it("fails with a NAMED error when LOCAL_KEK is missing", async () => {
    const env = { KMS_MODE: "local" } as unknown as Env;
    expect(await rejection(kmsProviderFromEnv(env))).toMatch(/LOCAL_KEK/);
  });

  it("rejects a KEK that is not 32 bytes", async () => {
    const env = { KMS_MODE: "local", LOCAL_KEK: btoa("too-short") } as unknown as Env;
    expect(await rejection(kmsProviderFromEnv(env))).toMatch(/32 bytes/);
  });

  it("only the exact string 'local' enables it — anything else takes the AWS path", async () => {
    // A fail-OPEN parse would be the whole vulnerability: `KMS_MODE=Local` or a stray value must not
    // silently select the dev custodian. Supply valid AWS config so the fallthrough is observable —
    // asserting on the error text of a config-less AWS path would be testing the wrong thing.
    for (const mode of ["Local", "LOCAL", "local ", "true", "1", "", "dev", "local\n"]) {
      const env = { ...AWS_ENV, KMS_MODE: mode, LOCAL_KEK: LOCAL_KEK_B64 } as unknown as Env;
      const kms = await kmsProviderFromEnv(env);
      expect(
        kms,
        `KMS_MODE=${JSON.stringify(mode)} must not select the local custodian`,
      ).toBeInstanceOf(AwsKmsProvider);
      expect(kms).not.toBeInstanceOf(LocalKmsProvider);
    }
  });

  it("an unset KMS_MODE is unchanged — the AWS path still builds", async () => {
    const kms = await kmsProviderFromEnv(AWS_ENV);
    expect(kms).toBeInstanceOf(AwsKmsProvider);
  });

  it("the same raw KEK survives a restart — a DEK wrapped by one instance unwraps in the next", async () => {
    // LocalKmsProvider.generate() would mint a fresh KEK per process, so every endpoint created
    // before a restart would become permanently unopenable. Deriving from LOCAL_KEK is what makes
    // local dev usable across restarts, and this is the assertion that pins it.
    const ctx: EncryptionContext = {
      orgId: "be000000-0000-4000-8000-000000000001",
      endpointId: "be000000-0000-4000-8000-000000000002",
      keyId: "be000000-0000-4000-8000-000000000003",
    };
    const first = await kmsProviderFromEnv(LOCAL_ENV);
    const wrapped = await first.generateDek(ctx);
    const second = await kmsProviderFromEnv(LOCAL_ENV);
    const unwrapped = await second.unwrapDek(wrapped.wrapped, ctx);
    expect(unwrapped).toBeTruthy();
  });
});

describe("buildVerifyFn (engine verify wiring over the KMS seam)", () => {
  const ORG = "be000000-0000-4000-8000-000000000001";
  const EP = "be000000-0000-4000-8000-000000000002";
  const enc = new TextEncoder();
  const T = 1_750_000_000;

  async function stripeSignature(secret: string, t: number, body: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`));
    return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  it("returns unverified for an unrecognized provider (no adapter, no unseal)", async () => {
    const verify = buildVerifyFn(await LocalKmsProvider.generate());
    const outcome = await verify({
      rawBody: enc.encode("{}"),
      headers: [],
      provider: null,
      orgId: ORG,
      endpointId: EP,
      sealedSecrets: [],
    });
    expect(outcome).toEqual({ verified: false, verification: null });
  });

  it("unseals + verifies a sealed provider secret round-trip via an injected (Local) custodian", async () => {
    // Proves the engine's prod composition (the same SecretStore + isolate DEK cache the AWS path
    // uses) unwraps a sealed secret and runs the adapter — through buildVerifyFn, not a hand-rolled
    // store. Uses a Local custodian so no AWS call is made.
    const kms = await LocalKmsProvider.generate();
    const store = new SecretStore(kms);
    const SECRET = "whsec_correct";
    const context: EncryptionContext = { orgId: ORG, endpointId: EP, keyId: "sec-1" };
    const sealed = await store.sealString(SECRET, context);
    const cached = toCachedSealedSecret({
      id: "sec-1",
      provider: "stripe",
      status: "active",
      sealed,
      context,
    });

    const body = `{"id":"evt_abc"}`;
    const sig = await stripeSignature(SECRET, T, body);
    // The verify clock must be the signing time so Stripe's replay window passes deterministically.
    const verify = buildVerifyFn(kms, () => new Date(T * 1000));

    const outcome = await verify({
      rawBody: enc.encode(body),
      headers: [["stripe-signature", `t=${T},v1=${sig}`]],
      provider: "stripe",
      orgId: ORG,
      endpointId: EP,
      sealedSecrets: [cached],
    });
    expect(outcome.verified).toBe(true);
    expect(outcome.verification).toMatchObject({ ok: true, scheme: "stripe" });
  });
});

describe("getVerifyFn (memoized prod entry over AWS KMS)", () => {
  // The load-bearing contract: an init that throws on incomplete KMS config must NOT be cached, so a
  // later (well-configured) request rebuilds rather than the isolate being poisoned for its lifetime.
  it("rejects on incomplete config, clears the memo, then rebuilds + memoizes on a valid call", async () => {
    const incomplete = {
      KMS_KEY_ARN: "",
      AWS_REGION: "",
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
    } as unknown as Env;
    // First call: incomplete config -> the async init rejects (kmsProviderFromEnv throws).
    await expect(getVerifyFn(incomplete)).rejects.toThrow(/AWS KMS config incomplete/);
    // Awaiting the rejection guarantees the .catch ran and cleared the memo: a valid call now builds.
    const verify = await getVerifyFn(AWS_ENV);
    expect(typeof verify).toBe("function");
    // And the successful build IS memoized: a second valid call returns the very same instance.
    expect(await getVerifyFn(AWS_ENV)).toBe(verify);
  });
});
