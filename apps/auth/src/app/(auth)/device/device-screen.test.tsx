import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DeviceScreen, firstParam } from "./device-screen";

describe("firstParam", () => {
  it("passes a string through, takes the first of a repeated (array) param, and handles none", () => {
    // Next yields string[] for a repeated query (?user_code=a&user_code=b) — guard so it can't reach
    // normalizeCode's raw.toUpperCase() and crash the render.
    expect(firstParam("YYM9-6SN5")).toBe("YYM9-6SN5");
    expect(firstParam(["AAAA-AAAA", "BBBB-BBBB"])).toBe("AAAA-AAAA");
    expect(firstParam(undefined)).toBeUndefined();
  });
});

// DeviceScreen is the body the device page renders inside AuthShell: the terminal panel when the issuer
// sent the user back with ?status=approved|denied (the consent flow's window.location.assign lands HERE,
// so this is the terminal screen the user ends on), else the code-entry form (pre-filled from ?user_code).
describe("DeviceScreen", () => {
  it("renders the APPROVED terminal panel (role=status), not the form, for status=approved", () => {
    render(<DeviceScreen status="approved" />);
    expect(screen.getByRole("status")).toHaveTextContent(/device connected/i);
    expect(screen.queryByLabelText(/device code/i)).not.toBeInTheDocument();
  });

  it("renders the DENIED terminal panel for status=denied (the issuer emits this too)", () => {
    render(<DeviceScreen status="denied" />);
    expect(screen.getByRole("status")).toHaveTextContent(/request denied/i);
    expect(screen.queryByLabelText(/device code/i)).not.toBeInTheDocument();
  });

  it("renders the code-entry form when there is no status", () => {
    render(<DeviceScreen />);
    expect(screen.getByLabelText(/device code/i)).toBeInTheDocument();
  });

  it("pre-fills the form from userCode when there is no status", () => {
    render(<DeviceScreen userCode="YYM9-6SN5" />);
    expect(screen.getByLabelText(/device code/i)).toHaveValue("YYM9-6SN5");
  });

  it("lets status WIN over userCode (terminal, never the pre-filled form)", () => {
    render(<DeviceScreen status="approved" userCode="YYM9-6SN5" />);
    expect(screen.getByRole("status")).toHaveTextContent(/device connected/i);
    expect(screen.queryByLabelText(/device code/i)).not.toBeInTheDocument();
  });

  it("falls through to the form for an unrecognized status value", () => {
    render(<DeviceScreen status="bogus" />);
    expect(screen.getByLabelText(/device code/i)).toBeInTheDocument();
  });
});
