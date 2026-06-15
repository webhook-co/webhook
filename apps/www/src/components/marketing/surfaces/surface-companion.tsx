import type { StreamRow } from "@/components/marketing/inspector/stream-data";
import { Terminal, TerminalLine, Tok } from "@/components/ui/terminal";
import { deriveAllSurfaces, type Segment, type SurfaceView, type Tone } from "./derive-surfaces";
import { Tabs, type TabItem } from "./tabs";

/**
 * Shows ONE selected event rendered across all four surfaces — MCP, CLI, API, web — so parity is
 * something you see, not a claim you read. On wide screens all four are visible at once (the "same
 * event everywhere" aha); below the inspector breakpoint they collapse to the keyboard-accessible
 * `Tabs` (one at a time). Both render from the same derived data, so they stay in sync; the switch is
 * pure CSS, so it's hydration-safe.
 */

// Reuse the terminal's syntax tokens so the companion can't drift from every other terminal's palette.
const TOK: Record<Tone, (typeof Tok)[keyof typeof Tok]> = {
  dim: Tok.Dim,
  mut: Tok.Mut,
  ok: Tok.Ok,
  info: Tok.Info,
  danger: Tok.Danger,
};

function Seg({ seg }: { seg: Segment }) {
  if (!seg.tone) return <>{seg.text}</>;
  const Tone = TOK[seg.tone];
  return <Tone>{seg.text}</Tone>;
}

function SurfacePanel({ view }: { view: SurfaceView }) {
  return (
    <Terminal title={view.title} meta={view.meta} className="h-full">
      {view.lines.map((line, i) => (
        <TerminalLine key={i} aria-hidden={line.length === 0 ? "true" : undefined}>
          {line.length === 0 ? " " : line.map((seg, j) => <Seg key={j} seg={seg} />)}
        </TerminalLine>
      ))}
    </Terminal>
  );
}

export function SurfaceCompanion({ row }: { row: StreamRow }) {
  const views = deriveAllSurfaces(row);
  return (
    <div>
      {/* All four at once — the parity view (≥861px). */}
      <div
        role="group"
        aria-label="The selected event across all four surfaces"
        className="hidden gap-3 min-[861px]:grid min-[861px]:grid-cols-2"
      >
        {views.map((view) => (
          <SurfacePanel key={view.id} view={view} />
        ))}
      </div>

      {/* One at a time — the narrow fallback (<861px). */}
      <div className="min-[861px]:hidden">
        <Tabs
          aria-label="The selected event, by surface"
          idBase="surfaces"
          defaultId="mcp"
          items={views.map<TabItem>((view) => ({
            id: view.id,
            label: view.label,
            panel: <SurfacePanel view={view} />,
          }))}
        />
      </div>

      <p className="sr-only">
        Each surface shows the selected event rendered from MCP, the CLI, the API, and the web app.
      </p>
    </div>
  );
}
