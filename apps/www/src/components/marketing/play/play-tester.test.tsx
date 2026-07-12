import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockMatchMedia } from "@/lib/test-utils";
import { axeComponent } from "@/test/axe";

import { CaptureRow, PLAY_SESSION_KEY, PlayTester, type Capture } from "./play-tester";

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
    // A mint now persists the session, so it must not leak into the next test (the component would
    // restore it and never show the mint button).
    sessionStorage.clear();
  });
  afterEach(() => {
    global.fetch = realFetch;
    global.EventSource = realES;
    sessionStorage.clear();
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

// Reload used to LOSE the sandbox: the token lived only in React state. The sandbox itself survived
// (the DO runs its full TTL and the coordinator only prunes by expiry — there is no release path), so
// with a per-IP cap of 5, five reloads silently 429'd the user for fifteen minutes while five
// invisible sandboxes ticked away. We now persist the NON-SECRET session in sessionStorage and
// re-attach on mount; the viewer secret stays where it always was — in the HttpOnly cookie.
describe("PlayTester — surviving a reload", () => {
  const realFetch = global.fetch;
  const realES = global.EventSource;
  const token = "b".repeat(32);
  const stored = (expiresAt: number) =>
    JSON.stringify({ token, ingestUrl: `https://play.wbhk.my/${token}`, expiresAt });

  beforeEach(() => {
    mockMatchMedia(true);
    FakeEventSource.instances = [];
    global.EventSource = FakeEventSource as unknown as typeof EventSource;
    sessionStorage.clear();
    global.fetch = vi.fn(() => {
      throw new Error("a restored session must NOT re-mint — that's what burns the per-IP budget");
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
    global.EventSource = realES;
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("restores a still-valid sandbox on mount and re-attaches the stream WITHOUT re-minting", async () => {
    sessionStorage.setItem(PLAY_SESSION_KEY, stored(Date.now() + 600_000));
    render(<PlayTester />);

    // The URL is back on screen, and no mint was issued (fetch would have thrown).
    expect((await screen.findAllByText(new RegExp(token))).length).toBeGreaterThan(0);
    // The stream was re-opened — the DO replays its capture backlog, so the captures come back too.
    const es = FakeEventSource.instances[0];
    expect(es.url).toContain(`/${token}/stream`);
    expect(es.init?.withCredentials).toBe(true);
  });

  it("never persists the viewer secret — the WRITE is filtered, not just the fixture", async () => {
    // This guards the load-bearing invariant: the viewer secret lives ONLY in the HttpOnly cookie.
    // It must therefore exercise the code that WRITES to storage (start()), not read back a fixture
    // the test itself wrote — that version passed even when start() persisted the whole mint payload.
    // So: hand the component a mint response salted with decoy secrets the real worker never sends,
    // and assert none of them survive into storage.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token,
        ingestUrl: `https://play.wbhk.my/${token}`,
        expiresAt: Date.now() + 900_000,
        curl: `curl -X POST https://play.wbhk.my/${token}`,
        viewerSecret: "DECOY_SECRET_VALUE",
        secret: "DECOY_SECRET_VALUE",
      }),
    }) as unknown as typeof fetch;

    render(<PlayTester />);
    await userEvent.click(screen.getByRole("button", { name: /create a test url/i }));

    const raw = sessionStorage.getItem(PLAY_SESSION_KEY);
    expect(raw, "the session must actually be persisted").not.toBeNull();
    expect(raw).not.toContain("DECOY_SECRET_VALUE");
    expect(Object.keys(JSON.parse(raw!)).sort()).toEqual(["expiresAt", "ingestUrl", "token"]);
  });

  it("ignores an expired stored sandbox (offers a fresh one instead of a dead URL)", async () => {
    sessionStorage.setItem(PLAY_SESSION_KEY, stored(Date.now() - 1));
    render(<PlayTester />);
    expect(await screen.findByRole("button", { name: /create a test url/i })).toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(sessionStorage.getItem(PLAY_SESSION_KEY)).toBeNull(); // and it's swept
  });

  it("ignores a corrupt stored value rather than crashing the page", async () => {
    sessionStorage.setItem(PLAY_SESSION_KEY, "{not json");
    render(<PlayTester />);
    expect(await screen.findByRole("button", { name: /create a test url/i })).toBeInTheDocument();
  });
});

// A sandbox URL you have to hand-select out of a <code> block is a papercut on the one page whose
// entire job is "send this thing a request in under ten seconds".
describe("PlayTester — copying the URL and the curl", () => {
  const realFetch = global.fetch;
  const realES = global.EventSource;
  const token = "c".repeat(32);

  beforeEach(() => {
    mockMatchMedia(true);
    FakeEventSource.instances = [];
    global.EventSource = FakeEventSource as unknown as typeof EventSource;
    sessionStorage.clear();
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
  });
  afterEach(() => {
    global.fetch = realFetch;
    global.EventSource = realES;
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("copies the sandbox url to the clipboard from a real, labelled button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<PlayTester />);
    await userEvent.click(screen.getByRole("button", { name: /create a test url/i }));

    await userEvent.click(await screen.findByRole("button", { name: /copy sandbox url/i }));
    expect(writeText).toHaveBeenCalledWith(`https://play.wbhk.my/${token}`);
    // Confirmation is announced, not just painted (screen-reader users get it too).
    expect(await screen.findByRole("status")).toHaveTextContent(/copied/i);
  });

  it("announces EACH copy — the live region text changes between the url and the curl", async () => {
    // aria-live only announces on a CHANGE. A bare "copied" string is identical for both buttons, so
    // copying the url and then the curl would announce exactly once and then go silent — the second
    // copy would be invisible to a screen-reader user while looking fine on screen.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<PlayTester />);
    await userEvent.click(screen.getByRole("button", { name: /create a test url/i }));

    await userEvent.click(await screen.findByRole("button", { name: /copy sandbox url/i }));
    const first = (await screen.findByRole("status")).textContent;

    await userEvent.click(screen.getByRole("button", { name: /copy curl command/i }));
    const second = (await screen.findByRole("status")).textContent;

    expect(first).toMatch(/copied/i);
    expect(second).toMatch(/copied/i);
    expect(second, "the announcement must change, or the second copy is never announced").not.toBe(
      first,
    );
  });

  it("copies the curl command from its own labelled button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<PlayTester />);
    await userEvent.click(screen.getByRole("button", { name: /create a test url/i }));
    await userEvent.click(await screen.findByRole("button", { name: /copy curl command/i }));
    // Derived from the ingest URL — the ONE source for this command (the worker no longer sends one).
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining(`curl -X POST https://play.wbhk.my/${token}`),
    );
  });

  it("tells the user any verb works, including a plain browser GET", async () => {
    render(<PlayTester />);
    await userEvent.click(screen.getByRole("button", { name: /create a test url/i }));
    expect(await screen.findByText(/any method/i)).toBeInTheDocument();
  });
});
