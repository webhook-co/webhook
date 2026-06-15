import { Terminal, TerminalLine, Tok } from "@/components/ui/terminal";

/**
 * The capture · inspect · replay visual: a `wbhk listen` session where one line is a replay. The
 * replayed line pulses (the `.term-hl` class in `marketing.css`); everything else is static. Column
 * gaps use string-literal spaces (`{"  "}`) so Prettier can't collapse them and `whitespace-pre`
 * preserves the alignment.
 */
export function ReplayTerminal() {
  return (
    <Terminal title="wbhk — zsh" meta="~/app">
      <TerminalLine>
        <Tok.Dim>$</Tok.Dim> wbhk listen
      </TerminalLine>
      <TerminalLine>
        <Tok.Mut>→ capturing at</Tok.Mut> https://3f2a.wbhk.my
      </TerminalLine>
      <TerminalLine>
        <Tok.Mut>→ forwarding to</Tok.Mut> localhost:3000
      </TerminalLine>
      <TerminalLine aria-hidden="true"> </TerminalLine>
      <TerminalLine>
        <Tok.Dim>14:02:11</Tok.Dim>
        {"  stripe  invoice.paid  "}
        <Tok.Ok>✓ verified</Tok.Ok>
        {"  "}
        <Tok.Dim>→ 200</Tok.Dim>
      </TerminalLine>
      <TerminalLine highlight>
        <Tok.Dim>14:06:54</Tok.Dim>
        {"  stripe  invoice.paid  "}
        <Tok.Info>↻ replayed</Tok.Info>
        {"  "}
        <Tok.Dim>→ 200</Tok.Dim>
      </TerminalLine>
      <TerminalLine>
        <Tok.Dim>14:07:20</Tok.Dim>
        {"  github  push          "}
        <Tok.Ok>✓ verified</Tok.Ok>
        {"  "}
        <Tok.Dim>→ 200</Tok.Dim>
      </TerminalLine>
    </Terminal>
  );
}
