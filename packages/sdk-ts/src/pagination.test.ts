import { describe, expect, it } from "vitest";

import { WebhookUnexpectedResponseError } from "./errors.js";
import { Paginator, type Page } from "./pagination.js";

/** A fake paged source: fixed pages keyed by the cursor sent, recording each requested cursor. */
function source(pages: Array<Page<number>>): {
  fetchPage: (cursor?: string) => Promise<Page<number>>;
  cursors: Array<string | undefined>;
} {
  const cursors: Array<string | undefined> = [];
  const fetchPage = async (cursor?: string): Promise<Page<number>> => {
    cursors.push(cursor);
    return pages[cursors.length - 1]!;
  };
  return { fetchPage, cursors };
}

describe("Paginator", () => {
  it("iterates items across pages until the cursor is null", async () => {
    const { fetchPage } = source([
      { items: [1, 2], nextCursor: "c1" },
      { items: [3, 4], nextCursor: null },
    ]);
    const seen: number[] = [];
    for await (const n of new Paginator(fetchPage)) seen.push(n);
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it("passes each page's nextCursor into the next fetch (first is undefined)", async () => {
    const { fetchPage, cursors } = source([
      { items: [1], nextCursor: "c1" },
      { items: [2], nextCursor: null },
    ]);
    for await (const _n of new Paginator(fetchPage)) {
      /* drain */
    }
    expect(cursors).toEqual([undefined, "c1"]);
  });

  it("yields a single page's items when it ends immediately", async () => {
    const { fetchPage } = source([{ items: [7, 8, 9], nextCursor: null }]);
    const seen: number[] = [];
    for await (const n of new Paginator(fetchPage)) seen.push(n);
    expect(seen).toEqual([7, 8, 9]);
  });

  it("yields nothing for an empty result", async () => {
    const { fetchPage } = source([{ items: [], nextCursor: null }]);
    const seen: number[] = [];
    for await (const n of new Paginator(fetchPage)) seen.push(n);
    expect(seen).toEqual([]);
  });

  it("exposes whole pages via .pages()", async () => {
    const pages: Array<Page<number>> = [
      { items: [1], nextCursor: "c1" },
      { items: [2], nextCursor: null },
    ];
    const { fetchPage } = source(pages);
    const collected: Array<Page<number>> = [];
    for await (const page of new Paginator(fetchPage).pages()) collected.push(page);
    expect(collected).toEqual(pages);
  });

  it("collects every item into an array via .collect()", async () => {
    const { fetchPage } = source([
      { items: [1, 2], nextCursor: "c1" },
      { items: [3], nextCursor: null },
    ]);
    expect(await new Paginator(fetchPage).collect()).toEqual([1, 2, 3]);
  });

  it("stops with an error if the cursor fails to advance (server bug guard)", async () => {
    // Always returns the same non-null cursor → would loop forever without the guard.
    const fetchPage = async (): Promise<Page<number>> => ({ items: [1], nextCursor: "stuck" });
    const run = async (): Promise<void> => {
      for await (const _n of new Paginator(fetchPage)) {
        /* drain */
      }
    };
    await expect(run()).rejects.toBeInstanceOf(WebhookUnexpectedResponseError);
  });
});
