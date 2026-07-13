"use client";

import { Badge, Banner, Button, Spinner } from "@webhook-co/ui";
import * as React from "react";

import type { LoadMoreAuditResult, VerifyChainResult } from "@/server/audit-actions";
import type { AuditItem, AuditResult } from "@/server/audit";

export interface AuditLogProps {
  readonly initial: AuditResult;
  readonly loadMore: (formData: FormData) => Promise<LoadMoreAuditResult>;
  readonly verifyChain: () => Promise<VerifyChainResult>;
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

export function AuditLog({ initial, loadMore, verifyChain }: AuditLogProps) {
  const [items, setItems] = React.useState<readonly AuditItem[]>(
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
      setVerifyResult(await verifyChain());
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
        <p className="text-sm text-fg-secondary">
          Every change to this organization, hash-chained so tampering is detectable.
        </p>
        <Button variant="secondary" onClick={handleVerify} disabled={verifying}>
          {verifying ? "Verifying…" : "Verify chain"}
        </Button>
      </div>

      {verifyResult ? <VerifyOutcome result={verifyResult} /> : null}

      {items.length === 0 ? (
        <p className="text-sm text-fg-secondary">Nothing has been recorded yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-hairline">
          {items.map((item) => (
            <AuditRow key={item.seq} item={item} />
          ))}
        </ul>
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
