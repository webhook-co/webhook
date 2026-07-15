import { describe, expect, it, vi } from "vitest";

import {
  bumpAvatarVersion,
  getAvatarVersion,
  getServerAvatarVersion,
  subscribeAvatarVersion,
} from "./avatar-version";

// The store is module-global; reset it to a known baseline by bumping and recording deltas rather than
// resetting (there is no reset API by design — it only ever moves forward within a session).
describe("avatar-version store", () => {
  it("starts at 0 on the server snapshot (SSR renders the canonical, un-versioned URL)", () => {
    expect(getServerAvatarVersion()).toBe(0);
  });

  it("moves forward on bump and notifies every subscriber", () => {
    const before = getAvatarVersion();
    const a = vi.fn();
    const b = vi.fn();
    const unA = subscribeAvatarVersion(a);
    const unB = subscribeAvatarVersion(b);

    bumpAvatarVersion();

    expect(getAvatarVersion()).toBe(before + 1);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    unA();
    unB();
  });

  it("stops notifying after unsubscribe", () => {
    const fn = vi.fn();
    const unsub = subscribeAvatarVersion(fn);
    unsub();
    bumpAvatarVersion();
    expect(fn).not.toHaveBeenCalled();
  });
});
