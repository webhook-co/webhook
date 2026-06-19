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
