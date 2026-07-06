import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DedupConfig } from "@webhook-co/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EndpointDedupManager } from "./endpoint-dedup-manager";

const ENDPOINT = "11111111-1111-1111-1111-111111111111";

let update: ReturnType<typeof vi.fn>;

beforeEach(() => {
  update = vi.fn();
});

function renderManager(initial: DedupConfig | null = null) {
  return render(<EndpointDedupManager endpointId={ENDPOINT} initial={initial} update={update} />);
}

// Open the mode combobox and pick an option by its user-facing label.
async function pickMode(user: ReturnType<typeof userEvent.setup>, optionLabel: RegExp) {
  await user.click(screen.getByRole("button", { name: /deduplication mode:/i }));
  await user.click(screen.getByRole("option", { name: optionLabel }));
}

describe("EndpointDedupManager", () => {
  it("renders the current mode from the stored config", () => {
    renderManager({ mode: "content", windowSeconds: 3600 });
    expect(screen.getByRole("button", { name: /deduplication mode: match on full content/i }));
    // The window is shown for a non-off mode, seeded from the stored value.
    expect(screen.getByLabelText(/deduplication window/i)).toHaveValue(3600);
  });

  it("defaults a null config to the automatic mode with the 24h window", () => {
    renderManager(null);
    expect(screen.getByRole("button", { name: /deduplication mode: automatic/i }));
    expect(screen.getByLabelText(/deduplication window/i)).toHaveValue(86400);
  });

  it("shows the billing warning and hides the window when switched to off", async () => {
    const user = userEvent.setup();
    renderManager(null);
    expect(screen.getByLabelText(/deduplication window/i)).toBeInTheDocument();

    await pickMode(user, /off — record every request/i);

    expect(screen.getByText(/counts toward usage/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/deduplication window/i)).not.toBeInTheDocument();
  });

  it("shows the fields editor only in fields mode", async () => {
    const user = userEvent.setup();
    renderManager(null);
    expect(screen.queryByLabelText(/^include fields/i)).not.toBeInTheDocument();

    await pickMode(user, /match on specific fields/i);
    expect(screen.getByLabelText(/^include fields/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^exclude fields/i)).toBeInTheDocument();
  });

  it("adds and removes an include path as a chip", async () => {
    const user = userEvent.setup();
    renderManager({ mode: "fields", windowSeconds: 3600, fields: { include: ["body.id"] } });

    // The seeded path is shown as a chip.
    expect(screen.getByText("body.id")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^include fields/i), "body.data.id");
    await user.click(screen.getByRole("button", { name: /add include fields/i }));
    // Scope to the chip list — "body.data.id" also appears in the path-syntax hint.
    const chips = screen.getByRole("list", { name: /chosen include paths/i });
    expect(within(chips).getByText("body.data.id")).toBeInTheDocument();

    // Remove the newly-added chip via its keyboard-focusable × button.
    await user.click(screen.getByRole("button", { name: /remove body\.data\.id/i }));
    expect(within(chips).queryByText("body.data.id")).not.toBeInTheDocument();
  });

  it("rejects an invalid field path inline without adding it", async () => {
    const user = userEvent.setup();
    renderManager({ mode: "fields", windowSeconds: 3600, fields: { include: ["body.id"] } });

    await user.type(screen.getByLabelText(/^include fields/i), "notaroot.value");
    await user.click(screen.getByRole("button", { name: /add include fields/i }));

    expect(screen.getByText(/isn't a valid field path/i)).toBeInTheDocument();
    expect(screen.queryByText("notaroot.value")).not.toBeInTheDocument();
  });

  it("disables Save when nothing has changed and enables it after an edit", async () => {
    const user = userEvent.setup();
    renderManager({ mode: "content", windowSeconds: 3600 });
    const save = screen.getByRole("button", { name: /save changes/i });
    expect(save).toBeDisabled();

    await user.clear(screen.getByLabelText(/deduplication window/i));
    await user.type(screen.getByLabelText(/deduplication window/i), "120");
    expect(save).toBeEnabled();
  });

  it("saves the assembled config for the chosen mode", async () => {
    const user = userEvent.setup();
    update.mockResolvedValue({ ok: true, dedupConfig: { mode: "content", windowSeconds: 120 } });
    renderManager(null);

    await pickMode(user, /match on full content/i);
    await user.clear(screen.getByLabelText(/deduplication window/i));
    await user.type(screen.getByLabelText(/deduplication window/i), "120");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(update).toHaveBeenCalledWith({
      endpointId: ENDPOINT,
      dedupConfig: { mode: "content", windowSeconds: 120 },
    });
    // A subtle inline success affordance (no toast).
    await waitFor(() => expect(screen.getByText(/^saved\.$/i)).toBeInTheDocument());
  });

  it("assembles a fields config with include + exclude lists", async () => {
    const user = userEvent.setup();
    update.mockResolvedValue({
      ok: true,
      dedupConfig: {
        mode: "fields",
        windowSeconds: 3600,
        fields: { include: ["body.id"], exclude: ["body.sent_at"] },
      },
    });
    renderManager({ mode: "fields", windowSeconds: 3600, fields: { include: ["body.id"] } });

    await user.type(screen.getByLabelText(/^exclude fields/i), "body.sent_at");
    await user.click(screen.getByRole("button", { name: /add exclude fields/i }));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(update).toHaveBeenCalledWith({
      endpointId: ENDPOINT,
      dedupConfig: {
        mode: "fields",
        windowSeconds: 3600,
        fields: { include: ["body.id"], exclude: ["body.sent_at"] },
      },
    });
  });

  it("renders a danger banner when the save fails", async () => {
    const user = userEvent.setup();
    update.mockResolvedValue({ ok: false, error: "That deduplication config isn't valid." });
    renderManager(null);

    await pickMode(user, /match on full content/i);
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(screen.getByText(/deduplication config isn't valid/i)).toBeInTheDocument(),
    );
  });

  it("shows a range error and disables Save for an out-of-range window (never silently clamps)", async () => {
    const user = userEvent.setup();
    renderManager({ mode: "content", windowSeconds: 3600 });
    const window = screen.getByLabelText(/deduplication window/i);
    await user.clear(window);
    await user.type(window, "10"); // below the 60s minimum

    expect(screen.getByText(/between 60 and 604800/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save changes/i })).toBeDisabled();
  });

  it("keeps an unsaved draft when the page revalidates with a new but equal `initial` object", async () => {
    const user = userEvent.setup();
    // Force-dynamic hands down a fresh object with the SAME value on any sibling revalidation.
    const initialA: DedupConfig = { mode: "content", windowSeconds: 3600 };
    const { rerender } = render(
      <EndpointDedupManager endpointId={ENDPOINT} initial={initialA} update={update} />,
    );
    await user.clear(screen.getByLabelText(/deduplication window/i));
    await user.type(screen.getByLabelText(/deduplication window/i), "120");

    // A NEW object, equal in value (what revalidatePath delivers) — must NOT wipe the unsaved edit.
    rerender(
      <EndpointDedupManager
        endpointId={ENDPOINT}
        initial={{ mode: "content", windowSeconds: 3600 }}
        update={update}
      />,
    );
    expect(screen.getByLabelText(/deduplication window/i)).toHaveValue(120);
    expect(screen.getByRole("button", { name: /save changes/i })).toBeEnabled();
  });

  it("keeps the Saved. confirmation when the post-save revalidation echoes the saved config", async () => {
    const user = userEvent.setup();
    update.mockResolvedValue({ ok: true, dedupConfig: { mode: "content", windowSeconds: 120 } });
    const { rerender } = render(
      <EndpointDedupManager endpointId={ENDPOINT} initial={null} update={update} />,
    );
    await pickMode(user, /match on full content/i);
    await user.clear(screen.getByLabelText(/deduplication window/i));
    await user.type(screen.getByLabelText(/deduplication window/i), "120");
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(screen.getByText(/^saved\.$/i)).toBeInTheDocument());

    // revalidatePath now re-renders with the just-saved value as a fresh object — "Saved." must persist.
    rerender(
      <EndpointDedupManager
        endpointId={ENDPOINT}
        initial={{ mode: "content", windowSeconds: 120 }}
        update={update}
      />,
    );
    expect(screen.getByText(/^saved\.$/i)).toBeInTheDocument();
  });

  it("fires the update action only once on a double-click", async () => {
    const user = userEvent.setup();
    let resolve: (() => void) | undefined;
    update.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = () => r({ ok: true, dedupConfig: { mode: "content", windowSeconds: 3600 } });
        }),
    );
    renderManager(null);

    await pickMode(user, /match on full content/i);
    await user.dblClick(screen.getByRole("button", { name: /save changes/i }));
    expect(update).toHaveBeenCalledTimes(1);

    resolve?.();
    await waitFor(() => expect(screen.getByText(/^saved\.$/i)).toBeInTheDocument());
  });
});
