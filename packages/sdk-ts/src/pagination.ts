// Cursor pagination. Every list endpoint returns `{items, nextCursor}` with an opaque keyset cursor that
// is null at the end. `Paginator` turns that into an async-iterable of individual items (the common case:
// `for await (const ep of client.endpoints.list())`), with `.pages()` for page-at-a-time access and
// `.collect()` to materialise everything.

import { WebhookUnexpectedResponseError } from "./errors.js";

/** One page of a cursor-paginated read. */
export interface Page<T> {
  readonly items: readonly T[];
  /** The cursor for the next page, or null at the end of the sequence. */
  readonly nextCursor: string | null;
}

/**
 * An async-iterable view over a cursor-paginated endpoint. Iterating yields individual items across all
 * pages; the underlying `fetchPage(cursor)` is called lazily, one page at a time, following `nextCursor`
 * until it is null.
 */
export class Paginator<T> implements AsyncIterable<T> {
  constructor(private readonly fetchPage: (cursor?: string) => Promise<Page<T>>) {}

  async *pages(): AsyncGenerator<Page<T>, void, undefined> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.fetchPage(cursor);
      yield page;
      if (page.nextCursor === null) return;
      // Defensive: a keyset cursor must strictly advance. If the server hands back the same cursor we
      // just sent, following it would loop forever — surface that as an unexpected response instead.
      if (page.nextCursor === cursor) {
        throw new WebhookUnexpectedResponseError("pagination cursor did not advance");
      }
      cursor = page.nextCursor;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    for await (const page of this.pages()) {
      for (const item of page.items) yield item;
    }
  }

  /** Materialise every item across all pages into an array. Beware unbounded result sets. */
  async collect(): Promise<T[]> {
    const out: T[] = [];
    for await (const item of this) out.push(item);
    return out;
  }
}
