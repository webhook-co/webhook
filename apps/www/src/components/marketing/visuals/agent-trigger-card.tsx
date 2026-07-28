import { Terminal, TerminalLine, Tok } from "@/components/ui/terminal";

/**
 * What a webhook→agent trigger actually looks like, using the REAL capability names from the contract
 * (`triggers.create`, `triggers.wait`), the REAL input fields, and the REAL semantics.
 *
 * The semantics matter more than the pixels here. `triggers.wait` is a SHORT-POLL: one fast scan per
 * call, at a cadence the caller drives, acknowledged by cursor. It does NOT "block until" an event
 * arrives and it does not push — that framing was wrong in three places in this repo and was
 * corrected; it must not come back in through a marketing visual.
 *
 * The ARGUMENTS are pinned too, and that is not belt-and-braces. This card previously showed
 * `triggers.create` taking `{ endpointId, eventTypes: ["issue.updated"] }`. There is no `eventTypes`
 * on a trigger — a trigger binds to ONE ENDPOINT and yields everything that endpoint captures. The
 * field is real on `subscriptions.create`, which is where it was copied from. At the time the input
 * schema stripped unknown keys rather than rejecting them, so a developer following this card sent a
 * filter, had it silently dropped, and received every event on the endpoint believing it was
 * filtered — the worst kind of documentation bug, because nothing errored. The name-only guard
 * passed it for a year.
 *
 * Both halves of that are now closed: `agent-trigger-card.test.tsx` validates the shown arguments
 * against the capability input schema, and capability inputs are STRICT (see `defineCapability`), so
 * the same mistake made anywhere else is a VALIDATION_ERROR instead of a silent no-op.
 */
export const TRIGGER_TOOLS = ["triggers.create", "triggers.wait"] as const;

/** The arguments this card SHOWS, pinned against the contract's input schemas by the test. */
export const SHOWN_ARGS = {
  "triggers.create": { endpointId: "…", name: "issue-triage" },
  "triggers.wait": { triggerId: "…", cursor: "…" },
} as const;

export function AgentTriggerCard() {
  return (
    <Terminal title="mcp.webhook.co" meta="triggers.wait">
      <TerminalLine>
        <Tok.Dim>tool</Tok.Dim>
        {"   triggers.create"}
      </TerminalLine>
      <TerminalLine>
        <Tok.Dim>input</Tok.Dim>
        {"  "}
        <Tok.Mut>{`{ "endpointId": "…", "name": "issue-triage" }`}</Tok.Mut>
      </TerminalLine>
      <TerminalLine aria-hidden="true"> </TerminalLine>
      <TerminalLine>
        <Tok.Dim>tool</Tok.Dim>
        {"   triggers.wait"}
      </TerminalLine>
      <TerminalLine>
        <Tok.Dim>input</Tok.Dim>
        {"  "}
        <Tok.Mut>{`{ "triggerId": "…", "cursor": "…" }`}</Tok.Mut>
      </TerminalLine>
      <TerminalLine aria-hidden="true"> </TerminalLine>
      <TerminalLine>{"{"}</TerminalLine>
      <TerminalLine>{'  "events": [ … ],'}</TerminalLine>
      <TerminalLine>
        {'  "cursor": '}
        <Tok.Mut>&quot;…&quot;</Tok.Mut>
        {"  "}
        <Tok.Dim>{"// ack by passing it back on the next call"}</Tok.Dim>
      </TerminalLine>
      <TerminalLine>{"}"}</TerminalLine>
    </Terminal>
  );
}
