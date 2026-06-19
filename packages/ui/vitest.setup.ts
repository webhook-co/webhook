import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement these DOM APIs that Radix's overlay/menu primitives call
// during pointer handling and keyboard navigation. Shim them so component tests can
// drive real interactions (open, arrow-key, select) instead of mocking the components
// under test.
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
