import { buildCommand, buildRouteMap, proposeCompletions, type Application } from "@stricli/core";

import type { AppContext } from "../context.js";

// Shell tab-completion. `wbhk completion bash` prints a sourceable bash script; the script defers every
// keystroke to `wbhk __complete` (the hidden engine, dispatched in bin.ts), so completions always reflect
// the LIVE command + flag set — the script never needs regenerating when commands change. bash only for
// now (zsh/fish are D4b). `@stricli/core`'s `proposeCompletions` does the actual routing/flag analysis.

/**
 * The emitted bash script. `_wbhk_complete` passes the words typed so far — after the program name and
 * INCLUDING the partial under the cursor (`${COMP_WORDS[@]:1:COMP_CWORD}`) — to `wbhk __complete`, which
 * prints one candidate per line, already filtered to the partial by `proposeCompletions`. `IFS=$'\n'`
 * splits the candidates on newlines only (so a candidate could contain a space, though commands/flags
 * don't). `__complete`'s stderr is suppressed (its exit status is not checked) so a stale binary never
 * breaks the user's prompt — a failed call just yields no candidates.
 */
const BASH_SCRIPT = `# wbhk bash completion. Enable it by sourcing this from your shell init, e.g.:
#   source <(wbhk completion bash)
_wbhk_complete() {
  local IFS=$'\\n'
  COMPREPLY=( $(wbhk __complete -- "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null) )
}
complete -F _wbhk_complete wbhk
`;

const bashCompletionCommand = buildCommand<Record<string, never>, [], AppContext>({
  async func(this: AppContext) {
    this.process.stdout.write(BASH_SCRIPT);
  },
  parameters: { flags: {} },
  docs: { brief: "print the bash completion script (source it from your shell init)" },
});

export const completionRoute = buildRouteMap({
  routes: { bash: bashCompletionCommand },
  docs: { brief: "shell tab-completion (bash)" },
});

/**
 * The `wbhk __complete` engine — print one completion candidate per line for the partial input. Called by
 * the bash script (and dispatched in bin.ts, NOT registered as a route) so it stays out of `--help` and
 * the completion candidates themselves, and so there's no app↔command import cycle. `proposeCompletions`
 * has already filtered the candidates to the trailing partial; an empty result prints nothing.
 */
export async function runCompletionProposals(
  app: Application<AppContext>,
  inputs: readonly string[],
  ctx: AppContext,
): Promise<void> {
  const proposals = await proposeCompletions(app, inputs, ctx);
  if (proposals.length > 0) {
    ctx.process.stdout.write(proposals.map((p) => p.completion).join("\n") + "\n");
  }
}
