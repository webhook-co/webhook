import { run } from "@stricli/core";
import { describe, expect, it } from "vitest";

import { app } from "../app.js";
import { makeTestContext } from "../context.js";
import { EXIT, normalizeStricliExitCode } from "../output/exit-codes.js";
import { runCompletionProposals } from "./completion.js";

describe("wbhk completion bash", () => {
  it("prints a sourceable bash completion script", async () => {
    const t = makeTestContext({});
    await run(app, ["completion", "bash"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    const out = t.stdout();
    expect(out).toContain("complete -F _wbhk_complete wbhk"); // registers the completion function
    expect(out).toContain("_wbhk_complete()"); // defines it
    expect(out).toContain("wbhk __complete"); // defers to the hidden engine
    // The literal ${...} must survive into the script (a JS-interpolation slip would mangle it).
    expect(out).toContain("${COMP_WORDS[@]:1:COMP_CWORD}");
  });
});

describe("wbhk completion zsh", () => {
  it("prints a sourceable zsh completion script", async () => {
    const t = makeTestContext({});
    await run(app, ["completion", "zsh"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    const out = t.stdout();
    expect(out).toContain("#compdef wbhk"); // fpath autoload marker
    expect(out).toContain("compdef _wbhk wbhk"); // registers when sourced
    expect(out).toContain("_wbhk()"); // defines the completion function
    expect(out).toContain("wbhk __complete"); // defers to the hidden engine
    // Literal ${...} must survive (a JS-interpolation slip would mangle / throw at module load). The
    // `(@)` flag is load-bearing: it expands the slice to SEPARATE words (preserving the empty trailing
    // token) — without it zsh joins them into one arg and subcommand/flag completion silently breaks.
    expect(out).toContain("${(@)words[2,CURRENT]}");
    expect(out).toContain("${(@f)");
  });
});

describe("wbhk completion fish", () => {
  it("prints a sourceable fish completion script", async () => {
    const t = makeTestContext({});
    await run(app, ["completion", "fish"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    const out = t.stdout();
    expect(out).toContain("complete -c wbhk"); // registers the completion
    expect(out).toContain("__wbhk_complete"); // the helper function
    expect(out).toContain("wbhk __complete"); // defers to the hidden engine
    expect(out).toContain("commandline -opc"); // captures the previous tokens (fish drops the current)
    // The explicit trailing empty token (so __complete returns the position's set; fish filters).
    expect(out).toContain('-- $prev[2..-1] ""');
  });
});

describe("runCompletionProposals (the `wbhk __complete` engine)", () => {
  const proposalsFor = async (inputs: string[]): Promise<string[]> => {
    const t = makeTestContext({});
    await runCompletionProposals(app, inputs, t.ctx);
    return t
      .stdout()
      .split("\n")
      .filter((l) => l.length > 0);
  };

  it("proposes top-level commands for an empty partial", async () => {
    const out = await proposalsFor([""]);
    expect(out).toEqual(expect.arrayContaining(["login", "events", "endpoints", "completion"]));
    expect(out).not.toContain("__complete"); // the engine is hidden from its own completions
  });

  it("filters top-level commands by a partial", async () => {
    expect(await proposalsFor(["ev"])).toContain("events");
  });

  it("proposes subcommands of a route", async () => {
    const out = await proposalsFor(["events", ""]);
    expect(out).toEqual(expect.arrayContaining(["list", "get", "payload"]));
  });

  it("filters subcommands by a partial", async () => {
    expect(await proposalsFor(["events", "l"])).toContain("list");
  });

  it("proposes flags for a command", async () => {
    const out = await proposalsFor(["whoami", "--"]);
    expect(out.some((c) => c.startsWith("--"))).toBe(true);
  });

  it("prints nothing when there are no matches", async () => {
    const t = makeTestContext({});
    await runCompletionProposals(app, ["zzz-no-such-command"], t.ctx);
    expect(t.stdout()).toBe("");
  });
});
