import { describe, expect, it } from "vitest";

import { SEED_ROWS } from "@/components/marketing/inspector/stream-data";
import {
  deriveAllSurfaces,
  deriveSurface,
  eventId,
  SURFACE_ORDER,
  surfaceText,
  timeLabel,
  type SurfaceId,
} from "./derive-surfaces";

// SEED_ROWS[0] = github / push / verified; SEED_ROWS[2] = shopify / orders.create / failed.
const VERIFIED = SEED_ROWS[0]!;
const FAILED = SEED_ROWS[2]!;

describe("derive-surfaces", () => {
  it("derives a deterministic, stable eventId from the row id (no time/randomness)", () => {
    expect(eventId(VERIFIED)).toBe(eventId(VERIFIED));
    expect(eventId(VERIFIED)).toMatch(/^evt_[0-9a-z]{7}$/);
    expect(eventId(VERIFIED)).not.toBe(eventId(FAILED));
  });

  it("derives a deterministic HH:MM:SS label from the row id", () => {
    expect(timeLabel(VERIFIED)).toBe(timeLabel(VERIFIED));
    expect(timeLabel(VERIFIED)).toMatch(/^14:[0-5]\d:[0-5]\d$/);
  });

  it("returns all four surfaces in MCP/CLI/API/web order", () => {
    const views = deriveAllSurfaces(VERIFIED);
    expect(views.map((v) => v.id)).toEqual(SURFACE_ORDER);
    expect(views.map((v) => v.id)).toEqual(["mcp", "cli", "api", "web"]);
  });

  it("renders a verified event as verified across all four surfaces", () => {
    for (const id of SURFACE_ORDER) {
      const text = surfaceText(deriveSurface(VERIFIED, id));
      expect(text).toMatch(/verified|true/);
      expect(text).not.toMatch(/failed|false/);
    }
    // MCP emits the agent event on success.
    expect(surfaceText(deriveSurface(VERIFIED, "mcp"))).toContain("agent event");
  });

  it("renders a failed event as failed (with the named reason) across all four surfaces", () => {
    for (const id of SURFACE_ORDER) {
      const text = surfaceText(deriveSurface(FAILED, id));
      // CLI/MCP/web say "failed"; the API surface expresses it as "verified": false.
      expect(text).toMatch(/failed|false/);
    }
    // The named reason surfaces where there's room (MCP/web carry the full label).
    expect(surfaceText(deriveSurface(FAILED, "mcp"))).toContain("timestamp too old");
    expect(surfaceText(deriveSurface(FAILED, "web"))).toContain("timestamp too old");
    // API reports verified:false; MCP does not emit an agent event.
    expect(surfaceText(deriveSurface(FAILED, "api"))).toContain("false");
    expect(surfaceText(deriveSurface(FAILED, "mcp"))).toContain("not emitted");
    expect(surfaceText(deriveSurface(FAILED, "mcp"))).not.toContain("agent event");
  });

  it("uses the row's own provider/event, never a hardcoded example", () => {
    for (const id of SURFACE_ORDER) {
      const text = surfaceText(deriveSurface(VERIFIED, id as SurfaceId));
      expect(text).toContain("github");
      expect(text).not.toContain("stripe");
    }
    expect(surfaceText(deriveSurface(FAILED, "web"))).toContain("shopify");
  });

  it("carries the derived eventId into the MCP, API, and web surfaces", () => {
    const id = eventId(VERIFIED);
    expect(surfaceText(deriveSurface(VERIFIED, "mcp"))).toContain(id);
    expect(surfaceText(deriveSurface(VERIFIED, "api"))).toContain(id);
    expect(deriveSurface(VERIFIED, "web").meta).toBe(id);
  });
});
