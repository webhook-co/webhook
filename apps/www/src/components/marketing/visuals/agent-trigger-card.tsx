import { Terminal, TerminalLine, Tok } from "@/components/ui/terminal";

/**
 * What a webhook→agent trigger actually looks like, using the REAL capability names from the contract
 * (`triggers.create`, `triggers.wait`) and the REAL semantics.
 *
 * The semantics matter more than the pixels here. `triggers.wait` is a SHORT-POLL: one fast scan per
 * call, at a cadence the caller drives, acknowledged by cursor. It does NOT "block until" an event
 * arrives and it does not push — that framing was wrong in three places in this repo and was
 * corrected; it must not come back in through a marketing visual. `agent-trigger-card.test.tsx` pins
 * the tool names to the capability registry and forbids the push wording.
 */
export const TRIGGER_TOOLS = ["triggers.create", "triggers.wait"] as const;

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
        <Tok.Mut>{`{ "endpointId": "…", "eventTypes": ["issue.updated"] }`}</Tok.Mut>
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
