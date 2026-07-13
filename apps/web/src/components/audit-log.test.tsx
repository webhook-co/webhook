import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AuditResult } from "@/server/audit";
import type { LoadMoreAuditResult, VerifyChainResult } from "@/server/audit-actions";

import { AuditLog } from "./audit-log";

const ITEMS = [
  {
    seq: 2,
    action: "endpoint.dedup_config_updated",
    target: "ep_1",
    actor: "You",
    createdAt: "2026-07-12T10:00:00.000Z",
  },
  {
    seq: 1,
    action: "endpoint.created",
    target: "ep_1",
    actor: "An API key",
    createdAt: "2026-07-12T09:00:00.000Z",
  },
];

const ok: AuditResult = { status: "ok", items: ITEMS, nextSeq: 1 };

function renderLog(
  initial: AuditResult = ok,
  over: {
    loadMore?: (fd: FormData) => Promise<LoadMoreAuditResult>;
    verifyChain?: () => Promise<VerifyChainResult>;
  } = {},
) {
  return render(
    <AuditLog
      initial={initial}
      loadMore={over.loadMore ?? vi.fn()}
      verifyChain={over.verifyChain ?? vi.fn()}
    />,
  );
}

describe("AuditLog", () => {
  it("renders entries with a readable action and who did it", () => {
    renderLog();
    expect(screen.getByText("dedup config updated")).toBeInTheDocument();
    expect(screen.getByText(/You/)).toBeInTheDocument();
    expect(screen.getByText(/An API key/)).toBeInTheDocument();
  });

  it("says the chain is INTACT when it verifies", async () => {
    const user = userEvent.setup();
    const verifyChain = vi.fn(async () => ({
      status: "ok" as const,
      verification: { ok: true as const, rowsVerified: 12 },
    }));
    renderLog(ok, { verifyChain });

    await user.click(screen.getByRole("button", { name: /verify chain/i }));
    // "12 entries recomputed" — the count matters: it's the evidence the check actually ran.
    expect(await screen.findByText(/chain intact.*12 entries recomputed/i)).toBeInTheDocument();
  });

  it("does NOT soften a BROKEN chain — it names the entry and says the record was altered", async () => {
    // The whole point of a tamper-evident log. A vague "something went wrong" here would be worse than
    // useless: it's the one moment the product has to be blunt.
    const user = userEvent.setup();
    const verifyChain = vi.fn(async () => ({
      status: "ok" as const,
      verification: {
        ok: false as const,
        rowsVerified: 3,
        break: {
          kind: "hash_mismatch" as const,
          seq: 4,
          detail: "row 4 does not recompute to its stored hash",
        },
      },
    }));
    renderLog(ok, { verifyChain });

    await user.click(screen.getByRole("button", { name: /verify chain/i }));
    expect(await screen.findByText(/broken at entry #4/i)).toBeInTheDocument();
    expect(screen.getByText(/does not recompute/i)).toBeInTheDocument(); // the operator detail, verbatim
    expect(screen.getByText(/record was altered/i)).toBeInTheDocument();
  });

  it("pages with the seq keyset and appends the next page", async () => {
    const user = userEvent.setup();
    const loadMore = vi.fn(async () => ({
      status: "ok" as const,
      result: {
        status: "ok" as const,
        items: [
          {
            seq: 0,
            action: "org.deleted",
            target: null,
            actor: "System",
            createdAt: "2026-07-11T09:00:00.000Z",
          },
        ],
        nextSeq: null,
      },
    }));
    renderLog(ok, { loadMore });

    await user.click(screen.getByRole("button", { name: /load more/i }));

    await waitFor(() => expect(loadMore).toHaveBeenCalledTimes(1));
    expect((loadMore.mock.calls[0][0] as FormData).get("afterSeq")).toBe("1");
    expect(await screen.findByText("deleted")).toBeInTheDocument();
    // Chain exhausted → no more button.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument(),
    );
  });

  it("renders an error state when the initial load failed", () => {
    renderLog({ status: "error" });
    expect(screen.getByText(/couldn't load the audit log/i)).toBeInTheDocument();
  });
});
