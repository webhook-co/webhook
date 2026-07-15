import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

// Access to the R2_AVATARS bucket (uploaded user avatars), mirroring the provider-icon R2 access: resolve the
// binding from the Cloudflare context and degrade gracefully when it's absent (dev / vitest / any non-workerd
// env have no binding). All callers must handle `undefined`.

/** The minimal R2 surface the avatar routes use. */
export interface AvatarBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(
    key: string,
    body: ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

/** The bound R2_AVATARS bucket, or undefined when unbound (dev / non-workerd) — callers fall back / no-op. */
export async function getAvatarBucket(): Promise<AvatarBucket | undefined> {
  try {
    const { env } = await getCloudflareContext({ async: true });
    const bucket = (env as Record<string, unknown>).R2_AVATARS as AvatarBucket | undefined;
    return bucket && typeof bucket.get === "function" ? bucket : undefined;
  } catch {
    // No Cloudflare context (e.g. a non-workerd runtime) → run without the bucket.
    return undefined;
  }
}
