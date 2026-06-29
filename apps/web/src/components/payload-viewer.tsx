"use client";

import { Banner, Button, CopyButton } from "@webhook-co/ui";
import * as React from "react";

import { formatBytes, isBinaryContentType, PAYLOAD_INLINE_MAX } from "@/lib/payload-format";
import type { PayloadResult } from "@/server/payloads";

export interface PayloadViewerProps {
  endpointId: string;
  eventId: string;
  /** From the event metadata already on the page — used to gate too_large/binary without a server round-trip. */
  payloadBytes: number;
  contentType: string | null;
  /** Load the body for the preview (server action; reads R2 under RLS). Injected by the gated page. */
  loadPayload: (input: { endpointId: string; eventId: string }) => Promise<PayloadResult>;
  /** The download route for the full bytes (binary / large / exact-byte download). */
  downloadHref: string;
}

type ViewState = { kind: "loading" } | PayloadResult;

export function PayloadViewer({
  endpointId,
  eventId,
  payloadBytes,
  contentType,
  loadPayload,
  downloadHref,
}: PayloadViewerProps) {
  // Decide too_large/binary from metadata the page already shipped — only an actual text body needs the
  // server round-trip (which reads R2). The server still re-validates size/type; this is just an optimization.
  const initial = React.useMemo<ViewState>(() => {
    if (payloadBytes > PAYLOAD_INLINE_MAX)
      return { kind: "too_large", bytes: payloadBytes, contentType };
    if (isBinaryContentType(contentType))
      return { kind: "binary", bytes: payloadBytes, contentType };
    return { kind: "loading" };
  }, [payloadBytes, contentType]);

  const [state, setState] = React.useState<ViewState>(initial);

  React.useEffect(() => {
    if (initial.kind !== "loading") {
      setState(initial);
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    loadPayload({ endpointId, eventId })
      .then((result) => {
        if (!cancelled) setState(result);
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [endpointId, eventId, initial, loadPayload]);

  switch (state.kind) {
    case "loading":
      return <p className="text-sm text-fg-secondary">Loading payload…</p>;
    case "text":
      return <TextPayload text={state.text} downloadHref={downloadHref} />;
    case "binary":
      return (
        <DownloadOnly
          message={`Binary payload (${formatBytes(state.bytes)}). Download to inspect the exact bytes.`}
          downloadHref={downloadHref}
        />
      );
    case "too_large":
      return (
        <DownloadOnly
          message={`This payload is ${formatBytes(state.bytes)} — too large to preview inline.`}
          downloadHref={downloadHref}
        />
      );
    case "pruned":
      return <Banner tone="neutral">The stored body was pruned and is no longer available.</Banner>;
    case "not_found":
    case "error":
      return (
        <Banner tone="danger">We couldn&apos;t load this payload. Refresh to try again.</Banner>
      );
  }
}

/**
 * Inline text body. Defaults to RAW (the exact bytes — the inspector's job), with an opt-in Pretty view for
 * JSON. Pretty re-formats via JSON.parse/stringify, which can normalize numbers (e.g. integers > 2^53), so
 * it is NOT the default and Raw is always one click away as the source of truth.
 */
function TextPayload({ text, downloadHref }: { text: string; downloadHref: string }) {
  const pretty = React.useMemo(() => tryPrettyJson(text), [text]);
  const [view, setView] = React.useState<"pretty" | "raw">("raw");
  const shown = view === "pretty" && pretty !== null ? pretty : text;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        {pretty !== null ? (
          <div className="inline-flex rounded-control border border-hairline p-0.5" role="group">
            <ToggleButton active={view === "raw"} onClick={() => setView("raw")}>
              Raw
            </ToggleButton>
            <ToggleButton active={view === "pretty"} onClick={() => setView("pretty")}>
              Pretty
            </ToggleButton>
          </div>
        ) : (
          <span className="text-xs text-fg-faint">raw</span>
        )}
        <div className="flex items-center gap-2">
          <CopyButton value={text} size="sm" label="Copy" />
          <Button asChild variant="secondary" size="sm">
            <a href={downloadHref}>Download</a>
          </Button>
        </div>
      </div>
      <pre className="max-h-[480px] overflow-auto rounded-control border border-hairline bg-surface-sunken p-3 font-mono text-xs text-fg">
        {shown}
      </pre>
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={
        "rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors " +
        (active ? "bg-surface-sunken text-fg" : "text-fg-secondary hover:text-fg")
      }
    >
      {children}
    </button>
  );
}

function DownloadOnly({ message, downloadHref }: { message: string; downloadHref: string }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-fg-secondary">{message}</p>
      <Button asChild variant="secondary" size="sm">
        <a href={downloadHref}>Download payload</a>
      </Button>
    </div>
  );
}

/** Pretty-print a JSON body, or null if it isn't valid JSON (so the caller shows raw only). */
function tryPrettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}
