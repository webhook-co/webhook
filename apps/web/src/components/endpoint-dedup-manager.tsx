"use client";

import {
  Banner,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Combobox,
  type ComboboxOption,
  Field,
  Label,
} from "@webhook-co/ui";
import {
  clampDedupWindow,
  DEFAULT_DEDUP_WINDOW_SECONDS,
  isDedupWindowInRange,
  MAX_DEDUP_WINDOW_SECONDS,
  MAX_FIELD_PATHS,
  MIN_DEDUP_WINDOW_SECONDS,
  parseFieldPath,
  type DedupConfig,
  type DedupMode,
} from "@webhook-co/shared";
import * as React from "react";

import type { UpdateEndpointDedupResult } from "@/server/endpoint-actions";

// The endpoint deduplication section: a mode picker + a window + (for `fields` mode) two path list editors.
// Dedup decides which repeat deliveries collapse into one event rather than being captured (and metered)
// again — so the copy is written from the operator's point of view (what happens to their events), not the
// engine's key-selection internals. Mirrors provider-secrets-manager: plain React.useState, a render-phase
// reconcile from a fresh `initial`, a synchronous `pendingRef` double-submit latch, inline `<Banner>` feedback
// (no toast), and design-system tokens only. The server is authoritative — it re-validates the assembled
// config against the same schema api/mcp use — so this form validates just enough to keep the UI coherent.

/** The user-facing mode labels (never the raw enum) + a one-line, end-user description of each mode. */
const MODE_OPTIONS: readonly { value: DedupMode; label: string; description: string }[] = [
  {
    value: "identifier",
    label: "Automatic (recommended)",
    description:
      "Collapses repeat deliveries using the sender's own event id, falling back to the full payload when there isn't one.",
  },
  {
    value: "content",
    label: "Match on full content",
    description: "Collapses deliveries only when the entire payload is identical.",
  },
  {
    value: "fields",
    label: "Match on specific fields",
    description:
      "Collapses deliveries that match on just the fields you choose — useful when a sender adds a timestamp or nonce to each retry.",
  },
  {
    value: "off",
    label: "Off — record every request",
    description: "Captures every delivery, even exact repeats.",
  },
];

const MODE_DESCRIPTIONS: ReadonlyMap<DedupMode, string> = new Map(
  MODE_OPTIONS.map((o) => [o.value, o.description]),
);

/** The editable form state — drafts for the two field inputs live in the sub-editors, not here. */
interface DedupDraft {
  readonly mode: DedupMode;
  /** Raw window input (kept as a string so the field can be cleared while editing). */
  readonly window: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/** Seed the editable draft from the endpoint's stored config; null (the default) → identifier + 24h. */
function fromConfig(cfg: DedupConfig | null): DedupDraft {
  if (!cfg) {
    return {
      mode: "identifier",
      window: String(DEFAULT_DEDUP_WINDOW_SECONDS),
      include: [],
      exclude: [],
    };
  }
  return {
    mode: cfg.mode,
    window: String(cfg.windowSeconds),
    include: cfg.fields?.include ? [...cfg.fields.include] : [],
    exclude: cfg.fields?.exclude ? [...cfg.fields.exclude] : [],
  };
}

/**
 * Assemble the wire config from the draft. The schema requires `windowSeconds` for every mode (including
 * `off`, where the UI hides it) and `fields` ONLY for `fields` mode, so we mirror that exactly. The window
 * uses the shared clamp (the server-safe floor); Save is gated on {@link isDedupWindowInRange} first, so
 * clamping only ever rounds an already-in-range entry — a user's out-of-range value is rejected, not
 * silently coerced.
 */
function assemble(d: DedupDraft): DedupConfig {
  const windowSeconds = clampDedupWindow(d.window);
  if (d.mode === "fields") {
    return {
      mode: "fields",
      windowSeconds,
      fields: { include: [...d.include], exclude: [...d.exclude] },
    };
  }
  return { mode: d.mode, windowSeconds };
}

/** Canonical equality — two drafts are "the same config" when their assembled wire forms match. */
function sameConfig(a: DedupDraft, b: DedupDraft): boolean {
  return JSON.stringify(assemble(a)) === JSON.stringify(assemble(b));
}

export interface EndpointDedupManagerProps {
  endpointId: string;
  initial: DedupConfig | null;
  update: (input: {
    endpointId: string;
    dedupConfig: DedupConfig | null;
  }) => Promise<UpdateEndpointDedupResult>;
}

export function EndpointDedupManager({ endpointId, initial, update }: EndpointDedupManagerProps) {
  const [draft, setDraft] = React.useState<DedupDraft>(() => fromConfig(initial));
  // The saved baseline the Save button diffs against — reconciled to the just-saved config on success.
  const [baseline, setBaseline] = React.useState<DedupDraft>(() => fromConfig(initial));
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  // A synchronous in-flight latch: `saving` state re-renders a frame late, so it can't block a same-tick
  // double-submit; this ref reliably fires the save exactly once.
  const pendingRef = React.useRef(false);

  // Reconcile to a fresh server-provided `initial` WITHOUT remounting. This page is force-dynamic, so ANY
  // sibling server action (e.g. adding a provider secret) hands down a NEW `initial` OBJECT with the SAME
  // value — keying on object identity would wipe the user's unsaved dedup draft on every route refresh. So
  // we key on the config's VALUE signature: the reconcile fires only when the persisted config actually
  // changed. And when it changed to a value that MATCHES what's on screen (our own just-saved config echoed
  // back by revalidatePath), we advance the baseline but keep the draft + the "Saved." confirmation — an
  // out-of-band change (api/cli) to a DIFFERENT value still resets the form (the server is authoritative).
  const initialSig = JSON.stringify(initial);
  const [seededSig, setSeededSig] = React.useState(initialSig);
  if (seededSig !== initialSig) {
    setSeededSig(initialSig);
    const next = fromConfig(initial);
    if (sameConfig(next, draft)) {
      setBaseline(next); // our save echoed back (or a no-op) — keep draft + "Saved.", just re-baseline
    } else {
      setDraft(next);
      setBaseline(next);
      setError(null);
      setSaved(false);
    }
  }

  // Any edit clears a stale error + the "Saved" affordance and re-opens the form for a fresh save.
  function edit(next: DedupDraft) {
    setDraft(next);
    if (error) setError(null);
    if (saved) setSaved(false);
  }

  function handleModeChange(mode: DedupMode) {
    edit({ ...draft, mode });
  }

  function handleWindowChange(window: string) {
    edit({ ...draft, window });
  }

  // Add a field path to the include/exclude list: trim, cap, dedupe, and grammar-check with the SAME parser
  // the server config-gate uses — so an obviously-bad path never gets added (the server still re-validates).
  function addPath(list: "include" | "exclude", raw: string): boolean {
    const path = raw.trim();
    if (!path) return false;
    const current = draft[list];
    if (current.includes(path)) {
      setError("You've already added that field.");
      return false;
    }
    if (current.length >= MAX_FIELD_PATHS) {
      setError(`You can add up to ${MAX_FIELD_PATHS} fields.`);
      return false;
    }
    if (!parseFieldPath(path).ok) {
      setError(
        "That isn't a valid field path. Try something like body.data.id or headers.x-event-id.",
      );
      return false;
    }
    edit({ ...draft, [list]: [...current, path] });
    return true;
  }

  function removePath(list: "include" | "exclude", path: string) {
    edit({ ...draft, [list]: draft[list].filter((p) => p !== path) });
  }

  const dirty = !sameConfig(draft, baseline);
  const windowOk = draft.mode === "off" || isDedupWindowInRange(draft.window);
  const fieldsOk = draft.mode !== "fields" || draft.include.length >= 1;
  const canSave = dirty && windowOk && fieldsOk && !saving;
  // Show an inline range error only once the user has typed something out of range — never on an empty field
  // mid-edit (that just keeps Save disabled). Reject-with-feedback, never a silent clamp to a bound.
  const windowError =
    draft.mode !== "off" && draft.window.trim() !== "" && !isDedupWindowInRange(draft.window)
      ? "Enter a whole number of seconds between 60 and 604800 (7 days)."
      : undefined;

  async function handleSave() {
    if (pendingRef.current) return; // synchronous double-submit guard
    pendingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await update({ endpointId, dedupConfig: assemble(draft) });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Reconcile the baseline to the saved config so Save re-disables until the next edit. Seed the draft
      // from the server's echo so the persisted (clamped) window is reflected back.
      const next = fromConfig(result.dedupConfig);
      setBaseline(next);
      setDraft(next);
      setSaved(true);
    } catch {
      setError("We couldn't update deduplication. Please try again.");
    } finally {
      setSaving(false);
      pendingRef.current = false;
    }
  }

  const modeOptions = React.useMemo<ComboboxOption[]>(
    () => MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
    [],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Deduplication</CardTitle>
        <CardDescription>
          Choose how we collapse repeat deliveries to this endpoint into a single event. Duplicates
          that collapse aren&apos;t captured again, so they don&apos;t count toward usage.
        </CardDescription>
      </CardHeader>

      <div className="flex flex-col gap-6 px-6 pb-6">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="dedup-mode">Deduplication mode</Label>
          <Combobox
            id="dedup-mode"
            label="Deduplication mode"
            options={modeOptions}
            value={draft.mode}
            onChange={(v) => handleModeChange(v as DedupMode)}
            className="w-full sm:max-w-sm"
          />
          <p className="text-sm text-fg-secondary">{MODE_DESCRIPTIONS.get(draft.mode)}</p>
        </div>

        {draft.mode !== "off" ? (
          <Field
            label="Deduplication window (seconds)"
            type="number"
            inputMode="numeric"
            min={MIN_DEDUP_WINDOW_SECONDS}
            max={MAX_DEDUP_WINDOW_SECONDS}
            hint="Between 60 seconds and 7 days. Repeats seen within this window collapse into the first delivery."
            error={windowError}
            value={draft.window}
            onChange={(e) => handleWindowChange(e.target.value)}
            disabled={saving}
            fieldClassName="sm:max-w-xs"
          />
        ) : null}

        {draft.mode === "fields" ? (
          <div className="flex flex-col gap-5 rounded-card border border-hairline bg-surface-sunken p-5">
            <p className="text-sm text-fg-secondary">
              Match on a dot-path into the payload — e.g. <code>body.data.id</code> or{" "}
              <code>headers.x-event-id</code>. Include the fields that identify a delivery; exclude
              any that change between retries.
            </p>
            <FieldPathList
              listId="dedup-include"
              title="Include fields"
              chipsLabel="Chosen include paths"
              required
              paths={draft.include}
              placeholder="e.g. body.data.id"
              disabled={saving}
              onAdd={(raw) => addPath("include", raw)}
              onRemove={(path) => removePath("include", path)}
            />
            <FieldPathList
              listId="dedup-exclude"
              title="Exclude fields"
              chipsLabel="Chosen exclude paths"
              paths={draft.exclude}
              placeholder="e.g. body.sent_at"
              disabled={saving}
              onAdd={(raw) => addPath("exclude", raw)}
              onRemove={(path) => removePath("exclude", path)}
            />
          </div>
        ) : null}

        {draft.mode === "off" ? (
          <Banner tone="warn">
            Every delivery to this endpoint will be captured, including exact repeats — and each one
            counts toward usage. Duplicate collapsing is disabled.
          </Banner>
        ) : null}

        {error ? <Banner tone="danger">{error}</Banner> : null}

        <div className="flex items-center gap-3">
          <Button type="button" onClick={handleSave} disabled={!canSave}>
            Save changes
          </Button>
          {saved ? (
            // A subtle inline confirmation (no toast) — announced politely, cleared on the next edit.
            <span role="status" className="text-sm text-ok">
              Saved.
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/**
 * One tag-style path list editor: a labelled text input + Add button, with the added paths shown as removable
 * chips. The draft input lives here (local); the parent owns the committed list + all validation. Enter adds
 * without submitting a form. Each chip's × is a real button, so paths are keyboard-removable.
 */
function FieldPathList({
  listId,
  title,
  chipsLabel,
  required,
  paths,
  placeholder,
  disabled,
  onAdd,
  onRemove,
}: {
  listId: string;
  title: string;
  /** Accessible name for the chip list — kept distinct from the input label so both stay queryable. */
  chipsLabel: string;
  required?: boolean;
  paths: readonly string[];
  placeholder: string;
  disabled?: boolean;
  onAdd: (raw: string) => boolean;
  onRemove: (path: string) => void;
}) {
  const [value, setValue] = React.useState("");

  function commit() {
    if (onAdd(value)) setValue("");
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <Field
          id={listId}
          label={required ? `${title} (at least one)` : `${title} (optional)`}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Enter adds the path without submitting anything — there's no enclosing form, but guard anyway.
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          fieldClassName="flex-1"
        />
        <Button
          type="button"
          variant="secondary"
          onClick={commit}
          disabled={disabled || value.trim() === ""}
          aria-label={`Add ${title.toLowerCase()}`}
        >
          Add
        </Button>
      </div>
      {paths.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label={chipsLabel}>
          {paths.map((path) => (
            <li
              key={path}
              className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 py-1 text-sm text-fg"
            >
              <code className="text-fg-secondary">{path}</code>
              <button
                type="button"
                onClick={() => onRemove(path)}
                disabled={disabled}
                aria-label={`Remove ${path}`}
                className="rounded-full text-fg-muted outline-none hover:text-fg focus-visible:shadow-[var(--wh-focus-ring)]"
              >
                <span aria-hidden>×</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
