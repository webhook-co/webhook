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
    sourceVerificationState: "verified",
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
    // A blocked (never-dispatched) row shows no signed/unsigned indicator.
    expect(screen.queryByText(/^signed$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^unsigned$/i)).not.toBeInTheDocument();
  });

  it("shows a 'Signed' indicator for a delivered event from a verified source", () => {
    render(<DeliveryDetail delivery={del({ sourceVerificationState: "verified" })} />);
    expect(screen.getByText("Signature")).toBeInTheDocument();
    expect(screen.getByText("Signed")).toBeInTheDocument();
  });

  it("shows an 'Unsigned' indicator for a delivered event from an unattempted source (ADR-0103)", () => {
    render(<DeliveryDetail delivery={del({ sourceVerificationState: "unattempted" })} />);
    expect(screen.getByText("Unsigned")).toBeInTheDocument();
    expect(screen.getByText(/without a signature/i)).toBeInTheDocument();
  });

  it("a verification-failure block reads about the signature, not the SSRF guard (ADR-0103)", () => {
    render(
      <DeliveryDetail
        delivery={del({
          status: "blocked",
          statusCode: null,
          destinationId: null,
          sourceVerificationState: "failed",
          error: "verification failed: source signature was checked and rejected",
        })}
      />,
    );
    expect(screen.getByText(/the source event's signature was rejected/i)).toBeInTheDocument();
    // The wrong SSRF hint must NOT appear for this case.
    expect(screen.queryByText(/the destination isn't allowed/i)).not.toBeInTheDocument();
    // The raw engine error still shows, and now agrees with the hint.
    expect(screen.getByText(/source signature was checked and rejected/i)).toBeInTheDocument();
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
