import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AuditResult, AuthAuditResult } from "@/server/audit";
import type {
  LoadMoreAuditResult,
  LoadMoreAuthAuditResult,
  VerifyChainResult,
} from "@/server/audit-actions";

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

const AUTH_ITEMS = [
  {
    seq: 2,
    eventType: "member_role_changed",
    actor: "u_me",
    targetId: "u_bob",
    metadata: { from: "member", to: "admin" },
    createdAt: "2026-07-12T11:00:00.000Z",
  },
  {
    seq: 1,
    eventType: "invite_created",
    actor: "u_other",
    targetId: "inv_1",
    metadata: { role: "member" },
    createdAt: "2026-07-12T08:00:00.000Z",
  },
];
const authOk: AuthAuditResult = { status: "ok", items: AUTH_ITEMS, nextSeq: null };

function renderLog(
  initial: AuditResult = ok,
  over: {
    loadMore?: (fd: FormData) => Promise<LoadMoreAuditResult>;
    verifyChain?: () => Promise<VerifyChainResult>;
    initialAuth?: AuthAuditResult;
    loadMoreAuth?: (fd: FormData) => Promise<LoadMoreAuthAuditResult>;
    verifyAuthChain?: () => Promise<VerifyChainResult>;
  } = {},
) {
  return render(
    <AuditLog
      initial={initial}
      loadMore={over.loadMore ?? vi.fn()}
      verifyChain={over.verifyChain ?? vi.fn()}
      initialAuth={over.initialAuth ?? authOk}
      loadMoreAuth={over.loadMoreAuth ?? vi.fn()}
      verifyAuthChain={over.verifyAuthChain ?? vi.fn()}
      currentUserId="u_me"
    />,
  );
}

/** The "Changes" (audit_log) tab is not the default — governance is. */
async function openChangesTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: /changes/i }));
}

describe("AuditLog", () => {
  it("renders entries with a readable action and who did it", async () => {
    const user = userEvent.setup();
    renderLog();
    await openChangesTab(user);
    expect(screen.getByText("dedup config updated")).toBeInTheDocument();
    expect(screen.getByText(/An API key/)).toBeInTheDocument();
  });

  it("says the chain is INTACT when it verifies", async () => {
    const user = userEvent.setup();
    const verifyChain = vi.fn(async () => ({
      status: "ok" as const,
      verification: { ok: true as const, rowsVerified: 12 },
    }));
    renderLog(ok, { verifyChain });
    await openChangesTab(user);

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
    await openChangesTab(user);

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
    await openChangesTab(user);

    await user.click(screen.getByRole("button", { name: /load more/i }));

    await waitFor(() => expect(loadMore).toHaveBeenCalledTimes(1));
    expect((loadMore.mock.calls[0][0] as FormData).get("afterSeq")).toBe("1");
    expect(await screen.findByText("deleted")).toBeInTheDocument();
    // Chain exhausted → no more button.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument(),
    );
  });

  it("renders an error state when the initial load failed", async () => {
    const user = userEvent.setup();
    renderLog({ status: "error" });
    await openChangesTab(user);
    expect(screen.getByText(/couldn't load the audit log/i)).toBeInTheDocument();
  });
});

// The GOVERNANCE chain (Lane 2.10). Everything collaboration emits — invites, role changes, removals, keys —
// lands on aae1, NOT audit_log. Before this the audit page showed none of it: an owner asking "who invited
// whom, who removed whom" found an empty answer.
describe("AuditLog — governance chain", () => {
  it("is the DEFAULT tab, because it's what people open an audit log to find", () => {
    renderLog();
    expect(screen.getByText("Member role changed")).toBeInTheDocument();
    expect(screen.getByText("Invite created")).toBeInTheDocument();
  });

  it("says 'You' for your own actions, and labels someone else's pseudonymous id", () => {
    renderLog();
    // Yours reads as "You"…
    expect(screen.getByText(/^You · from: member · to: admin$/)).toBeInTheDocument();
    // …and another actor is a LABELLED pseudonymous id, never an email (the chain stores no email at all —
    // invites deliberately keep it out of the hashed metadata).
    expect(screen.getByText(/^User u_other… · role: member$/)).toBeInTheDocument();
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });

  it("verifies the governance chain SEPARATELY from the changes chain", async () => {
    const user = userEvent.setup();
    const verifyAuthChain = vi.fn(async () => ({
      status: "ok" as const,
      verification: { ok: true as const, rowsVerified: 7 },
    }));
    const verifyChain = vi.fn();
    renderLog(ok, { verifyAuthChain, verifyChain });

    await user.click(screen.getByRole("button", { name: /verify chain/i }));

    // Two chains with independent sequences — verifying one must never claim anything about the other.
    expect(await screen.findByText(/chain intact.*7 entries recomputed/i)).toBeInTheDocument();
    expect(verifyChain).not.toHaveBeenCalled();
  });

  it("reports a BROKEN governance chain just as bluntly", async () => {
    const user = userEvent.setup();
    const verifyAuthChain = vi.fn(async () => ({
      status: "ok" as const,
      verification: {
        ok: false as const,
        rowsVerified: 1,
        break: { kind: "seq_gap" as const, seq: 3, detail: "a row is missing" },
      },
    }));
    renderLog(ok, { verifyAuthChain });

    await user.click(screen.getByRole("button", { name: /verify chain/i }));
    expect(await screen.findByText(/broken at entry #3/i)).toBeInTheDocument();
    expect(screen.getByText(/record was altered/i)).toBeInTheDocument();
  });
});
