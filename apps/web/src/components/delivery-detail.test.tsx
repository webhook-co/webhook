import type { Delivery } from "@webhook-co/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DeliveryDetail } from "./delivery-detail";

const EVT = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4fbbbb";
const DEST = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4faaaa";
const SUB = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4fcccc";

function del(over: Partial<Delivery> = {}): Delivery {
  return {
    id: "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5061",
    eventId: EVT,
    destinationId: DEST,
    subscriptionId: null,
    status: "delivered",
    statusCode: 200,
    attempt: 1,
    error: null,
    nextRetryAt: null,
    createdAt: new Date("2026-06-28T12:00:00Z"),
    ...over,
  };
}

describe("DeliveryDetail", () => {
  it("renders the status pill (from deliveryCopy), status code, attempt, event id, and destination", () => {
    render(<DeliveryDetail delivery={del()} />);
    expect(screen.getByText("Delivered")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
    expect(screen.getByText(EVT)).toBeInTheDocument();
    expect(screen.getByText(DEST)).toBeInTheDocument();
  });

  it("shows a retry hint + the next-retry time only when the delivery is pending with a due time", () => {
    const nextRetryAt = new Date(Date.now() + 30 * 60_000);
    render(<DeliveryDetail delivery={del({ status: "pending", statusCode: null, nextRetryAt })} />);
    expect(screen.getByText(/retrying in/i)).toBeInTheDocument();
    expect(screen.getByText("Next retry")).toBeInTheDocument();
    // A missing status code renders the em dash placeholder, not a blank.
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("omits the next-retry row when there is no retry clock (terminal state)", () => {
    render(<DeliveryDetail delivery={del({ status: "delivered" })} />);
    expect(screen.queryByText("Next retry")).not.toBeInTheDocument();
  });

  it("renders the engine error in a danger banner when present", () => {
    render(
      <DeliveryDetail
        delivery={del({ status: "failed", statusCode: 500, error: "connection refused" })}
      />,
    );
    expect(screen.getByText("connection refused")).toBeInTheDocument();
  });

  it("shows the honest blocked hint (true for both guard paths) and no 'localhost' mislabel", () => {
    render(
      <DeliveryDetail
        delivery={del({ status: "blocked", statusCode: null, destinationId: null })}
      />,
    );
    expect(screen.getByText(/the destination isn't allowed/i)).toBeInTheDocument();
    // A blocked row is not a legacy localhost forward — it must not be mislabeled "localhost".
    expect(screen.queryByText("localhost")).not.toBeInTheDocument();
  });

  it("labels a null destination 'localhost' only on a legacy forwarded row", () => {
    render(
      <DeliveryDetail
        delivery={del({ status: "forwarded", statusCode: null, destinationId: null })}
      />,
    );
    expect(screen.getByText("localhost")).toBeInTheDocument();
  });

  it("renders the subscription row only when a subscription is linked", () => {
    const { rerender } = render(<DeliveryDetail delivery={del({ subscriptionId: null })} />);
    expect(screen.queryByText("Subscription")).not.toBeInTheDocument();
    rerender(<DeliveryDetail delivery={del({ subscriptionId: SUB })} />);
    expect(screen.getByText("Subscription")).toBeInTheDocument();
    expect(screen.getByText(SUB)).toBeInTheDocument();
  });
});
