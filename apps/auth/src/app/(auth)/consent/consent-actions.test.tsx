import type { ConsentRequest } from "@webhook-co/contract";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConsentActionsClient } from "./consent-actions";

const request: ConsentRequest = {
  requestId: "tkt_abc",
  csrfToken: "csrf_xyz",
  flow: "pkce_loopback",
  client: { id: "cli", name: "webhook CLI" },
  org: { id: "org", name: "Acme Inc" },
  origin: { ip: "203.0.113.7", location: "San Francisco, US" },
  scopes: ["events:read"],
  audience: "https://api.webhook.co",
  grantExpiresAt: "2026-09-18T00:00:00Z",
  keyTtlSeconds: 86_400,
};

describe("ConsentActionsClient", () => {
  it("renders the consent form for the resolved request", () => {
    render(<ConsentActionsClient request={request} />);
    expect(screen.getByRole("heading", { name: /authorize webhook CLI/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /authorize/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deny/i })).toBeInTheDocument();
  });
});
