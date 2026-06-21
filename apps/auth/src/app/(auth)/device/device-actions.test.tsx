import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DeviceActionsClient } from "./device-actions";

describe("DeviceActionsClient", () => {
  it("renders the device code-entry form with the live action wired", () => {
    render(<DeviceActionsClient />);
    expect(screen.getByLabelText(/device code/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue/i })).toBeInTheDocument();
  });
});
