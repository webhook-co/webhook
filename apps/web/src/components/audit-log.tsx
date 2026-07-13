"use client";

import {
  Badge,
  Banner,
  Button,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@webhook-co/ui";
import * as React from "react";

import type {
  LoadMoreAuditResult,
  LoadMoreAuthAuditResult,
  VerifyChainResult,
} from "@/server/audit-actions";
import type { AuditItem, AuditResult, AuthAuditItem, AuthAuditResult } from "@/server/audit";

export interface AuditLogProps {
  readonly initial: AuditResult;
  readonly loadMore: (formData: FormData) => Promise<LoadMoreAuditResult>;
  readonly verifyChain: () => Promise<VerifyChainResult>;
  /** The governance chain (aae1): invites, roles, removals, keys, grants. A SEPARATE chain, so it has its
   *  own list and its own verify — merging them would imply a single sequence that doesn't exist. */
  readonly initialAuth: AuthAuditResult;
  readonly loadMoreAuth: (formData: FormData) => Promise<LoadMoreAuthAuditResult>;
  readonly verifyAuthChain: () => Promise<VerifyChainResult>;
  /** The signed-in user, so their own actions read as "You" instead of an opaque id. */
  readonly currentUserId: string;
}

/** `member_role_changed` → "Member role changed". The event vocabulary is closed, but formatting it beats
 *  a switch with 13 arms that a new event type would silently fall through. */
function formatEventType(eventType: string): string {
  const words = eventType.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The actor is a pseudonymous user id — never an email. Say "You" when it's the reader; "System" when null. */
function describeActor(actor: string | null, currentUserId: string): string {
  if (actor === null) return "System";
  if (actor === currentUserId) return "You";
  return actor === "system" ? "System" : `User ${actor.slice(0, 8)}…`;
}

function AuthAuditRow({ item, currentUserId }: { item: AuthAuditItem; currentUserId: string }) {
  const meta = item.metadata
    ? Object.entries(item.metadata)
        .map(([k, v]) => `${k}: ${v}`)
        .join(" · ")
    : null;
  return (
    <li className="flex items-start justify-between gap-4 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-medium text-fg">{formatEventType(item.eventType)}</span>
        <span className="truncate text-xs text-fg-secondary">
          {describeActor(item.actor, currentUserId)}
          {meta ? ` · ${meta}` : ""}
        </span>
      </div>
      <time
        className="shrink-0 whitespace-nowrap text-xs tabular-nums text-fg-muted"
        dateTime={item.createdAt}
      >
        {new Date(item.createdAt).toLocaleString()}
      </time>
    </li>
  );
}

/**
 * Turn `endpoint.dedup_config_updated` into "Endpoint · dedup config updated".
 *
 * The action vocabulary is an OPEN string set — new actions ship without a schema change — so this formats
 * rather than switching on a closed union. An unknown action still reads sensibly instead of falling through
 * to a blank cell or a raw identifier.
 */
function formatAction(action: string): { domain: string; verb: string } {
  const [head, ...rest] = action.split(".");
  const domain = (head ?? action).replaceAll("_", " ");
  const verb = rest.join(".").replaceAll("_", " ") || "—";
  return { domain, verb };
}

function AuditRow({ item }: { item: AuditItem }) {
  const { domain, verb } = formatAction(item.action);
  return (
    <li className="flex items-start justify-between gap-4 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-fg">{verb}</span>
          <Badge tone="neutral">{domain}</Badge>
        </span>
        <span className="truncate text-xs text-fg-secondary">
          {item.actor}
          {item.target ? ` · ${item.target}` : ""}
        </span>
      </div>
      <time
        className="shrink-0 whitespace-nowrap text-xs tabular-nums text-fg-muted"
        dateTime={item.createdAt}
      >
        {new Date(item.createdAt).toLocaleString()}
      </time>
    </li>
  );
}

/** The verification outcome, stated plainly — including WHERE it broke, which is the only actionable part. */
function VerifyOutcome({ result }: { result: VerifyChainResult }) {
  if (result.status === "forbidden") {
    return <Banner tone="danger">You don&apos;t have permission to verify the audit chain.</Banner>;
  }
  if (result.status === "error") {
    return <Banner tone="danger">We couldn&apos;t verify the chain right now. Try again.</Banner>;
  }
  const v = result.verification;
  if (v.ok) {
    return (
      <Banner tone="ok">
        Chain intact — {v.rowsVerified.toLocaleString()}{" "}
        {v.rowsVerified === 1 ? "entry" : "entries"} recomputed and every link matched.
      </Banner>
    );
  }
  // Don't soften this. A broken chain means the record has been altered, and `detail` is written for an
  // operator — surface it verbatim rather than paraphrasing it into something reassuring.
  return (
    <Banner tone="danger">
      Chain BROKEN at entry #{v.break.seq} ({v.break.kind}): {v.break.detail} — {v.rowsVerified}{" "}
      entries verified before the break. Contact support: this means the record was altered.
    </Banner>
  );
}

/**
 * One chain's panel: the entries, "Load more", and "Verify chain". Both chains get the same shell — they are
 * the same KIND of thing (an append-only hash chain), and giving them two different UIs would make the user
 * learn twice.
 */
function ChainPanel<T extends { seq: number }>({
  initial,
  loadMore,
  verify,
  renderRow,
  blurb,
  emptyText,
}: {
  initial: { status: "ok"; items: readonly T[]; nextSeq: number | null } | { status: "error" };
  loadMore: (
    fd: FormData,
  ) => Promise<
    | {
        status: "ok";
        result: { status: "ok"; items: readonly T[]; nextSeq: number | null } | { status: "error" };
      }
    | { status: "forbidden" }
  >;
  verify: () => Promise<VerifyChainResult>;
  renderRow: (item: T) => React.ReactNode;
  blurb: string;
  emptyText: string;
}) {
  const [items, setItems] = React.useState<readonly T[]>(
    initial.status === "ok" ? initial.items : [],
  );
  const [nextSeq, setNextSeq] = React.useState<number | null>(
    initial.status === "ok" ? initial.nextSeq : null,
  );
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [verifying, setVerifying] = React.useState(false);
  const [verifyResult, setVerifyResult] = React.useState<VerifyChainResult | null>(null);

  if (initial.status !== "ok") {
    return (
      <Banner tone="danger">
        We couldn&apos;t load the audit log. Refresh the page to try again.
      </Banner>
    );
  }

  async function handleVerify() {
    setVerifying(true);
    setVerifyResult(null);
    try {
      setVerifyResult(await verify());
    } catch {
      setVerifyResult({ status: "error" });
    } finally {
      setVerifying(false);
    }
  }

  async function handleLoadMore() {
    if (nextSeq === null) return;
    setLoading(true);
    setLoadError(null);
    try {
      const fd = new FormData();
      fd.set("afterSeq", String(nextSeq));
      const res = await loadMore(fd);
      if (res.status !== "ok") {
        setLoadError("We couldn't load more entries. Try again.");
        return;
      }
      const page = res.result;
      if (page.status !== "ok") {
        setLoadError("We couldn't load more entries. Try again.");
        return;
      }
      setItems((prev) => [...prev, ...page.items]);
      setNextSeq(page.nextSeq);
    } catch {
      setLoadError("We couldn't load more entries. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-fg-secondary">{blurb}</p>
        <Button variant="secondary" onClick={handleVerify} disabled={verifying}>
          {verifying ? "Verifying…" : "Verify chain"}
        </Button>
      </div>

      {verifyResult ? <VerifyOutcome result={verifyResult} /> : null}

      {items.length === 0 ? (
        <p className="text-sm text-fg-secondary">{emptyText}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-hairline">{items.map(renderRow)}</ul>
      )}

      {loadError ? <Banner tone="danger">{loadError}</Banner> : null}

      {nextSeq !== null ? (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={handleLoadMore} disabled={loading}>
            {loading ? <Spinner size="sm" /> : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The audit log: TWO separate hash chains, shown as two tabs.
 *
 * They are genuinely separate records with independent sequences — `audit_log` (what changed in the org) and
 * `auth_audit_event` (who was granted or denied access to it). Interleaving them into one list would imply a
 * single ordering that does not exist, and a single "verify" that cannot be computed. Tabs keep the
 * distinction the data actually has.
 *
 * Governance is the DEFAULT tab: it's where invites, role changes and removals land, which is what someone
 * opening an audit log is usually looking for.
 */
export function AuditLog({
  initial,
  loadMore,
  verifyChain,
  initialAuth,
  loadMoreAuth,
  verifyAuthChain,
  currentUserId,
}: AuditLogProps) {
  return (
    <Tabs defaultValue="governance">
      <TabsList>
        <TabsTrigger value="governance">Access &amp; governance</TabsTrigger>
        <TabsTrigger value="changes">Changes</TabsTrigger>
      </TabsList>

      <TabsContent value="governance">
        <ChainPanel
          initial={initialAuth}
          loadMore={loadMoreAuth}
          verify={verifyAuthChain}
          blurb="Invites, roles, removals, keys and devices — hash-chained so tampering is detectable."
          emptyText="No access changes recorded yet."
          renderRow={(item) => (
            <AuthAuditRow key={item.seq} item={item} currentUserId={currentUserId} />
          )}
        />
      </TabsContent>

      <TabsContent value="changes">
        <ChainPanel
          initial={initial}
          loadMore={loadMore}
          verify={verifyChain}
          blurb="Every change to endpoints, destinations and events — hash-chained so tampering is detectable."
          emptyText="Nothing has been recorded yet."
          renderRow={(item) => <AuditRow key={item.seq} item={item} />}
        />
      </TabsContent>
    </Tabs>
  );
}
