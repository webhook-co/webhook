import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockMatchMedia } from "@/lib/test-utils";
import { axeComponent } from "@/test/axe";

import { CaptureRow, PlayTester, type Capture } from "./play-tester";

// The render half of the /play XSS control: captured request content is attacker-controlled, so it
// must render as INERT text — never as HTML/DOM. React text nodes give this for free; these tests pin
// it so a future refactor to dangerouslySetInnerHTML (or a markdown/HTML preview) turns red.

const xssCapture: Capture = {
  id: "c1",
  method: "POST",
  headers: [
    ["x-evil", "<script>alert('h')</script>"],
    ["content-type", "text/html"],
  ],
  contentType: "text/html",
  body: '<img src=x onerror="alert(document.domain)"><script>alert(1)</script>',
  bodyBytes: 68,
  truncated: false,
  receivedAt: 0,
};

describe("CaptureRow — inert rendering", () => {
  it("renders an XSS body as literal text, injecting no <img>/<script> element", () => {
    const { container } = render(<CaptureRow capture={xssCapture} />);
    // No element was created from the payload — it's text, not markup.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    // The exact dangerous bytes are present, but only as textContent.
    expect(container.textContent).toContain("<img src=x onerror=");
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("renders an XSS header value as literal text too", () => {
    const { container } = render(<CaptureRow capture={xssCapture} />);
    // The header value is shown verbatim as text; no script element materialises from it.
    expect(container.textContent).toContain("<script>alert('h')</script>");
    expect(container.querySelectorAll("script")).toHaveLength(0);
  });

  it("shows the method, content-type and size chrome", () => {
    const { container } = render(<CaptureRow capture={xssCapture} />);
    expect(container.textContent).toContain("POST");
    expect(container.textContent).toContain("text/html");
    expect(container.textContent).toContain("68 bytes");
  });

  it("has no accessibility violations", async () => {
    // CaptureRow is an <li>; wrap it so the list has a valid parent for the a11y scan.
    const { container } = render(
      <ul>
        <CaptureRow capture={xssCapture} />
      </ul>,
    );
    expect(await axeComponent(container)).toHaveNoViolations();
  });
});

// The mint → live → capture → error lifecycle (where the dead-onerror bug lived) — mocking fetch +
// EventSource so the flow is exercised, not just CaptureRow.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  constructor(
    public url: string,
    public init?: { withCredentials?: boolean },
  ) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.readyState = 2;
  }
}

describe("PlayTester lifecycle", () => {
  const realFetch = global.fetch;
  const realES = global.EventSource;
  beforeEach(() => {
    mockMatchMedia(true);
    FakeEventSource.instances = [];
    global.EventSource = FakeEventSource as unknown as typeof EventSource;
  });
  afterEach(() => {
    global.fetch = realFetch;
    global.EventSource = realES;
    vi.restoreAllMocks();
  });

  it("mints, shows the ingest URL, and renders a streamed capture as inert text", async () => {
    const token = "a".repeat(32);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token,
        ingestUrl: `https://play.wbhk.my/${token}`,
        expiresAt: Date.now() + 900_000,
        curl: `curl -X POST https://play.wbhk.my/${token}`,
      }),
    }) as unknown as typeof fetch;

    render(<PlayTester />);
    await userEvent.click(screen.getByRole("button", { name: /create a test url/i }));

    // Mint sent credentials, and the ingest URL is shown (no secret anywhere).
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
      credentials: "include",
    });
    expect((await screen.findAllByText(new RegExp(token))).length).toBeGreaterThan(0);
    const es = FakeEventSource.instances[0];
    expect(es.init?.withCredentials).toBe(true);
    expect(es.url).not.toContain("v="); // secret is in the cookie, never the URL

    // A captured request with an XSS body streams in and renders as inert text (no <script> element).
    await act(async () => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify({
          id: "c1",
          method: "POST",
          headers: [["x-test", "1"]],
          contentType: "text/html",
          body: "<script>alert(1)</script>",
          bodyBytes: 25,
          truncated: false,
          receivedAt: 0,
        }),
      });
    });
    expect(await screen.findByText(/1 request captured/i)).toBeInTheDocument();
    // The XSS body rendered as inert text: no <script> element materialised; the literal is present.
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("<script>alert(1)</script>")).toBeInTheDocument();
  });

  it("surfaces a clear error when the mint is rate-limited", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 }) as unknown as typeof fetch;
    render(<PlayTester />);
    await userEvent.click(screen.getByRole("button", { name: /create a test url/i }));
    expect(await screen.findByText(/too many sandboxes/i)).toBeInTheDocument();
  });
});
