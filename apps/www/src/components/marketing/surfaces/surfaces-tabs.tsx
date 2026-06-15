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
 */
export function SurfacesTabs() {
  return (
    <section aria-labelledby="surfaces-title" className={cn(container, sectionPad)}>
      <SectionHeading
        id="surfaces-title"
        eyebrow="one platform, every surface"
        title="The same event, wherever you work"
      >
        CLI, API, dashboard, MCP — every capability is reachable identically. Here&rsquo;s one
        verified event, seen from each.
      </SectionHeading>

      <Tabs aria-label="Webhook surfaces" idBase="surfaces" defaultId="mcp" items={SURFACES} />
    </section>
  );
}

const SURFACES: readonly TabItem[] = [
  {
    id: "mcp",
    label: "MCP",
    icon: <Bot size={15} />,
    panel: (
      <Terminal title="mcp.webhook.co" meta="tool call">
        <TerminalLine>
          <Tok.Dim>→</Tok.Dim> events.get
          {"  "}
          <Tok.Mut>{'{ id: "evt_1Qx84K" }'}</Tok.Mut>
        </TerminalLine>
        <TerminalLine aria-hidden="true"> </TerminalLine>
        <TerminalLine>
          {"  "}provider{"   "}
          <Tok.Mut>stripe</Tok.Mut>
        </TerminalLine>
        <TerminalLine>
          {"  "}event{"      "}
          <Tok.Mut>invoice.paid</Tok.Mut>
        </TerminalLine>
        <TerminalLine>
          {"  "}signature{"  "}
          <Tok.Ok>✓ verified</Tok.Ok>
        </TerminalLine>
        <TerminalLine>
          {"  "}status{"     "}
          <Tok.Dim>200 · 38ms</Tok.Dim>
        </TerminalLine>
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
          <Tok.Dim>$</Tok.Dim> wbhk listen
        </TerminalLine>
        <TerminalLine>
          <Tok.Mut>→ capturing at</Tok.Mut> https://3f2a.wbhk.my
        </TerminalLine>
        <TerminalLine aria-hidden="true"> </TerminalLine>
        <TerminalLine>
          <Tok.Dim>14:02:11</Tok.Dim>
          {"  stripe  invoice.paid  "}
          <Tok.Ok>✓ verified</Tok.Ok>
          {"  "}
          <Tok.Dim>→ 200</Tok.Dim>
        </TerminalLine>
        <TerminalLine>
          <Tok.Dim>14:02:38</Tok.Dim>
          {"  github  push          "}
          <Tok.Ok>✓ verified</Tok.Ok>
          {"  "}
          <Tok.Dim>→ 200</Tok.Dim>
        </TerminalLine>
      </Terminal>
    ),
  },
  {
    id: "api",
    label: "API",
    icon: <Code size={15} />,
    panel: (
      <Terminal title="api.webhook.co" meta="GET /v1/events">
        <TerminalLine>
          <Tok.Dim>$</Tok.Dim> curl https://api.webhook.co/v1/events \
        </TerminalLine>
        <TerminalLine>
          {"     "}
          <Tok.Mut>-H</Tok.Mut> &quot;authorization: Bearer $WBHK_TOKEN&quot;
        </TerminalLine>
        <TerminalLine aria-hidden="true"> </TerminalLine>
        <TerminalLine>
          <Tok.Mut>{"{"}</Tok.Mut>
        </TerminalLine>
        <TerminalLine>
          {'  "data": [{ "id": '}
          <Tok.Ok>&quot;evt_1Qx84K&quot;</Tok.Ok>, &quot;verified&quot;: <Tok.Info>true</Tok.Info>
          {" }]"}
        </TerminalLine>
        <TerminalLine>
          <Tok.Mut>{"}"}</Tok.Mut>
        </TerminalLine>
      </Terminal>
    ),
  },
  {
    id: "web",
    label: "Web app",
    icon: <AppWindow size={15} />,
    panel: (
      <Terminal title="webhook.co/events" meta="evt_1Qx84K">
        <TerminalLine>
          provider{"   "}
          <Tok.Mut>stripe</Tok.Mut>
        </TerminalLine>
        <TerminalLine>
          event{"      "}
          <Tok.Mut>invoice.paid</Tok.Mut>
        </TerminalLine>
        <TerminalLine>
          signature{"  "}
          <Tok.Ok>✓ verified</Tok.Ok>
          {"  "}
          <Tok.Dim>whsec_…3f2a</Tok.Dim>
        </TerminalLine>
        <TerminalLine>
          received{"   "}
          <Tok.Dim>14:02:11.840</Tok.Dim>
        </TerminalLine>
        <TerminalLine>
          status{"     "}
          <Tok.Dim>200 · 38ms ·</Tok.Dim> <Tok.Info>replayed 1×</Tok.Info>
        </TerminalLine>
      </Terminal>
    ),
  },
];
