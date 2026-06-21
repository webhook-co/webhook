import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement these DOM APIs that Radix's menu/overlay primitives call during
// pointer handling and keyboard navigation. Shim them so component tests can drive real
// interactions (e.g. opening the account menu) instead of mocking the components.
Element.prototype.scrollIntoView = function scrollIntoView() {};
Element.prototype.hasPointerCapture = function hasPointerCapture() {
  return false;
};
Element.prototype.setPointerCapture = function setPointerCapture() {};
Element.prototype.releasePointerCapture = function releasePointerCapture() {};

globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// jsdom doesn't implement matchMedia; ThemeToggle reads it on mount. Default to "light".
window.matchMedia = (query) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() {
    return false;
  },
});

// Some jsdom setups expose no localStorage (opaque origin); ThemeToggle reads it on mount. Provide a
// minimal in-memory store only when it's missing, so it never overrides a working jsdom localStorage.
if (!("localStorage" in window) || !window.localStorage) {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}
