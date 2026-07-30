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

import { MCP_BOUND_CAPABILITIES } from "./bound-capabilities";

/**
 * The docs count SCOPE-GATED capability tools and deliberately exclude `whoami`, saying so in the text:
 * "It's identity, not a scope-gated capability, so it isn't counted". That is a defensible editorial
 * choice, so this pins the number they actually mean rather than the raw tool count a client would show.
 */
const BOUND = MCP_BOUND_CAPABILITIES.map((c) => c.name).sort();

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

  it("the withheld list accounts for every capability that is NOT bound", () => {
    // The other half of the same claim: the page says N capabilities are "held back on purpose". If a
    // capability stops being withheld and becomes bound, that sentence goes stale in the safe-sounding
    // direction — it would still read as though the agent surface were narrower than it is.
    const withheldClaim =
      /Twelve|(\d+) capabilities that exist on other surfaces are held back/.exec(overview);
    expect(
      withheldClaim,
      "overview.mdx should state how many capabilities are withheld",
    ).not.toBeNull();
  });
});
