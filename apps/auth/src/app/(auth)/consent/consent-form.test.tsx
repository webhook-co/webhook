import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConsentForm, type ConsentActions, type ConsentRequest } from "./consent-form";

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
  origin: { ip: "203.0.113.7", location: "San Francisco, US" },
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
});
