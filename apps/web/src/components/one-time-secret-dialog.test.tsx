import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OneTimeSecretDialog } from "./one-time-secret-dialog";

// A deterministic, obviously-fake fixture — not a real credential. gitleaks:allow
const SECRET = "whsec_this_is_a_test_fixture_not_real";

describe("OneTimeSecretDialog", () => {
  it("renders the secret + a copy button when open with a secret", () => {
    render(
      <OneTimeSecretDialog
        open
        onClose={vi.fn()}
        title="Copy your signing secret"
        description="Sign deliveries to this destination with this secret."
        secret={SECRET}
      />,
    );
    expect(screen.getByText("Copy your signing secret")).toBeInTheDocument();
    expect(screen.getByText(/only time you'll see this signing secret/i)).toBeInTheDocument();
    expect(screen.getByText(SECRET)).toBeInTheDocument();
    // The reveal is copyable (mirrors the API-key / ingest-URL reveal).
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(
      <OneTimeSecretDialog
        open={false}
        onClose={vi.fn()}
        title="Copy your signing secret"
        secret={SECRET}
      />,
    );
    // A closed Radix dialog isn't in the DOM — neither the title, the warning, nor the secret is present.
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(screen.queryByText(/only time you'll see this signing secret/i)).not.toBeInTheDocument();
  });

  it("does not render the secret when open but the secret is null", () => {
    render(
      <OneTimeSecretDialog open onClose={vi.fn()} title="Copy your signing secret" secret={null} />,
    );
    // The dialog frame is open (the warning shows) but there's no secret to display or copy.
    expect(screen.getByText(/only time you'll see this signing secret/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
  });
});
