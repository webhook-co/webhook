import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  ConsentDecisionError,
  ConsentForm,
  flagFromCountry,
  fmtDuration,
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
  client: { id: "cli_wbhk", name: "webhook CLI", identityDomain: null, verified: false },
  redirect: { host: null, isLoopback: false },
  device: { name: "Dana's MacBook Pro" },
  org: { id: "org_1", name: "Acme Inc" },
  orgOptions: [{ id: "org_1", name: "Acme Inc" }],
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
    // both durations: the grant ceiling (~90d date) AND the per-key TTL (~24h)
    expect(screen.getByText(/2026-09-18/)).toBeInTheDocument();
    expect(screen.getByText("Key lifetime")).toBeInTheDocument();
    expect(screen.getByText("24 hours")).toBeInTheDocument();
    // both decisions are offered
    expect(screen.getByRole("button", { name: /authorize/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deny/i })).toBeInTheDocument();
  });

  it("authorizes the request", async () => {
    const actions = makeActions();
    render(<ConsentForm request={baseRequest} actions={actions} />);
    await userEvent.click(screen.getByRole("button", { name: /authorize/i }));
    expect(actions.decide).toHaveBeenCalledWith("approve", "org_1");
    expect(await screen.findByRole("status")).toHaveTextContent(/authorized|all set/i);
  });

  it("denies the request", async () => {
    const actions = makeActions();
    render(<ConsentForm request={baseRequest} actions={actions} />);
    await userEvent.click(screen.getByRole("button", { name: /deny/i }));
    expect(actions.decide).toHaveBeenCalledWith("deny", "org_1");
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
    // the name appears exactly once (a trust badge follows it, but the name isn't duplicated)
    const occurrences = appRow?.textContent?.match(/webhook CLI/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("warns and makes Cancel dominant for a remote UNVERIFIED client (origin-honest, anti-phishing)", () => {
    const remote: ConsentRequest = {
      ...baseRequest,
      flow: "pkce_loopback",
      device: undefined,
      client: {
        id: "https://acme.dev/c.json",
        name: "Acme",
        identityDomain: "acme.dev",
        verified: false,
      },
      redirect: { host: "acme.dev", isLoopback: false },
    };
    render(<ConsentForm request={remote} actions={makeActions()} />);
    // an "unverified app" warning naming the un-spoofable identity domain
    expect(screen.getByText(/unverified app/i)).toBeInTheDocument();
    expect(screen.getAllByText(/acme\.dev/).length).toBeGreaterThan(0);
    // the redirect host is shown (MCP spec MUST)
    expect(screen.getByText("Sends code to")).toBeInTheDocument();
    // the safe action is the primary button — labelled Cancel, not Deny
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^deny$/i })).toBeNull();
  });

  it("shows a verified indicator and the usual Deny for a vetted client, no warning", () => {
    const verified: ConsentRequest = {
      ...baseRequest,
      flow: "pkce_loopback",
      device: undefined,
      client: {
        id: "https://claude.ai/oauth/claude-code-client-metadata",
        name: "Claude Code",
        identityDomain: "claude.ai",
        verified: true,
      },
      redirect: { host: "127.0.0.1", isLoopback: true },
    };
    render(<ConsentForm request={verified} actions={makeActions()} />);
    expect(screen.getByText(/verified/i)).toBeInTheDocument();
    expect(screen.queryByText(/unverified app/i)).toBeNull();
    expect(screen.getByRole("button", { name: /deny/i })).toBeInTheDocument();
  });

  it("never shows the unverified warning for a device flow (no redirect host)", () => {
    render(<ConsentForm request={baseRequest} actions={makeActions()} />);
    expect(screen.queryByText(/unverified app/i)).toBeNull();
    expect(screen.getByRole("button", { name: /deny/i })).toBeInTheDocument();
  });

  it("shows the vetted vendor host as Identity for a DCR-verified client with no CIMD domain", () => {
    // Claude Desktop registers via DCR (opaque client_id, no CIMD url) with an https://claude.ai redirect.
    // It's verified via the redirect host, so the Identity row must show that host — never "no verified
    // domain" alongside a ✓ verified badge (the contradiction N1 guards against).
    const dcrVerified: ConsentRequest = {
      ...baseRequest,
      flow: "pkce_loopback",
      device: undefined,
      client: { id: "dcr_opaque", name: "Claude", identityDomain: null, verified: true },
      redirect: { host: "claude.ai", isLoopback: false },
    };
    render(<ConsentForm request={dcrVerified} actions={makeActions()} />);
    expect(screen.queryByText(/no verified domain/i)).toBeNull();
    const identityRow = screen.getByText("Identity").parentElement?.querySelector("dd");
    expect(identityRow?.textContent).toContain("claude.ai");
    expect(screen.queryByText(/unverified app/i)).toBeNull();
  });

  it("shows the 'runs on your computer' note for a loopback redirect", () => {
    const loopback: ConsentRequest = {
      ...baseRequest,
      flow: "pkce_loopback",
      device: undefined,
      redirect: { host: "localhost", isLoopback: true },
    };
    render(<ConsentForm request={loopback} actions={makeActions()} />);
    expect(screen.getByText(/runs on your computer/i)).toBeInTheDocument();
    // loopback carries no cross-origin phishing surface → no scary "unverified app" banner
    expect(screen.queryByText(/unverified app/i)).toBeNull();
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

describe("fmtDuration", () => {
  it("formats a TTL in the largest clean unit, pluralized (days only at ≥2d)", () => {
    expect(fmtDuration(86_400)).toBe("24 hours");
    expect(fmtDuration(172_800)).toBe("2 days");
    expect(fmtDuration(3_600)).toBe("1 hour");
    expect(fmtDuration(1_800)).toBe("30 minutes");
    expect(fmtDuration(60)).toBe("1 minute");
    expect(fmtDuration(90)).toBe("90 seconds");
  });
});

// ---- org selection (Lane 2.4b) --------------------------------------------------------------------
// An app authorized on this screen gets access to ONE org's data. When the user belongs to more than one
// (i.e. they were invited to a team), the choice has to be here — not derived behind their back, which is
// how a teammate's CLI used to end up in their own empty personal org.

const twoOrgs = {
  ...baseRequest,
  org: { id: "org_1", name: "Acme Inc" },
  orgOptions: [
    { id: "org_1", name: "Acme Inc" },
    { id: "org_2", name: "Beta Team" },
  ],
};

describe("ConsentForm — organization", () => {
  it("renders the org as plain text when there is nothing to choose", () => {
    render(<ConsentForm request={baseRequest} actions={makeActions()} />);
    expect(screen.getByText("Acme Inc")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("offers a picker when the user belongs to several orgs, defaulting to the ticket's default", () => {
    render(<ConsentForm request={twoOrgs} actions={makeActions()} />);
    const select = screen.getByRole("combobox");
    expect(select).toHaveValue("org_1"); // the default (their personal org)
    expect(screen.getByRole("option", { name: "Beta Team" })).toBeInTheDocument();
  });

  it("authorizes for the org the user PICKED, not the default", async () => {
    const user = userEvent.setup();
    const actions = makeActions();
    render(<ConsentForm request={twoOrgs} actions={actions} />);

    await user.selectOptions(screen.getByRole("combobox"), "org_2");
    await user.click(screen.getByRole("button", { name: /authorize/i }));

    await waitFor(() => expect(actions.decide).toHaveBeenCalledWith("approve", "org_2"));
  });
});
