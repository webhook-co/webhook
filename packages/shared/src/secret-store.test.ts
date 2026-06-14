import { describe, expect, it } from "vitest";

import { utf8Decoder, utf8Encoder } from "./bytes";
import { type EncryptionContext } from "./envelope";
import { LocalKmsProvider } from "./kms/local";
import { OrgScopedDekCache } from "./kms/lru";
import { SecretStore } from "./secret-store";

const ctx: EncryptionContext = { orgId: "org_1", endpointId: "ep_1", keyId: "key_1" };

async function newStore() {
  const kms = await LocalKmsProvider.generate("local-kek-store");
  return new SecretStore(kms);
}

describe("SecretStore (seal/open helper)", () => {
  it("seals on write and opens the same plaintext on read", async () => {
    const store = await newStore();
    const record = await store.seal(utf8Encoder.encode("whsec_value"), ctx);

    expect(record.envelopeVersion).toBeGreaterThan(0);
    expect(record.wrapped.kekRef).toBe("local-kek-store");

    const opened = await store.open(record, ctx);
    expect(utf8Decoder.decode(opened)).toBe("whsec_value");
  });

  it("accepts and returns plaintext as a string convenience", async () => {
    const store = await newStore();
    const record = await store.sealString("whsec_string", ctx);
    expect(await store.openString(record, ctx)).toBe("whsec_string");
  });

  it("fails to open under a mismatched encryption context (AAD binding)", async () => {
    const store = await newStore();
    const record = await store.seal(utf8Encoder.encode("x"), ctx);
    await expect(store.open(record, { ...ctx, endpointId: "ep_other" })).rejects.toBeTruthy();
  });

  it("uses the cache so a repeated read unwraps the DEK only once", async () => {
    const kms = await LocalKmsProvider.generate("local-kek-store");
    let unwraps = 0;
    const counting = {
      generateDek: kms.generateDek.bind(kms),
      unwrapDek: async (...args: Parameters<typeof kms.unwrapDek>) => {
        unwraps++;
        return kms.unwrapDek(...args);
      },
    };
    const cache = new OrgScopedDekCache({ maxEntries: 8 });
    const store = new SecretStore(counting, cache);

    const record = await store.seal(utf8Encoder.encode("v"), ctx);
    await store.open(record, ctx);
    await store.open(record, ctx);
    expect(unwraps).toBe(1);
  });

  it("bypasses the cache for a BAA org (unwrap per read)", async () => {
    const kms = await LocalKmsProvider.generate("local-kek-store");
    let unwraps = 0;
    const counting = {
      generateDek: kms.generateDek.bind(kms),
      unwrapDek: async (...args: Parameters<typeof kms.unwrapDek>) => {
        unwraps++;
        return kms.unwrapDek(...args);
      },
    };
    const cache = new OrgScopedDekCache({
      maxEntries: 8,
      isCacheDisabled: (orgId) => orgId === ctx.orgId,
    });
    const store = new SecretStore(counting, cache);

    const record = await store.seal(utf8Encoder.encode("v"), ctx);
    await store.open(record, ctx);
    await store.open(record, ctx);
    expect(unwraps).toBe(2);
  });

  it("works without a cache (unwraps every read)", async () => {
    const kms = await LocalKmsProvider.generate("local-kek-store");
    let unwraps = 0;
    const counting = {
      generateDek: kms.generateDek.bind(kms),
      unwrapDek: async (...args: Parameters<typeof kms.unwrapDek>) => {
        unwraps++;
        return kms.unwrapDek(...args);
      },
    };
    const store = new SecretStore(counting);
    const record = await store.seal(utf8Encoder.encode("v"), ctx);
    await store.open(record, ctx);
    await store.open(record, ctx);
    expect(unwraps).toBe(2);
  });
});
