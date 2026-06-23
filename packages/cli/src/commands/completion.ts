import { buildCommand, buildRouteMap, proposeCompletions, type Application } from "@stricli/core";

import type { AppContext } from "../context.js";

// Shell tab-completion. `wbhk completion <bash|zsh|fish>` prints a sourceable script; each defers every
// keystroke to `wbhk __complete` (the hidden engine, dispatched in bin.ts), so completions always reflect
// the LIVE command + flag set — the scripts never need regenerating when commands change. `@stricli/core`'s
// `proposeCompletions` does the routing/flag analysis. The scripts call `__complete` with the words typed
// so far (after the program name) including the partial under the cursor; it prints one candidate per line,
// already filtered to that partial. `2>/dev/null` everywhere: a stale binary yields no candidates, never
// an error in the user's prompt. (powershell is a later addition.)

/**
 * bash: `${COMP_WORDS[@]:1:COMP_CWORD}` is the words after the program name INCLUDING the partial under the
 * cursor; `proposeCompletions` filters, and `IFS=$'\n'` splits the candidates on newlines into COMPREPLY.
 */
const BASH_SCRIPT = `# wbhk bash completion. Enable it by sourcing this from your shell init, e.g.:
#   source <(wbhk completion bash)
_wbhk_complete() {
  local IFS=$'\\n'
  COMPREPLY=( $(wbhk __complete -- "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null) )
}
complete -F _wbhk_complete wbhk
`;

/**
 * zsh: `${words[2,CURRENT]}` is the words after the program name through the one under the cursor (zsh keeps
 * an empty word there after a space, so a partial is always present); `${(@f)...}` splits the candidates on
 * newlines into an array. `proposeCompletions` filters; `compadd` re-matches against the current word (a
 * no-op on the already-filtered set). Works sourced (`compdef _wbhk wbhk`, after `compinit`) or autoloaded
 * from fpath (the `#compdef` line).
 */
const ZSH_SCRIPT = `#compdef wbhk
# wbhk zsh completion. Enable it (after compinit) with:
#   source <(wbhk completion zsh)
_wbhk() {
  local -a candidates
  candidates=(\${(@f)"$(wbhk __complete -- "\${(@)words[2,CURRENT]}" 2>/dev/null)"})
  compadd -a candidates
}
compdef _wbhk wbhk
`;

/**
 * fish: unlike bash/zsh, fish drops the empty token under the cursor, so we pass the PREVIOUS tokens
 * (`commandline -opc`, after the program name) plus an explicit trailing `""` — `__complete` then returns
 * the full candidate set for that position, and fish itself filters by the token being typed.
 */
const FISH_SCRIPT = `# wbhk fish completion. Enable it for this shell with:
#   wbhk completion fish | source
# or persist it:  wbhk completion fish > ~/.config/fish/completions/wbhk.fish
function __wbhk_complete
    set -l prev (commandline -opc)
    wbhk __complete -- $prev[2..-1] "" 2>/dev/null
end
complete -c wbhk -f -a '(__wbhk_complete)'
`;

/** A `completion <shell>` subcommand: print the static script for that shell to stdout. */
function scriptCommand(shell: string, script: string) {
  return buildCommand<Record<string, never>, [], AppContext>({
    async func(this: AppContext) {
      this.process.stdout.write(script);
    },
    parameters: { flags: {} },
    docs: { brief: `print the ${shell} completion script (see the script's header to install it)` },
  });
}

export const completionRoute = buildRouteMap({
  routes: {
    bash: scriptCommand("bash", BASH_SCRIPT),
    zsh: scriptCommand("zsh", ZSH_SCRIPT),
    fish: scriptCommand("fish", FISH_SCRIPT),
  },
  docs: { brief: "shell tab-completion (bash, zsh, fish)" },
});

/**
 * The `wbhk __complete` engine — print one completion candidate per line for the partial input. Called by
 * the shell scripts (and dispatched in bin.ts, NOT registered as a route) so it stays out of `--help` and
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
