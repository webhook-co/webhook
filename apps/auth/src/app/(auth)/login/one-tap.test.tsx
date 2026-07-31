import { cleanup, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OneTap } from "./one-tap";

import type { OneTapOutcome } from "./one-tap-exchange";

// The lifecycle guarantees are the entire reason this component exists instead of a call to
// better-auth's `oneTapClient()`, so they are what these tests pin: prompt exactly once per mount,
// never silently, take the prompt down on unmount, and keep a failed script load off the user's screen.

const CLIENT_ID = "231453726280-abc.apps.googleusercontent.com";

type InitConfig = Parameters<NonNullable<Window["google"]>["accounts"]["id"]["initialize"]>[0];

let initialize: ReturnType<typeof vi.fn>;
let prompt: ReturnType<typeof vi.fn>;
let cancel: ReturnType<typeof vi.fn>;
/** Fires the Google credential callback the component registered. */
let fireCredential: (credential: string) => void;

/** Install a fake GSI api, as the real script would when it loads. */
function installGoogle() {
  initialize = vi.fn((config: InitConfig) => {
    fireCredential = (credential: string) => config.callback({ credential });
  });
  prompt = vi.fn();
  cancel = vi.fn();
  window.google = { accounts: { id: { initialize, prompt, cancel } } };
}

beforeEach(() => {
  installGoogle();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  delete window.google;
  vi.restoreAllMocks();
  document.querySelectorAll("script").forEach((s) => s.remove());
});

const signedIn = (target = "/session/handoff"): OneTapOutcome => ({ status: "signed-in", target });

function renderOneTap(over: Partial<React.ComponentProps<typeof OneTap>> = {}) {
  const exchange = vi.fn(async () => signedIn());
  const navigate = vi.fn();
  render(
    <OneTap
      clientId={CLIENT_ID}
      callbackURL="/session/handoff"
      exchange={exchange}
      navigate={navigate}
      {...over}
    />,
  );
  return { exchange, navigate };
}

describe("OneTap — prompting", () => {
  it("initializes with the given client id and prompts", async () => {
    renderOneTap();
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(initialize).toHaveBeenCalledTimes(1);
    expect((initialize.mock.calls[0][0] as InitConfig).client_id).toBe(CLIENT_ID);
  });

  // The founder's decision was prompt-plus-tap-to-confirm. `auto_select: true` would sign a returning
  // visitor in with no interaction at all — a different product, and one nobody agreed to.
  it("NEVER auto-selects — the user must confirm", async () => {
    renderOneTap();
    await waitFor(() => expect(initialize).toHaveBeenCalled());
    const config = initialize.mock.calls[0][0] as InitConfig;
    expect(config.auto_select).toBe(false);
  });

  it("uses the FedCM prompt and ITP support", async () => {
    renderOneTap();
    await waitFor(() => expect(initialize).toHaveBeenCalled());
    const config = initialize.mock.calls[0][0] as InitConfig;
    expect(config.use_fedcm_for_prompt).toBe(true);
    expect(config.itp_support).toBe(true);
  });

  // React StrictMode double-invokes effects in development, and next.config.ts turns it on. Two
  // initialize+prompt cycles for one mount is what better-auth's module-global guard exists to stop —
  // ours is a ref, which is per-mount rather than per-JS-context.
  it("prompts ONCE under StrictMode's double effect invocation", async () => {
    const exchange = vi.fn(async () => signedIn());
    render(
      <React.StrictMode>
        <OneTap
          clientId={CLIENT_ID}
          callbackURL="/session/handoff"
          exchange={exchange}
          navigate={vi.fn()}
        />
      </React.StrictMode>,
    );
    await waitFor(() => expect(prompt).toHaveBeenCalled());
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  // Without this the overlay can outlive the route that owns it.
  it("cancels the prompt on unmount", async () => {
    const { unmount } = render(
      <OneTap
        clientId={CLIENT_ID}
        callbackURL="/session/handoff"
        exchange={vi.fn(async () => signedIn())}
        navigate={vi.fn()}
      />,
    );
    await waitFor(() => expect(prompt).toHaveBeenCalled());
    unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("OneTap — a completed tap", () => {
  it("exchanges the credential and navigates to the returned target", async () => {
    const { exchange, navigate } = renderOneTap();
    await waitFor(() => expect(prompt).toHaveBeenCalled());

    fireCredential("id-token-abc");

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/session/handoff"));
    expect(exchange).toHaveBeenCalledWith({
      credential: "id-token-abc",
      callbackURL: "/session/handoff",
    });
  });

  it("navigates to wherever the exchange says, not to the raw callbackURL", async () => {
    const { navigate } = renderOneTap({
      exchange: vi.fn(async () => signedIn("/consent?x=1")),
    });
    await waitFor(() => expect(prompt).toHaveBeenCalled());
    fireCredential("t");
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/consent?x=1"));
  });

  it("ignores a callback with no credential", async () => {
    const { exchange } = renderOneTap();
    await waitFor(() => expect(prompt).toHaveBeenCalled());
    (initialize.mock.calls[0][0] as InitConfig).callback({});
    expect(exchange).not.toHaveBeenCalled();
  });
});

describe("OneTap — failure behaviour", () => {
  // The user actively tapped and confirmed. Silence here is the "clicking does nothing" bug.
  it("shows a danger banner when the exchange is rejected", async () => {
    const { navigate } = renderOneTap({
      exchange: vi.fn(async () => ({ status: "rejected", message: "Nope, try again." }) as const),
    });
    await waitFor(() => expect(prompt).toHaveBeenCalled());
    fireCredential("t");

    expect(await screen.findByRole("alert")).toHaveTextContent("Nope, try again.");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("renders NOTHING until something actually fails", async () => {
    const { container } = render(
      <OneTap
        clientId={CLIENT_ID}
        callbackURL="/session/handoff"
        exchange={vi.fn(async () => signedIn())}
        navigate={vi.fn()}
      />,
    );
    await waitFor(() => expect(prompt).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  // A blocked gsi/client (an extension, a strict corporate network, a Google outage) must not put an
  // error in front of a user who can still sign in three other ways on this very page.
  it("stays SILENT when the Google script cannot load", async () => {
    delete window.google;
    const { container } = render(
      <OneTap
        clientId={CLIENT_ID}
        callbackURL="/session/handoff"
        exchange={vi.fn(async () => signedIn())}
        navigate={vi.fn()}
      />,
    );

    // The component appended a <script>; simulate the network refusing it.
    const script = await waitFor(() => {
      const el = document.head.querySelector<HTMLScriptElement>(`script[src*="gsi/client"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    script.dispatchEvent(new Event("error"));

    await waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // better-auth's loader leaves the failed tag in the document and never resets its promise, so each
  // retry appends another. Ours removes it, which is what makes a later mount able to try again cleanly.
  it("removes the dead <script> when the load fails", async () => {
    delete window.google;
    render(
      <OneTap
        clientId={CLIENT_ID}
        callbackURL="/session/handoff"
        exchange={vi.fn(async () => signedIn())}
        navigate={vi.fn()}
      />,
    );
    const script = await waitFor(() => {
      const el = document.head.querySelector<HTMLScriptElement>(`script[src*="gsi/client"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    script.dispatchEvent(new Event("error"));

    await waitFor(() =>
      expect(document.head.querySelectorAll(`script[src*="gsi/client"]`).length).toBe(0),
    );
  });
});
