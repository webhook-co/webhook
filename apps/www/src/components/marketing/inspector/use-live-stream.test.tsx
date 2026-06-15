import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockMatchMedia } from "@/lib/test-utils";
import { SEED_COUNTER } from "./stream-data";
import { useLiveStream } from "./use-live-stream";

describe("useLiveStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts on the static seed and playing", () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useLiveStream());
    expect(result.current.state.counter).toBe(SEED_COUNTER);
    expect(result.current.state.rows[0].id).toBe("seed-0");
    expect(result.current.isPlaying).toBe(true);
  });

  it("advances one event per interval while playing", () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useLiveStream(1000));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.state.counter).toBe(SEED_COUNTER + 1);
    expect(result.current.state.rows[0]).toMatchObject({ provider: "linear", id: "evt-1" });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.state.counter).toBe(SEED_COUNTER + 4);
    expect(result.current.state.rows).toHaveLength(5);
  });

  it("defaults to paused under reduced motion and does not advance", () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useLiveStream(1000));
    expect(result.current.isPlaying).toBe(false);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.state.counter).toBe(SEED_COUNTER);
  });

  it("toggles play and pause", () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useLiveStream(1000));
    act(() => {
      result.current.toggle();
    });
    expect(result.current.isPlaying).toBe(false);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.state.counter).toBe(SEED_COUNTER);
    act(() => {
      result.current.toggle();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.state.counter).toBe(SEED_COUNTER + 1);
  });

  it("pauses while the tab is hidden and resumes when visible, manual pause winning", () => {
    mockMatchMedia(false);
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    const { result } = renderHook(() => useLiveStream(1000));

    hidden = true;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.state.counter).toBe(SEED_COUNTER);

    hidden = false;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.state.counter).toBe(SEED_COUNTER + 1);

    delete (document as { hidden?: boolean }).hidden;
  });

  it("clears the interval and visibility listener on unmount", () => {
    mockMatchMedia(false);
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = renderHook(() => useLiveStream(1000));
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    clearSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
