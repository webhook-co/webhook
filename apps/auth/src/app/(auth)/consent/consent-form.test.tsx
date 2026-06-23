import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  ConsentDecisionError,
  ConsentForm,
  flagFromCountry,
  type ConsentActions,
  type ConsentRequest,
} from "./consent-form";

/** True if the text contains a Unicode regional-indicator symbol (a flag-emoji building block). */
function hasFlagChar(text: string | null | undefined): boolean {
  for (const ch of text ?? "") {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return true;
  }
  return false;
}

function makeActions(over: Partial<ConsentActions> = {}): ConsentActions {
  return { decide: vi.fn().mockResolvedValue(undefined), ...over };
}

const baseRequest: ConsentRequest = {
  requestId: "areq_123",
  csrfToken: "csrf_abc",
  flow: "device_code",
  client: { id: "cli_wbhk", name: "webhook CLI" },
  device: { name: "Dana's MacBook Pro" },
  org: { id: "org_1", name: "Acme Inc" },
  origin: {
    ip: "203.0.113.7",
    location: "US",
    city: "San Francisco",
    region: "California",
    regionCode: "CA",
  },
  scopes: ["events:read", "events:replay"],
  audience: "https://api.webhook.co",
  grantExpiresAt: "2026-09-18T00:00:00Z",
  keyTtlSeconds: 86_400,
};

describe("ConsentForm", () => {
  it("renders the grant summary the user is consenting to", () => {
    render(<ConsentForm request={baseRequest} actions={makeActions()} />);
    // who/what is asking
    expect(screen.getByRole("heading", { name: /authorize webhook CLI/i })).toBeInTheDocument();
    expect(screen.getByText("Dana's MacBook Pro")).toBeInTheDocument();
    // the trust signals
    expect(screen.getByText(/San Francisco, US/)).toBeInTheDocument();
    expect(screen.getByText(/203\.0\.113\.7/)).toBeInTheDocument();
    expect(screen.getByText("Acme Inc")).toBeInTheDocument();
    // the requested access (summary, not a checklist)
    expect(screen.getByText("events:read")).toBeInTheDocument();
    expect(screen.getByText("events:replay")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    // the grant ceiling (Lane E renders the key TTL too at E8 — the contract now carries both)
    expect(screen.getByText(/2026-09-18/)).toBeInTheDocument();
    // both decisions are offered
    expect(screen.getByRole("button", { name: /authorize/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deny/i })).toBeInTheDocument();
  });

  it("authorizes the request", async () => {
    const actions = makeActions();
    render(<ConsentForm request={baseRequest} actions={actions} />);
    await userEvent.click(screen.getByRole("button", { name: /authorize/i }));
    expect(actions.decide).toHaveBeenCalledWith("approve");
    expect(await screen.findByRole("status")).toHaveTextContent(/authorized|all set/i);
  });

  it("denies the request", async () => {
    const actions = makeActions();
    render(<ConsentForm request={baseRequest} actions={actions} />);
    await userEvent.click(screen.getByRole("button", { name: /deny/i }));
    expect(actions.decide).toHaveBeenCalledWith("deny");
    expect(await screen.findByRole("status")).toHaveTextContent(/denied/i);
  });

  it("surfaces an error when the decision can't be recorded", async () => {
    const actions = makeActions({ decide: vi.fn().mockRejectedValue(new Error("boom")) });
    render(<ConsentForm request={baseRequest} actions={actions} />);
    await userEvent.click(screen.getByRole("button", { name: /authorize/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't record/i);
    // the decision is still actionable
    expect(screen.getByRole("button", { name: /authorize/i })).toBeEnabled();
  });

  it("shows consent even for a loopback PKCE request (deliberate-grant model)", () => {
    const loopback: ConsentRequest = {
      ...baseRequest,
      flow: "pkce_loopback",
      device: undefined,
    };
    render(<ConsentForm request={loopback} actions={makeActions()} />);
    expect(screen.getByText("events:read")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /authorize/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deny/i })).toBeInTheDocument();
  });

  it("shows the app name once in the App row when there's no device (no duplicate)", () => {
    const loopback: ConsentRequest = { ...baseRequest, flow: "pkce_loopback", device: undefined };
    render(<ConsentForm request={loopback} actions={makeActions()} />);
    // the subject IS the client here, so a "· {client}" suffix would render "webhook CLI · webhook CLI"
    const appRow = screen.getByText("App").parentElement?.querySelector("dd");
    expect(appRow?.textContent?.trim()).toBe("webhook CLI");
  });

  it("keeps 'device · app' in the Device row (the app suffix is meaningful when they differ)", () => {
    render(<ConsentForm request={baseRequest} actions={makeActions()} />);
    const deviceRow = screen.getByText("Device").parentElement?.querySelector("dd");
    expect(deviceRow?.textContent).toContain("Dana's MacBook Pro");
    expect(deviceRow?.textContent).toContain("webhook CLI");
  });

  it("renders the origin as place + country flag, with the IP on its own line", () => {
    const { container } = render(<ConsentForm request={baseRequest} actions={makeActions()} />);
    // "San Francisco, US" with the flag derived from the 2-letter country
    expect(hasFlagChar(screen.getByText(/San Francisco, US/).textContent)).toBe(true);
    expect(hasFlagChar(container.textContent)).toBe(true);
    // the flag is decorative (the 2-letter country carries the info) → hidden from assistive tech
    const decorative = [...container.querySelectorAll('[aria-hidden="true"]')];
    expect(decorative.some((el) => hasFlagChar(el.textContent))).toBe(true);
    // the IP is its own element, not concatenated onto the location
    const ip = screen.getByText("203.0.113.7");
    expect(ip.textContent).toBe("203.0.113.7");
  });

  it("renders the country + flag when only the country is known", () => {
    const req: ConsentRequest = {
      ...baseRequest,
      origin: { ip: "2001:db8::1", location: "PT", city: null, region: null, regionCode: null },
    };
    const { container } = render(<ConsentForm request={req} actions={makeActions()} />);
    expect(hasFlagChar(screen.getByText(/\bPT\b/).textContent)).toBe(true);
    expect(hasFlagChar(container.textContent)).toBe(true);
    expect(screen.getByText("2001:db8::1")).toBeInTheDocument();
  });

  it("guards a fully unknown origin — renders just the IP, no place line or flag", () => {
    const req: ConsentRequest = {
      ...baseRequest,
      origin: { ip: "198.51.100.9", location: null },
    };
    const { container } = render(<ConsentForm request={req} actions={makeActions()} />);
    expect(screen.getByText("198.51.100.9")).toBeInTheDocument();
    expect(hasFlagChar(container.textContent)).toBe(false);
  });

  it("renders a friendly 'already completed' terminal on a 409 (not a generic error)", async () => {
    const actions = makeActions({
      decide: vi.fn().mockRejectedValue(new ConsentDecisionError("already_decided")),
    });
    render(<ConsentForm request={baseRequest} actions={actions} />);
    await userEvent.click(screen.getByRole("button", { name: /authorize/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/already (completed|handled)/i);
    // it is a terminal, not the retryable error path
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /authorize/i })).not.toBeInTheDocument();
  });

  it("renders an 'expired' terminal on a 400 (stale request)", async () => {
    const actions = makeActions({
      decide: vi.fn().mockRejectedValue(new ConsentDecisionError("expired")),
    });
    render(<ConsentForm request={baseRequest} actions={actions} />);
    await userEvent.click(screen.getByRole("button", { name: /deny/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/expired/i);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("flagFromCountry", () => {
  it("derives the regional-indicator flag from a 2-letter code (case-insensitive)", () => {
    expect(flagFromCountry("PT")).toBe(String.fromCodePoint(0x1f1f5, 0x1f1f9)); // 🇵🇹
    expect(flagFromCountry("us")).toBe(String.fromCodePoint(0x1f1fa, 0x1f1f8)); // 🇺🇸
  });

  it("returns an empty string for anything that isn't exactly two letters", () => {
    expect(flagFromCountry(null)).toBe("");
    expect(flagFromCountry(undefined)).toBe("");
    expect(flagFromCountry("")).toBe("");
    expect(flagFromCountry("USA")).toBe("");
    expect(flagFromCountry("U1")).toBe("");
    expect(flagFromCountry("1")).toBe("");
  });
});
