import type { Cursor, Delivery } from "@webhook-co/shared";
import { describe, expect, it, vi } from "vitest";

import {
  loadDeliveries,
  loadDelivery,
  loadMoreDeliveries,
  type DeliveryReaders,
} from "./deliveries";

const ORG = "11111111-1111-1111-1111-111111111111";
const DELIVERY_ID = "22222222-2222-2222-2222-222222222222";

function delivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: DELIVERY_ID,
    eventId: "33333333-3333-3333-3333-333333333333",
    destinationId: "44444444-4444-4444-4444-444444444444",
    subscriptionId: null,
    status: "delivered",
    statusCode: 200,
    attempt: 1,
    error: null,
    nextRetryAt: null,
    createdAt: new Date("2026-07-01T12:00:00.000Z"),
    ...overrides,
  };
}

const CURSOR: Cursor = { orderKey: "2026-07-01T12:00:00.000000Z", id: DELIVERY_ID };

describe("loadDeliveries — global list", () => {
  it("returns ok with items + nextCursor from the reader", async () => {
    const readers: DeliveryReaders = {
      firstPage: vi.fn().mockResolvedValue({ items: [delivery()], nextCursor: CURSOR }),
      listMore: vi.fn(),
      getDelivery: vi.fn(),
    };
    const result = await loadDeliveries(ORG, { status: ["delivered"] }, readers);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toEqual(CURSOR);
    expect(readers.firstPage).toHaveBeenCalledWith(ORG, { status: ["delivered"] });
  });

  it("maps a reader throw to {status:error} (scrubbed, not surfaced)", async () => {
    const readers: DeliveryReaders = {
      firstPage: vi.fn().mockRejectedValue(new Error("boom")),
      listMore: vi.fn(),
      getDelivery: vi.fn(),
    };
    const result = await loadDeliveries(ORG, undefined, readers);
    expect(result.status).toBe("error");
  });
});

describe("loadMoreDeliveries — the load-older path", () => {
  it("threads the cursor + active filters to the reader", async () => {
    const readers: DeliveryReaders = {
      firstPage: vi.fn(),
      listMore: vi.fn().mockResolvedValue({ items: [delivery()], nextCursor: null }),
      getDelivery: vi.fn(),
    };
    const page = await loadMoreDeliveries(ORG, CURSOR, { status: ["failed"] }, readers);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
    expect(readers.listMore).toHaveBeenCalledWith(ORG, CURSOR, { status: ["failed"] });
  });
});

describe("loadDelivery — detail", () => {
  it("non-uuid id → not_found without hitting the reader", async () => {
    const readers: DeliveryReaders = {
      firstPage: vi.fn(),
      listMore: vi.fn(),
      getDelivery: vi.fn(),
    };
    const result = await loadDelivery(ORG, "not-a-uuid", readers);
    expect(result.status).toBe("not_found");
    expect(readers.getDelivery).not.toHaveBeenCalled();
  });

  it("reader returns null → not_found (no cross-org existence oracle)", async () => {
    const readers: DeliveryReaders = {
      firstPage: vi.fn(),
      listMore: vi.fn(),
      getDelivery: vi.fn().mockResolvedValue(null),
    };
    const result = await loadDelivery(ORG, DELIVERY_ID, readers);
    expect(result.status).toBe("not_found");
  });

  it("reader returns a delivery → ok", async () => {
    const readers: DeliveryReaders = {
      firstPage: vi.fn(),
      listMore: vi.fn(),
      getDelivery: vi.fn().mockResolvedValue(delivery({ status: "blocked" })),
    };
    const result = await loadDelivery(ORG, DELIVERY_ID, readers);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.delivery.status).toBe("blocked");
  });

  it("maps a reader throw to {status:error}", async () => {
    const readers: DeliveryReaders = {
      firstPage: vi.fn(),
      listMore: vi.fn(),
      getDelivery: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const result = await loadDelivery(ORG, DELIVERY_ID, readers);
    expect(result.status).toBe("error");
  });
});
