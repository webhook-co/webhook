import { describe, expect, it } from "vitest";

// The MCP docs describe what an agent connected to us can do. That page's whole argument is about which
// capabilities an agent may and may not reach — "reading events an agent already has access to steers
// nothing; redirecting egress does" — so a bound tool missing from it is not a typo, it is a false
// statement about the agent surface.
//
// `events.delete` was exactly that: registered, `destructive: true`, and absent from every MCP docs page,
// while the overview's Events card listed only list/get/tail. A reader would conclude an agent cannot
// delete events. It can.
//
// So the tool list and the count are DERIVED here from MCP_BOUND_CAPABILITIES — the same set that decides
// what actually gets registered — rather than compared against a second hand-maintained list, which would
// just be the same drift one file further away.
//
// Raw imports, not readFileSync: this suite runs in the workerd pool, which has no filesystem (a read
// there fails at COLLECTION and shows up as a failed FILE with zero failing tests).
import overview from "../../docs/mcp/overview.mdx?raw";
import connectDocs from "../../docs/mcp/connect-the-docs-mcp.mdx?raw";
import usingFromAClient from "../../docs/mcp/using-from-a-client.mdx?raw";

import { CAPABILITIES } from "@webhook-co/contract";

import { MCP_BOUND_CAPABILITIES } from "./bound-capabilities";

/**
 * The docs count SCOPE-GATED capability tools and deliberately exclude `whoami`, saying so in the text:
 * "It's identity, not a scope-gated capability, so it isn't counted". That is a defensible editorial
 * choice, so this pins the number they actually mean rather than the raw tool count a client would show.
 */
const BOUND = MCP_BOUND_CAPABILITIES.map((c) => c.name).sort();

/** Every capability the MCP surface does NOT bind — the set the "held back on purpose" section describes. */
const BOUND_NAMES = new Set(MCP_BOUND_CAPABILITIES.map((c) => c.name));
const WITHHELD = CAPABILITIES.filter((c) => !BOUND_NAMES.has(c.name));

/** Prose spells small numbers ("Twelve capabilities…"), so accept a word or a numeral. */
const NUMBER_WORDS: Record<string, number> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
};

function statedWithheldCount(source: string): number {
  const m = /(\w+) capabilities that exist on other surfaces are held back/.exec(source);
  if (m === null) {
    throw new Error(
      "could not find the withheld-count sentence in overview.mdx — parsing is broken",
    );
  }
  const raw = m[1].toLowerCase();
  const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
  if (n === undefined) {
    throw new Error(`withheld count "${m[1]}" is neither a numeral nor a word this test knows`);
  }
  return n;
}

/** The withheld section: from its heading to the end of the page's bullet list. */
function withheldSection(source: string): string {
  const start = source.search(/^## What's deliberately/m);
  if (start === -1) {
    throw new Error("could not locate the withheld section in overview.mdx — parsing is broken");
  }
  return source.slice(start);
}

/**
 * The catalog CARD LIST — the `<CardGroup>` block only, not the whole section.
 *
 * This was originally scoped to everything between the "## The N tools" heading and the withheld section,
 * and that was too wide to do its job: surrounding PROSE that merely mentions a tool satisfied a check
 * meant to prove the tool is LISTED. Verified by mutation — deleting `events.delete` from its card left
 * the suite green, because a sentence below the cards named it. A list check has to read the list.
 */
function catalogCards(source: string): string {
  const start = source.indexOf("<CardGroup");
  const end = source.indexOf("</CardGroup>");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("could not locate the <CardGroup> catalog in overview.mdx — parsing is broken");
  }
  return source.slice(start, end);
}

describe("the MCP docs describe the tools that are actually bound", () => {
  it("finds a non-empty bound set and a parseable catalog (else everything below is vacuous)", () => {
    expect(BOUND.length).toBeGreaterThan(10);
    expect(catalogCards(overview).length).toBeGreaterThan(200);
  });

  it("lists EVERY bound capability in the CARDS — a bound tool missing from the docs is a false claim", () => {
    const catalog = catalogCards(overview);
    const undocumented = BOUND.filter((name) => !catalog.includes(`\`${name}\``));
    expect(undocumented).toEqual([]);
  });

  it("states a tool count equal to the number of bound capabilities", () => {
    const heading = /^## The (\d+) tools$/m.exec(overview);
    expect(heading).not.toBeNull();
    expect(Number(heading?.[1])).toBe(BOUND.length);
  });

  it("every page that names a tool count agrees with the bound set", () => {
    // Discovered, not listed: any "N tools" phrasing on these pages has to be the real number, so a new
    // page repeating the figure cannot quietly disagree.
    for (const [name, source] of [
      ["overview.mdx", overview],
      ["connect-the-docs-mcp.mdx", connectDocs],
      ["using-from-a-client.mdx", usingFromAClient],
    ] as const) {
      const counts = [...source.matchAll(/\b(\d+) tools\b/g)].map((m) => Number(m[1]));
      expect(counts.length, `${name} should state a tool count`).toBeGreaterThan(0);
      for (const n of counts) {
        expect(n, `${name} claims ${n} tools; ${BOUND.length} are bound`).toBe(BOUND.length);
      }
    }
  });

  it("states a withheld count equal to the capabilities that are NOT bound", () => {
    // This assertion previously only checked that the sentence EXISTED — it matched a regex and asserted
    // the match was non-null, so a wrong number could never fail it. The comment claimed it caught drift;
    // it did not. Deriving the number is the whole point, so derive it.
    //
    // The direction that matters: if a capability moves withheld -> bound and this sentence is left alone,
    // the page keeps describing the agent surface as narrower than it is. That is the same
    // under-disclosure as the missing `events.delete`, one paragraph further down.
    expect(WITHHELD.length).toBeGreaterThan(0);
    expect(statedWithheldCount(overview), "overview.mdx withheld count").toBe(WITHHELD.length);
  });

  it("accounts for every withheld capability by name or by an explicit wildcard", () => {
    // A count alone would pass if one capability were swapped for another. The page names some outright
    // (`events.getPayload`) and covers families with a wildcard (`replayDestinations.*`), so accept
    // either — but every unbound capability must be covered by one of them.
    const section = withheldSection(overview);
    const unaccounted = WITHHELD.map((c) => c.name).filter((name) => {
      if (section.includes(`\`${name}\``)) return false;
      const family = name.slice(0, name.indexOf("."));
      return !section.includes(`\`${family}.*\``);
    });
    expect(unaccounted).toEqual([]);
  });
});
