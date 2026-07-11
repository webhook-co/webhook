import assert from "node:assert/strict";
import { test } from "node:test";

import { countDeadLinks } from "./check-no-dead-links.mjs";

// A dead link must not be able to hide behind attribute order, whitespace, or a newline. React emits
// double-quoted lowercase attributes and escapes `>` inside values, so these are the shapes that can
// actually reach out/.

test("catches a dead link whatever the attribute order", () => {
  assert.equal(countDeadLinks('<a href="#" class="x">About</a>'), 1);
  assert.equal(countDeadLinks('<a class="x" href="#">About</a>'), 1);
  assert.equal(countDeadLinks('<a class="a b" rel="me" href="#">About</a>'), 1);
});

// `[^>]+` is a negated character class, not `.` — so it spans newlines with no `s` flag. Worth a test,
// because getting this wrong is how a formatter-wrapped tag slips a dead link past the gate.
test("catches one split across lines", () => {
  assert.equal(countDeadLinks('<a\n  href="#"\n  class="x"\n>About</a>'), 1);
  assert.equal(countDeadLinks('<a\thref="#">About</a>'), 1);
});

test("counts every dead link on the page, not just the first", () => {
  assert.equal(countDeadLinks('<a href="#">a</a><a class="q" href="#">b</a>'), 2);
});

// The whole point of the trailing quote: real in-page targets must not trip it. The skip link and the
// 54 legal section anchors are load-bearing, and a guard that flagged them would just get disabled.
test("never flags a real in-page anchor", () => {
  assert.equal(countDeadLinks('<a href="#main">Skip to content</a>'), 0);
  assert.equal(countDeadLinks('<a href="#limitation-of-liability">9. Limitation</a>'), 0);
  assert.equal(countDeadLinks('<a href="/dpa#sub-processors">Sub-processors</a>'), 0);
  assert.equal(countDeadLinks('<a href="#faq">FAQ</a>'), 0);
});

test("never flags a real destination", () => {
  assert.equal(
    countDeadLinks('<a href="https://docs.webhook.co/mcp/overview">Read the docs</a>'),
    0,
  );
  assert.equal(countDeadLinks('<a href="mailto:sourabh@webhook.co">Contact</a>'), 0);
  assert.equal(countDeadLinks('<a href="/pricing">Pricing</a>'), 0);
});

// An `href="#"` inside a script payload or an escaped code sample is text, not a link.
test("does not flag escaped or scripted text", () => {
  assert.equal(
    countDeadLinks('<script type="application/ld+json">{"x":"\\u003ca href=#\\u003e"}</script>'),
    0,
  );
  assert.equal(countDeadLinks('<pre>&lt;a href="#"&gt;</pre>'), 0);
});

test("an anchor with no href at all is not a link to nowhere", () => {
  assert.equal(countDeadLinks("<a>About</a>"), 0);
});
