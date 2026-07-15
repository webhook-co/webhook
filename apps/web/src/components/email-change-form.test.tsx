import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { EmailChangeForm } from "./email-change-form";

const start = vi.fn();
const commit = vi.fn();

function renderForm() {
  return render(<EmailChangeForm currentEmail="old@e.test" start={start} commit={commit} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  start.mockResolvedValue({ ok: true });
  commit.mockResolvedValue({ ok: true, oldEmail: "old@e.test", newEmail: "new@e.test" });
});
afterEach(cleanup);

describe("EmailChangeForm", () => {
  it("step 1 → step 2: sends a code to the CURRENT email, then asks for the code", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/new email/i), { target: { value: "new@e.test" } });
    fireEvent.click(screen.getByRole("button", { name: /send code/i }));

    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    // FormData carried the new address.
    expect((start.mock.calls[0][0] as FormData).get("email")).toBe("new@e.test");
    // Now on the code step, which names the CURRENT address as where the code went.
    expect(await screen.findByLabelText(/verification code/i)).toBeInTheDocument();
    expect(screen.getByText(/old@e\.test/)).toBeInTheDocument();
  });

  it("surfaces a start error (e.g. taken) and stays on step 1", async () => {
    start.mockResolvedValue({ ok: false, error: "That email is already in use.", reason: "taken" });
    renderForm();
    fireEvent.change(screen.getByLabelText(/new email/i), { target: { value: "taken@e.test" } });
    fireEvent.click(screen.getByRole("button", { name: /send code/i }));

    expect(await screen.findByText(/already in use/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/verification code/i)).toBeNull();
  });

  it("commits with the entered code and shows the signed-out-of-other-sessions confirmation", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/new email/i), { target: { value: "new@e.test" } });
    fireEvent.click(screen.getByRole("button", { name: /send code/i }));
    const codeInput = await screen.findByLabelText(/verification code/i);
    fireEvent.change(codeInput, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm change/i }));

    await waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect((commit.mock.calls[0][0] as FormData).get("code")).toBe("123456");
    expect(await screen.findByText(/your email is now/i)).toBeInTheDocument();
    expect(screen.getByText(/revoked your other sign-ins/i)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("only allows digits in the code field (strips junk, caps at 6)", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/new email/i), { target: { value: "new@e.test" } });
    fireEvent.click(screen.getByRole("button", { name: /send code/i }));
    const codeInput = (await screen.findByLabelText(/verification code/i)) as HTMLInputElement;
    fireEvent.change(codeInput, { target: { value: "1a2b3c4d5e6f7" } });
    expect(codeInput.value).toBe("123456");
  });

  it("an expired/locked commit kicks back to step 1", async () => {
    commit.mockResolvedValue({
      ok: false,
      error: "That code expired. Start again.",
      reason: "expired",
    });
    renderForm();
    fireEvent.change(screen.getByLabelText(/new email/i), { target: { value: "new@e.test" } });
    fireEvent.click(screen.getByRole("button", { name: /send code/i }));
    fireEvent.change(await screen.findByLabelText(/verification code/i), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm change/i }));

    expect(await screen.findByText(/expired/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/new email/i)).toBeInTheDocument()); // back to step 1
  });
});
