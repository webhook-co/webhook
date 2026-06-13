import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { deliveryStatusTone, StatusPill, type DeliveryStatus } from "./status";

describe("deliveryStatusTone", () => {
  it.each([
    ["delivered", "ok"],
    ["pending", "neutral"],
    ["retrying", "warn"],
    ["failed", "danger"],
    ["replayed", "info"],
    ["disabled", "neutral"],
  ] as Array<[DeliveryStatus, string]>)("maps %s to %s", (status, tone) => {
    expect(deliveryStatusTone(status)).toBe(tone);
  });
});

describe("StatusPill", () => {
  it("derives tone and label from a status", () => {
    render(<StatusPill status="delivered" />);
    const el = screen.getByText("delivered");
    expect(el).toHaveClass("text-ok");
  });

  it("renders an explicit tone and label", () => {
    render(<StatusPill tone="info">replayed</StatusPill>);
    expect(screen.getByText("replayed")).toHaveClass("text-info");
  });

  it("lets status override an explicitly-passed tone (documented precedence)", () => {
    // Both set: status ("failed" -> danger) must win over tone ("info").
    render(<StatusPill status="failed" tone="info" />);
    const el = screen.getByText("failed");
    expect(el).toHaveClass("text-danger");
    expect(el).not.toHaveClass("text-info");
  });

  it("shows a leading dot by default and hides it on request", () => {
    const { container, rerender } = render(<StatusPill status="failed" />);
    expect(container.querySelector("span[aria-hidden='true']")).not.toBeNull();

    rerender(<StatusPill status="failed" dot={false} />);
    expect(container.querySelector("span[aria-hidden='true']")).toBeNull();
  });

  it("falls back to neutral when nothing is provided", () => {
    render(<StatusPill>unknown</StatusPill>);
    expect(screen.getByText("unknown")).toHaveClass("text-fg-secondary");
  });
});
