"use client";

import { cn } from "@webhook-co/ui";
import { AppWindow, Bot, Code, Terminal as TerminalIcon } from "lucide-react";

import { SectionHeading } from "@/components/ui/section-heading";
import { Terminal, TerminalLine, Tok } from "@/components/ui/terminal";
import { container, sectionPad } from "@/lib/styles";
import { Tabs, type TabItem } from "./tabs";

/**
 * The "same operations everywhere" section. Four surfaces — MCP, CLI, API, web — each showing the
 * same event from its own vantage. MCP leads, because the platform is AI-native first. Panels reuse
 * the dark `Terminal` island; the tablist (in `tabs.tsx`) is fully keyboard-operable.
 *
 * Every string in these panels is what the product actually prints. The panels are hardcoded (the
 * site is a static export under a hard byte budget — it must not import the engine to render a
 * screenshot), and `surfaces-tabs.test.tsx` pins them to the real sources of truth: the CLI's own
 * `renderEventsTable`, the capability registry, the OpenAPI route manifest, and the event schemas.
 * Change what the product returns and this section fails, loudly, before it can mislead anyone.
 */
export function SurfacesTabs() {
  return (
    <section aria-labelledby="surfaces-title" className={cn(container, sectionPad)}>
      <SectionHeading
        id="surfaces-title"
        eyebrow="one platform, every surface"
        title="The same event, wherever you work"
      >
        CLI, API, dashboard, MCP &mdash; four surfaces over one capability contract. Here&rsquo;s
        one verified event, seen from each.
      </SectionHeading>

      {/* A focused, centered code card — the terminal reads better narrow than full-bleed. */}
      {/* Sized to the WIDEST panel's content, not guessed. Measured at 1440px: the MCP tab needs 776px
          of line width (the event uuid), the web panel 716, API 678, CLI 671 — against a 598px box, so every
          tab scrolled and the MCP one hid a third of itself. 840px clears the widest with headroom, and
          still sits well inside the 1120px container. Below 880px it just uses the width available and
          the terminal scrolls internally, as it always did. */}
      <div className="mx-auto max-w-[840px]">
        <Tabs aria-label="Webhook surfaces" idBase="surfaces" defaultId="mcp" items={SURFACES} />
      </div>
    </section>
  );
}

/** The endpoint the sample event was captured on (a real uuid — ids are uuids, not `evt_…` handles). */
const ENDPOINT_ID = "0197f0b9-4d52-7e11-9b7a-2c8f6d4e1a33";
const ORG_ID = "0197f0b7-2c41-7d33-8a0e-6e3d1f5c9a02";
/** The provider secret that verified the sample event — a signing key's id, as `verification.keyId`. */
const KEY_ID = "0197f0ba-8c19-7f42-a1d6-5b2e7c9f0d84";
const EVENT_ID = "0197f0c1-6b3a-7a11-9f3e-2b6a4f0d9c21";

/**
 * The three events the CLI panel lists — the exact `EventSummary` records behind the table below.
 * The test parses each one with the real `EventSummarySchema` and re-renders the table with the CLI's
 * own `renderEventsTable`, so the panel can't show a shape, a state, or a spacing the CLI wouldn't.
 * `gitlab` is `authenticated`, not `verified`: a shared static token proves the sender, not a
 * signature over the payload — the CLI says so, and so does this.
 */
export const CLI_EVENTS = [
  {
    id: EVENT_ID,
    orgId: ORG_ID,
    endpointId: ENDPOINT_ID,
    receivedAt: "2026-07-12T14:02:11.840Z",
    provider: "linear",
    dedupKey: "msg_2Nf7RbK9xQ", // gitleaks:allow — demo fixture: a provider idempotency key, not a secret
    dedupStrategy: "sw_webhook_id",
    verified: true,
    verificationState: "verified",
  },
  {
    id: "0197f0c2-1e77-7c58-8d41-7a5b9e2c4f16",
    orgId: ORG_ID,
    endpointId: ENDPOINT_ID,
    receivedAt: "2026-07-12T14:02:38.114Z",
    provider: "github",
    dedupKey: "8f2b1c40-6d19-4f0a-9e77-1b3c5d2a8e04", // gitleaks:allow — demo fixture: a provider idempotency key, not a secret
    dedupStrategy: "provider_event_id",
    verified: true,
    verificationState: "verified",
  },
  {
    id: "0197f0c3-7b0a-79d6-b2e5-4f1c8a6d3b90",
    orgId: ORG_ID,
    endpointId: ENDPOINT_ID,
    receivedAt: "2026-07-12T14:03:02.902Z",
    provider: "gitlab",
    dedupKey: "3d9c1a77e0b45f28", // gitleaks:allow — demo fixture: a provider idempotency key, not a secret
    dedupStrategy: "content_hash",
    verified: true,
    verificationState: "authenticated",
  },
] as const;

/**
 * The `wbhk events list` table, byte-for-byte as `renderEventsTable` prints it: UPPERCASE headers,
 * full ISO timestamps, a two-space gutter, and the plain status words (`verified` / `authenticated` /
 * `unverified`) — no glyphs. The test regenerates this from the CLI renderer and compares.
 */
const CLI_TABLE = [
  "RECEIVED                  PROVIDER  VERIFIED       ID",
  "2026-07-12T14:02:11.840Z  linear    verified       0197f0c1-6b3a-7a11-9f3e-2b6a4f0d9c21",
  "2026-07-12T14:02:38.114Z  github    verified       0197f0c2-1e77-7c58-8d41-7a5b9e2c4f16",
  "2026-07-12T14:03:02.902Z  gitlab    authenticated  0197f0c3-7b0a-79d6-b2e5-4f1c8a6d3b90",
] as const;

const SURFACES: readonly TabItem[] = [
  {
    id: "mcp",
    label: "MCP",
    icon: <Bot size={15} />,
    panel: (
      <Terminal title="mcp.webhook.co" meta="events.get">
        <TerminalLine>
          <Tok.Dim>tool</Tok.Dim>
          {"   events.get"}
        </TerminalLine>
        <TerminalLine>
          <Tok.Dim>input</Tok.Dim>
          {"  "}
          <Tok.Mut>{`{ "eventId": "${EVENT_ID}" }`}</Tok.Mut>
        </TerminalLine>
        <TerminalLine aria-hidden="true"> </TerminalLine>
        <TerminalLine>{"{"}</TerminalLine>
        <TerminalLine>{`  "id": "${EVENT_ID}",`}</TerminalLine>
        <TerminalLine>
          {'  "provider": '}
          <Tok.Mut>&quot;linear&quot;</Tok.Mut>,
        </TerminalLine>
        <TerminalLine>
          {'  "verified": '}
          <Tok.Info>true</Tok.Info>,
        </TerminalLine>
        <TerminalLine>
          {'  "verificationState": '}
          <Tok.Ok>&quot;verified&quot;</Tok.Ok>,
        </TerminalLine>
        <TerminalLine>
          {'  "verification": { "ok": '}
          <Tok.Info>true</Tok.Info>
          {`, "scheme": "linear", "keyId": "${KEY_ID}" }`}
        </TerminalLine>
        <TerminalLine>{"}"}</TerminalLine>
      </Terminal>
    ),
  },
  {
    id: "cli",
    label: "CLI",
    icon: <TerminalIcon size={15} />,
    panel: (
      <Terminal title="wbhk — zsh" meta="~/app">
        <TerminalLine>
          <Tok.Dim>$</Tok.Dim> wbhk events list {ENDPOINT_ID}
        </TerminalLine>
        <TerminalLine aria-hidden="true"> </TerminalLine>
        <TerminalLine>
          <Tok.Dim>{CLI_TABLE[0]}</Tok.Dim>
        </TerminalLine>
        {CLI_TABLE.slice(1).map((row) => (
          <TerminalLine key={row}>{row}</TerminalLine>
        ))}
      </Terminal>
    ),
  },
  {
    id: "api",
    label: "API",
    icon: <Code size={15} />,
    panel: (
      <Terminal title="api.webhook.co" meta="events.list">
        <TerminalLine>
          <Tok.Dim>$</Tok.Dim> curl https://api.webhook.co/v1/endpoints/{ENDPOINT_ID}/events \
        </TerminalLine>
        <TerminalLine>
          {"     "}
          <Tok.Mut>-H</Tok.Mut> &quot;authorization: Bearer $WBHK_TOKEN&quot;
        </TerminalLine>
        <TerminalLine aria-hidden="true"> </TerminalLine>
        <TerminalLine>{"{"}</TerminalLine>
        <TerminalLine>{'  "items": ['}</TerminalLine>
        <TerminalLine>{`    { "id": "${EVENT_ID}", "provider": "linear",`}</TerminalLine>
        <TerminalLine>
          {'      "verified": '}
          <Tok.Info>true</Tok.Info>
          {', "verificationState": '}
          <Tok.Ok>&quot;verified&quot;</Tok.Ok>
          {" }"}
        </TerminalLine>
        <TerminalLine>{"  ],"}</TerminalLine>
        <TerminalLine>
          {'  "nextCursor": '}
          <Tok.Dim>null</Tok.Dim>
        </TerminalLine>
        <TerminalLine>{"}"}</TerminalLine>
      </Terminal>
    ),
  },
  {
    id: "web",
    label: "Web",
    icon: <AppWindow size={15} />,
    panel: (
      <Terminal title="app.webhook.co/events" meta="event detail">
        <TerminalLine>
          Event ID{"       "}
          <Tok.Mut>{EVENT_ID}</Tok.Mut>
        </TerminalLine>
        <TerminalLine>
          Received{"       "}
          <Tok.Dim>2026-07-12T14:02:11.840Z</Tok.Dim>
        </TerminalLine>
        <TerminalLine>
          Provider{"       "}
          <Tok.Mut>Linear</Tok.Mut>
        </TerminalLine>
        <TerminalLine>
          Content type{"   "}
          <Tok.Dim>application/json</Tok.Dim>
        </TerminalLine>
        <TerminalLine>
          Payload size{"   "}
          <Tok.Dim>2148 bytes</Tok.Dim>
        </TerminalLine>
        <TerminalLine>
          Dedup{"          "}
          <Tok.Dim>sw_webhook_id · msg_2Nf7RbK9xQ</Tok.Dim>
        </TerminalLine>
        <TerminalLine aria-hidden="true"> </TerminalLine>
        <TerminalLine>
          <Tok.Ok>Verified</Tok.Ok>
          {"       "}
          <Tok.Mut>Signature verified — linear scheme (key {KEY_ID}).</Tok.Mut>
        </TerminalLine>
      </Terminal>
    ),
  },
];
