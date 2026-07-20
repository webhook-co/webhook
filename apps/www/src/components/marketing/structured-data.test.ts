import { describe, expect, it } from "vitest";

import { SITE_URL } from "@/app/metadata";
import {
  breadcrumbList,
  ORG_ID,
  organizationNode,
  PERSON_ID,
  personNode,
  siteGraph,
  websiteNode,
} from "./structured-data";

// The JSON-LD is the machine-readable half of the entity-resolution work: it's how search engines
// learn that "webhook.co" is a distinct company (not the generic noun / the homonym free tool) and
// who is behind it. These invariants keep the graph internally consistent and — critically — keep it
// HONEST: never a fabricated sameAs (the one thing the entity research explicitly warned against).

describe("structured-data builders", () => {
  it("links the Organization to its founder Person by @id", () => {
    const org = organizationNode();
    expect(org["@type"]).toBe("Organization");
    expect(org["@id"]).toBe(ORG_ID);
    expect(org.founder).toEqual({ "@id": PERSON_ID });
  });

  it("names the real founder and marks them as such", () => {
    const person = personNode();
    expect(person["@type"]).toBe("Person");
    expect(person["@id"]).toBe(PERSON_ID);
    expect(person.name).toBe("Sourabh Choraria");
    // worksFor points back at the Organization node, closing the founder↔company loop.
    expect(person.worksFor).toEqual({ "@id": ORG_ID });
  });

  it("ships NO fabricated sameAs — every sameAs URL is a real, absolute https profile", () => {
    // The entity research: "Do not ship a hallucinated sameAs." A sameAs is a claim that two URLs are
    // the SAME entity; a wrong one poisons exactly the entity graph this exists to build. So the rule
    // is an allowlist: only profiles the founder has confirmed may appear here. Adding one means
    // confirming it first, then adding it to this list — never the other way round.
    const CONFIRMED = new Set([
      "https://github.com/webhook-co", // the org
      "https://www.linkedin.com/company/webhook-co/", // company page, founder-confirmed 2026-07-20
      "https://www.crunchbase.com/organization/webhook-co", // founder-confirmed 2026-07-20
      "https://www.linkedin.com/in/choraria/", // founder-confirmed 2026-07-12
      "https://github.com/choraria", // founder-confirmed 2026-07-12
    ]);

    const org = organizationNode();
    expect(org.sameAs).toContain("https://github.com/webhook-co");
    // The corroborating org profiles (created 2026-07-20) that make the entity resolve off-site.
    expect(org.sameAs).toContain("https://www.linkedin.com/company/webhook-co/");
    expect(org.sameAs).toContain("https://www.crunchbase.com/organization/webhook-co");

    const person = personNode();
    // Non-vacuous: the Person really does carry profiles now (the entity work depends on it).
    expect(person.sameAs?.length).toBeGreaterThan(0);
    expect(person.sameAs).toContain("https://www.linkedin.com/in/choraria/");

    for (const url of [...(org.sameAs ?? []), ...(person.sameAs ?? [])]) {
      expect(url).toMatch(/^https:\/\//);
      expect(CONFIRMED, `unconfirmed sameAs: ${url}`).toContain(url);
    }
  });

  it("points the Person at a self-hosted image, never a hotlink", () => {
    const person = personNode();
    expect(person.image).toBe("https://www.webhook.co/sourabh-choraria.webp");
    // A third-party host could change or remove the file under us — and it would leak a referrer.
    // Assert the HOST, parsed: a substring/regex test on a URL matches anywhere in it, so
    // `https://www.webhook.co.evil.com/…` (or `…/redirect?to=choraria.io`) would sail through one.
    expect(new URL(person.image!).host).toBe("www.webhook.co");
  });

  it("the WebSite node is published by the Organization", () => {
    const site = websiteNode();
    expect(site["@type"]).toBe("WebSite");
    expect(site.publisher).toEqual({ "@id": ORG_ID });
    expect(site.url).toBe(SITE_URL);
  });

  it("siteGraph is a valid, self-consistent @graph (org + person + website, ids resolve)", () => {
    const graph = siteGraph();
    const ids = graph.map((n) => n["@id"]);
    expect(ids).toContain(ORG_ID);
    expect(ids).toContain(PERSON_ID);
    // Every @id referenced by a node exists as a node in the graph (no dangling references).
    const referenced = [ORG_ID, PERSON_ID];
    for (const ref of referenced) {
      expect(ids, `${ref} is referenced but not defined in the graph`).toContain(ref);
    }
  });

  it("breadcrumbList builds absolute item URLs in order", () => {
    const bc = breadcrumbList([
      { name: "Home", path: "/" },
      { name: "About", path: "/about" },
    ]);
    expect(bc["@type"]).toBe("BreadcrumbList");
    expect(bc.itemListElement).toHaveLength(2);
    expect(bc.itemListElement[0]).toMatchObject({ position: 1, name: "Home", item: SITE_URL });
    expect(bc.itemListElement[1]).toMatchObject({
      position: 2,
      name: "About",
      item: `${SITE_URL}/about`,
    });
  });
});
