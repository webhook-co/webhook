import { vi } from "vitest";

/**
 * Shared test doubles for the interactive islands. jsdom implements neither `matchMedia` nor
 * `IntersectionObserver`, so the hooks that depend on them need explicit stubs. Pair every install
 * with `vi.unstubAllGlobals()` in an `afterEach`.
 */

/** Stub `window.matchMedia` so `(prefers-reduced-motion: reduce)` resolves to `reduce`. */
export function mockMatchMedia(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("reduce") ? reduce : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

export interface IntersectionObserverMock {
  /** How many observers have been constructed. */
  readonly instances: number;
  /** Elements currently observed across all instances. */
  readonly observed: Element[];
  /** Fire an intersection for `el` (or the first observed element) on every live observer. */
  triggerIntersect: (el?: Element) => void;
}

/** Install a controllable `IntersectionObserver`. Returns a handle to inspect and drive it. */
export function installIntersectionObserverMock(): IntersectionObserverMock {
  const observed: Element[] = [];
  const callbacks: IntersectionObserverCallback[] = [];
  let instances = 0;

  // A minimal stand-in — not a structural `implements IntersectionObserver`, so it stays stable as the
  // DOM lib adds members (e.g. `scrollMargin`). The hook only uses observe/unobserve/disconnect.
  class IOMock {
    constructor(cb: IntersectionObserverCallback) {
      instances += 1;
      callbacks.push(cb);
    }
    observe(el: Element) {
      observed.push(el);
    }
    unobserve(el: Element) {
      const i = observed.indexOf(el);
      if (i >= 0) observed.splice(i, 1);
    }
    disconnect() {
      observed.length = 0;
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  vi.stubGlobal("IntersectionObserver", IOMock);

  return {
    get instances() {
      return instances;
    },
    get observed() {
      return observed;
    },
    triggerIntersect(el?: Element) {
      const target = el ?? observed[0];
      const entry = { isIntersecting: true, target } as IntersectionObserverEntry;
      for (const cb of callbacks) cb([entry], {} as IntersectionObserver);
    },
  };
}
