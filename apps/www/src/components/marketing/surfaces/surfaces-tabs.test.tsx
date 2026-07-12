import { renderEventsTable } from "@webhook-co/cli/output/render";
import { CAPABILITY_REGISTRY, eventsList } from "@webhook-co/contract";
import { ROUTES } from "@webhook-co/openapi/routes";
import { EventSchema, EventSummarySchema, VERIFICATION_STATES } from "@webhook-co/shared";
import { VerificationResultSchema } from "@webhook-co/webhooks-spec";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CLI_EVENTS, SurfacesTabs } from "./surfaces-tabs";

/**
 * "The same event, wherever you work" is a claim about the product, so the four panels have to show
 * what the product actually prints. They used to show fiction: a `✓ verified` glyph the CLI has never
 * emitted, a `{"verified": true}` API body, an invented MCP prompt format, `evt_…` ids where the
 * product uses uuids.
 *
 * Every panel is now pinned to its source of truth — the CLI's own table renderer, the capability
 * registry, the route manifest, the entity schemas. All of those imports are TEST-ONLY devDependencies
 * of apps/www: the site ships hardcoded strings (600 KB static-export budget), and this test is what
 * proves the strings are the real ones.
 */

/** The text of one tab panel, line by line (each terminal row is its own element). */
function panelLines(container: HTMLElement, id: string): string[] {
  const panel = container.querySelector(`#surfaces-panel-${id}`);
  expect(panel, `no panel for the ${id} tab`).not.toBeNull();
  return [...(panel?.querySelectorAll("[data-terminal-line]") ?? [])].map(
    (line) => line.textContent ?? "",
  );
}

/** The JSON value shown in a panel: the lines from the first `{` to the last `}`. */
function panelJson(lines: readonly string[]): unknown {
  const start = lines.findIndex((line) => line.trim().startsWith("{"));
  const end = lines.map((line) => line.trim().endsWith("}")).lastIndexOf(true);
  expect(start, "no JSON block in this panel").toBeGreaterThanOrEqual(0);
  return JSON.parse(lines.slice(start, end + 1).join("\n"));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("the surfaces tabs", () => {
  it("pins against real schemas (this test is not vacuous)", () => {
    expect(CAPABILITY_REGISTRY.has("events.list")).toBe(true);
    expect(CAPABILITY_REGISTRY.has("events.verify_signature")).toBe(false);
    expect(VERIFICATION_STATES).toContain("verified");
    expect(VERIFICATION_STATES).not.toContain("✓ verified");
  });

  describe("the CLI panel", () => {
    it("shows exactly what `wbhk events list` renders", () => {
      const { container } = render(<SurfacesTabs />);
      const lines = panelLines(container, "cli");

      // The fixtures are parsed through the real EventSummary schema, so a displayed provider, id or
      // timestamp that the product could never produce fails here before the table is even rendered.
      const expected = renderEventsTable(
        CLI_EVENTS.map((event) => EventSummarySchema.parse(event)),
        false,
      ).split("\n");

      const table = lines.slice(lines.indexOf(expected[0] as string));
      expect(table).toEqual(expected);
    });

    it("does not decorate the CLI's output with glyphs it never prints", () => {
      const { container } = render(<SurfacesTabs />);
      const text = panelLines(container, "cli").join("\n");
      expect(text).not.toContain("✓");
      expect(text).toContain("wbhk events list");
    });
  });

  describe("the MCP panel", () => {
    it("calls a tool that exists, and shows a result the event schema accepts", () => {
      const { container } = render(<SurfacesTabs />);
      const lines = panelLines(container, "mcp");

      const called = [...CAPABILITY_REGISTRY.keys()].filter((name) =>
        lines.some((line) => line.includes(name)),
      );
      expect(called, "the MCP panel names no real capability").not.toHaveLength(0);

      const result = panelJson(lines) as Record<string, unknown>;
      const eventKeys = Object.keys(EventSchema.shape);
      for (const key of Object.keys(result)) {
        expect(eventKeys, `events.get never returns a "${key}" field`).toContain(key);
      }
      expect(VERIFICATION_STATES).toContain(result.verificationState);
      expect(String(result.id)).toMatch(UUID);
      // The real `verification` is a discriminated union, not a boolean — parse it as one.
      expect(() => VerificationResultSchema.parse(result.verification)).not.toThrow();
    });
  });

  describe("the API panel", () => {
    it("curls a route that exists in the published spec", () => {
      const { container } = render(<SurfacesTabs />);
      const curl = panelLines(container, "api").find((line) => line.includes("curl")) ?? "";

      const url = curl.match(/https:\/\/\S+/)?.[0] ?? "";
      expect(url).toContain("https://api.webhook.co");
      const template = new URL(url).pathname.replace(UUID_PATH, "/{endpointId}/");
      const route = ROUTES.find((r) => r.path === template && r.method === "GET");
      expect(route, `${template} is not a route in the OpenAPI manifest`).toBeDefined();
      expect(route?.capability).toBe(eventsList.name);
    });

    it("shows the real response shape, not a `verified: true` boolean flag", () => {
      const { container } = render(<SurfacesTabs />);
      const body = panelJson(panelLines(container, "api")) as Record<string, unknown>;

      const outputKeys = Object.keys(eventsList.output.shape);
      for (const key of Object.keys(body)) {
        expect(outputKeys, `events.list never returns a "${key}" field`).toContain(key);
      }
      const items = body.items as Record<string, unknown>[];
      expect(items.length).toBeGreaterThan(0);
      const summaryKeys = Object.keys(EventSummarySchema.shape);
      for (const item of items) {
        for (const key of Object.keys(item)) {
          expect(summaryKeys, `an event summary has no "${key}" field`).toContain(key);
        }
        expect(VERIFICATION_STATES).toContain(item.verificationState);
        expect(String(item.id)).toMatch(UUID);
      }
    });
  });

  describe("the web panel", () => {
    it("shows a real event id and a real verification state", () => {
      const { container } = render(<SurfacesTabs />);
      const lines = panelLines(container, "web");
      const text = lines.join("\n");

      expect(text).not.toContain("✓");
      expect(text).not.toContain("evt_");
      const id = text.match(UUID_ANY)?.[0] ?? "";
      expect(() => EventSummarySchema.shape.id.parse(id)).not.toThrow();
      expect(
        VERIFICATION_STATES.some((state) => text.includes(state)),
        "the web panel names no real verification state",
      ).toBe(true);
    });
  });
});

/** The uuid path segment in the curl URL, normalized back to the route template's `{endpointId}`. */
const UUID_PATH = /\/[0-9a-f-]{36}\//;
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/;
