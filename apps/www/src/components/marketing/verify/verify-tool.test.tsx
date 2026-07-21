import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VerifyTool } from "./verify-tool";

describe("VerifyTool — rendering + XSS-inert (the render half of the secret-safe design)", () => {
  it("renders the provider selector and the core inputs", () => {
    render(<VerifyTool initialProvider="github" />);
    expect(screen.getByLabelText(/provider/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /verify signature/i })).toBeTruthy();
    // The signature field is labelled with the provider's actual header.
    expect(screen.getByText(/x-hub-signature-256/i)).toBeTruthy();
  });

  it("switching providers relabels the signature header (recipe-driven)", () => {
    render(<VerifyTool initialProvider="github" />);
    fireEvent.change(screen.getByLabelText(/provider/i), { target: { value: "shopify" } });
    expect(screen.getByText(/x-shopify-hmac-sha256/i)).toBeTruthy();
  });

  it("a sig-in-body provider (adyen) hides the signature header field", () => {
    render(<VerifyTool initialProvider="adyen" />);
    expect(screen.getByText(/carries the signature inside the request body/i)).toBeTruthy();
  });

  it("renders an attacker-controlled payload as INERT text — no HTML injection", () => {
    const { container } = render(<VerifyTool initialProvider="github" />);
    const xss = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>`;
    const payload = screen.getByPlaceholderText("{ … }") as HTMLTextAreaElement;
    fireEvent.change(payload, { target: { value: xss } });
    const sig = screen.getByPlaceholderText(/sha256=/i) as HTMLInputElement;
    fireEvent.change(sig, { target: { value: xss } });
    // The dangerous bytes live only as controlled input VALUES — never parsed into DOM elements.
    expect(payload.value).toBe(xss);
    expect(container.querySelector("img[onerror]")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    // and nothing executed
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("keygen surfaces the draft-cavage signed headers (host/date) it cannot verify without", () => {
    render(<VerifyTool initialProvider="keygen" />);
    // Without an input for these, a correctly-signed keygen request fails MALFORMED_SIGNATURE forever.
    const headers = screen.getByLabelText(/other signed headers/i);
    expect(headers).toBeTruthy();
    expect(screen.getByText("host")).toBeTruthy();
    expect(screen.getByText("date")).toBeTruthy();
  });

  it("plivo surfaces its nonce header (without it, MISSING_HEADER is unavoidable)", () => {
    render(<VerifyTool initialProvider="plivo" />);
    expect(screen.getByLabelText(/other signed headers/i)).toBeTruthy();
    expect(screen.getByText("x-plivo-signature-v3-nonce")).toBeTruthy();
  });

  it("a sig-field timestamp provider (stripe) does NOT ask for a timestamp header", () => {
    const { container } = render(<VerifyTool initialProvider="stripe" />);
    // Stripe's timestamp rides in the signature value (`t=`), so telling the user to paste a
    // "timestamp header" sends them looking for a header that does not exist.
    expect(container.textContent).not.toMatch(/the timestamp header/i);
  });

  it("a header-timestamp provider (slack) names the actual timestamp header", () => {
    render(<VerifyTool initialProvider="slack" />);
    expect(screen.getByText("x-slack-request-timestamp")).toBeTruthy();
  });

  it("the secret field does not persist or autofill (autocomplete off, password-manager-ignored)", () => {
    render(<VerifyTool initialProvider="github" />);
    const secret = screen.getByPlaceholderText(/whsec_/i) as HTMLInputElement;
    expect(secret.getAttribute("autocomplete")).toBe("off");
    expect(secret.getAttribute("data-1p-ignore")).toBe("true");
    expect(secret.getAttribute("data-lpignore")).toBe("true");
    expect(secret.type).toBe("password"); // masked by default
  });
});
